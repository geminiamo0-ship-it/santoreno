import type { D1DatabaseLike, D1PreparedStatementLike } from "../runtime/bindings";

export type ServerCredentialStatus = "active" | "revoked";

export interface ServerCredentialRecord {
  id: string;
  tenantId: string;
  keyPrefix: string;
  secretHash: string;
  status: ServerCredentialStatus;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFromId: string | null;
}

export type TenantSecurityAuditAction =
  "credential.created" | "credential.rotated" | "credential.revoked" | "domains.updated";

export interface CredentialRepository {
  findActiveByTenantId(tenantId: string): Promise<ServerCredentialRecord | null>;
  findById(tenantId: string, credentialId: string): Promise<ServerCredentialRecord | null>;
  findByPrefix(keyPrefix: string): Promise<ServerCredentialRecord | null>;
  createCredential(record: ServerCredentialRecord, actorWorkosUserId: string): Promise<void>;
  rotateCredential(
    previous: ServerCredentialRecord,
    replacement: ServerCredentialRecord,
    actorWorkosUserId: string,
  ): Promise<void>;
  revokeCredential(
    record: ServerCredentialRecord,
    actorWorkosUserId: string,
    revokedAt: string,
  ): Promise<void>;
  touchLastUsed(credentialId: string, usedAt: string): Promise<void>;
  replaceAllowedDomains(
    tenantId: string,
    domains: string[],
    actorWorkosUserId: string,
    updatedAt: string,
  ): Promise<void>;
  getAllowedDomains(tenantId: string): Promise<string[]>;
}

interface CredentialRow {
  id: string;
  tenant_id: string;
  key_prefix: string;
  secret_hash: string;
  status: ServerCredentialStatus;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  rotated_from_id: string | null;
}

interface DomainsRow {
  domains_json: string | null;
}

function mapCredential(row: CredentialRow): ServerCredentialRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    keyPrefix: row.key_prefix,
    secretHash: row.secret_hash,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    rotatedFromId: row.rotated_from_id,
  };
}

function auditStatement(
  db: D1DatabaseLike,
  tenantId: string,
  actorWorkosUserId: string,
  action: TenantSecurityAuditAction,
  targetId: string | null,
  createdAt: string,
): D1PreparedStatementLike {
  return db
    .prepare(
      `INSERT INTO tenant_security_audit (
        id, tenant_id, actor_workos_user_id, action, target_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), tenantId, actorWorkosUserId, action, targetId, createdAt);
}

export class D1CredentialRepository implements CredentialRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  private async firstCredential(query: string, ...values: unknown[]) {
    const row = await this.db
      .prepare(query)
      .bind(...values)
      .first<CredentialRow>();
    return row ? mapCredential(row) : null;
  }

  findActiveByTenantId(tenantId: string): Promise<ServerCredentialRecord | null> {
    return this.firstCredential(
      `SELECT id, tenant_id, key_prefix, secret_hash, status, created_at,
              last_used_at, revoked_at, rotated_from_id
       FROM tenant_credentials
       WHERE tenant_id = ? AND status = 'active'
       LIMIT 1`,
      tenantId,
    );
  }

  findById(tenantId: string, credentialId: string): Promise<ServerCredentialRecord | null> {
    return this.firstCredential(
      `SELECT id, tenant_id, key_prefix, secret_hash, status, created_at,
              last_used_at, revoked_at, rotated_from_id
       FROM tenant_credentials
       WHERE tenant_id = ? AND id = ?
       LIMIT 1`,
      tenantId,
      credentialId,
    );
  }

  findByPrefix(keyPrefix: string): Promise<ServerCredentialRecord | null> {
    return this.firstCredential(
      `SELECT id, tenant_id, key_prefix, secret_hash, status, created_at,
              last_used_at, revoked_at, rotated_from_id
       FROM tenant_credentials
       WHERE key_prefix = ?
       LIMIT 1`,
      keyPrefix,
    );
  }

  async createCredential(record: ServerCredentialRecord, actorWorkosUserId: string): Promise<void> {
    const insert = this.db
      .prepare(
        `INSERT INTO tenant_credentials (
          id, tenant_id, key_prefix, secret_hash, status, created_at,
          last_used_at, revoked_at, rotated_from_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.tenantId,
        record.keyPrefix,
        record.secretHash,
        record.status,
        record.createdAt,
        record.lastUsedAt,
        record.revokedAt,
        record.rotatedFromId,
      );
    const audit = auditStatement(
      this.db,
      record.tenantId,
      actorWorkosUserId,
      "credential.created",
      record.id,
      record.createdAt,
    );

    if (this.db.batch) {
      await this.db.batch([insert, audit]);
      return;
    }
    await insert.run();
    await audit.run();
  }

  async rotateCredential(
    previous: ServerCredentialRecord,
    replacement: ServerCredentialRecord,
    actorWorkosUserId: string,
  ): Promise<void> {
    const revoke = this.db
      .prepare(
        `UPDATE tenant_credentials
         SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'active'`,
      )
      .bind(replacement.createdAt, previous.id, previous.tenantId);
    const insert = this.db
      .prepare(
        `INSERT INTO tenant_credentials (
          id, tenant_id, key_prefix, secret_hash, status, created_at,
          last_used_at, revoked_at, rotated_from_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        replacement.id,
        replacement.tenantId,
        replacement.keyPrefix,
        replacement.secretHash,
        replacement.status,
        replacement.createdAt,
        replacement.lastUsedAt,
        replacement.revokedAt,
        replacement.rotatedFromId,
      );
    const audit = auditStatement(
      this.db,
      replacement.tenantId,
      actorWorkosUserId,
      "credential.rotated",
      replacement.id,
      replacement.createdAt,
    );

    if (this.db.batch) {
      await this.db.batch([revoke, insert, audit]);
      return;
    }
    await revoke.run();
    await insert.run();
    await audit.run();
  }

  async revokeCredential(
    record: ServerCredentialRecord,
    actorWorkosUserId: string,
    revokedAt: string,
  ): Promise<void> {
    const revoke = this.db
      .prepare(
        `UPDATE tenant_credentials
         SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'active'`,
      )
      .bind(revokedAt, record.id, record.tenantId);
    const audit = auditStatement(
      this.db,
      record.tenantId,
      actorWorkosUserId,
      "credential.revoked",
      record.id,
      revokedAt,
    );

    if (this.db.batch) {
      await this.db.batch([revoke, audit]);
      return;
    }
    await revoke.run();
    await audit.run();
  }

  async touchLastUsed(credentialId: string, usedAt: string): Promise<void> {
    await this.db
      .prepare("UPDATE tenant_credentials SET last_used_at = ? WHERE id = ?")
      .bind(usedAt, credentialId)
      .run();
  }

  async replaceAllowedDomains(
    tenantId: string,
    domains: string[],
    actorWorkosUserId: string,
    updatedAt: string,
  ): Promise<void> {
    const statements: D1PreparedStatementLike[] = [
      this.db.prepare("DELETE FROM tenant_allowed_domains WHERE tenant_id = ?").bind(tenantId),
      ...domains.map((domain) =>
        this.db
          .prepare(
            "INSERT INTO tenant_allowed_domains (tenant_id, domain, created_at) VALUES (?, ?, ?)",
          )
          .bind(tenantId, domain, updatedAt),
      ),
      auditStatement(this.db, tenantId, actorWorkosUserId, "domains.updated", null, updatedAt),
    ];

    if (this.db.batch) {
      await this.db.batch(statements);
      return;
    }
    for (const statement of statements) {
      await statement.run();
    }
  }

  async getAllowedDomains(tenantId: string): Promise<string[]> {
    const row = await this.db
      .prepare(
        `SELECT json_group_array(domain) AS domains_json
         FROM (
           SELECT domain
           FROM tenant_allowed_domains
           WHERE tenant_id = ?
           ORDER BY domain
         )`,
      )
      .bind(tenantId)
      .first<DomainsRow>();

    if (!row?.domains_json) {
      return [];
    }

    const parsed: unknown = JSON.parse(row.domains_json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  }
}
