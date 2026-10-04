import type { CreateTenantRequest, Tenant } from "@santo/contracts";
import { describe, expect, it } from "vitest";

import { PortalAuthError, type PortalTokenVerifier } from "../auth/workos";
import { createApp } from "../app";
import type { SantoBindings } from "../runtime/bindings";
import type { TenantMembership, TenantRepository } from "./repository";

class InMemoryTenantRepository implements TenantRepository {
  private readonly tenants = new Map<string, Tenant>();
  private readonly organizationTenantIds = new Map<string, string>();
  private readonly memberships = new Map<string, TenantMembership>();

  async createTenantWithOwner(input: CreateTenantRequest): Promise<Tenant> {
    if (this.organizationTenantIds.has(input.workosOrgId)) {
      throw new Error("duplicate organization");
    }

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

  async findMembership(
    tenantId: string,
    workosUserId: string,
  ): Promise<TenantMembership | null> {
    return this.memberships.get(`${tenantId}:${workosUserId}`) ?? null;
  }

  async updateTenantName(tenantId: string, name: string): Promise<Tenant | null> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return null;
    }

    const updated: Tenant = {
      ...tenant,
      name,
      updatedAt: new Date().toISOString(),
    };
    this.tenants.set(tenantId, updated);
    return updated;
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
    case "Bearer medpark-second-org":
      return { userId: "user_medpark", organizationId: "org_second", tokenRole: "owner" };
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

describe("P2 tenant control plane", () => {
  it("derives owner tenant context from verified identity and blocks cross-tenant read/write", async () => {
    const repository = new InMemoryTenantRepository();
    const app = createApp({
      verifyPortalToken,
      tenantRepositoryFactory: () => repository,
    });

    const medpark = await createTenant(app, {
      slug: "medpark",
      name: "MedPark",
      workosOrgId: "org_medpark",
      ownerWorkosUserId: "user_medpark",
    });
    const second = await createTenant(app, {
      slug: "royal-bank",
      name: "Royal Bank",
      workosOrgId: "org_second",
      ownerWorkosUserId: "user_second",
    });

    const contextResponse = await app.request(
      "/v1/portal/context",
      { headers: { authorization: "Bearer medpark" } },
      env,
    );
    expect(contextResponse.status).toBe(200);
    await expect(contextResponse.json()).resolves.toMatchObject({
      userId: "user_medpark",
      role: "owner",
      tenant: {
        id: medpark.id,
        slug: "medpark",
        workosOrgId: "org_medpark",
      },
    });

    const ownRead = await app.request(
      `/v1/portal/tenants/${medpark.id}`,
      { headers: { authorization: "Bearer medpark" } },
      env,
    );
    expect(ownRead.status).toBe(200);

    const crossRead = await app.request(
      `/v1/portal/tenants/${second.id}`,
      { headers: { authorization: "Bearer medpark" } },
      env,
    );
    expect(crossRead.status).toBe(403);
    await expect(crossRead.json()).resolves.toEqual({ error: "FORBIDDEN" });

    const crossWrite = await app.request(
      `/v1/portal/tenants/${second.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: "Bearer medpark",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Compromised" }),
      },
      env,
    );
    expect(crossWrite.status).toBe(403);
    expect((await repository.findTenantById(second.id))?.name).toBe("Royal Bank");

    const ownWrite = await app.request(
      `/v1/portal/tenants/${medpark.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: "Bearer medpark",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "MedPark Medical" }),
      },
      env,
    );
    expect(ownWrite.status).toBe(200);
    await expect(ownWrite.json()).resolves.toMatchObject({
      id: medpark.id,
      name: "MedPark Medical",
    });
  });

  it("does not trust WorkOS organization selection without Santo membership", async () => {
    const repository = new InMemoryTenantRepository();
    const app = createApp({
      verifyPortalToken,
      tenantRepositoryFactory: () => repository,
    });

    await createTenant(app, {
      slug: "medpark",
      name: "MedPark",
      workosOrgId: "org_medpark",
      ownerWorkosUserId: "user_medpark",
    });
    await createTenant(app, {
      slug: "royal-bank",
      name: "Royal Bank",
      workosOrgId: "org_second",
      ownerWorkosUserId: "user_second",
    });

    const response = await app.request(
      "/v1/portal/context",
      { headers: { authorization: "Bearer medpark-second-org" } },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "FORBIDDEN" });
  });

  it("requires verified authentication and super-admin permission for tenant creation", async () => {
    const repository = new InMemoryTenantRepository();
    const app = createApp({
      verifyPortalToken,
      tenantRepositoryFactory: () => repository,
    });

    const unauthenticated = await app.request(
      "/v1/admin/tenants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "medpark",
          name: "MedPark",
          workosOrgId: "org_medpark",
          ownerWorkosUserId: "user_medpark",
        }),
      },
      env,
    );
    expect(unauthenticated.status).toBe(401);

    const ownerAttempt = await app.request(
      "/v1/admin/tenants",
      {
        method: "POST",
        headers: {
          authorization: "Bearer medpark",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          slug: "forbidden-tenant",
          name: "Forbidden Tenant",
          workosOrgId: "org_forbidden",
          ownerWorkosUserId: "user_forbidden",
        }),
      },
      env,
    );
    expect(ownerAttempt.status).toBe(403);
  });
});
