import type { Tenant } from "@santo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableObjectNamespaceLike, SantoBindings } from "../runtime/bindings";
import type { ExternalUserRepository, ExternalUserRecord } from "../session/repository";
import { SantoSessionTokenService } from "../session/token";
import type { TenantRepository } from "../tenancy/repository";
import { createConversationHandler } from "./handler";
import { ConversationService } from "./service";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const SIGNING_KEY = "session-test-secret-that-is-more-than-thirty-two-chars";
const actor = { tenantId: TENANT_ID, externalUserId: "student-1" };
const tenant: Tenant = {
  id: TENANT_ID,
  slug: "generic-test-tenant",
  name: "Generic",
  workosOrgId: "org_test",
  status: "active",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};

function tenantRepo(suspended: boolean): TenantRepository {
  return {
    createTenantWithOwner: async () => tenant,
    findTenantById: async () => ({ ...tenant, status: suspended ? "suspended" : "active" }),
    findTenantByWorkOSOrgId: async () => tenant,
    findMembership: async () => null,
    updateTenantName: async () => tenant,
  };
}

function userRepo(): ExternalUserRepository {
  const record: ExternalUserRecord = {
    id: "33333333-3333-4333-8333-333333333333",
    ...actor,
    email: null,
    displayName: null,
    status: "active",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  };
  return {
    upsertExternalUser: async () => record,
    findByTenantAndExternalId: async (_tenantId, externalUserId) =>
      externalUserId === actor.externalUserId ? record : null,
  };
}

describe("authenticated conversation handler", () => {
  let env: SantoBindings;
  let token: string;
  let forwarded: unknown[];
  let calls: ReturnType<typeof vi.fn>;
  let suspended: boolean;

  beforeEach(async () => {
    env = { SANTO_SESSION_SIGNING_KEY: SIGNING_KEY };
    token = (await new SantoSessionTokenService(env).issue(actor)).token;
    forwarded = [];
    calls = vi.fn(async (input: Request | string) => {
      const req = typeof input === "string" ? new Request(input) : input;
      const body: unknown = await req.json();
      forwarded.push(body);
      const operation = new URL(req.url).pathname;
      if (operation === "/create") {
        return Response.json({
          conversationId: CONVERSATION_ID,
          title: null,
          createdAt: "2026-10-13T00:00:00.000Z",
          nextSequence: 0,
        });
      }
      if (operation === "/read") {
        return Response.json({
          conversationId: CONVERSATION_ID,
          title: null,
          createdAt: "2026-10-13T00:00:00.000Z",
          nextSequence: 0,
          totalMessages: 0,
          messages: [],
        });
      }
      if (operation === "/append") {
        return Response.json({
          message: {
            messageId: "44444444-4444-4444-8444-444444444444",
            sequence: 0,
            role: "user",
            text: "What is hyponatremia?",
            createdAt: "2026-10-13T00:00:00.000Z",
          },
          nextSequence: 1,
          replayed: false,
        });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    suspended = false;
  });

  function handler() {
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({ fetch: calls }),
    };
    return createConversationHandler({
      tenantRepositoryFactory: () => tenantRepo(suspended),
      externalUserRepositoryFactory: () => userRepo(),
      serviceFactory: () => new ConversationService(namespace),
    });
  }

  function request(path: string, method: string, payload?: unknown, accessToken = token) {
    return new Request(`https://santo.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
  }

  it("forwards only authenticated actor information on create, read and append", async () => {
    const createResponse = await handler()(
      request("/v1/conversations", "POST", {
        conversationId: CONVERSATION_ID,
        idempotencyKey: "create-key",
      }),
      env,
    );
    expect(createResponse.status).toBe(201);
    expect(createResponse.headers.get("cache-control")).toBe("no-store");

    const read = await handler()(
      request(`/v1/conversations/${CONVERSATION_ID}`, "GET"),
      env,
    );
    expect(read.status).toBe(200);
    const append = await handler()(
      request(`/v1/conversations/${CONVERSATION_ID}/messages`, "POST", {
        idempotencyKey: "append-key",
        expectedSequence: 0,
        text: "What is hyponatremia?",
      }),
      env,
    );
    expect(append.status).toBe(200);
    expect(forwarded).toHaveLength(3);
    for (const payload of forwarded) {
      expect(payload).toMatchObject({ actor });
    }
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it("rejects an invalid session before any Durable Object operation", async () => {
    const response = await handler()(
      request("/v1/conversations", "POST", {
        conversationId: CONVERSATION_ID,
        idempotencyKey: "key",
      }, "tampered"),
      env,
    );
    expect(response.status).toBe(401);
    expect(calls).not.toHaveBeenCalled();
  });

  it("blocks a suspended tenant before reading conversations", async () => {
    suspended = true;
    const response = await handler()(
      request(`/v1/conversations/${CONVERSATION_ID}`, "GET"),
      env,
    );
    expect(response.status).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });

  it("rejects user-supplied tenant or actor fields before writing", async () => {
    const response = await handler()(
      request("/v1/conversations", "POST", {
        conversationId: CONVERSATION_ID,
        idempotencyKey: "key",
        actor: { tenantId: TENANT_ID, externalUserId: "attacker" },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });

  it("rejects invalid resource identifiers and unsupported operations", async () => {
    const response = await handler()(request("/v1/conversations/not-a-uuid", "GET"), env);
    expect(response.status).toBe(404);
    expect(calls).not.toHaveBeenCalled();
  });
});
