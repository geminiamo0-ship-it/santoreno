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
  draftFormat: "cumulative" | "delta" = "cumulative",
): Response {
  const encoder = new TextEncoder();
  let canceled = false;
  let lastText = "";
  let count = 0;
  const startedAt = performance.now();
  let firstDraftRecorded = false;
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
            if (canceled || text === lastText) return;
            if (++count > 12_000 || text.length > 120_000) {
              throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Draft stream limit exceeded");
            }
            if (!firstDraftRecorded && text.length > 0) {
              firstDraftRecorded = true;
              console.info("santo_first_draft_delta_ms", {
                milliseconds: Math.round(performance.now() - startedAt),
              });
            }
            const previous = lastText;
            lastText = text;
            if (draftFormat === "delta" && text.startsWith(previous) && previous.length > 0) {
              // The provider gives cumulative snapshots. Send only the suffix so
              // total network traffic is linear, not quadratic in answer length.
              send({ type: "draft_delta", text: text.slice(previous.length) });
            } else {
              // First preview, legacy client, or explicit reset/fallback.
              send({ type: "draft", text });
            }
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
