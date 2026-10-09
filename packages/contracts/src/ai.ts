import { z } from "zod";

export const GroundedAiLibraryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
export type GroundedAiLibraryId = z.infer<typeof GroundedAiLibraryIdSchema>;

export const GroundedAiQueryRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(4000),
    idempotency_key: z.string().trim().min(1).max(128),
    library_id: GroundedAiLibraryIdSchema.optional(),
  })
  .strict();
export type GroundedAiQueryRequest = z.infer<typeof GroundedAiQueryRequestSchema>;

export const GroundedAiCitationSchema = z.object({
  sourceId: z.string().min(1).max(512),
  title: z.string().min(1).max(500),
  page: z.number().int().positive().nullable(),
});
export type GroundedAiCitation = z.infer<typeof GroundedAiCitationSchema>;

export const GroundedAiUsageSchema = z.object({
  unitsCharged: z.literal(1),
  remaining: z.number().int().nonnegative(),
});
export type GroundedAiUsage = z.infer<typeof GroundedAiUsageSchema>;

export const GroundedAiQueryResponseSchema = z.object({
  requestId: z.string().uuid(),
  messageId: z.string().uuid(),
  answer: z.string().min(1),
  citations: z.array(GroundedAiCitationSchema).min(1).max(5),
  usage: GroundedAiUsageSchema,
});
export type GroundedAiQueryResponse = z.infer<typeof GroundedAiQueryResponseSchema>;

/**
 * SSE frames for the buffered verified stream. No event is sent before
 * grounded citations are server-validated and quota is finalized.
 */
export const GroundedAiStreamDeltaSchema = z
  .object({
    type: z.literal("delta"),
    requestId: z.string().uuid(),
    messageId: z.string().uuid(),
    index: z.number().int().nonnegative(),
    text: z.string().min(1).max(360),
  })
  .strict();

export const GroundedAiStreamCompleteSchema = z
  .object({
    type: z.literal("complete"),
    response: GroundedAiQueryResponseSchema,
  })
  .strict();

export const GroundedAiStreamEventSchema = z.discriminatedUnion("type", [
  GroundedAiStreamDeltaSchema,
  GroundedAiStreamCompleteSchema,
]);
export type GroundedAiStreamEvent = z.infer<typeof GroundedAiStreamEventSchema>;
