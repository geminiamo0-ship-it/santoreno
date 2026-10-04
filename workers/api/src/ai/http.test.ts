import type { GroundedAiResult } from "./types";
import { describe, expect, it, vi } from "vitest";

import type { SantoBindings } from "../runtime/bindings";
import { SessionTokenError } from "../session/token";
import { GroundedAiError } from "./service";
import { handleGroundedAiQuery } from "./http";

const session = {
  tenantId: "fca2b199-7e22-45cc-96ec-3b509e7f0d95",
  externalUserId: "58392",
  sessionId: "23bdd2c5-d1a1-4c79-9e9c-366545996f41",
  expiresAt: "2026-10-04T18:00:00.000Z",
};

const result: GroundedAiResult = {
  requestId: "32dc0f35-78aa-4ee8-a245-9abb8b827ee0",
  messageId: "46014ad1-f5bc-4cd2-8317-24a26b0f4d48",
  answer: "Grounded answer",
  citations: [
    {
      sourceId: "src_1",
      instanceId: "guidelines",
      title: "Guideline",
      page: 42,
      score: 0.9,
    },
  ],
  usage: { unitsCharged: 1, remaining: 9 },
};

function request(headers: Record<string, string> = {}, body: unknown = { question: "Question?" }) {
  return new Request("https://santo.test/v1/ai/query", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("handleGroundedAiQuery", () => {
  it("denies invalid sessions before parsing or calling the AI service", async () => {
    const query = vi.fn(async () => result);
    const response = await handleGroundedAiQuery(
      request({ "idempotency-key": "req-1" }),
      {},
      {
        async authenticateSession() {
          throw new SessionTokenError(401, "SESSION_TOKEN_INVALID", "invalid");
        },
        query,
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "SESSION_TOKEN_INVALID" });
    expect(query).not.toHaveBeenCalled();
  });

  it("requires a bounded idempotency key before the use case", async () => {
    const query = vi.fn(async () => result);
    const response = await handleGroundedAiQuery(
      request(),
      {},
      {
        authenticateSession: vi.fn(async () => session),
        query,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_IDEMPOTENCY_KEY" });
    expect(query).not.toHaveBeenCalled();
  });

  it("passes only authenticated session context plus validated input to the use case", async () => {
    const query = vi.fn(async () => result);
    const response = await handleGroundedAiQuery(
      request({ "idempotency-key": "req-123" }, { question: "  What does evidence show?  " }),
      {},
      {
        authenticateSession: vi.fn(async () => session),
        query,
      },
    );

    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      {
        session,
        question: "What does evidence show?",
        idempotencyKey: "req-123",
      },
      {},
    );
    expect(await response.json()).toEqual(result);
  });

  it("maps grounded AI errors to stable HTTP error codes", async () => {
    const response = await handleGroundedAiQuery(
      request({ "idempotency-key": "req-1" }),
      {},
      {
        authenticateSession: vi.fn(async () => session),
        async query() {
          throw new GroundedAiError(429, "USER_EXHAUSTED", "quota exhausted");
        },
      },
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "USER_EXHAUSTED" });
  });

  it("records only safe structured telemetry after authentication", async () => {
    const points: unknown[] = [];
    const env: SantoBindings = {
      USAGE_ANALYTICS: {
        writeDataPoint(point) {
          points.push(point);
        },
      },
    };

    await handleGroundedAiQuery(request({ "idempotency-key": "req-1" }), env, {
      authenticateSession: vi.fn(async () => session),
      query: vi.fn(async () => result),
    });

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      indexes: [session.tenantId],
      blobs: ["grounded_ai_query", "success", session.sessionId, ""],
    });
    expect(JSON.stringify(points[0])).not.toContain("Question?");
    expect(JSON.stringify(points[0])).not.toContain("58392");
  });
});
