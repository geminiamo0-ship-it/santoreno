import { describe, expect, it } from "vitest";

import {
  SantoConversationClient,
  SantoWidgetApiError,
  type WidgetConversationStore,
} from "./conversation-client";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ANSWER = {
  requestId: "22222222-2222-4222-8222-222222222222",
  messageId: "33333333-3333-4333-8333-333333333333",
  answer: "Grounded clinical explanation.",
  citations: [{ sourceId: "mrcp:chunk-1", title: "Verified reference", page: 2 }],
  usage: { unitsCharged: 1, remaining: 9 },
};
const READ = {
  conversationId: CONVERSATION,
  title: null,
  createdAt: "2026-10-13T00:00:00Z",
  nextSequence: 1,
  messages: [],
  totalMessages: 1,
};

function harness(onRequest: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const values = new Map<string, string>();
  const store: WidgetConversationStore = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, init: init ?? {} });
    return onRequest(path, init ?? {});
  }) as typeof fetch;
  return {
    requests,
    values,
    store,
    options: {
      apiBaseUrl: "/santo",
      sessionProvider: async () => "user-session-token",
      fetchImpl,
      store,
      storeKey: "tenant:student",
    },
  };
}

describe("Santo widget conversation transport", () => {
  it("preserves same request ID after failed AI call without duplicate charging", async () => {
    let asks = 0;
    const seenKeys: string[] = [];
    const h = harness((path, init) => {
      if (path.endsWith("/v1/conversations")) {
        const request = JSON.parse(String(init.body)) as { conversationId: string };
        return Response.json({
          conversationId: request.conversationId,
          title: null,
          createdAt: READ.createdAt,
          nextSequence: 0,
        }, { status: 201 });
      }
      if (path.endsWith("/ask")) {
        const request = JSON.parse(String(init.body)) as { idempotencyKey: string };
        seenKeys.push(request.idempotencyKey);
        asks += 1;
        return asks === 1
          ? Response.json({ error: "MODEL_TIMEOUT" }, { status: 503 })
          : Response.json(ANSWER);
      }
      if (path.endsWith("/turns")) return Response.json({ turns: [] });
      if (path.includes("/v1/conversations/")) return Response.json(READ);
      throw Error("Unexpected transport path " + path);
    });
    const client = new SantoConversationClient(h.options);
    await expect(client.ask("What is the sodium range?", "mrcp")).rejects.toMatchObject({
      code: "MODEL_TIMEOUT",
      status: 503,
    });
    const retry = client.pending;
    expect(retry).toMatchObject({
      expectedSequence: 0,
      text: "What is the sodium range?",
      libraryId: "mrcp",
    });
    expect(JSON.stringify([...h.values.values()])).not.toContain("user-session-token");
    expect(await client.retryPending()).toEqual(ANSWER);
    expect(client.pending).toBeNull();
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);
    expect(new Set(seenKeys).size).toBe(1);
    expect(h.requests.every((req) =>
      (req.init.headers as Record<string, string>).Authorization === "Bearer user-session-token",
    )).toBe(true);
  });

  it("reconnects using persisted owner-scoped ID and reads verified turns", async () => {
    const h = harness((path) => {
      if (path.endsWith("/turns")) return Response.json({
        turns: [{
          messageId: "44444444-4444-4444-8444-444444444444",
          sequence: 0,
          question: "What is sodium?",
          libraryId: "mrcp",
          status: "completed",
          response: ANSWER,
        }],
      });
      return Response.json(READ);
    });
    h.store.setItem("santo:conversation:tenant:student", JSON.stringify({
      conversationId: CONVERSATION,
      createKey: "55555555-5555-4555-8555-555555555555",
      pending: null,
    }));
    const client = new SantoConversationClient(h.options);
    const turns = await client.connect();
    expect(client.conversationId).toBe(CONVERSATION);
    expect(client.nextSequence).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.response?.answer).toBe(ANSWER.answer);
    expect(h.requests.map((x) => x.path)).toEqual([
      `/santo/v1/conversations/${CONVERSATION}`,
      `/santo/v1/conversations/${CONVERSATION}/turns`,
    ]);
  });

  it("rejects stale/forged persisted state rather than trusting unvalidated identities", async () => {
    const h = harness(() => { throw Error("not called"); });
    h.store.setItem("santo:conversation:tenant:student", JSON.stringify({
      conversationId: "../other-tenant",
      createKey: "fake",
      pending: null,
    }));
    const client = new SantoConversationClient(h.options);
    expect(await client.connect()).toEqual([]);
    expect(client.conversationId).toBeNull();
    expect(h.requests).toHaveLength(0);
  });

  it("refuses to change the prompt/library for a pending charged-or-uncertain turn", async () => {
    const h = harness((path, init) => {
      if (path.endsWith("/v1/conversations")) {
        const id = (JSON.parse(String(init.body)) as { conversationId: string }).conversationId;
        return Response.json({ ...READ, conversationId: id, nextSequence: 0 }, { status: 201 });
      }
      return Response.json({ error: "QUOTA_FINALIZE_FAILED" }, { status: 503 });
    });
    const client = new SantoConversationClient(h.options);
    await expect(client.ask("Original question", null)).rejects.toBeInstanceOf(SantoWidgetApiError);
    await expect(client.ask("Changed question", null)).rejects.toMatchObject({
      status: 409, code: "PENDING_TURN_REQUIRES_RETRY",
    });
  });

  it("fails closed for non-image media and does not blindly render image URLs", async () => {
    const h = harness(() => new Response("<svg />", {
      status: 200, headers: { "content-type": "text/html" },
    }));
    const client = new SantoConversationClient(h.options);
    await expect(client.sourceImage(ANSWER.messageId, "mrcp:chunk-1", "image-1"))
      .rejects.toMatchObject({ code: "WIDGET_INVALID_IMAGE" });
  });
});
