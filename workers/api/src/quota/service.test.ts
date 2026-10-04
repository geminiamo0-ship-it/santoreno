import { describe, expect, it } from "vitest";

import type { DurableObjectNamespaceLike, DurableObjectStubLike } from "../runtime/bindings";
import { DurableObjectQuotaService, QuotaServiceError } from "./service";

const tenantId = "fca2b199-7e22-45cc-96ec-3b509e7f0d95";

function namespaceFor(handler: (request: Request) => Promise<Response>) {
  const names: string[] = [];
  const paths: string[] = [];
  const stub: DurableObjectStubLike = {
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      paths.push(new URL(request.url).pathname);
      return handler(request);
    },
  };
  const namespace: DurableObjectNamespaceLike = {
    idFromName(name) {
      names.push(name);
      return name;
    },
    get() {
      return stub;
    },
  };
  return { namespace, names, paths };
}

describe("DurableObjectQuotaService", () => {
  it("routes quota work to the Durable Object named by authenticated tenant id", async () => {
    const snapshot = {
      tenantId,
      externalUserId: "58392",
      cycleStartAt: "2026-10-01T00:00:00.000Z",
      cycleEndAt: "2026-11-01T00:00:00.000Z",
      expiresAt: null,
      tenantStatus: "active",
      userStatus: "active",
      tenant: { limit: 100, used: 0, reserved: 0, remaining: 100 },
      user: { limit: 10, used: 0, reserved: 0, remaining: 10 },
    };
    const { namespace, names, paths } = namespaceFor(async () => Response.json(snapshot));
    const service = new DurableObjectQuotaService(namespace);

    await service.read({ tenantId, externalUserId: "58392" });

    expect(names).toEqual([tenantId]);
    expect(paths).toEqual(["/state"]);
  });

  it("preserves stable Durable Object error codes", async () => {
    const { namespace } = namespaceFor(async () =>
      Response.json({ error: "TENANT_EXHAUSTED" }, { status: 409 }),
    );
    const service = new DurableObjectQuotaService(namespace);

    await expect(
      service.reserve({ tenantId, externalUserId: "58392", idempotencyKey: "req-1", units: 1 }),
    ).rejects.toMatchObject<Partial<QuotaServiceError>>({
      status: 409,
      code: "TENANT_EXHAUSTED",
    });
  });
});
