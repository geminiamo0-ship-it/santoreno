import type { Tenant } from "@santo/contracts";
import { describe, expect, it } from "vitest";
import type { SantoBindings, R2BucketLike } from "../runtime/bindings";
import type { ExternalUserRepository } from "../session/repository";
import { SantoSessionTokenService } from "../session/token";
import type { TenantRepository } from "../tenancy/repository";
import { LibraryReaderService } from "./reader";
import { createLibraryReaderHandler } from "./handler";

const tenantId = "11111111-1111-4111-8111-111111111111";
const key = "test-signing-key-that-is-longer-than-thirty-two-characters";
const tenant: Tenant = {
  id: tenantId,
  slug: "pilot",
  name: "Pilot",
  workosOrgId: "org_pilot",
  status: "active",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};
const tenants: TenantRepository = {
  createTenantWithOwner: async () => tenant,
  findTenantById: async () => tenant,
  findTenantByWorkOSOrgId: async () => tenant,
  findMembership: async () => null,
  updateTenantName: async () => tenant,
};
const users: ExternalUserRepository = {
  upsertExternalUser: async () => {
    throw new Error("not used");
  },
  findByTenantAndExternalId: async (t, u) => ({
    id: "33333333-3333-4333-8333-333333333333",
    tenantId: t,
    externalUserId: u,
    email: null,
    displayName: null,
    status: "active" as const,
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  }),
};
const bucket: R2BucketLike = {
  get: async () => null,
  put: async () => undefined,
  delete: async () => {},
};
const handler = createLibraryReaderHandler({
  tenants: () => tenants,
  users: () => users,
  reader: () => new LibraryReaderService(bucket),
});
describe("library reader session and rollout authorization", () => {
  const enabled: SantoBindings = {
    SANTO_ENV: "staging",
    SANTO_LIBRARY_READER_V1: "true",
    SANTO_SESSION_SIGNING_KEY: key,
  };
  it("rejects all unauthenticated browser/catalog/source requests", async () => {
    for (const path of [
      "/v1/libraries",
      "/v1/libraries/passmedicine/articles",
      "/v1/libraries/passmedicine/articles/passmed-5683",
      "/v1/sources/article",
    ]) {
      const response = await handler(
        new Request("https://santo.test" + path, {
          method: path.endsWith("/article") ? "POST" : "GET",
          body: path.endsWith("/article") ? JSON.stringify({}) : undefined,
        }),
        enabled,
      );
      expect(response.status).toBe(401);
    }
  });
  it("production activation still requires explicit flag and a signed user session", async () => {
    const path = new Request("https://santo.test/v1/libraries");
    const production = { ...enabled, SANTO_ENV: "production" as const };
    expect((await handler(path, production)).status).toBe(401);
    expect((await handler(path, { ...production, SANTO_LIBRARY_READER_V1: "false" })).status).toBe(
      404,
    );
    expect((await handler(path, { ...production, SANTO_LIBRARY_READER_V1: undefined })).status).toBe(
      404,
    );
    expect((await handler(path, { ...enabled, SANTO_ENV: "local" })).status).toBe(404);
  });
  it("enforces method, query and strict article IDs", async () => {
    const token = (
      await new SantoSessionTokenService(enabled).issue({
        tenantId,
        externalUserId: "student",
      })
    ).token;
    const request = (path: string, method = "GET") =>
      handler(
        new Request("https://santo.test" + path, {
          method,
          headers: { Authorization: "Bearer " + token },
        }),
        enabled,
      );
    expect((await request("/v1/libraries", "DELETE")).status).toBe(405);
    expect((await request("/v1/libraries/passmedicine/articles?cursor=10000")).status).toBe(400);
    expect((await request("/v1/libraries/passmedicine/articles/..%2fsecret")).status).toBe(400);
  });
});
