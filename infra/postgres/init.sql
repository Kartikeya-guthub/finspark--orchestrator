CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  parse_status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  mandatory BOOLEAN NOT NULL DEFAULT false,
  confidence DOUBLE PRECISION NOT NULL,
  source_sentence TEXT,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  api_action TEXT
);

CREATE TABLE IF NOT EXISTS adapters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  provider TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adapter_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  adapter_id UUID NOT NULL REFERENCES adapters(id) ON DELETE CASCADE,
  api_version TEXT NOT NULL,
  request_schema JSONB NOT NULL,
  response_schema JSONB NOT NULL,
  embedding vector(1024)
);

CREATE TABLE IF NOT EXISTS tenant_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  current_version_id UUID
);

CREATE TABLE IF NOT EXISTS tenant_config_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_config_id UUID NOT NULL REFERENCES tenant_configs(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  config_json JSONB NOT NULL,
  status TEXT NOT NULL
);

ALTER TABLE tenant_configs
  ADD CONSTRAINT tenant_configs_current_version_fk
  FOREIGN KEY (current_version_id)
  REFERENCES tenant_config_versions(id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS dag_nodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_config_version_id UUID NOT NULL REFERENCES tenant_config_versions(id) ON DELETE CASCADE,
  adapter_version_id UUID REFERENCES adapter_versions(id) ON DELETE SET NULL,
  node_type TEXT NOT NULL,
  condition JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS dag_edges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_config_version_id UUID NOT NULL REFERENCES tenant_config_versions(id) ON DELETE CASCADE,
  from_node_id UUID NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  to_node_id UUID NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS field_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_config_version_id UUID NOT NULL REFERENCES tenant_config_versions(id) ON DELETE CASCADE,
  source_field TEXT NOT NULL,
  target_field TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL
);