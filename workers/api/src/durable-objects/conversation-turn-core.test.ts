import { describe, expect, it } from "vitest";

import type { DurableObjectStorageLike, SqlStorageLike } from "./tenant-meter-core";
import { ConversationStateCore, ConversationStateError } from "./conversation-core";
import { ConversationTurnCore } from "./conversation-turn-core";

const conversationId = "11111111-1111-4111-8111-111111111111";
const actor = { tenantId: "22222222-2222-4222-8222-222222222222", externalUserId: "student" };
const ask = (key = "first", text = "What is sodium?", sequence = 0) => ({
  actor,
  conversationId,
  idempotencyKey: key,
  expectedSequence: sequence,
  text,
});
const answer = {
  requestId: "33333333-3333-4333-8333-333333333333",
  messageId: "44444444-4444-4444-8444-444444444444",
  answer: "Sodium ranges are 135–145.",
  citations: [{ sourceId: "medical:sodium", title: "Serum sodium", page: 3 }],
  usage: { unitsCharged: 1 as const, remaining: 9 },
};

type Row = Record<string, unknown>;
class State implements DurableObjectStorageLike {
  meta: Row | null = null;
  messages: Row[] = [];
  turns: Row[] = [];
  summary: Row | null = null;
  sql: SqlStorageLike = {
    exec: <T>(query: string, ...params: unknown[]) => {
      let rows: Row[] = [];
      if (query.trimStart().startsWith("CREATE TABLE")) {
        // Production validates SQLite SQL in the separate live staging gate.
      } else if (query.startsWith("PRAGMA table_info(conversation_turns)")) {
        rows = [{ name: "source_mode" }];
      } else if (query.includes("INSERT INTO conversation_meta")) {
        this.meta = {
          conversation_id: params[0],
          tenant_id: params[1],
          external_user_id: params[2],
          creation_key: params[3],
          title: params[4],
          created_at_ms: params[5],
        };
      } else if (query.includes("INSERT INTO conversation_messages")) {
        this.messages.push({
          sequence: params[0],
          message_id: params[1],
          idempotency_key: params[2],
          expected_sequence: params[3],
          role: "user",
          text: params[4],
          created_at_ms: params[5],
        });
      } else if (query.includes("INSERT INTO conversation_turns")) {
        this.turns.push({
          idempotency_key: params[0],
          message_id: params[1],
          sequence: params[2],
          expected_sequence: params[3],
          question: params[4],
          library_id: params[5],
          source_mode: params[6],
          status: "pending",
          attempt_id: params[7],
          lease_until_ms: params[8],
          response_json: null,
          context_text: params[9],
          quota_epoch: 0,
        });
      } else if (query.startsWith("UPDATE conversation_turns SET status = 'pending'")) {
        const row = this.turns.find((t) => t.idempotency_key === params[2]);
        if (row)
          Object.assign(row, {
            status: "pending",
            attempt_id: params[0],
            lease_until_ms: params[1],
          });
      } else if (query.startsWith("UPDATE conversation_turns SET status = 'completed'")) {
        const row = this.turns.find((t) => t.idempotency_key === params[1]);
        if (row)
          Object.assign(row, { status: "completed", response_json: params[0], lease_until_ms: 0 });
      } else if (query.startsWith("UPDATE conversation_turns SET status = 'retryable'")) {
        const row = this.turns.find((t) => t.idempotency_key === params[1]);
        if (row)
          Object.assign(row, {
            status: "retryable",
            lease_until_ms: 0,
            quota_epoch: Number(row.quota_epoch) + Number(params[0]),
          });
      } else if (query.includes("INSERT INTO conversation_context_summary")) {
        this.summary = { last_completed_sequence: params[0], summary_text: params[1] };
      } else if (query.startsWith("DELETE FROM conversation_context_summary")) {
        this.summary = null;
      } else if (query.includes("FROM conversation_context_summary")) {
        rows = this.summary ? [this.summary] : [];
      } else if (query.startsWith("DELETE FROM conversation_turns")) {
        this.turns = [];
      } else if (query.startsWith("DELETE FROM conversation_messages")) {
        this.messages = [];
      } else if (query.startsWith("DELETE FROM conversation_meta")) {
        this.meta = null;
      } else if (query.includes("FROM conversation_meta")) {
        rows = this.meta ? [this.meta] : [];
      } else if (query.includes("COALESCE(MAX(sequence)")) {
        rows = [{ next_sequence: this.messages.length }];
      } else if (query.includes("FROM conversation_turns WHERE idempotency_key")) {
        rows = this.turns.filter((t) => t.idempotency_key === params[0]);
      } else if (query.includes("FROM conversation_turns WHERE status = 'pending'")) {
        rows = this.turns
          .filter(
            (t) =>
              t.status === "pending" &&
              Number(t.lease_until_ms) > Number(params[0]) &&
              (!query.includes("idempotency_key != ?") || t.idempotency_key !== params[1]),
          )
          .slice(0, 1);
      } else if (
        query.startsWith(
          "SELECT sequence, response_json FROM conversation_turns WHERE status = 'completed'",
        )
      ) {
        rows = this.turns
          .filter(
            (t) =>
              t.status === "completed" &&
              Number(t.sequence) >= Number(params[0]) &&
              Number(t.sequence) < Number(params[1]),
          )
          .sort((a, b) => Number(b.sequence) - Number(a.sequence))
          .slice(0, 5);
      } else if (query.includes("FROM conversation_turns WHERE status = 'completed'")) {
        rows = this.turns
          .filter((t) => t.status === "completed")
          .reverse()
          .slice(0, 3);
      } else if (query.includes("FROM conversation_turns ORDER BY sequence DESC")) {
        rows = [...this.turns].reverse().slice(0, 10);
      } else if (
        query.startsWith("SELECT sequence FROM conversation_messages WHERE role = 'user'")
      ) {
        rows = this.messages
          .filter((m) => m.role === "user" && Number(m.sequence) <= Number(params[0]))
          .sort((a, b) => Number(b.sequence) - Number(a.sequence))
          .slice(0, 5)
          .map((m) => ({ sequence: m.sequence }));
      } else if (query.includes("FROM conversation_messages WHERE role = 'user'")) {
        rows = this.messages
          .filter((m) => m.role === "user" && Number(m.sequence) <= Number(params[0]))
          .sort((a, b) => Number(b.sequence) - Number(a.sequence))
          .slice(0, 5)
          .map((m) => ({ text: m.text }));
      } else if (query.includes("FROM conversation_messages WHERE idempotency_key")) {
        rows = this.messages.filter((m) => m.idempotency_key === params[0]);
      } else if (query.includes("FROM conversation_messages ORDER BY sequence DESC")) {
        rows = [...this.messages].reverse().slice(0, Number(params[0]));
      } else {
        throw new Error(`Unsupported fake SQL ${query}`);
      }
      return { toArray: () => rows as T[] };
    },
  };
  transactionSync<T>(callback: () => T): T {
    return callback();
  }
}

function setup() {
  const storage = new State();
  let clock = Date.parse("2026-10-13T00:00:00Z");
  let counter = 0;
  const id = () => `55555555-5555-4555-8555-${String(++counter).padStart(12, "0")}`;
  const base = new ConversationStateCore(storage, () => clock, id);
  base.create({ actor, conversationId, idempotencyKey: "create" });
  const turns = new ConversationTurnCore(storage, () => clock, id);
  return {
    storage,
    base,
    turns,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("verified conversation turn state", () => {
  it("pins Research vs Libraries to the same conversation idempotency key", () => {
    const { turns } = setup();
    const research = { ...ask(), sourceMode: "research" as const };
    const started = turns.begin(research);
    expect(started.turn.sourceMode).toBe("research");
    expect(() => turns.begin({ ...ask(), sourceMode: "libraries" as const })).toThrowError(
      ConversationStateError,
    );
    turns.fail({ actor, conversationId, idempotencyKey: "first", attemptId: started.attemptId! });
    const retry = turns.begin(research);
    expect(retry.turn.sourceMode).toBe("research");
    expect(retry.quotaEpoch).toBe(0);
  });

  it("returns only the five latest user messages, never Luna answers, from begin-turn", () => {
    const { turns } = setup();
    const questions = [
      "Explain aortic stenosis",
      "What about management?",
      "Explain FMF",
      "Why amyloidosis?",
      "What are complications?",
      "hi",
    ];
    for (let i = 0; i < questions.length; i++) {
      const start = turns.begin(ask(`k${i}`, questions[i]!, i));
      expect(start.recentUserMessages?.at(-1)).toBe(questions[i]);
      if (i < questions.length - 1) {
        turns.complete({
          actor,
          conversationId,
          idempotencyKey: `k${i}`,
          attemptId: start.attemptId,
          response: { ...answer, answer: "LUNA_PRIVATE_ANSWER_NOT_FOR_QWEN" },
        });
      }
      if (i === questions.length - 1) {
        expect(start.recentUserMessages).toEqual(questions.slice(-5));
        expect(JSON.stringify(start.recentUserMessages)).not.toContain("LUNA_PRIVATE");
      }
    }
  });

  it("retrieves only Qwen authored short replies among last five user messages; excludes Luna and older turns", () => {
    const { turns } = setup();
    const questions = [
      "Hi",
      "Let's study cardiology",
      "Explain anemia",
      "Aortic stenosis",
      "management?",
    ];
    for (let i = 0; i < questions.length; i++) {
      const start = turns.begin(ask("q" + i, questions[i]!, i));
      if (i === 4) {
        expect(start.recentUserMessages).toEqual(questions);
        expect(start.recentQwenReplies?.map((reply) => reply.answer)).toEqual([
          "Hello! What are we studying?",
          "Sure, which cardiology topic?",
        ]);
        expect(JSON.stringify(start.recentQwenReplies)).not.toContain("SECRET_LUNA");
      } else {
        turns.complete({
          actor,
          conversationId,
          idempotencyKey: "q" + i,
          attemptId: start.attemptId!,
          response:
            i < 2
              ? {
                  ...answer,
                  answer:
                    i === 0 ? "Hello! What are we studying?" : "Sure, which cardiology topic?",
                  citations: [],
                  groundingMode: "general" as const,
                  responder: "qwen" as const,
                }
              : { ...answer, answer: "SECRET_LUNA_ANSWER_NOT_FOR_ROUTER" },
        });
      }
    }
  });

  it("persists Related Pics with a verified answer and restores them unchanged", () => {
    const { turns } = setup();
    const start = turns.begin(ask());
    const saved = {
      ...answer,
      relatedPics: [
        {
          src: "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/valve.webp",
          alt: "Aortic valve",
          caption: "Stenotic aortic valve",
          sourceName: "Medical gallery",
        },
      ],
    };
    const completed = turns.complete({
      actor,
      conversationId,
      idempotencyKey: "first",
      attemptId: start.attemptId,
      response: saved,
    });
    expect(completed.response).toMatchObject({ relatedPics: saved.relatedPics });
    expect(turns.begin(ask()).turn.response).toMatchObject({ relatedPics: saved.relatedPics });
    expect(turns.list({ actor, conversationId }).turns[0]?.response).toMatchObject({
      relatedPics: saved.relatedPics,
    });
  });

  it("atomically starts, completes and replays the same verified response", () => {
    const { turns, base } = setup();
    const start = turns.begin(ask());
    expect(start).toMatchObject({ state: "started", turn: { sequence: 0, status: "pending" } });
    expect(() => turns.begin(ask())).toThrowError(ConversationStateError);
    expect(() =>
      base.append({
        actor,
        conversationId,
        idempotencyKey: "different",
        expectedSequence: 1,
        text: "Cannot bypass pending turn",
      }),
    ).toThrowError(ConversationStateError);
    const persisted = turns.complete({
      actor,
      conversationId,
      idempotencyKey: "first",
      attemptId: start.attemptId,
      response: answer,
    });
    expect(persisted.response).toEqual(answer);
    const replay = turns.begin(ask());
    expect(replay.state).toBe("completed");
    expect(replay.turn.response).toEqual(answer);
    expect(base.read({ actor, conversationId }).nextSequence).toBe(1);
    expect(turns.list({ actor, conversationId }).turns).toHaveLength(1);
  });

  it("rejects conflicting payload, cross-user access and forged completion attempts", () => {
    const { turns } = setup();
    const start = turns.begin(ask());
    expect(() => turns.begin(ask("first", "Changed"))).toThrowError(ConversationStateError);
    expect(() =>
      turns.list({ actor: { ...actor, externalUserId: "other" }, conversationId }),
    ).toThrowError(ConversationStateError);
    expect(() =>
      turns.complete({
        actor,
        conversationId,
        idempotencyKey: "first",
        attemptId: "66666666-6666-4666-8666-666666666666",
        response: answer,
      }),
    ).toThrowError(ConversationStateError);
    expect(() =>
      turns.complete({
        actor: { ...actor, externalUserId: "other" },
        conversationId,
        idempotencyKey: "first",
        attemptId: start.attemptId,
        response: answer,
      }),
    ).toThrowError(ConversationStateError);
  });

  it("supports explicit failure retry without a second user message and fences stale attempts", () => {
    const { turns, base } = setup();
    const first = turns.begin(ask());
    turns.fail({ actor, conversationId, idempotencyKey: "first", attemptId: first.attemptId });
    const retry = turns.begin(ask());
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect(retry.quotaEpoch).toBe(0);
    expect(base.read({ actor, conversationId }).nextSequence).toBe(1);
    expect(() =>
      turns.complete({
        actor,
        conversationId,
        idempotencyKey: "first",
        attemptId: first.attemptId,
        response: answer,
      }),
    ).toThrowError(ConversationStateError);
    turns.complete({
      actor,
      conversationId,
      idempotencyKey: "first",
      attemptId: retry.attemptId,
      response: answer,
    });
  });

  it("reclaims timed out leases and keeps identical context on retry", () => {
    const { turns, advance } = setup();
    const start = turns.begin(ask());
    advance(180_001);
    const again = turns.begin(ask());
    expect(again.attemptId).not.toBe(start.attemptId);
    expect(again.context).toBe(start.context);
  });

  it("derives bounded follow-up context exclusively from completed verified turns", () => {
    const { turns } = setup();
    const a = turns.begin(ask("first"));
    turns.complete({
      actor,
      conversationId,
      idempotencyKey: "first",
      attemptId: a.attemptId,
      response: answer,
    });
    const b = turns.begin(ask("second", "What about renal effects?", 1));
    expect(b.context).toContain("Verified A: Sodium ranges");
    expect(b.context.length).toBeLessThanOrEqual(1600);
    expect(() => turns.begin(ask("another", "Concurrent question?", 2))).toThrowError(
      ConversationStateError,
    );
    turns.fail({ actor, conversationId, idempotencyKey: "second", attemptId: b.attemptId });
    expect(turns.list({ actor, conversationId }).turns.map((t) => t.status)).toEqual([
      "completed",
      "retryable",
    ]);
  });

  it("preserves state across DO reconstruction and erases verified responses on delete", () => {
    const { turns, base, storage } = setup();
    const a = turns.begin(ask());
    turns.complete({
      actor,
      conversationId,
      idempotencyKey: "first",
      attemptId: a.attemptId,
      response: answer,
    });
    const reloaded = new ConversationTurnCore(storage);
    expect(reloaded.begin(ask()).turn.response?.messageId).toBe(answer.messageId);
    base.delete({ actor, conversationId });
    expect(() => reloaded.list({ actor, conversationId })).toThrowError(ConversationStateError);
    expect(storage.turns).toHaveLength(0);
  });
});
