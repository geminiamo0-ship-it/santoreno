import {
  GroundedAiQueryResponseSchema,
  GroundedAiStreamEventSchema,
  type GroundedAiQueryResponse,
  type GroundedAiStreamEvent,
} from "@santo/contracts/ai";

import { ConversationAnswerSchema, type ConversationAnswer } from "@santo/contracts/conversation";

const MAX_DELTA_CODEPOINTS = 180;

function frame(event: GroundedAiStreamEvent): Uint8Array {
  const validated = GroundedAiStreamEventSchema.parse(event);
  return new TextEncoder().encode(
    "event: " + validated.type + "\ndata: " + JSON.stringify(validated) + "\n\n",
  );
}

/**
 * Fail-closed buffered stream: the entire answer and all citations must already
 * be validated, and the reservation finalized, before any event is produced.
 * This does not claim provider-token time-to-first-byte streaming.
 */
export function streamValidatedGroundedAnswer(result: GroundedAiQueryResponse | ConversationAnswer): Response {
  // Zero-unit deterministic turns cannot be represented as cited grounded SSE.
  // Respond with their separately validated JSON contract even if SSE was requested.
  if ("kind" in result && result.kind === "quick_reply") {
    return Response.json(ConversationAnswerSchema.parse(result), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  const response = GroundedAiQueryResponseSchema.parse(result);
  const codepoints = Array.from(response.answer);
  let offset = 0;
  let index = 0;
  let completed = false;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < codepoints.length) {
        const text = codepoints.slice(offset, offset + MAX_DELTA_CODEPOINTS).join("");
        offset += MAX_DELTA_CODEPOINTS;
        controller.enqueue(
          frame({
            type: "delta",
            requestId: response.requestId,
            messageId: response.messageId,
            index: index++,
            text,
          }),
        );
        return;
      }
      if (!completed) {
        completed = true;
        controller.enqueue(frame({ type: "complete", response }));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
