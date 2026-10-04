CREATE TABLE IF NOT EXISTS tenant_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  rotated_from_id TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (rotated_from_id) REFERENCES tenant_credentials(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_credentials_one_active
  ON tenant_credentials(tenant_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_tenant_credentials_tenant
  ON tenant_credentials(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS tenant_allowed_domains (
  tenant_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, domain),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tenant_security_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_workos_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('credential.created', 'credential.rotated', 'credential.revoked', 'domains.updated')
  ),
  target_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_security_audit_tenant
  ON tenant_security_audit(tenant_id, created_at);
