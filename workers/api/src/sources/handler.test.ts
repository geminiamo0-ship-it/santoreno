import type { Tenant } from "@santo/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import type { R2BucketLike, R2ObjectBodyLike, SantoBindings } from "../runtime/bindings";
import type { ExternalUserRecord, ExternalUserRepository } from "../session/repository";
import { SantoSessionTokenService } from "../session/token";
import type { TenantRepository } from "../tenancy/repository";
import { createTrustedSourceHandler } from "./handler";
import { R2VerifiedSourceStore } from "./store";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "instance-mrcp:chunk-1";
const SIGNING_KEY = "test-signing-key-that-is-longer-than-thirty-two-characters";
const source = {
  sourceId: SOURCE_ID,
  libraryId: "mrcp",
  instanceId: "instance-mrcp",
  itemKey: "electrolytes.md",
  title: "Electrolytes",
  page: 12,
  section: "Sodium disorders",
};
const manifestEntry = {
  sourceId: source.sourceId,
  libraryId: source.libraryId,
  instanceId: source.instanceId,
  itemKey: source.itemKey,
  assetId: "sodium-chart",
  objectKey: "source-media/mrcp/sodium-chart.png",
  contentType: "image/png" as const,
  altText: "Sodium chart",
  caption: null,
  width: 400,
  height: 200,
};
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

class FakeBucket implements R2BucketLike {
  readonly values = new Map<string, string | Uint8Array>();

  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown> {
    this.values.set(key, typeof value === "string" ? value : new Uint8Array(value));
    return Promise.resolve(undefined);
  }

  get(key: string): Promise<R2ObjectBodyLike | null> {
    const data = this.values.get(key);
    if (data === undefined) return Promise.resolve(null);
    return Promise.resolve({
      text: async () => (typeof data === "string" ? data : new TextDecoder().decode(data)),
      arrayBuffer: async () => {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        return bytes.slice().buffer;
      },
    });
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

async function manifestKey(): Promise<string> {
  const input = `${source.libraryId}\u0000${source.instanceId}\u0000${source.itemKey}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return (
    "source-manifests/v1/" +
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") +
    ".json"
  );
}

function repositoryTenant(): TenantRepository {
  const tenant: Tenant = {
    id: TENANT_ID,
    slug: "mrcp",
    name: "MRCP",
    workosOrgId: "org_mrcp",
    status: "active",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  };
  return {
    createTenantWithOwner: async () => tenant,
    findTenantById: async (id) => (id === TENANT_ID || id === OTHER_TENANT ? tenant : null),
    findTenantByWorkOSOrgId: async () => tenant,
    findMembership: async () => null,
    updateTenantName: async () => tenant,
  };
}

function repositoryUser(): ExternalUserRepository {
  const fake = (tenantId: string, externalUserId: string): ExternalUserRecord => ({
    id: "55555555-5555-4555-8555-555555555555",
    tenantId,
    externalUserId,
    email: null,
    displayName: null,
    status: "active",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  });
  return {
    upsertExternalUser: async () => fake(TENANT_ID, "student"),
    findByTenantAndExternalId: async (tenantId, externalUserId) => fake(tenantId, externalUserId),
  };
}

describe("authenticated source details and media", () => {
  let bucket: FakeBucket;
  let env: SantoBindings;
  let store: R2VerifiedSourceStore;
  let token: string;

  const handler = createTrustedSourceHandler({
    tenantRepositoryFactory: () => repositoryTenant(),
    externalUserRepositoryFactory: () => repositoryUser(),
    sourceStoreFactory: () => store,
  });

  const detail = (accessToken: string, body: unknown) =>
    handler(
      new Request("https://santo.test/v1/sources/detail", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );

  const image = (accessToken: string, assetId = manifestEntry.assetId) =>
    handler(
      new Request(`https://santo.test/v1/sources/${MESSAGE_ID}/${SOURCE_ID}/images/${assetId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      env,
    );

  beforeEach(async () => {
    bucket = new FakeBucket();
    env = { SANTO_SESSION_SIGNING_KEY: SIGNING_KEY };
    store = new R2VerifiedSourceStore(bucket);
    token = (
      await new SantoSessionTokenService(env).issue({
        tenantId: TENANT_ID,
        externalUserId: "student",
      })
    ).token;
    await store.save({ tenantId: TENANT_ID, externalUserId: "student", messageId: MESSAGE_ID }, [
      source,
    ]);
    bucket.values.set(await manifestKey(), JSON.stringify([manifestEntry]));
    bucket.values.set(manifestEntry.objectKey, png);
  });

  it("serves only trusted metadata and never exposes R2 keys or arbitrary URLs", async () => {
    const response = await detail(token, { messageId: MESSAGE_ID, sourceId: SOURCE_ID });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body).toEqual({
      source,
      images: [
        {
          assetId: manifestEntry.assetId,
          altText: manifestEntry.altText,
          caption: null,
          contentType: "image/png",
          width: 400,
          height: 200,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("source-media/");
  });

  it("requires a valid session before accessing source records", async () => {
    expect((await detail("invalid", { messageId: MESSAGE_ID, sourceId: SOURCE_ID })).status).toBe(
      401,
    );
    const response = await handler(
      new Request("https://santo.test/v1/sources/detail", {
        method: "POST",
        body: JSON.stringify({ messageId: MESSAGE_ID, sourceId: SOURCE_ID }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("enforces both tenant and external user isolation", async () => {
    for (const [tenantId, userId] of [
      [OTHER_TENANT, "student"],
      [TENANT_ID, "other"],
    ]) {
      const forgedToken = (
        await new SantoSessionTokenService(env).issue({
          tenantId: tenantId!,
          externalUserId: userId!,
        })
      ).token;
      expect(
        (await detail(forgedToken, { messageId: MESSAGE_ID, sourceId: SOURCE_ID })).status,
      ).toBe(404);
      expect((await image(forgedToken)).status).toBe(404);
    }
  });

  it("rejects uncited sources, unknown assets, and caller-supplied tenant ids", async () => {
    expect(
      (await detail(token, { messageId: MESSAGE_ID, sourceId: "instance-mrcp:forged" })).status,
    ).toBe(404);
    expect((await image(token, "forged-asset")).status).toBe(404);
    expect(
      (await detail(token, { messageId: MESSAGE_ID, sourceId: SOURCE_ID, tenantId: TENANT_ID }))
        .status,
    ).toBe(400);
  });

  it("delivers valid image bytes with safe headers and no public caching", async () => {
    const response = await image(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("rejects masquerading HTML bytes and missing mapped objects", async () => {
    bucket.values.set(manifestEntry.objectKey, "<script>alert(1)</script>");
    expect((await image(token)).status).toBe(502);
    bucket.values.delete(manifestEntry.objectKey);
    expect((await image(token)).status).toBe(404);
  });

  it("fails closed on forged or malformed manifest records", async () => {
    bucket.values.set(
      await manifestKey(),
      JSON.stringify([{ ...manifestEntry, libraryId: "usmle" }]),
    );
    expect((await detail(token, { messageId: MESSAGE_ID, sourceId: SOURCE_ID })).status).toBe(502);
    bucket.values.set(
      await manifestKey(),
      JSON.stringify([{ ...manifestEntry, objectKey: "../secret.png" }]),
    );
    expect((await image(token)).status).toBe(502);
  });

  it("shows no images when the verified source has no manifest", async () => {
    bucket.values.delete(await manifestKey());
    const response = await detail(token, { messageId: MESSAGE_ID, sourceId: SOURCE_ID });
    expect(response.status).toBe(200);
    expect((await response.json()).images).toEqual([]);
  });

  it("fails closed on snapshots that exceed the retention window", async () => {
    const oldStore = new R2VerifiedSourceStore(bucket, () => 0);
    const oldMessageId = "66666666-6666-4666-8666-666666666666";
    await oldStore.save(
      { tenantId: TENANT_ID, externalUserId: "student", messageId: oldMessageId },
      [source],
    );
    const response = await detail(token, { messageId: oldMessageId, sourceId: SOURCE_ID });
    expect(response.status).toBe(404);
  });
});
