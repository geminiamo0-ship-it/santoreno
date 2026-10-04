import type { D1DatabaseLike } from "../runtime/bindings";

export type ExternalUserStatus = "active" | "suspended";

export interface ExternalUserRecord {
  id: string;
  tenantId: string;
  externalUserId: string;
  email: string | null;
  displayName: string | null;
  status: ExternalUserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertExternalUserInput {
  tenantId: string;
  externalUserId: string;
  email?: string;
  displayName?: string;
}

export interface ExternalUserRepository {
  upsertExternalUser(input: UpsertExternalUserInput): Promise<ExternalUserRecord>;
  findByTenantAndExternalId(
    tenantId: string,
    externalUserId: string,
  ): Promise<ExternalUserRecord | null>;
}

interface ExternalUserRow {
  id: string;
  tenant_id: string;
  external_user_id: string;
  email: string | null;
  display_name: string | null;
  status: ExternalUserStatus;
  created_at: string;
  updated_at: string;
}

function mapExternalUser(row: ExternalUserRow): ExternalUserRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    externalUserId: row.external_user_id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1ExternalUserRepository implements ExternalUserRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async upsertExternalUser(input: UpsertExternalUserInput): Promise<ExternalUserRecord> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await this.db
      .prepare(
        `INSERT INTO external_users (
          id, tenant_id, external_user_id, email, display_name, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(tenant_id, external_user_id) DO UPDATE SET
          email = COALESCE(excluded.email, external_users.email),
          display_name = COALESCE(excluded.display_name, external_users.display_name),
          updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        input.tenantId,
        input.externalUserId,
        input.email ?? null,
        input.displayName ?? null,
        now,
        now,
      )
      .run();

    const user = await this.findByTenantAndExternalId(input.tenantId, input.externalUserId);
    if (!user) {
      throw new Error("External user upsert did not produce a row");
    }

    return user;
  }

  async findByTenantAndExternalId(
    tenantId: string,
    externalUserId: string,
  ): Promise<ExternalUserRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, external_user_id, email, display_name, status, created_at, updated_at
         FROM external_users
         WHERE tenant_id = ? AND external_user_id = ?
         LIMIT 1`,
      )
      .bind(tenantId, externalUserId)
      .first<ExternalUserRow>();

    return row ? mapExternalUser(row) : null;
  }
}
