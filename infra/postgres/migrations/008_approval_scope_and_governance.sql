ALTER TABLE approvals
ADD COLUMN IF NOT EXISTS approver_id TEXT,
ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'full';

CREATE INDEX IF NOT EXISTS idx_approvals_scope ON approvals (scope);

CREATE TABLE IF NOT EXISTS config_rollbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_config_id UUID NOT NULL REFERENCES tenant_configs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_version_id UUID NOT NULL REFERENCES tenant_config_versions(id) ON DELETE CASCADE,
  new_version_id UUID NOT NULL REFERENCES tenant_config_versions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_config_rollbacks_tenant_id ON config_rollbacks (tenant_id);
