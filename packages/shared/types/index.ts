export enum ServiceCategory {
  BUREAU = "BUREAU",
  KYC = "KYC",
  GST = "GST",
  PAYMENT = "PAYMENT",
  FRAUD = "FRAUD",
  OPEN_BANKING = "OPEN_BANKING",
}

export interface Tenant {
  id: string;
  name: string;
  status: string;
}

export interface Document {
  id: string;
  tenant_id: string;
  filename: string;
  storage_path: string;
  fingerprint: string;
  parse_status: string;
}

export interface Requirement {
  id: string;
  document_id: string;
  tenant_id: string;
  service_type: ServiceCategory | string;
  mandatory: boolean;
  confidence: number;
  source_sentence: string | null;
  conditions: Record<string, unknown>;
  api_action: string | null;
}

export interface Adapter {
  id: string;
  name: string;
  category: ServiceCategory | string;
  provider: string;
}

export interface AdapterVersion {
  id: string;
  adapter_id: string;
  api_version: string;
  request_schema: Record<string, unknown>;
  response_schema: Record<string, unknown>;
  embedding: number[] | null;
}

export interface ConfigVersion {
  id: string;
  tenant_config_id: string;
  version_number: number;
  config_json: Record<string, unknown>;
  status: string;
}

export interface DAGNode {
  id: string;
  tenant_config_version_id: string;
  adapter_version_id: string | null;
  node_type: string;
  condition: Record<string, unknown>;
}

export interface DAGEdge {
  id: string;
  tenant_config_version_id: string;
  from_node_id: string;
  to_node_id: string;
}

export interface FieldMapping {
  id: string;
  tenant_config_version_id: string;
  source_field: string;
  target_field: string;
  confidence: number;
}