import { GroundedAiError } from "./errors";

type Progress = (provisionalAnswer: string) => void;

function streamBody(value: unknown): ReadableStream<Uint8Array> | null {
  if (value instanceof ReadableStream) return value as ReadableStream<Uint8Array>;
  if (value instanceof Response && value.body) return value.body;
  return null;
}

/**
 * Preview only the JSON "answer" string; never stream citations, URLs, or
 * provider JSON metadata. The caller must label this text UNVERIFIED until
 * Santo persists a citation-validated final response.
 */
export function previewStructuredAnswer(json: string): string {
  const match = /"answer"\s*:\s*"/.exec(json);
  if (!match) return "";
  const start = match.index + match[0].length;
  let end = json.length;
  for (let i = start; i < json.length; i++) {
    if (json[i] === "\\") {
      i++;
      continue;
    }
    if (json[i] === '"') {
      end = i;
      break;
    }
  }
  let quoted = json.slice(start, end);
  // The provider can split a backslash/uXXXX escape across SSE events.
  while (quoted.length) {
    try {
      const answer: unknown = JSON.parse('"' + quoted + '"');
      return typeof answer === "string" ? answer.slice(0, 12000) : "";
    } catch {
      quoted = quoted.slice(0, -1);
    }
  }
  return "";
}

/** Collects native Responses SSE from Cloudflare AI.run(stream:true). */
/**
 * Return only actual output_text supplied as part of the completed provider
 * response. This can recover a final JSON string from THE SAME paid inference
 * when the gateway omitted some textual deltas; never create an answer or cite
 * anything that the provider did not return.
 */
function completedProviderText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const response = value as Record<string, unknown>;
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  if (!Array.isArray(response.output)) return null;
  const sections: string[] = [];
  for (const entry of response.output) {
    if (typeof entry !== "object" || entry === null) continue;
    const message = entry as Record<string, unknown>;
    if (message.type !== "message" || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (typeof content !== "object" || content === null) continue;
      const item = content as Record<string, unknown>;
      if (item.type === "output_text" && typeof item.text === "string") {
        sections.push(item.text);
      }
    }
  }
  const text = sections.join("");
  return text.trim() ? text : null;
}

/**
 * Diagnostic labels are fixed literals with no student text, source IDs,
 * provider error bodies or credentials. Never log or replay clinical content.
 */
function recordStreamFailure(stage: string, outputChars: number, outputTokens?: number): void {
  console.warn("santo_luna_stream_failure", {
    stage,
    outputChars,
    ...(typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0
      ? { outputTokens }
      : {}),
  });
}

function providerIncompleteReason(value: Record<string, unknown> | null): string {
  if (!value) return "provider_incomplete";
  const details = value.incomplete_details;
  const reason =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>).reason
      : undefined;
  return reason === "max_output_tokens" ? "max_output_tokens" : "provider_incomplete";
}

/** Collects native Responses SSE from the existing Cloudflare AI.run(stream:true).
 * CRLF may be split between network chunks: normalization MUST span chunk
 * boundaries or the final response.completed frame can disappear.
 */
export async function collectLunaEventStream(
  raw: unknown,
  onProgress: Progress,
  previewFormat: "json" | "plain" = "json",
): Promise<string> {
  const body = streamBody(raw);
  if (!body) {
    throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Model did not return SSE");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let prevCR = false;
  let generated = "";
  let doneText: string | null = null;
  let completedText: string | null = null;
  let seenCompleted = false;
  let lastPreview = "";
  let bytes = 0;
  let observedOutputTokens: number | undefined;
  let completionTextReceived = false;

  function receive(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      recordStreamFailure("provider_sse_event_invalid", generated.length, observedOutputTokens);
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Invalid provider SSE event");
    }
    if (typeof event !== "object" || event === null) return;
    const value = event as Record<string, unknown>;
    if (value.type === "response.failed" || value.type === "error") {
      throw new GroundedAiError(502, "MODEL_FAILED", "Provider streaming request failed");
    }
    if (value.type === "response.incomplete") {
      const provider =
        typeof value.response === "object" && value.response !== null
          ? (value.response as Record<string, unknown>)
          : null;
      const reason = providerIncompleteReason(provider);
      recordStreamFailure(reason, generated.length, observedOutputTokens);
      throw new GroundedAiError(
        502,
        reason === "max_output_tokens" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_PROVIDER_INCOMPLETE",
        "Provider response was incomplete",
      );
    }
    if (value.type === "response.output_text.delta" && typeof value.delta === "string") {
      generated += value.delta;
      if (generated.length > 64000) {
        throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Provider output exceeds limit");
      }
      // Plain Markdown uses the same SSE parser and completion checks,
      // but does not depend on an enclosing JSON string to show its draft.
      const preview =
        previewFormat === "plain" ? generated.slice(0, 12000) : previewStructuredAnswer(generated);
      if (preview && preview !== lastPreview) {
        lastPreview = preview;
        onProgress(preview);
      }
    }
    if (
      value.type === "response.output_text.done" &&
      typeof value.text === "string" &&
      value.text.trim()
    ) {
      doneText = value.text;
      completionTextReceived = true;
    }
    if (value.type === "response.completed") {
      const provider =
        typeof value.response === "object" && value.response !== null
          ? (value.response as Record<string, unknown>)
          : null;
      if (provider && typeof provider.status === "string" && provider.status !== "completed") {
        const reason = providerIncompleteReason(provider);
        recordStreamFailure(reason, generated.length, observedOutputTokens);
        throw new GroundedAiError(
          502,
          reason === "max_output_tokens" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_PROVIDER_INCOMPLETE",
          "Provider response not completed",
        );
      }
      const usage = provider?.usage;
      if (typeof usage === "object" && usage !== null) {
        const count = (usage as Record<string, unknown>).output_tokens;
        if (typeof count === "number" && Number.isFinite(count) && count >= 0)
          observedOutputTokens = count;
      }
      completedText = completedProviderText(provider);
      if (completedText) completionTextReceived = true;
      seenCompleted = true;
    }
  }

  function processFrames(): void {
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      receive(pending.slice(0, boundary));
      pending = pending.slice(boundary + 2);
      boundary = pending.indexOf("\n\n");
    }
  }

  // Treat \r\n, bare \r and \n as newline, but wait one character when a
  // network chunk ends on \r. Replacing newlines per chunk loses CRLF pairs.
  function appendChunk(rawText: string): void {
    let normalized = "";
    for (const ch of rawText) {
      if (prevCR) {
        normalized += "\n";
        prevCR = false;
        if (ch === "\n") continue;
      }
      if (ch === "\r") prevCR = true;
      else normalized += ch;
    }
    pending += normalized;
    processFrames();
  }

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 160000) {
        throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Oversized provider SSE");
      }
      appendChunk(decoder.decode(next.value, { stream: true }));
    }
    appendChunk(decoder.decode());
    if (prevCR) {
      prevCR = false;
      pending += "\n";
    }
    if (pending.trim()) receive(pending);
    if (!seenCompleted) {
      recordStreamFailure("missing_response_completed", generated.length, observedOutputTokens);
      throw new GroundedAiError(502, "MODEL_STREAM_UNFINISHED", "Provider stream unfinished");
    }
    const actualText = completedText ?? doneText ?? generated;
    if (!actualText || actualText.length > 64000) {
      recordStreamFailure("completed_without_usable_text", generated.length, observedOutputTokens);
      throw new GroundedAiError(
        502,
        "MODEL_RESPONSE_INVALID",
        "Provider completed without usable text",
      );
    }
    if (
      previewFormat === "json" &&
      !completionTextReceived &&
      actualText &&
      !actualText.trim().endsWith("}")
    ) {
      // Do not invent JSON braces or sources to transform a truncated response.
      recordStreamFailure(
        "completed_delta_missing_json_end",
        generated.length,
        observedOutputTokens,
      );
    }
    return actualText;
  } finally {
    reader.releaseLock();
  }
}
