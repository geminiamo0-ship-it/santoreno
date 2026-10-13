import { describe, expect, it } from "vitest";

import {
  ConversationActorSchema,
  ConversationAppendRequestSchema,
  ConversationAppendResponseSchema,
  ConversationCreateRequestSchema,
  ConversationCreateResponseSchema,
  ConversationInternalAppendSchema,
  ConversationMessageSchema,
  ConversationReadResponseSchema,
} from "./conversation";

const conversationId = "11111111-1111-4111-8111-111111111111";
const actor = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  externalUserId: "student-1",
};

describe("conversation API contracts", () => {
  it("validates a strictly scoped create request and response", () => {
    const input = { conversationId, idempotencyKey: "create-1", title: "Cardiology review" };
    expect(ConversationCreateRequestSchema.parse(input)).toEqual(input);
    expect(
      ConversationCreateResponseSchema.parse({
        conversationId,
        title: "Cardiology review",
        createdAt: "2026-10-13T00:00:00.000Z",
        nextSequence: 0,
      }).conversationId,
    ).toBe(conversationId);
  });

  it("never permits the browser to specify tenant or user authority", () => {
    expect(ConversationActorSchema.safeParse(actor).success).toBe(true);
    expect(
      ConversationCreateRequestSchema.safeParse({
        conversationId,
        idempotencyKey: "create-1",
        tenantId: actor.tenantId,
      }).success,
    ).toBe(false);
    expect(
      ConversationAppendRequestSchema.safeParse({
        idempotencyKey: "append-1",
        expectedSequence: 0,
        text: "Question",
        externalUserId: actor.externalUserId,
      }).success,
    ).toBe(false);
  });

  it("rejects empty text, invalid offsets and arbitrary assistant messages", () => {
    expect(
      ConversationAppendRequestSchema.safeParse({
        idempotencyKey: "key",
        expectedSequence: -1,
        text: "question",
      }).success,
    ).toBe(false);
    expect(
      ConversationAppendRequestSchema.safeParse({
        idempotencyKey: "key",
        expectedSequence: 0,
        text: "  ",
      }).success,
    ).toBe(false);
    expect(
      ConversationMessageSchema.safeParse({
        messageId: conversationId,
        sequence: 0,
        role: "assistant",
        text: "unverified answer",
        createdAt: "2026-10-13T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("accepts a verified internal actor but rejects extra authority selectors", () => {
    const request = {
      actor,
      conversationId,
      idempotencyKey: "write-1",
      expectedSequence: 0,
      text: "Clinical question",
    };
    expect(ConversationInternalAppendSchema.parse(request)).toEqual(request);
    expect(
      ConversationInternalAppendSchema.safeParse({ ...request, admin: true }).success,
    ).toBe(false);
  });

  it("validates replay and bounded read response envelopes", () => {
    const message = {
      messageId: "33333333-3333-4333-8333-333333333333",
      sequence: 0,
      role: "user",
      text: "Question",
      createdAt: "2026-10-13T00:00:00.000Z",
    };
    expect(
      ConversationAppendResponseSchema.safeParse({ message, nextSequence: 1, replayed: true })
        .success,
    ).toBe(true);
    const read = {
      conversationId,
      title: null,
      createdAt: "2026-10-13T00:00:00.000Z",
      nextSequence: 1,
      messages: [message],
      totalMessages: 1,
    };
    expect(ConversationReadResponseSchema.parse(read)).toEqual(read);
    expect(
      ConversationReadResponseSchema.safeParse({
        ...read,
        messages: Array.from({ length: 51 }, () => message),
      }).success,
    ).toBe(false);
  });
});
