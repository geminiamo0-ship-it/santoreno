import type { CreateTenantRequest, SessionExchangeResponse, Tenant } from "@santo/contracts";
import { describe, expect, it } from "vitest";

import { createApp } from "../app";
import type { CredentialRepository, ServerCredentialRecord } from "../credentials/repository";
import { ServerCredentialService } from "../credentials/service";
import type { SantoBindings } from "../runtime/bindings";
import type { TenantMembership, TenantRepository } from "../tenancy/repository";
import type {
  ExternalUserRecord,
  ExternalUserRepository,
  UpsertExternalUserInput,
} from "./repository";
import { SantoSessionTokenService, SessionTokenError } from "./token";

class InMemoryTenantRepository implements TenantRepository {
  readonly tenants = new Map<string, Tenant>();
  private readonly organizationTenantIds = new Map<string, string>();
  private readonly memberships = new Map<string, TenantMembership>();

  seedTenant(slug: string): Tenant {
    const now = new Date().toISOString();
    const tenant: Tenant = {
      id: crypto.randomUUID(),
      slug,
      name: slug,
      status: "active",
      workosOrgId: `org_${slug}`,
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.set(tenant.id, tenant);
    this.organizationTenantIds.set(tenant.workosOrgId, tenant.id);
    return tenant;
  }

  setStatus(tenantId: string, status: Tenant["status"]): void {
    const tenant = this.tenants.get(tenantId);
    if (tenant) {
      this.tenants.set(tenantId, { ...tenant, status, updatedAt: new Date().toISOString() });
    }
  }

  async createTenantWithOwner(input: CreateTenantRequest): Promise<Tenant> {
    const now = new Date().toISOString();
    const tenant: Tenant = {
      id: crypto.randomUUID(),
      slug: input.slug,
      name: input.name,
      status: "active",
      workosOrgId: input.workosOrgId,
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.set(tenant.id, tenant);
    this.organizationTenantIds.set(tenant.workosOrgId, tenant.id);
    this.memberships.set(`${tenant.id}:${input.ownerWorkosUserId}`, {
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      workosUserId: input.ownerWorkosUserId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    return tenant;
  }

  async findTenantById(tenantId: string): Promise<Tenant | null> {
    return this.tenants.get(tenantId) ?? null;
  }

  async findTenantByWorkOSOrgId(workosOrgId: string): Promise<Tenant | null> {
    const tenantId = this.organizationTenantIds.get(workosOrgId);
    return tenantId ? (this.tenants.get(tenantId) ?? null) : null;
  }

  async findMembership(tenantId: string, workosUserId: string): Promise<TenantMembership | null> {
    return this.memberships.get(`${tenantId}:${workosUserId}`) ?? null;
  }

  async updateTenantName(tenantId: string, name: string): Promise<Tenant | null> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return null;
    }
    const updated = { ...tenant, name, updatedAt: new Date().toISOString() };
    this.tenants.set(tenantId, updated);
    return updated;
  }
}

class InMemoryCredentialRepository implements CredentialRepository {
  readonly records = new Map<string, ServerCredentialRecord>();
  private readonly domains = new Map<string, string[]>();

  async findActiveByTenantId(tenantId: string): Promise<ServerCredentialRecord | null> {
    return (
      [...this.records.values()].find(
        (record) => record.tenantId === tenantId && record.status === "active",
      ) ?? null
    );
  }

  async findById(tenantId: string, credentialId: string): Promise<ServerCredentialRecord | null> {
    const record = this.records.get(credentialId);
    return record?.tenantId === tenantId ? record : null;
  }

  async findByPrefix(keyPrefix: string): Promise<ServerCredentialRecord | null> {
    return [...this.records.values()].find((record) => record.keyPrefix === keyPrefix) ?? null;
  }

  async createCredential(record: ServerCredentialRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async rotateCredential(
    previous: ServerCredentialRecord,
    replacement: ServerCredentialRecord,
  ): Promise<void> {
    this.records.set(previous.id, {
      ...previous,
      status: "revoked",
      revokedAt: replacement.createdAt,
    });
    this.records.set(replacement.id, { ...replacement });
  }

  async revokeCredential(record: ServerCredentialRecord, _actor: string, revokedAt: string) {
    this.records.set(record.id, { ...record, status: "revoked", revokedAt });
  }

  async touchLastUsed(credentialId: string, usedAt: string): Promise<void> {
    const record = this.records.get(credentialId);
    if (record) {
      this.records.set(credentialId, { ...record, lastUsedAt: usedAt });
    }
  }

  async replaceAllowedDomains(tenantId: string, domains: string[]): Promise<void> {
    this.domains.set(tenantId, [...domains]);
  }

  async getAllowedDomains(tenantId: string): Promise<string[]> {
    return this.domains.get(tenantId) ?? [];
  }
}

class InMemoryExternalUserRepository implements ExternalUserRepository {
  readonly records = new Map<string, ExternalUserRecord>();

  async upsertExternalUser(input: UpsertExternalUserInput): Promise<ExternalUserRecord> {
    const key = `${input.tenantId}:${input.externalUserId}`;
    const existing = this.records.get(key);
    const now = new Date().toISOString();
    const record: ExternalUserRecord = existing
      ? {
          ...existing,
          email: input.email ?? existing.email,
          displayName: input.displayName ?? existing.displayName,
          updatedAt: now,
        }
      : {
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          externalUserId: input.externalUserId,
          email: input.email ?? null,
          displayName: input.displayName ?? null,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
    this.records.set(key, record);
    return record;
  }

  async findByTenantAndExternalId(
    tenantId: string,
    externalUserId: string,
  ): Promise<ExternalUserRecord | null> {
    return this.records.get(`${tenantId}:${externalUserId}`) ?? null;
  }
}

const env: SantoBindings = {
  SANTO_ENV: "local",
  SANTO_SESSION_SIGNING_KEY: "test-session-signing-key-that-is-longer-than-thirty-two-characters",
  SANTO_SESSION_TTL_SECONDS: "900",
};

function tamper(token: string): string {
  const last = token.at(-1);
  return `${token.slice(0, -1)}${last === "a" ? "b" : "a"}`;
}

async function exchange(
  app: ReturnType<typeof createApp>,
  secret: string,
  externalUserId: string,
): Promise<Response> {
  return app.request(
    "/v1/session/exchange",
    {
      method: "POST",
      headers: {
        authorization: `Santo ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ external_user_id: externalUserId }),
    },
    env,
  );
}

describe("P4 external-user session exchange", () => {
  it("issues tenant-scoped sessions and isolates the same external ID across tenants", async () => {
    const tenants = new InMemoryTenantRepository();
    const credentials = new InMemoryCredentialRepository();
    const users = new InMemoryExternalUserRepository();
    const medpark = tenants.seedTenant("medpark");
    const second = tenants.seedTenant("second-tenant");
    const credentialService = new ServerCredentialService(credentials, tenants);
    const medparkCredential = await credentialService.createCredential(medpark.id, "owner_medpark");
    const secondCredential = await credentialService.createCredential(second.id, "owner_second");
    const app = createApp({
      tenantRepositoryFactory: () => tenants,
      credentialRepositoryFactory: () => credentials,
      externalUserRepositoryFactory: () => users,
    });

    const medparkResponse = await exchange(app, medparkCredential.secret, "58392");
    expect(medparkResponse.status).toBe(200);
    const medparkSession = (await medparkResponse.json()) as SessionExchangeResponse;
    expect(medparkSession.user.tenantId).toBe(medpark.id);
    expect(medparkSession.user.externalUserId).toBe("58392");
    expect(medparkSession.expiresIn).toBe(900);

    const medparkContext = await app.request(
      "/v1/session/context",
      { headers: { authorization: `Bearer ${medparkSession.accessToken}` } },
      env,
    );
    expect(medparkContext.status).toBe(200);
    await expect(medparkContext.json()).resolves.toMatchObject({
      tenantId: medpark.id,
      externalUserId: "58392",
    });

    const secondResponse = await exchange(app, secondCredential.secret, "58392");
    expect(secondResponse.status).toBe(200);
    const secondSession = (await secondResponse.json()) as SessionExchangeResponse;
    expect(secondSession.user.tenantId).toBe(second.id);
    expect(secondSession.user.externalUserId).toBe("58392");
    expect(secondSession.user.id).not.toBe(medparkSession.user.id);
    expect(users.records.size).toBe(2);

    const secondContext = await app.request(
      "/v1/session/context",
      { headers: { authorization: `Bearer ${secondSession.accessToken}` } },
      env,
    );
    await expect(secondContext.json()).resolves.toMatchObject({
      tenantId: second.id,
      externalUserId: "58392",
    });
  });

  it("rejects invalid payloads, bad server credentials, suspended tenants, and tampered tokens", async () => {
    const tenants = new InMemoryTenantRepository();
    const credentials = new InMemoryCredentialRepository();
    const users = new InMemoryExternalUserRepository();
    const medpark = tenants.seedTenant("medpark");
    const credentialService = new ServerCredentialService(credentials, tenants);
    const issued = await credentialService.createCredential(medpark.id, "owner_medpark");
    const app = createApp({
      tenantRepositoryFactory: () => tenants,
      credentialRepositoryFactory: () => credentials,
      externalUserRepositoryFactory: () => users,
    });

    const invalidPayload = await app.request(
      "/v1/session/exchange",
      {
        method: "POST",
        headers: {
          authorization: `Santo ${issued.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ external_user_id: "" }),
      },
      env,
    );
    expect(invalidPayload.status).toBe(400);
    await expect(invalidPayload.json()).resolves.toEqual({ error: "INVALID_SESSION_REQUEST" });

    const badCredential = await app.request(
      "/v1/session/exchange",
      {
        method: "POST",
        headers: {
          authorization:
            "Santo santo_sk_000000000000_0000000000000000000000000000000000000000000000000000000000000000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ external_user_id: "58392" }),
      },
      env,
    );
    expect(badCredential.status).toBe(401);

    const activeExchange = await exchange(app, issued.secret, "58392");
    const session = (await activeExchange.json()) as SessionExchangeResponse;
    const tampered = await app.request(
      "/v1/session/context",
      { headers: { authorization: `Bearer ${tamper(session.accessToken)}` } },
      env,
    );
    expect(tampered.status).toBe(401);
    await expect(tampered.json()).resolves.toEqual({ error: "INVALID_SESSION_TOKEN" });

    tenants.setStatus(medpark.id, "suspended");
    const suspended = await exchange(app, issued.secret, "other-user");
    expect(suspended.status).toBe(403);
    await expect(suspended.json()).resolves.toEqual({ error: "SERVER_TENANT_INACTIVE" });
  });

  it("denies expired tokens with an explicit error", async () => {
    const baseSeconds = 2_000_000_000;
    const issuer = new SantoSessionTokenService(env, () => baseSeconds);
    const issued = await issuer.issue({
      tenantId: crypto.randomUUID(),
      externalUserId: "58392",
    });
    const verifier = new SantoSessionTokenService(env, () => baseSeconds + 901);

    try {
      await verifier.verifyBearerToken(`Bearer ${issued.token}`);
      throw new Error("Expected expired token verification to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionTokenError);
      expect((error as SessionTokenError).code).toBe("SESSION_TOKEN_EXPIRED");
    }
  });
});
