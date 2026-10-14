import {
  ConversationAnswerSchema,
  ConversationProgressEventSchema,
  type ConversationAnswer,
  type ConversationProgressEvent,
} from "@santo/contracts/conversation";

import { GroundedAiError } from "../ai/errors";
import { ConversationServiceError } from "./service";

/**
 * Unlike the existing server-validated buffered SSE, these draft events are
 * explicit provisional plain text. Clients MUST withhold citations/verified UI
 * until complete has passed the full auth, source snapshot, quota and persisted
 * conversation lifecycle.
 */
export function streamProvisionalConversationAnswer(
  work: (onDraft: (text: string) => void) => Promise<ConversationAnswer>,
): Response {
  const encoder = new TextEncoder();
  let canceled = false;
  let lastText = "";
  let count = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ConversationProgressEvent): void => {
        if (canceled) return;
        const verified = ConversationProgressEventSchema.parse(event);
        controller.enqueue(
          encoder.encode(
            "event: " + verified.type + "\ndata: " + JSON.stringify(verified) + "\n\n",
          ),
        );
      };
      void (async () => {
        try {
          const result = await work((text) => {
            if (canceled || text === lastText || ++count > 1000) return;
            lastText = text;
            send({ type: "draft", text });
          });
          send({ type: "complete", response: ConversationAnswerSchema.parse(result) });
        } catch (error) {
          const code =
            error instanceof GroundedAiError || error instanceof ConversationServiceError
              ? error.code
              : "SANTO_UNAVAILABLE";
          // Never leak provider output, stack traces or authorization details.
          send({
            type: "error",
            code: /^[A-Z0-9_]{3,90}$/.test(code) ? code : "SANTO_UNAVAILABLE",
          });
        } finally {
          if (!canceled) controller.close();
        }
      })();
    },
    cancel() {
      canceled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
