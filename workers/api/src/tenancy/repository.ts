import {
  TenantSchema,
  type CreateTenantRequest,
  type PortalRole,
  type Tenant,
} from "@santo/contracts";

import type { D1DatabaseLike } from "../runtime/bindings";

export interface TenantMembership {
  id: string;
  tenantId: string;
  workosUserId: string;
  role: Extract<PortalRole, "owner">;
  createdAt: string;
  updatedAt: string;
}

export interface TenantRepository {
  createTenantWithOwner(input: CreateTenantRequest): Promise<Tenant>;
  findTenantById(tenantId: string): Promise<Tenant | null>;
  findTenantByWorkOSOrgId(workosOrgId: string): Promise<Tenant | null>;
  findMembership(tenantId: string, workosUserId: string): Promise<TenantMembership | null>;
  updateTenantName(tenantId: string, name: string): Promise<Tenant | null>;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended";
  workos_org_id: string;
  created_at: string;
  updated_at: string;
}

interface TenantMembershipRow {
  id: string;
  tenant_id: string;
  workos_user_id: string;
  role: "owner";
  created_at: string;
  updated_at: string;
}

function mapTenant(row: TenantRow): Tenant {
  return TenantSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    workosOrgId: row.workos_org_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapMembership(row: TenantMembershipRow): TenantMembership {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workosUserId: row.workos_user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1TenantRepository implements TenantRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async createTenantWithOwner(input: CreateTenantRequest): Promise<Tenant> {
    const now = new Date().toISOString();
    const tenant: Tenant = TenantSchema.parse({
      id: crypto.randomUUID(),
      slug: input.slug,
      name: input.name,
      status: "active",
      workosOrgId: input.workosOrgId,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = crypto.randomUUID();

    const tenantStatement = this.db
      .prepare(
        `INSERT INTO tenants (
          id, slug, name, status, workos_org_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenant.id,
        tenant.slug,
        tenant.name,
        tenant.status,
        tenant.workosOrgId,
        tenant.createdAt,
        tenant.updatedAt,
      );

    const membershipStatement = this.db
      .prepare(
        `INSERT INTO tenant_members (
          id, tenant_id, workos_user_id, role, created_at, updated_at
        ) VALUES (?, ?, ?, 'owner', ?, ?)`,
      )
      .bind(membershipId, tenant.id, input.ownerWorkosUserId, now, now);

    if (this.db.batch) {
      await this.db.batch([tenantStatement, membershipStatement]);
    } else {
      await tenantStatement.run();
      await membershipStatement.run();
    }

    return tenant;
  }

  async findTenantById(tenantId: string): Promise<Tenant | null> {
    const row = await this.db
      .prepare(
        `SELECT id, slug, name, status, workos_org_id, created_at, updated_at
         FROM tenants
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<TenantRow>();

    return row ? mapTenant(row) : null;
  }

  async findTenantByWorkOSOrgId(workosOrgId: string): Promise<Tenant | null> {
    const row = await this.db
      .prepare(
        `SELECT id, slug, name, status, workos_org_id, created_at, updated_at
         FROM tenants
         WHERE workos_org_id = ?
         LIMIT 1`,
      )
      .bind(workosOrgId)
      .first<TenantRow>();

    return row ? mapTenant(row) : null;
  }

  async findMembership(tenantId: string, workosUserId: string): Promise<TenantMembership | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, workos_user_id, role, created_at, updated_at
         FROM tenant_members
         WHERE tenant_id = ? AND workos_user_id = ?
         LIMIT 1`,
      )
      .bind(tenantId, workosUserId)
      .first<TenantMembershipRow>();

    return row ? mapMembership(row) : null;
  }

  async updateTenantName(tenantId: string, name: string): Promise<Tenant | null> {
    const updatedAt = new Date().toISOString();
    await this.db
      .prepare("UPDATE tenants SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name, updatedAt, tenantId)
      .run();

    return this.findTenantById(tenantId);
  }
}
