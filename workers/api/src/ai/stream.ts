import {
  GroundedAiQueryResponseSchema,
  GroundedAiStreamEventSchema,
  type GroundedAiQueryResponse,
  type GroundedAiStreamEvent,
} from "@santo/contracts/ai";

const DELTA_CODEPOINTS = 256;

function encodeEvent(event: GroundedAiStreamEvent): Uint8Array {
  const validated = GroundedAiStreamEventSchema.parse(event);
  return new TextEncoder().encode(
    `event: ${validated.type}\ndata: ${JSON.stringify(validated)}\n\n`,
  );
}

/**
 * Validation-gated SSE transport. The service must finish authenticated retrieval,
 * model output and citation validation, and quota finalization before this is called.
 * Provider tokens are never streamed directly to clients.
 */
export function createVerifiedGroundedAiStreamResponse(
  response: GroundedAiQueryResponse,
): Response {
  const verified = GroundedAiQueryResponseSchema.parse(response);
  const answerCodepoints = Array.from(verified.answer);
  let offset = 0;
  let completed = false;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < answerCodepoints.length) {
        const text = answerCodepoints.slice(offset, offset + DELTA_CODEPOINTS).join("");
        offset += DELTA_CODEPOINTS;
        controller.enqueue(encodeEvent({ type: "delta", text }));
        return;
      }

      if (!completed) {
        completed = true;
        controller.enqueue(encodeEvent({ type: "complete", response: verified }));
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
