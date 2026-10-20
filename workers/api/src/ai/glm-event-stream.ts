import { GroundedAiError } from "./errors";
import { LUNA_MAX_GENERATED_CHARS, LUNA_MAX_PROVIDER_SSE_BYTES } from "./luna-event-stream";

/**
 * Workers AI GLM-4.7-Flash uses OpenAI Chat Completions SSE, NOT the
 * Responses API used by Luna. Never mistake a closed socket for completion.
 * Accept only choice[0].finish_reason=stop followed by data: [DONE].
 * Thinking/reasoning_content is not the student answer or a citation.
 */
export async function collectGlmEventStream(
  raw: unknown,
  onProgress: (answer: string) => void,
): Promise<string> {
  const body =
    raw instanceof ReadableStream
      ? raw
      : raw instanceof Response
        ? raw.body
        : null;
  if (!body) {
    throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "GLM did not return an SSE stream");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let previousCR = false;
  let generated = "";
  let totalBytes = 0;
  let sawStop = false;
  let sawDone = false;

  function parseFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    if (sawDone) {
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "GLM emitted text after completion");
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Malformed GLM stream event");
    }
    if (!json || typeof json !== "object") {
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Invalid GLM stream event");
    }
    const event = json as Record<string, unknown>;
    // Some workers send a usage-only frame between finish_reason and [DONE].
    // It carries no model-authored answer text and is safe to ignore.
    if (sawStop) {
      if (event.usage && Array.isArray(event.choices) && event.choices.length === 0) return;
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "GLM emitted content after stop");
    }
    if (event.error) {
      throw new GroundedAiError(502, "MODEL_FAILED", "GLM provider returned an error");
    }
    if (!Array.isArray(event.choices) || event.choices.length === 0) {
      // Some providers send a separate trailing usage frame.
      if (event.usage) return;
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "GLM stream missing choice");
    }
    const choice = event.choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string" && delta.content.length > 0) {
      generated += delta.content;
      if (generated.length > LUNA_MAX_GENERATED_CHARS) {
        throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "GLM output too large");
      }
      onProgress(generated);
    }
    const finishReason = choice?.finish_reason;
    if (typeof finishReason === "string") {
      if (finishReason !== "stop") {
        throw new GroundedAiError(
          502,
          finishReason === "length" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_PROVIDER_INCOMPLETE",
          "GLM generation did not finish normally",
        );
      }
      sawStop = true;
    }
  }

  function append(text: string): void {
    let normalized = "";
    for (const ch of text) {
      if (previousCR) {
        normalized += "\n";
        previousCR = false;
        if (ch === "\n") continue;
      }
      if (ch === "\r") previousCR = true;
      else normalized += ch;
    }
    pending += normalized;
    let boundary = pending.indexOf("\n\n");
    while (boundary !== -1) {
      parseFrame(pending.slice(0, boundary));
      pending = pending.slice(boundary + 2);
      boundary = pending.indexOf("\n\n");
    }
  }

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > LUNA_MAX_PROVIDER_SSE_BYTES) {
        throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Oversized GLM SSE");
      }
      append(decoder.decode(next.value, { stream: true }));
    }
    append(decoder.decode());
    if (previousCR) pending += "\n";
    if (pending.trim()) parseFrame(pending);
    if (!sawStop || !sawDone) {
      throw new GroundedAiError(502, "MODEL_STREAM_UNFINISHED", "GLM stream ended without verified completion");
    }
    if (!generated.trim()) {
      throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "GLM did not emit answer text");
    }
    return generated;
  } finally {
    reader.releaseLock();
  }
}
