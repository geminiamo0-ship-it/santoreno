import type { CreateTenantRequest, CredentialIssueResponse, Tenant } from "@santo/contracts";
import { describe, expect, it } from "vitest";

import { PortalAuthError, type PortalTokenVerifier } from "../auth/workos";
import { createApp } from "../app";
import type { SantoBindings } from "../runtime/bindings";
import type { TenantMembership, TenantRepository } from "../tenancy/repository";
import type {
  CredentialRepository,
  ServerCredentialRecord,
  TenantSecurityAuditAction,
} from "./repository";

class InMemoryTenantRepository implements TenantRepository {
  private readonly tenants = new Map<string, Tenant>();
  private readonly organizationTenantIds = new Map<string, string>();
  private readonly memberships = new Map<string, TenantMembership>();

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
    const membership: TenantMembership = {
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      workosUserId: input.ownerWorkosUserId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    };

    this.tenants.set(tenant.id, tenant);
    this.organizationTenantIds.set(tenant.workosOrgId, tenant.id);
    this.memberships.set(`${tenant.id}:${membership.workosUserId}`, membership);
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
  readonly audits: TenantSecurityAuditAction[] = [];
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
    this.audits.push("credential.created");
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
    this.audits.push("credential.rotated");
  }

  async revokeCredential(record: ServerCredentialRecord, _actor: string, revokedAt: string) {
    this.records.set(record.id, { ...record, status: "revoked", revokedAt });
    this.audits.push("credential.revoked");
  }

  async touchLastUsed(credentialId: string, usedAt: string): Promise<void> {
    const record = this.records.get(credentialId);
    if (record) {
      this.records.set(credentialId, { ...record, lastUsedAt: usedAt });
    }
  }

  async replaceAllowedDomains(tenantId: string, domains: string[]): Promise<void> {
    this.domains.set(tenantId, [...domains]);
    this.audits.push("domains.updated");
  }

  async getAllowedDomains(tenantId: string): Promise<string[]> {
    return this.domains.get(tenantId) ?? [];
  }
}

const verifyPortalToken: PortalTokenVerifier = async (_env, authorizationHeader) => {
  switch (authorizationHeader) {
    case "Bearer super":
      return { userId: "user_super", organizationId: null, tokenRole: null };
    case "Bearer medpark":
      return { userId: "user_medpark", organizationId: "org_medpark", tokenRole: "owner" };
    case "Bearer second":
      return { userId: "user_second", organizationId: "org_second", tokenRole: "owner" };
    default:
      throw new PortalAuthError("AUTH_REQUIRED", "test token required");
  }
};

const env: SantoBindings = {
  SANTO_ENV: "local",
  SANTO_SUPER_ADMIN_USER_IDS: "user_super",
};

async function createTenant(
  app: ReturnType<typeof createApp>,
  input: CreateTenantRequest,
): Promise<Tenant> {
  const response = await app.request(
    "/v1/admin/tenants",
    {
      method: "POST",
      headers: {
        authorization: "Bearer super",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
    env,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Tenant;
}

describe("P3 customer server credentials", () => {
  it("issues once, authenticates tenant context, rotates, revokes, and isolates domains", async () => {
    const tenants = new InMemoryTenantRepository();
    const credentials = new InMemoryCredentialRepository();
    const app = createApp({
      verifyPortalToken,
      tenantRepositoryFactory: () => tenants,
      credentialRepositoryFactory: () => credentials,
    });

    const medpark = await createTenant(app, {
      slug: "medpark",
      name: "MedPark",
      workosOrgId: "org_medpark",
      ownerWorkosUserId: "user_medpark",
    });
    const second = await createTenant(app, {
      slug: "second-tenant",
      name: "Second Tenant",
      workosOrgId: "org_second",
      ownerWorkosUserId: "user_second",
    });

    const issueResponse = await app.request(
      `/v1/portal/tenants/${medpark.id}/credentials`,
      { method: "POST", headers: { authorization: "Bearer medpark" } },
      env,
    );
    expect(issueResponse.status).toBe(201);
    const issued = (await issueResponse.json()) as CredentialIssueResponse;
    expect(issued.secret).toMatch(/^santo_sk_[0-9a-f]{12}_[0-9a-f]{64}$/);
    expect(issued.credential.tenantId).toBe(medpark.id);
    expect(JSON.stringify([...credentials.records.values()])).not.toContain(issued.secret);

    const ownContext = await app.request(
      `/v1/server/tenants/${medpark.id}/context`,
      { headers: { authorization: `Santo ${issued.secret}` } },
      env,
    );
    expect(ownContext.status).toBe(200);
    await expect(ownContext.json()).resolves.toEqual({
      tenantId: medpark.id,
      credentialId: issued.credential.id,
    });
    expect(credentials.records.get(issued.credential.id)?.lastUsedAt).not.toBeNull();

    const wrongTenant = await app.request(
      `/v1/server/tenants/${second.id}/context`,
      { headers: { authorization: `Santo ${issued.secret}` } },
      env,
    );
    expect(wrongTenant.status).toBe(403);
    await expect(wrongTenant.json()).resolves.toEqual({ error: "FORBIDDEN" });

    const invalidSecret = `${issued.secret.slice(0, -1)}${issued.secret.endsWith("0") ? "1" : "0"}`;
    const invalid = await app.request(
      `/v1/server/tenants/${medpark.id}/context`,
      { headers: { authorization: `Santo ${invalidSecret}` } },
      env,
    );
    expect(invalid.status).toBe(401);

    const rotateResponse = await app.request(
      `/v1/portal/tenants/${medpark.id}/credentials/${issued.credential.id}/rotate`,
      { method: "POST", headers: { authorization: "Bearer medpark" } },
      env,
    );
    expect(rotateResponse.status).toBe(201);
    const rotated = (await rotateResponse.json()) as CredentialIssueResponse;
    expect(rotated.secret).not.toBe(issued.secret);
    expect(rotated.credential.rotatedFromId).toBe(issued.credential.id);

    const oldAfterRotate = await app.request(
      `/v1/server/tenants/${medpark.id}/context`,
      { headers: { authorization: `Santo ${issued.secret}` } },
      env,
    );
    expect(oldAfterRotate.status).toBe(401);

    const newAfterRotate = await app.request(
      `/v1/server/tenants/${medpark.id}/context`,
      { headers: { authorization: `Santo ${rotated.secret}` } },
      env,
    );
    expect(newAfterRotate.status).toBe(200);

    const domainUpdate = await app.request(
      `/v1/portal/tenants/${medpark.id}/domains`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer medpark",
          "content-type": "application/json",
        },
        body: JSON.stringify({ domains: ["APP.MEDPARK.COM", "medpark.com", "medpark.com"] }),
      },
      env,
    );
    expect(domainUpdate.status).toBe(200);
    await expect(domainUpdate.json()).resolves.toEqual({
      tenantId: medpark.id,
      domains: ["app.medpark.com", "medpark.com"],
    });

    const crossTenantDomainUpdate = await app.request(
      `/v1/portal/tenants/${second.id}/domains`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer medpark",
          "content-type": "application/json",
        },
        body: JSON.stringify({ domains: ["evil.example"] }),
      },
      env,
    );
    expect(crossTenantDomainUpdate.status).toBe(403);

    const revokeResponse = await app.request(
      `/v1/portal/tenants/${medpark.id}/credentials/${rotated.credential.id}`,
      { method: "DELETE", headers: { authorization: "Bearer medpark" } },
      env,
    );
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toMatchObject({ status: "revoked" });

    const revoked = await app.request(
      `/v1/server/tenants/${medpark.id}/context`,
      { headers: { authorization: `Santo ${rotated.secret}` } },
      env,
    );
    expect(revoked.status).toBe(401);

    expect(credentials.audits).toEqual([
      "credential.created",
      "credential.rotated",
      "domains.updated",
      "credential.revoked",
    ]);
  });

  it("does not let another tenant owner issue credentials for MedPark", async () => {
    const tenants = new InMemoryTenantRepository();
    const credentials = new InMemoryCredentialRepository();
    const app = createApp({
      verifyPortalToken,
      tenantRepositoryFactory: () => tenants,
      credentialRepositoryFactory: () => credentials,
    });

    const medpark = await createTenant(app, {
      slug: "medpark",
      name: "MedPark",
      workosOrgId: "org_medpark",
      ownerWorkosUserId: "user_medpark",
    });
    await createTenant(app, {
      slug: "second-tenant",
      name: "Second Tenant",
      workosOrgId: "org_second",
      ownerWorkosUserId: "user_second",
    });

    const response = await app.request(
      `/v1/portal/tenants/${medpark.id}/credentials`,
      { method: "POST", headers: { authorization: "Bearer second" } },
      env,
    );

    expect(response.status).toBe(403);
    expect(credentials.records.size).toBe(0);
  });
});
