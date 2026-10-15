import { describe, expect, it, vi } from "vitest";

import { GroundedAiError } from "../ai/errors";
import type { SantoBindings } from "../runtime/bindings";
import { ConversationAskService } from "./ask-service";
import { ConversationService, ConversationServiceError } from "./service";

const conversationId = "11111111-1111-4111-8111-111111111111";
const actor = { tenantId: "22222222-2222-4222-8222-222222222222", externalUserId: "student" };
const response = {
  requestId: "33333333-3333-4333-8333-333333333333",
  messageId: "44444444-4444-4444-8444-444444444444",
  answer: "Answer supported by a verified source",
  citations: [{ sourceId: "medical:ref", title: "Verified", page: null }],
  usage: { unitsCharged: 1 as const, remaining: 3 },
};
const body = { idempotencyKey: "first", expectedSequence: 0, text: "Clinical question?" };

function harness() {
  let quotaEpoch = 0;
  let persisted: typeof response | null = null;
  const begin = vi.fn(async () => ({
    state: persisted ? ("completed" as const) : ("started" as const),
    attemptId: persisted ? null : "55555555-5555-4555-8555-555555555555",
    quotaEpoch,
    context: "Earlier verified assistant: standard",
    turn: {
      messageId: "66666666-6666-4666-8666-666666666666",
      sequence: 0,
      question: body.text,
      libraryId: null,
      status: persisted ? ("completed" as const) : ("pending" as const),
      response: persisted,
    },
  }));
  const complete = vi.fn(
    async (
      _a: typeof actor,
      _id: string,
      _key: string,
      _attempt: string,
      answer: typeof response,
    ) => {
      persisted = answer;
      return {
        messageId: "66666666-6666-4666-8666-666666666666",
        sequence: 0,
        question: body.text,
        libraryId: null,
        status: "completed" as const,
        response: answer,
      };
    },
  );
  const fail = vi.fn(
    async (_a: typeof actor, _id: string, _key: string, _attempt: string, rotate: boolean) => {
      if (rotate) quotaEpoch++;
    },
  );
  const client = {
    beginTurn: begin,
    completeTurn: complete,
    failTurn: fail,
  } as unknown as ConversationService;
  return { client, begin, complete, fail, getEpoch: () => quotaEpoch };
}

describe("grounded turn billing/verification coordinator", () => {
  const env: SantoBindings = {};
  const signal = new AbortController().signal;
  it("persists verified output before responding and replays without any new model call", async () => {
    const t = harness();
    const model = vi.fn(async () => response);
    const ask = new ConversationAskService(t.client, model);
    const first = await ask.ask(actor, conversationId, body, "Bearer signed", env, signal);
    expect(first).toEqual(response);
    expect(t.complete).toHaveBeenCalledTimes(1);
    const retry = await ask.ask(actor, conversationId, body, "Bearer signed", env, signal);
    expect(retry).toEqual(response);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("rotates a released billing reservation on definitive model failure", async () => {
    const t = harness();
    const keys: string[] = [];
    let attempt = 0;
    const model = vi.fn(
      async (
        _token: string,
        _env: SantoBindings,
        input: { query: string; idempotency_key: string; library_id?: string },
      ) => {
        keys.push(input.idempotency_key);
        if (++attempt === 1) throw new ConversationServiceError(502, "MODEL_FAILED");
        return response;
      },
    );
    const ask = new ConversationAskService(t.client, model);
    await expect(
      ask.ask(actor, conversationId, body, "Bearer signed", env, signal),
    ).rejects.toMatchObject({ code: "MODEL_FAILED" });
    expect(t.fail).toHaveBeenCalledWith(
      actor,
      conversationId,
      body.idempotencyKey,
      expect.any(String),
      true,
    );
    expect(t.getEpoch()).toBe(1);
    await ask.ask(actor, conversationId, body, "Bearer signed", env, signal);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("reuses the SAME quota key when finalization is uncertain instead of double charging", async () => {
    const t = harness();
    const keys: string[] = [];
    let attempt = 0;
    const ask = new ConversationAskService(t.client, async (_token, _env, input) => {
      keys.push(input.idempotency_key);
      if (++attempt === 1) throw new ConversationServiceError(503, "QUOTA_FINALIZE_FAILED");
      return response;
    });
    await expect(
      ask.ask(actor, conversationId, body, "Bearer signed", env, signal),
    ).rejects.toMatchObject({ code: "QUOTA_FINALIZE_FAILED" });
    expect(t.getEpoch()).toBe(0);
    await ask.ask(actor, conversationId, body, "Bearer signed", env, signal);
    expect(keys[0]).toEqual(keys[1]);
  });

  it("keeps the billing key after verified AI succeeds but durable persistence fails", async () => {
    const t = harness();
    let failCompletion = true;
    t.complete.mockImplementation(async (_a, _id, _key, _attempt, answer) => {
      if (failCompletion) {
        failCompletion = false;
        throw new ConversationServiceError(503, "CONVERSATION_UNAVAILABLE");
      }
      return {
        messageId: "66666666-6666-4666-8666-666666666666",
        sequence: 0,
        question: body.text,
        libraryId: null,
        status: "completed" as const,
        response: answer,
      };
    });
    const keys: string[] = [];
    const ask = new ConversationAskService(t.client, async (_token, _env, input) => {
      keys.push(input.idempotency_key);
      return response;
    });
    await expect(
      ask.ask(actor, conversationId, body, "Bearer signed", env, signal),
    ).rejects.toMatchObject({ code: "CONVERSATION_UNAVAILABLE" });
    expect(t.getEpoch()).toBe(0);
    await ask.ask(actor, conversationId, body, "Bearer signed", env, signal);
    expect(keys[0]).toEqual(keys[1]);
  });

  it("routes even greetings and clarifications through the model", async () => {
    for (const value of ["hi", "Management", "thanks"]) {
      const model = vi.fn(async () => response);
      const t = harness();
      const result = await new ConversationAskService(t.client, model).ask(
        actor,
        conversationId,
        { ...body, text: value },
        "Bearer signed",
        { SANTO_ENV: "staging" },
        signal,
      );
      expect(result).toEqual(response);
      expect(model).toHaveBeenCalledTimes(1);
    }
  });

  it("blocks cancellation before reserving a conversation turn or quota", async () => {
    const t = harness();
    const controller = new AbortController();
    controller.abort();
    const model = vi.fn(async () => response);
    await expect(
      new ConversationAskService(t.client, model).ask(
        actor,
        conversationId,
        body,
        "Bearer signed",
        env,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(GroundedAiError);
    expect(t.begin).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
});
