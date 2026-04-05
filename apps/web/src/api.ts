export type DocumentRecord = {
  id: string;
  tenant_id: string;
  filename: string;
  storage_path: string;
  fingerprint: string;
  parse_status: string;
  raw_text?: string | null;
  redacted_content?: {
    redacted_text?: string;
    entities?: unknown[];
  } | null;
};

export type RequirementRecord = {
  id: string;
  document_id: string;
  tenant_id: string;
  service_type: string;
  mandatory: boolean;
  confidence: number;
  source_sentence: string;
  conditions: Record<string, unknown>;
  api_action?: string | null;
  matched_adapter_version_id?: string | null;
  match_explanation?: string | null;
};

export type ConfigVersionRecord = {
  id: string;
  tenant_config_id: string;
  version_number: number;
  config_json: {
    field_mappings?: Array<Record<string, unknown>>;
    dag?: {
      nodes?: Array<Record<string, unknown>>;
      edges?: Array<Record<string, unknown>>;
    };
    [key: string]: unknown;
  };
  status: string;
};

export type AuditEventRecord = {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  data: Record<string, unknown>;
  created_at: string;
};

export type SimulationResult = {
  simulation_run_id: string;
  status: string;
  result: {
    trace: Array<{
      node_id: string;
      requirement_id: string | null;
      adapter_version_id: string | null;
      adapter_name: string | null;
      service_type: string | null;
      status: string;
      latency_ms: number;
      input: Record<string, unknown>;
      output: Record<string, unknown> | null;
      error?: string;
      skipped_reason?: string;
    }>;
    summary: {
      total_nodes: number;
      success_count: number;
      failed_count: number;
      skipped_count: number;
    };
  };
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000";
const simulatorBaseUrl = (import.meta.env.VITE_SIMULATOR_BASE_URL as string | undefined) ?? "http://localhost:8003";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  return (await response.json()) as T;
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

export function getSimulatorBaseUrl(): string {
  return simulatorBaseUrl;
}

export function bootstrapTenant(): Promise<{ tenant_id: string; name: string; status: string }> {
  return requestJson(`${apiBaseUrl}/api/tenants/bootstrap`);
}

export async function uploadDocument(file: File, tenantId: string): Promise<{ idempotent: boolean; document: DocumentRecord }> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${apiBaseUrl}/api/documents/upload?tenant_id=${encodeURIComponent(tenantId)}`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  return (await response.json()) as { idempotent: boolean; document: DocumentRecord };
}

export function getDocument(documentId: string): Promise<DocumentRecord> {
  return requestJson(`${apiBaseUrl}/api/documents/${documentId}`);
}

export function getRequirements(documentId: string): Promise<RequirementRecord[]> {
  return requestJson(`${apiBaseUrl}/api/documents/${documentId}/requirements`);
}

export function getLatestConfig(tenantId: string): Promise<ConfigVersionRecord> {
  return requestJson(`${apiBaseUrl}/api/tenants/${tenantId}/config/latest`);
}

export function getAuditTrail(tenantId: string): Promise<AuditEventRecord[]> {
  return requestJson(`${apiBaseUrl}/api/tenants/${tenantId}/audit`);
}

export function getConfigDiff(versionId: string): Promise<Record<string, unknown>> {
  return requestJson(`${apiBaseUrl}/api/configs/${versionId}/diff`);
}

export function approveConfig(versionId: string, payload: { role: string; scope: string; comment?: string; actor?: string }): Promise<Record<string, unknown>> {
  return requestJson(`${apiBaseUrl}/api/configs/${versionId}/approve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function runSimulation(configVersionId: string): Promise<SimulationResult> {
  return requestJson(`${simulatorBaseUrl}/api/simulate/${configVersionId}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}