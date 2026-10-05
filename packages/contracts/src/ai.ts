import { z } from "zod";

export const SantoLibraryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export type SantoLibraryId = z.infer<typeof SantoLibraryIdSchema>;

export const GroundedAiQueryRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(4000),
    idempotency_key: z.string().trim().min(1).max(128),
    library_id: SantoLibraryIdSchema.optional(),
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
