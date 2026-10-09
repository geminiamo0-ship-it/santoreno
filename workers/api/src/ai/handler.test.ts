import type {
  QuotaConfigureRequest,
  QuotaFinalizeRequest,
  QuotaOperationResponse,
  QuotaReadRequest,
  QuotaReleaseRequest,
  QuotaReserveRequest,
  QuotaSnapshot,
  Tenant,
} from "@santo/contracts";
import { GroundedAiStreamEventSchema } from "@santo/contracts/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaService } from "../quota/types";
import type { SantoBindings } from "../runtime/bindings";
import type {
  ExternalUserRecord,
  ExternalUserRepository,
  UpsertExternalUserInput,
} from "../session/repository";
import { SantoSessionTokenService } from "../session/token";
import type { TenantMembership, TenantRepository } from "../tenancy/repository";
import { createGroundedAiHandler } from "./handler";
import type { AiTelemetryEvent, AiTelemetryPort, ModelPort, RetrievalPort } from "./types";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "58392";
const SIGNING_KEY = "test-signing-key-that-is-longer-than-thirty-two-characters";
const SOURCE_ID = "medical:chunk-1";

const tenant: Tenant = {
  id: TENANT_ID,
  slug: "medpark",
  name: "MedPark",
  status: "active",
  workosOrgId: "org_test",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const user: ExternalUserRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  tenantId: TENANT_ID,
  externalUserId: USER_ID,
  email: null,
  displayName: null,
  status: "active",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

function snapshot(used: number, reserved: number): QuotaSnapshot {
  return {
    tenantId: TENANT_ID,
    externalUserId: USER_ID,
    cycleStartAt: "2026-10-01T00:00:00.000Z",
    cycleEndAt: "2026-11-01T00:00:00.000Z",
    expiresAt: null,
    tenantStatus: "active",
    userStatus: "active",
    tenant: { limit: 10, used, reserved, remaining: Math.max(0, 10 - used - reserved) },
    user: { limit: 10, used, reserved, remaining: Math.max(0, 10 - used - reserved) },
  };
}

class FakeQuotaService implements QuotaService {
  reserveCalls = 0;
  finalizeCalls = 0;
  releaseCalls = 0;
  used = 0;
  exhausted = false;
  private readonly finalized = new Set<string>();
  private readonly reserved = new Set<string>();

  configure(_request: QuotaConfigureRequest): Promise<QuotaSnapshot> {
    return Promise.resolve(snapshot(this.used, this.reserved.size));
  }

  read(_request: QuotaReadRequest): Promise<QuotaSnapshot> {
    return Promise.resolve(snapshot(this.used, this.reserved.size));
  }

  reserve(request: QuotaReserveRequest): Promise<QuotaOperationResponse> {
    this.reserveCalls += 1;
    if (this.exhausted) {
      return Promise.resolve({
        allowed: false,
        reservationStatus: "denied",
        denialReason: "USER_EXHAUSTED",
        snapshot: snapshot(this.used, this.reserved.size),
      });
    }
    if (this.finalized.has(request.idempotencyKey)) {
      return Promise.resolve({
        allowed: true,
        reservationStatus: "finalized",
        denialReason: null,
        snapshot: snapshot(this.used, this.reserved.size),
      });
    }
    this.reserved.add(request.idempotencyKey);
    return Promise.resolve({
      allowed: true,
      reservationStatus: "reserved",
      denialReason: null,
      snapshot: snapshot(this.used, this.reserved.size),
    });
  }

  finalize(request: QuotaFinalizeRequest): Promise<QuotaOperationResponse> {
    this.finalizeCalls += 1;
    if (!this.finalized.has(request.idempotencyKey)) {
      this.finalized.add(request.idempotencyKey);
      this.reserved.delete(request.idempotencyKey);
      this.used += 1;
    }
    return Promise.resolve({
      allowed: true,
      reservationStatus: "finalized",
      denialReason: null,
      snapshot: snapshot(this.used, this.reserved.size),
    });
  }

  release(request: QuotaReleaseRequest): Promise<QuotaOperationResponse> {
    this.releaseCalls += 1;
    this.reserved.delete(request.idempotencyKey);
    return Promise.resolve({
      allowed: false,
      reservationStatus: "released",
      denialReason: "RESERVATION_RELEASED",
      snapshot: snapshot(this.used, this.reserved.size),
    });
  }
}

function tenantRepository(): TenantRepository {
  return {
    createTenantWithOwner: async () => tenant,
    findTenantById: async (tenantId) => (tenantId === TENANT_ID ? tenant : null),
    findTenantByWorkOSOrgId: async () => tenant,
    findMembership: async (): Promise<TenantMembership | null> => null,
    updateTenantName: async () => tenant,
  };
}

function externalUserRepository(): ExternalUserRepository {
  return {
    upsertExternalUser: async (_input: UpsertExternalUserInput) => user,
    findByTenantAndExternalId: async (tenantId, externalUserId) =>
      tenantId === TENANT_ID && externalUserId === USER_ID ? user : null,
  };
}

function request(
  token: string,
  idempotencyKey = "query-1",
  query = "What is the normal serum sodium range?",
  libraryId?: string,
): Request {
  return new Request("https://santo.test/v1/ai/query", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      idempotency_key: idempotencyKey,
      ...(libraryId ? { library_id: libraryId } : {}),
    }),
  });
}

describe("grounded AI handler", () => {
  let env: SantoBindings;
  let quota: FakeQuotaService;
  let retrieval: RetrievalPort;
  let model: ModelPort;
  let telemetryEvents: AiTelemetryEvent[];
  let telemetry: AiTelemetryPort;
  let token: string;
  let stageTimeouts: { retrievalMs: number; modelMs: number };

  beforeEach(async () => {
    env = {
      SANTO_ENV: "local",
      SANTO_SESSION_SIGNING_KEY: SIGNING_KEY,
      SANTO_SESSION_TTL_SECONDS: "900",
    };
    quota = new FakeQuotaService();
    stageTimeouts = { retrievalMs: 15000, modelMs: 90000 };
    retrieval = {
      retrieve: vi.fn(async () => [
        {
          sourceId: SOURCE_ID,
          libraryId: "medical",
          instanceId: "medical",
          itemKey: "electrolytes.md",
          title: "Electrolytes",
          page: 12,
          section: "Sodium disorders",
          text: "Normal serum sodium is generally 135 to 145 mmol/L.",
          score: 0.91,
        },
      ]),
    };
    model = {
      generate: vi.fn(async () => ({
        answer: "The cited source gives a normal serum sodium range of 135–145 mmol/L.",
        citationIds: [SOURCE_ID],
      })),
    };
    telemetryEvents = [];
    telemetry = {
      record: (event) => telemetryEvents.push(event),
    };
    token = (
      await new SantoSessionTokenService(env).issue({
        tenantId: TENANT_ID,
        externalUserId: USER_ID,
      })
    ).token;
  });

  function handler() {
    return createGroundedAiHandler({
      tenantRepositoryFactory: () => tenantRepository(),
      externalUserRepositoryFactory: () => externalUserRepository(),
      quotaServiceFactory: () => quota,
      retrievalFactory: () => retrieval,
      modelFactory: () => model,
      telemetryFactory: () => telemetry,
      stageTimeouts,
    });
  }

  it("runs session -> quota -> retrieval -> model -> verified citation -> finalize", async () => {
    const response = await handler()(request(token), env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      answer: "The cited source gives a normal serum sodium range of 135–145 mmol/L.",
      citations: [{ sourceId: SOURCE_ID, title: "Electrolytes", page: 12 }],
      usage: { unitsCharged: 1, remaining: 9 },
    });
    expect(retrieval.retrieve).toHaveBeenCalledWith({
      query: "What is the normal serum sodium range?",
      libraryId: null,
    });
    expect(quota.reserveCalls).toBe(1);
    expect(quota.finalizeCalls).toBe(1);
    expect(quota.releaseCalls).toBe(0);
    expect(telemetryEvents.at(-1)?.status).toBe("success");
  });

  it("passes a validated library filter into retrieval", async () => {
    const response = await handler()(request(token, "library-key", "sodium", "mrcp"), env);

    expect(response.status).toBe(200);
    expect(retrieval.retrieve).toHaveBeenCalledWith({ query: "sodium", libraryId: "mrcp" });
  });

  it("rejects an invalid session before quota, search, or model work", async () => {
    const response = await handler()(request("invalid-token"), env);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_SESSION_TOKEN" });
    expect(quota.reserveCalls).toBe(0);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("denies exhausted quota before search or model work", async () => {
    quota.exhausted = true;
    const response = await handler()(request(token), env);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "USER_QUOTA_EXHAUSTED" });
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("releases the reservation when no evidence is retrieved", async () => {
    retrieval.retrieve = vi.fn(async () => []);
    const response = await handler()(request(token), env);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INSUFFICIENT_EVIDENCE" });
    expect(quota.releaseCalls).toBe(1);
    expect(quota.used).toBe(0);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("rejects invented citations and releases the reservation", async () => {
    model.generate = vi.fn(async () => ({
      answer: "Unsupported answer",
      citationIds: ["medical:not-retrieved"],
    }));
    const response = await handler()(request(token), env);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "CITATION_INVALID" });
    expect(quota.releaseCalls).toBe(1);
    expect(quota.used).toBe(0);
  });

  it("does not double-charge when the same idempotency key is retried", async () => {
    const first = await handler()(request(token, "same-key"), env);
    const second = await handler()(request(token, "same-key"), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(quota.used).toBe(1);
    expect(quota.reserveCalls).toBe(2);
    expect(quota.finalizeCalls).toBe(2);
  });

  it("does charge distinct queries even when a client reuses the same key", async () => {
    const first = await handler()(request(token, "reused-key", "sodium"), env);
    const second = await handler()(request(token, "reused-key", "potassium"), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(quota.used).toBe(2);
  });

  it("does charge distinct library scopes when a client reuses the same key and query", async () => {
    const first = await handler()(request(token, "scope-key", "sodium", "mrcp"), env);
    const second = await handler()(request(token, "scope-key", "sodium", "usmle"), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(quota.used).toBe(2);
  });

  it("streams validated deltas and a final structured result only after charging", async () => {
    const req = request(token, "stream-key");
    req.headers.set("accept", "application/json, text/event-stream; charset=utf-8");
    const result = await handler()(req, env);

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(quota.used).toBe(1);
    expect(quota.finalizeCalls).toBe(1);
    const events = (await result.text())
      .trim()
      .split("\n\n")
      .map((block) => {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) throw new Error("Missing SSE data");
        return GroundedAiStreamEventSchema.parse(JSON.parse(data.slice(6)));
      });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: {
        citations: [{ sourceId: SOURCE_ID }],
        usage: { unitsCharged: 1, remaining: 9 },
      },
    });
    expect(events.slice(0, -1).every((event) => event.type === "delta")).toBe(true);
    expect(
      events.map((event) => (event.type === "delta" ? event.text : "")).join(""),
    ).toBe("The cited source gives a normal serum sodium range of 135–145 mmol/L.");
  });

  it("never streams an answer if the model invents citations", async () => {
    model.generate = vi.fn(async () => ({
      answer: "Invented medical answer",
      citationIds: ["not-retrieved"],
    }));
    const req = request(token);
    req.headers.set("accept", "text/event-stream");
    const result = await handler()(req, env);

    expect(result.status).toBe(502);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(await result.json()).toEqual({ error: "CITATION_INVALID" });
    expect(quota.used).toBe(0);
    expect(quota.releaseCalls).toBe(1);
  });

  it("does not stream before quota finalization succeeds", async () => {
    quota.finalize = vi.fn(async () => {
      throw new Error("temporary quota failure");
    });
    const req = request(token);
    req.headers.set("accept", "text/event-stream");
    const result = await handler()(req, env);

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "QUOTA_FINALIZE_FAILED" });
    expect(result.headers.get("content-type")).toContain("application/json");
  });

  it("releases quota after a model timeout rather than sending partial SSE", async () => {
    stageTimeouts = { retrievalMs: 200, modelMs: 5 };
    model.generate = vi.fn(() => new Promise(() => {}));
    const req = request(token);
    req.headers.set("accept", "text/event-stream");
    const result = await handler()(req, env);

    expect(result.status).toBe(504);
    expect(await result.json()).toEqual({ error: "MODEL_TIMEOUT" });
    expect(quota.used).toBe(0);
    expect(quota.releaseCalls).toBe(1);
  });

  it("releases quota after a retrieval timeout without invoking the model", async () => {
    stageTimeouts = { retrievalMs: 5, modelMs: 200 };
    retrieval.retrieve = vi.fn(() => new Promise(() => {}));
    const result = await handler()(request(token), env);

    expect(result.status).toBe(504);
    expect(await result.json()).toEqual({ error: "SEARCH_TIMEOUT" });
    expect(model.generate).not.toHaveBeenCalled();
    expect(quota.used).toBe(0);
    expect(quota.releaseCalls).toBe(1);
  });

  it("cancels a pending model call and releases the reservation", async () => {
    const controller = new AbortController();
    let modelStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    model.generate = vi.fn(() => {
      modelStarted();
      return new Promise(() => {});
    });
    const req = new Request(request(token), { signal: controller.signal });
    const pending = handler()(req, env);
    await started;
    controller.abort();
    const result = await pending;

    expect(result.status).toBe(499);
    expect(await result.json()).toEqual({ error: "REQUEST_CANCELLED" });
    expect(quota.releaseCalls).toBe(1);
    expect(quota.used).toBe(0);
  });

  it("streams idempotent retries without charging the same request twice", async () => {
    const firstReq = request(token, "stream-idempotent");
    firstReq.headers.set("accept", "text/event-stream");
    const secondReq = request(token, "stream-idempotent");
    secondReq.headers.set("accept", "text/event-stream");

    const first = await handler()(firstReq, env);
    const second = await handler()(secondReq, env);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(quota.used).toBe(1);
    expect(quota.reserveCalls).toBe(2);
    expect(quota.finalizeCalls).toBe(2);
    expect(await first.text()).toContain("event: complete");
    expect(await second.text()).toContain("event: complete");
  });
});
