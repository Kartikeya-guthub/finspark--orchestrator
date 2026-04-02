CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  mandatory BOOLEAN NOT NULL,
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_sentence TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS adapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  provider TEXT NOT NULL,
  description TEXT NOT NULL,
  capability_tags TEXT[] NOT NULL DEFAULT '{}',
  auth_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, provider)
);

CREATE TABLE IF NOT EXISTS adapter_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_id UUID NOT NULL REFERENCES adapters(id) ON DELETE CASCADE,
  api_version TEXT NOT NULL,
  schema_def JSONB NOT NULL,
  lifecycle_status TEXT NOT NULL,
  mock_endpoint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (adapter_id, api_version)
);

CREATE TABLE IF NOT EXISTS tenant_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS tenant_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_config_id UUID NOT NULL REFERENCES tenant_configs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  config_json JSONB NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_config_id, version_number)
);

ALTER TABLE tenant_configs
  DROP CONSTRAINT IF EXISTS tenant_configs_current_version_id_fkey,
  ADD CONSTRAINT tenant_configs_current_version_id_fkey
  FOREIGN KEY (current_version_id) REFERENCES tenant_config_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_config_id UUID NOT NULL REFERENCES tenant_configs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_field TEXT NOT NULL,
  target_field TEXT NOT NULL,
  transformation_rule TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dag_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_config_id UUID NOT NULL REFERENCES tenant_configs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  adapter_version_id UUID REFERENCES adapter_versions(id) ON DELETE SET NULL,
  node_type TEXT NOT NULL,
  condition TEXT,
  retry_policy JSONB NOT NULL DEFAULT '{}',
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dag_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node_id UUID NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  to_node_id UUID NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  condition_type TEXT NOT NULL,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('success', 'failure', 'parallel')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_node_id <> to_node_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_config_version_id UUID NOT NULL REFERENCES tenant_config_versions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  approver_role TEXT NOT NULL,
  status TEXT NOT NULL,
  comment TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_config_id UUID NOT NULL REFERENCES tenant_configs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('schema', 'dryrun', 'mock')),
  status TEXT NOT NULL,
  results JSONB NOT NULL DEFAULT '{}',
  triggered_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rollback_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_config_id UUID NOT NULL REFERENCES tenant_configs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ref_key TEXT NOT NULL,
  vault_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ref_key)
);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_id ON documents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_requirements_tenant_id ON requirements (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_configs_tenant_id ON tenant_configs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_config_versions_tenant_id ON tenant_config_versions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_field_mappings_tenant_id ON field_mappings (tenant_id);
CREATE INDEX IF NOT EXISTS idx_dag_nodes_tenant_id ON dag_nodes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_id ON approvals (tenant_id);
CREATE INDEX IF NOT EXISTS idx_simulation_runs_tenant_id ON simulation_runs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_id ON audit_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_rollback_snapshots_tenant_id ON rollback_snapshots (tenant_id);
CREATE INDEX IF NOT EXISTS idx_secrets_refs_tenant_id ON secrets_refs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_adapters_category ON adapters (category);
