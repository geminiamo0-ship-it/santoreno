import { z } from "zod";

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
