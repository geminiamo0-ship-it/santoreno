CREATE TABLE IF NOT EXISTS external_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, external_user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_external_users_tenant_status
  ON external_users(tenant_id, status, external_user_id);
