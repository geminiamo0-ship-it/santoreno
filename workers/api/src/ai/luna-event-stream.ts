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
export async function collectLunaEventStream(raw: unknown, onProgress: Progress): Promise<string> {
  const body = streamBody(raw);
  if (!body) {
    throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Model did not return SSE");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let generated = "";
  let seenCompleted = false;
  let lastPreview = "";
  let bytes = 0;

  function receive(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Invalid provider SSE event");
    }
    if (typeof event !== "object" || event === null) return;
    const value = event as Record<string, unknown>;
    if (value.type === "response.failed" || value.type === "error") {
      throw new GroundedAiError(502, "MODEL_FAILED", "Provider streaming request failed");
    }
    if (value.type === "response.output_text.delta" && typeof value.delta === "string") {
      generated += value.delta;
      if (generated.length > 64000) {
        throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Provider output exceeds limit");
      }
      const preview = previewStructuredAnswer(generated);
      if (preview && preview !== lastPreview) {
        lastPreview = preview;
        onProgress(preview);
      }
    }
    if (value.type === "response.completed") seenCompleted = true;
  }

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 160000) {
        throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Oversized provider SSE");
      }
      pending += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        receive(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf("\n\n");
      }
    }
    pending += decoder.decode();
    if (pending.trim()) receive(pending);
    if (!seenCompleted) {
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Provider stream unfinished");
    }
    return generated;
  } finally {
    reader.releaseLock();
  }
}
