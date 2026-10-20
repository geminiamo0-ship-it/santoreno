import { z } from "zod";
import { GroundedAiQueryResponseSchema, SantoSourceModeSchema } from "./ai";

export const ConversationIdSchema = z.string().uuid();
export const ConversationIdempotencyKeySchema = z.string().trim().min(1).max(128);
export const ConversationTextSchema = z.string().trim().min(1).max(4000);
export const ConversationTitleSchema = z.string().trim().min(1).max(120);

export const ConversationCreateRequestSchema = z
  .object({
    conversationId: ConversationIdSchema,
    idempotencyKey: ConversationIdempotencyKeySchema,
    title: ConversationTitleSchema.optional(),
  })
  .strict();
export type ConversationCreateRequest = z.infer<typeof ConversationCreateRequestSchema>;

export const ConversationCreateResponseSchema = z
  .object({
    conversationId: ConversationIdSchema,
    title: ConversationTitleSchema.nullable(),
    createdAt: z.string().datetime(),
    nextSequence: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationCreateResponse = z.infer<typeof ConversationCreateResponseSchema>;

export const ConversationAppendRequestSchema = z
  .object({
    idempotencyKey: ConversationIdempotencyKeySchema,
    expectedSequence: z.number().int().nonnegative().max(200),
    text: ConversationTextSchema,
  })
  .strict();
export type ConversationAppendRequest = z.infer<typeof ConversationAppendRequestSchema>;

export const ConversationMessageSchema = z
  .object({
    messageId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    role: z.literal("user"),
    text: ConversationTextSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationAppendResponseSchema = z
  .object({
    message: ConversationMessageSchema,
    nextSequence: z.number().int().positive(),
    replayed: z.boolean(),
  })
  .strict();
export type ConversationAppendResponse = z.infer<typeof ConversationAppendResponseSchema>;

export const ConversationReadResponseSchema = ConversationCreateResponseSchema.extend({
  messages: z.array(ConversationMessageSchema).max(50),
  totalMessages: z.number().int().nonnegative().max(200),
}).strict();
export type ConversationReadResponse = z.infer<typeof ConversationReadResponseSchema>;

/** Internal only: populated by an authenticated Santo session, never by client input. */
export const ConversationActorSchema = z
  .object({
    tenantId: z.string().uuid(),
    externalUserId: z.string().min(1).max(255),
  })
  .strict();
export type ConversationActor = z.infer<typeof ConversationActorSchema>;

export const ConversationInternalCreateSchema = ConversationCreateRequestSchema.extend({
  actor: ConversationActorSchema,
}).strict();

export const ConversationInternalAppendSchema = ConversationAppendRequestSchema.extend({
  actor: ConversationActorSchema,
  conversationId: ConversationIdSchema,
}).strict();

export const ConversationInternalReadSchema = z
  .object({
    actor: ConversationActorSchema,
    conversationId: ConversationIdSchema,
  })
  .strict();

export const ConversationDeleteResponseSchema = z.object({ deleted: z.literal(true) }).strict();
export type ConversationDeleteResponse = z.infer<typeof ConversationDeleteResponseSchema>;

/** Client-facing grounded follow-up request; tenant identity and response are never client-supplied. */
export const ConversationAskRequestSchema = z
  .object({
    idempotencyKey: ConversationIdempotencyKeySchema,
    expectedSequence: z.number().int().nonnegative().max(200),
    text: ConversationTextSchema,
    sourceMode: SantoSourceModeSchema.optional(),
    libraryId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
  })
  .strict()
  .refine((req) => req.sourceMode !== "research" || !req.libraryId, {
    message: "Research mode cannot filter a Santo library",
  });
export type ConversationAskRequest = z.infer<typeof ConversationAskRequestSchema>;

/** Deterministic, authorized non-clinical conversation; never a fabricated sourced answer. */
export const ConversationQuickReplySchema = z
  .object({
    requestId: z.string().uuid(),
    messageId: z.string().uuid(),
    answer: z.string().min(1).max(1000),
    citations: z.tuple([]),
    usage: z.object({
      unitsCharged: z.literal(0),
      remaining: z.number().int().nonnegative(),
    }),
    kind: z.literal("quick_reply"),
  })
  .strict();
export type ConversationQuickReply = z.infer<typeof ConversationQuickReplySchema>;

export const ConversationAnswerSchema = z.union([
  GroundedAiQueryResponseSchema,
  ConversationQuickReplySchema,
]);
export type ConversationAnswer = z.infer<typeof ConversationAnswerSchema>;

/** Native model token-time-to-first-byte remains PROVISIONAL until complete. */
export const ConversationProgressEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("draft"),
      text: z.string().max(12000),
    })
    .strict(),
  z
    .object({
      type: z.literal("draft_delta"),
      // Opt-in compact SSE: append text to the most recent cumulative draft.
      text: z.string().min(1).max(12000),
    })
    .strict(),
  z
    .object({
      type: z.literal("complete"),
      response: ConversationAnswerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.string().regex(/^[A-Z0-9_]{3,90}$/),
    })
    .strict(),
]);
export type ConversationProgressEvent = z.infer<typeof ConversationProgressEventSchema>;

export const ConversationTurnStatusSchema = z.enum(["pending", "completed", "retryable"]);
export const ConversationTurnSchema = z
  .object({
    messageId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    question: ConversationTextSchema,
    libraryId: z.string().nullable(),
    sourceMode: SantoSourceModeSchema.optional(),
    status: ConversationTurnStatusSchema,
    response: ConversationAnswerSchema.nullable(),
  })
  .strict();
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const ConversationBeginTurnSchema = ConversationAskRequestSchema.extend({
  actor: ConversationActorSchema,
  conversationId: ConversationIdSchema,
}).strict();

export const ConversationBeginTurnResponseSchema = z
  .object({
    state: z.enum(["started", "completed"]),
    attemptId: z.string().uuid().nullable(),
    quotaEpoch: z.number().int().nonnegative(),
    turn: ConversationTurnSchema,
    context: z.string().max(1600),
    /** Only authenticated user turns, including current, no assistant answers. */
    recentUserMessages: z.array(ConversationTextSchema).max(5).optional(),
  })
  .strict();
export type ConversationBeginTurnResponse = z.infer<typeof ConversationBeginTurnResponseSchema>;

export const ConversationFinishTurnSchema = z
  .object({
    actor: ConversationActorSchema,
    conversationId: ConversationIdSchema,
    idempotencyKey: ConversationIdempotencyKeySchema,
    attemptId: z.string().uuid(),
    response: ConversationTurnSchema.shape.response.unwrap(),
  })
  .strict();

export const ConversationRetryTurnSchema = ConversationFinishTurnSchema.omit({
  response: true,
}).extend({
  rotateQuotaKey: z.boolean().optional(),
});
export const ConversationTurnListResponseSchema = z
  .object({
    turns: z.array(ConversationTurnSchema).max(10),
  })
  .strict();
