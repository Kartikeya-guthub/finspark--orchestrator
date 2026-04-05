import Fastify from "fastify";
import cors from "@fastify/cors";
import axios from "axios";
import { Pool } from "pg";

const app = Fastify({ logger: true });

function resolvePort(): number {
  const argIndex = process.argv.findIndex((arg) => arg === "--port");
  if (argIndex !== -1 && process.argv[argIndex + 1]) {
    const parsed = Number(process.argv[argIndex + 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const envPort = Number(process.env.SIMULATOR_PORT ?? 8003);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 8003;
}

const port = resolvePort();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://finspark:finspark@127.0.0.1:5432/finspark",
});

void app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
});

const extractionApiKey = (process.env.EXTRACTION_API_KEY ?? process.env.GLINER_API_KEY ?? process.env.NVIDIA_API_KEY ?? "").trim();
const extractionBaseUrl = (process.env.EXTRACTION_BASE_URL ?? process.env.GLINER_BASE_URL ?? "https://integrate.api.nvidia.com/v1").trim();
const extractionModel = (process.env.EXTRACTION_MODEL ?? process.env.NVIDIA_REQUIREMENTS_MODEL ?? "mistralai/mistral-small-3.1-24b-instruct-2503").trim();
const failProbability = Number(process.env.SIMULATOR_FAIL_PROBABILITY ?? 0);

type JsonObject = Record<string, unknown>;

type DagNode = {
  node_id: string;
  requirement_id?: string;
  service_type?: string;
  api_action?: string;
  adapter_version_id?: string | null;
  adapter_name?: string;
  conditions?: JsonObject;
};

type DagEdge = {
  edge_id?: string;
  from_node_id: string;
  to_node_id: string;
  depends_on_requirement_id?: string;
  requirement_id?: string;
};

type FieldMapping = {
  requirement_id?: string;
  adapter_version_id?: string | null;
  source_field: string;
  target_field: string;
  confidence: number;
  method?: string;
};

type ConfigJson = {
  tenant_id: string;
  document_id: string;
  version_number: number;
  field_mappings: FieldMapping[];
  dag: {
    nodes: DagNode[];
    edges: DagEdge[];
  };
};

type AdapterVersion = {
  id: string;
  request_schema: JsonObject;
  response_schema: JsonObject;
};

type ValidationIssue = {
  node_id: string;
  adapter_version_id: string;
  missing_required_fields: string[];
  severity: "ERROR" | "WARN";
  message: string;
};

type SimulationStep = {
  node_id: string;
  requirement_id: string | null;
  adapter_version_id: string | null;
  adapter_name: string | null;
  service_type: string | null;
  status: "success" | "failed" | "skipped";
  latency_ms: number;
  input: JsonObject;
  output: JsonObject | null;
  error?: string;
  skipped_reason?: string;
};

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function extractSchemaRequiredFields(schema: JsonObject): string[] {
  const required = schema.required;
  if (Array.isArray(required)) {
    return required.filter((item): item is string => typeof item === "string");
  }

  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    return Object.keys(properties as JsonObject);
  }

  return [];
}

function randomLatency(): number {
  return Math.floor(Math.random() * 151) + 50;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldSimulateFailure(): boolean {
  if (!Number.isFinite(failProbability) || failProbability <= 0) {
    return false;
  }
  return Math.random() < failProbability;
}

function inferMockValue(sourceField: string): unknown {
  const lowered = sourceField.toLowerCase();
  if (lowered.includes("pan")) return "ABCDE1234F";
  if (lowered.includes("aadhaar") || lowered.includes("aadhar")) return "123412341234";
  if (lowered.includes("name")) return "Ravi Kumar";
  if (lowered.includes("dob") || lowered.includes("birth")) return "1992-08-14";
  if (lowered.includes("ifsc")) return "HDFC0001234";
  if (lowered.includes("account")) return "009912345678";
  if (lowered.includes("amount") || lowered.includes("loan")) return 250000;
  if (lowered.includes("ip")) return "103.24.10.77";
  if (lowered.includes("device")) return "ANDROID-9A2C-7781";
  if (lowered.includes("score")) return 742;
  return `mock_${sourceField}`;
}

function safeJsonParse(text: string): unknown {
  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {
    // continue
  }

  const fenced = direct.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }

  const startObj = direct.indexOf("{");
  const endObj = direct.lastIndexOf("}");
  if (startObj >= 0 && endObj > startObj) {
    return JSON.parse(direct.slice(startObj, endObj + 1));
  }

  throw new Error("invalid_json_response");
}

async function ensureSimulationTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS simulation_runs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      config_version_id UUID NOT NULL REFERENCES tenant_config_versions(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      result_json JSONB NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function writeAuditEvent(
  tenantId: string,
  entityType: string,
  entityId: string,
  action: string,
  actor: string,
  data: JsonObject,
): Promise<void> {
  await pool.query(
    `
    INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, actor, data)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [tenantId, entityType, entityId, action, actor, JSON.stringify(data ?? {})],
  );
}

async function getConfigVersion(configVersionId: string): Promise<{ tenantId: string; config: ConfigJson }> {
  const result = await pool.query<{
    tenant_id: string;
    config_json: ConfigJson;
  }>(
    `
    SELECT tc.tenant_id, tcv.config_json
    FROM tenant_config_versions tcv
    JOIN tenant_configs tc ON tc.id = tcv.tenant_config_id
    WHERE tcv.id = $1
    LIMIT 1
    `,
    [configVersionId],
  );

  if (!result.rowCount || !result.rows[0]) {
    throw new Error("config_version_not_found");
  }

  return {
    tenantId: result.rows[0].tenant_id,
    config: result.rows[0].config_json,
  };
}

async function getAdapterVersionsByIds(ids: string[]): Promise<Map<string, AdapterVersion>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await pool.query<AdapterVersion>(
    `
    SELECT id, request_schema, response_schema
    FROM adapter_versions
    WHERE id = ANY($1::uuid[])
    `,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.id, row]));
}

function validateSchema(config: ConfigJson, adapterVersions: Map<string, AdapterVersion>): { issues: ValidationIssue[]; ok: boolean } {
  const issues: ValidationIssue[] = [];
  const mappings = Array.isArray(config.field_mappings) ? config.field_mappings : [];

  for (const node of config.dag?.nodes ?? []) {
    const adapterVersionId = node.adapter_version_id;
    if (!adapterVersionId) {
      continue;
    }

    const adapterVersion = adapterVersions.get(adapterVersionId);
    if (!adapterVersion) {
      issues.push({
        node_id: node.node_id,
        adapter_version_id: adapterVersionId,
        missing_required_fields: [],
        severity: "ERROR",
        message: "adapter_version_not_found",
      });
      continue;
    }

    const requiredFields = extractSchemaRequiredFields(adapterVersion.request_schema);
    const mappedTargets = new Set(
      mappings
        .filter((item) => item.adapter_version_id === adapterVersionId)
        .map((item) => item.target_field),
    );

    const missing = requiredFields.filter((field) => !mappedTargets.has(field));
    if (missing.length > 0) {
      issues.push({
        node_id: node.node_id,
        adapter_version_id: adapterVersionId,
        missing_required_fields: missing,
        severity: "ERROR",
        message: `Missing mappings for required adapter fields: ${missing.join(", ")}`,
      });
    }
  }

  return {
    issues,
    ok: issues.every((item) => item.severity !== "ERROR"),
  };
}

function topoSort(nodes: DagNode[], edges: DagEdge[]): DagNode[] {
  const nodeMap = new Map(nodes.map((node) => [node.node_id, node]));
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.node_id, 0);
    outgoing.set(node.node_id, []);
  }

  for (const edge of edges) {
    if (!nodeMap.has(edge.from_node_id) || !nodeMap.has(edge.to_node_id)) {
      continue;
    }
    inDegree.set(edge.to_node_id, (inDegree.get(edge.to_node_id) ?? 0) + 1);
    outgoing.get(edge.from_node_id)?.push(edge.to_node_id);
  }

  const queue = [...nodes]
    .filter((node) => (inDegree.get(node.node_id) ?? 0) === 0)
    .sort((a, b) => (a.requirement_id ?? a.node_id).localeCompare(b.requirement_id ?? b.node_id));

  const sorted: DagNode[] = [];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      break;
    }
    sorted.push(node);

    for (const nextId of outgoing.get(node.node_id) ?? []) {
      inDegree.set(nextId, (inDegree.get(nextId) ?? 0) - 1);
      if ((inDegree.get(nextId) ?? 0) === 0) {
        const nextNode = nodeMap.get(nextId);
        if (nextNode) {
          queue.push(nextNode);
          queue.sort((a, b) => (a.requirement_id ?? a.node_id).localeCompare(b.requirement_id ?? b.node_id));
        }
      }
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error("dag_cycle_detected_or_disconnected");
  }

  return sorted;
}

async function generateMockResponseWithAi(params: {
  adapterName: string;
  serviceType: string;
  responseSchema: JsonObject;
  inputPayload: JsonObject;
}): Promise<JsonObject> {
  if (!extractionApiKey) {
    throw new Error("missing_extraction_api_key_for_simulation");
  }

  const prompt = [
    "You are a fintech integration simulator.",
    "Generate a realistic successful mock JSON response that strictly follows the provided adapter response schema.",
    "For Bureau/CIBIL-like flows include a believable numeric credit score such as 742.",
    "Return JSON only (no markdown, no explanations).",
    `Adapter: ${params.adapterName}`,
    `Service type: ${params.serviceType}`,
    `Response schema: ${JSON.stringify(params.responseSchema)}`,
    `Input payload: ${JSON.stringify(params.inputPayload)}`,
  ].join("\n");

  const url = resolveChatCompletionsUrl(extractionBaseUrl);
  const response = await axios.post(
    url,
    {
      model: extractionModel,
      messages: [
        { role: "system", content: "Return strict JSON only." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 900,
      stream: false,
    },
    {
      headers: {
        Authorization: `Bearer ${extractionApiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 60000,
    },
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("mock_generation_empty_content");
  }

  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mock_generation_invalid_json_object");
  }

  return parsed as JsonObject;
}

async function runMockSimulation(config: ConfigJson, adapterVersions: Map<string, AdapterVersion>): Promise<SimulationStep[]> {
  const nodes = config.dag?.nodes ?? [];
  const edges = config.dag?.edges ?? [];
  const mappings = config.field_mappings ?? [];

  const orderedNodes = topoSort(nodes, edges);
  const predecessors = new Map<string, string[]>();

  for (const node of nodes) {
    predecessors.set(node.node_id, []);
  }
  for (const edge of edges) {
    if (predecessors.has(edge.to_node_id)) {
      predecessors.get(edge.to_node_id)?.push(edge.from_node_id);
    }
  }

  const steps: SimulationStep[] = [];
  const stepByNodeId = new Map<string, SimulationStep>();

  for (const node of orderedNodes) {
    const nodePreds = predecessors.get(node.node_id) ?? [];
    const hasFailedUpstream = nodePreds.some((pred) => {
      const predStep = stepByNodeId.get(pred);
      return predStep?.status === "failed" || predStep?.status === "skipped";
    });

    const adapterVersionId = node.adapter_version_id ?? null;
    const adapterVersion = adapterVersionId ? adapterVersions.get(adapterVersionId) : undefined;

    const nodeMappings = mappings.filter(
      (item) => item.adapter_version_id === adapterVersionId || item.requirement_id === node.requirement_id,
    );

    const inputPayload: JsonObject = {};
    for (const mapping of nodeMappings) {
      inputPayload[mapping.target_field] = inferMockValue(mapping.source_field);
    }

    if (hasFailedUpstream) {
      const latency = randomLatency();
      await sleep(latency);
      const skippedStep: SimulationStep = {
        node_id: node.node_id,
        requirement_id: node.requirement_id ?? null,
        adapter_version_id: adapterVersionId,
        adapter_name: node.adapter_name ?? null,
        service_type: node.service_type ?? null,
        status: "skipped",
        latency_ms: latency,
        input: inputPayload,
        output: null,
        skipped_reason: "upstream_failed_or_skipped",
      };
      steps.push(skippedStep);
      stepByNodeId.set(node.node_id, skippedStep);
      continue;
    }

    if (shouldSimulateFailure()) {
      const latency = randomLatency();
      await sleep(latency);
      const failedStep: SimulationStep = {
        node_id: node.node_id,
        requirement_id: node.requirement_id ?? null,
        adapter_version_id: adapterVersionId,
        adapter_name: node.adapter_name ?? null,
        service_type: node.service_type ?? null,
        status: "failed",
        latency_ms: latency,
        input: inputPayload,
        output: null,
        error: "simulated_node_failure",
      };
      steps.push(failedStep);
      stepByNodeId.set(node.node_id, failedStep);
      continue;
    }

    if (!adapterVersion) {
      const latency = randomLatency();
      await sleep(latency);
      const failedStep: SimulationStep = {
        node_id: node.node_id,
        requirement_id: node.requirement_id ?? null,
        adapter_version_id: adapterVersionId,
        adapter_name: node.adapter_name ?? null,
        service_type: node.service_type ?? null,
        status: "failed",
        latency_ms: latency,
        input: inputPayload,
        output: null,
        error: "adapter_version_missing",
      };
      steps.push(failedStep);
      stepByNodeId.set(node.node_id, failedStep);
      continue;
    }

    const latency = randomLatency();
    await sleep(latency);

    try {
      const output = await generateMockResponseWithAi({
        adapterName: node.adapter_name ?? "Unknown Adapter",
        serviceType: node.service_type ?? "OTHER",
        responseSchema: adapterVersion.response_schema,
        inputPayload,
      });

      const successStep: SimulationStep = {
        node_id: node.node_id,
        requirement_id: node.requirement_id ?? null,
        adapter_version_id: adapterVersionId,
        adapter_name: node.adapter_name ?? null,
        service_type: node.service_type ?? null,
        status: "success",
        latency_ms: latency,
        input: inputPayload,
        output,
      };
      steps.push(successStep);
      stepByNodeId.set(node.node_id, successStep);
    } catch (error) {
      const failedStep: SimulationStep = {
        node_id: node.node_id,
        requirement_id: node.requirement_id ?? null,
        adapter_version_id: adapterVersionId,
        adapter_name: node.adapter_name ?? null,
        service_type: node.service_type ?? null,
        status: "failed",
        latency_ms: latency,
        input: inputPayload,
        output: null,
        error: error instanceof Error ? error.message : String(error),
      };
      steps.push(failedStep);
      stepByNodeId.set(node.node_id, failedStep);
    }
  }

  return steps;
}

function summarizeSimulationStatus(validationOk: boolean, steps: SimulationStep[]): "completed" | "failed" {
  if (!validationOk) {
    return "failed";
  }
  if (steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  return "completed";
}

async function persistSimulationRun(params: {
  tenantId: string;
  configVersionId: string;
  status: "completed" | "failed";
  resultJson: JsonObject;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `
    INSERT INTO simulation_runs (tenant_id, config_version_id, status, result_json, completed_at)
    VALUES ($1, $2, $3, $4::jsonb, NOW())
    RETURNING id
    `,
    [params.tenantId, params.configVersionId, params.status, JSON.stringify(params.resultJson)],
  );

  return result.rows[0]?.id ?? "";
}

app.get("/health", async () => ({ status: "ok" }));

app.post("/api/simulate/:config_version_id", async (request, reply) => {
  const startedAt = new Date().toISOString();
  const { config_version_id: configVersionId } = request.params as { config_version_id: string };

  try {
    const { tenantId, config } = await getConfigVersion(configVersionId);

    const adapterIds = Array.from(
      new Set((config.dag?.nodes ?? []).map((node) => node.adapter_version_id).filter((id): id is string => Boolean(id))),
    );

    const adapterVersions = await getAdapterVersionsByIds(adapterIds);
    const validation = validateSchema(config, adapterVersions);
    const trace = await runMockSimulation(config, adapterVersions);

    const finalStatus = summarizeSimulationStatus(validation.ok, trace);

    const resultJson: JsonObject = {
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      tenant_id: tenantId,
      config_version_id: configVersionId,
      schema_validation: {
        ok: validation.ok,
        issues: validation.issues,
      },
      trace,
      summary: {
        total_nodes: trace.length,
        success_count: trace.filter((step) => step.status === "success").length,
        failed_count: trace.filter((step) => step.status === "failed").length,
        skipped_count: trace.filter((step) => step.status === "skipped").length,
      },
    };

    const simulationRunId = await persistSimulationRun({
      tenantId,
      configVersionId,
      status: finalStatus,
      resultJson,
    });

    await writeAuditEvent(
      tenantId,
      "simulation_run",
      simulationRunId,
      "simulation_run",
      "simulator_service",
      {
        config_version_id: configVersionId,
        status: finalStatus,
        success_count: (resultJson.summary as JsonObject).success_count,
        failed_count: (resultJson.summary as JsonObject).failed_count,
        skipped_count: (resultJson.summary as JsonObject).skipped_count,
      },
    );

    return reply.send({
      simulation_run_id: simulationRunId,
      status: finalStatus,
      result: resultJson,
    });
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({
      error: "simulation_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/simulations/:id", async (request, reply) => {
  try {
    const { id } = request.params as { id: string };
    const result = await pool.query(
      `SELECT id, tenant_id, config_version_id, status, result_json, started_at, completed_at
       FROM simulation_runs
       WHERE id = $1
       LIMIT 1`,
      [id],
    );

    if (!result.rowCount || !result.rows[0]) {
      return reply.code(404).send({ error: "simulation_run_not_found" });
    }

    return reply.send(result.rows[0]);
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_fetch_simulation_run" });
  }
});

app.addHook("onClose", async () => {
  await pool.end();
});

async function start(): Promise<void> {
  try {
    await ensureSimulationTables();
    await app.listen({ host: "0.0.0.0", port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
