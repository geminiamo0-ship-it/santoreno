import { describe, expect, it } from "vitest";

import type { DurableObjectStorageLike, SqlStorageLike } from "./tenant-meter-core";
import { ConversationStateCore, ConversationStateError } from "./conversation-core";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const actor = { tenantId: TENANT_ID, externalUserId: "student" };
const create = (key = "create-1") => ({
  actor,
  conversationId: CONVERSATION_ID,
  idempotencyKey: key,
  title: "Clinical teaching",
});
const append = (idempotencyKey: string, expectedSequence: number, text = "Question") => ({
  actor,
  conversationId: CONVERSATION_ID,
  idempotencyKey,
  expectedSequence,
  text,
});

interface FakeMessageRow {
  message_id: string;
  sequence: number;
  idempotency_key: string;
  expected_sequence: number;
  role: "user";
  text: string;
  created_at_ms: number;
}

class MemorySqlStorage implements DurableObjectStorageLike {
  private meta: Record<string, unknown> | null = null;
  private readonly messages: FakeMessageRow[] = [];

  readonly sql: SqlStorageLike = {
    exec: <T>(query: string, ...bindings: unknown[]) => {
      let rows: unknown[] = [];
      if (query.trimStart().startsWith("CREATE TABLE")) {
        // Mock only: live staging must separately verify real SQLite.
      } else if (query.includes("INSERT INTO conversation_meta")) {
        this.meta = {
          singleton: 1,
          conversation_id: bindings[0],
          tenant_id: bindings[1],
          external_user_id: bindings[2],
          creation_key: bindings[3],
          title: bindings[4],
          created_at_ms: bindings[5],
        };
      } else if (query.includes("INSERT INTO conversation_messages")) {
        this.messages.push({
          sequence: Number(bindings[0]),
          message_id: String(bindings[1]),
          idempotency_key: String(bindings[2]),
          expected_sequence: Number(bindings[3]),
          role: "user",
          text: String(bindings[4]),
          created_at_ms: Number(bindings[5]),
        });
      } else if (query.startsWith("DELETE FROM conversation_turns")) {
        // This state-only fake has no AI turns.
      } else if (query.includes("FROM conversation_turns WHERE status")) {
        rows = [];
      } else if (query.startsWith("DELETE FROM conversation_messages")) {
        this.messages.length = 0;
      } else if (query.startsWith("DELETE FROM conversation_meta")) {
        this.meta = null;
      } else if (query.includes("FROM conversation_meta")) {
        rows = this.meta ? [this.meta] : [];
      } else if (query.includes("COALESCE(MAX(sequence)")) {
        rows = [{ next_sequence: this.messages.length }];
      } else if (query.includes("WHERE idempotency_key")) {
        rows = this.messages.filter((message) => message.idempotency_key === bindings[0]);
      } else if (query.includes("ORDER BY sequence DESC")) {
        rows = [...this.messages].reverse().slice(0, Number(bindings[0]));
      } else {
        throw new Error(`Fake SQL does not support: ${query}`);
      }
      return { toArray: () => rows as T[] };
    },
  };

  transactionSync<T>(callback: () => T): T {
    return callback();
  }
}

let nextMessageId = 0;
function core(storage = new MemorySqlStorage()): ConversationStateCore {
  return new ConversationStateCore(
    storage,
    () => Date.parse("2026-10-13T00:00:00.000Z"),
    () => `33333333-3333-4333-8333-${String(++nextMessageId).padStart(12, "0")}`,
  );
}

describe("conversation state core", () => {
  it("creates and replays a conversation without duplicate state", () => {
    const state = core();
    const result = state.create(create());
    expect(result).toMatchObject({
      conversationId: CONVERSATION_ID,
      title: "Clinical teaching",
      nextSequence: 0,
    });
    expect(state.create(create())).toEqual(result);
    expect(state.read({ actor, conversationId: CONVERSATION_ID }).messages).toEqual([]);
  });

  it("rejects cross-tenant and cross-user access, including read and append", () => {
    const state = core();
    state.create(create());
    for (const other of [
      { tenantId: "44444444-4444-4444-8444-444444444444", externalUserId: "student" },
      { tenantId: TENANT_ID, externalUserId: "not-student" },
    ]) {
      expect(() => state.read({ actor: other, conversationId: CONVERSATION_ID })).toThrowError(
        ConversationStateError,
      );
      expect(() => state.append({ ...append("other", 0), actor: other })).toThrowError(
        ConversationStateError,
      );
      expect(() => state.create({ ...create(), actor: other })).toThrowError(
        ConversationStateError,
      );
    }
  });

  it("rejects conflicting create and append keys without mutating messages", () => {
    const state = core();
    state.create(create());
    expect(() => state.create(create("different"))).toThrowError(ConversationStateError);
    const first = state.append(append("first", 0));
    expect(first).toMatchObject({ message: { sequence: 0 }, nextSequence: 1, replayed: false });
    expect(state.append(append("first", 0))).toMatchObject({
      message: { messageId: first.message.messageId },
      nextSequence: 1,
      replayed: true,
    });
    expect(() => state.append(append("first", 0, "changed"))).toThrowError(ConversationStateError);
    expect(() => state.append(append("other", 0))).toThrowError(ConversationStateError);
    expect(state.read({ actor, conversationId: CONVERSATION_ID }).totalMessages).toBe(1);
  });

  it("ensures exactly one of 100 competing writes claims the same sequence", async () => {
    const state = core();
    state.create(create());
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        Promise.resolve().then(() => state.append(append(`key-${i}`, 0))),
      ),
    );
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(99);
    expect(state.read({ actor, conversationId: CONVERSATION_ID }).nextSequence).toBe(1);
  });

  it("recovers ordered durable state after reconstructing a core over the same storage", () => {
    const storage = new MemorySqlStorage();
    const before = core(storage);
    before.create(create());
    const first = before.append(append("first", 0));
    const after = core(storage);
    expect(after.append(append("first", 0))).toEqual({ ...first, replayed: true });
    const second = after.append(append("second", 1));
    expect(second.message.sequence).toBe(1);
    expect(
      after
        .read({ actor, conversationId: CONVERSATION_ID })
        .messages.map((message) => message.sequence),
    ).toEqual([0, 1]);
  });

  it("keeps reads bounded to the latest 50 messages and blocks more than 200", () => {
    const state = core();
    state.create(create());
    for (let i = 0; i < 200; i += 1) {
      state.append(append(`key-${i}`, i, `Question ${i}`));
    }
    const read = state.read({ actor, conversationId: CONVERSATION_ID });
    expect(read.totalMessages).toBe(200);
    expect(read.messages).toHaveLength(50);
    expect(read.messages[0]?.sequence).toBe(150);
    expect(read.messages[49]?.sequence).toBe(199);
    expect(() => state.append(append("overflow", 200))).toThrowError(ConversationStateError);
  });

  it("allows owner erasure without a cross-tenant delete bypass", () => {
    const state = core();
    state.create(create());
    state.append(append("first", 0));
    expect(() =>
      state.delete({
        actor: { tenantId: TENANT_ID, externalUserId: "not-owner" },
        conversationId: CONVERSATION_ID,
      }),
    ).toThrowError(ConversationStateError);
    expect(state.read({ actor, conversationId: CONVERSATION_ID }).totalMessages).toBe(1);
    expect(state.delete({ actor, conversationId: CONVERSATION_ID })).toEqual({ deleted: true });
    expect(() => state.read({ actor, conversationId: CONVERSATION_ID })).toThrowError(
      ConversationStateError,
    );
  });

  it("returns a typed not-found for a conversation that has not been created", () => {
    const state = core();
    expect(() => state.read({ actor, conversationId: CONVERSATION_ID })).toThrowError(
      ConversationStateError,
    );
  });
});
