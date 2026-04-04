import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ParallelVersionTester } from "./parallel-version-test.js";

const port = Number(process.env.SIMULATOR_PORT ?? 8003);
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8002";
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

type SimulationMode = "schema" | "dryrun" | "mock";
type Scenario = "success" | "partial_failure" | "timeout" | "schema_mismatch";

class SimulationEngine {
  async getConfigVersion(configVersionId: string) {
    const result = await dbPool.query<{
      id: string;
      tenant_config_id: string;
      tenant_id: string;
      version_number: number;
      config_json: any;
    }>(
      `
        SELECT id, tenant_config_id, tenant_id, version_number, config_json
        FROM tenant_config_versions
        WHERE id = $1
        LIMIT 1
      `,
      [configVersionId],
    );

    if (!result.rowCount) {
      throw new Error("config_version_not_found");
    }
    return result.rows[0];
  }

  async getAdapterVersion(adapterVersionId: string) {
    const result = await dbPool.query<{
      id: string;
      api_version: string;
      schema_def: any;
      mock_endpoint: string;
      lifecycle_status: string;
      adapter_name: string;
    }>(
      `
        SELECT av.id, av.api_version, av.schema_def, av.mock_endpoint, av.lifecycle_status, a.name AS adapter_name
        FROM adapter_versions av
        JOIN adapters a ON a.id = av.adapter_id
        WHERE av.id = $1
        LIMIT 1
      `,
      [adapterVersionId],
    );
    return result.rowCount ? result.rows[0] : null;
  }

  getRequiredFields(requestSchema: any): string[] {
    if (!requestSchema || typeof requestSchema !== "object") {
      return [];
    }
    const fields = Array.isArray(requestSchema.fields) ? requestSchema.fields : [];
    return fields.map((field: unknown) => String(field));
  }

  async saveSimulationRun(configVersion: { tenant_config_id: string; tenant_id: string }, mode: SimulationMode, status: string, results: any, triggeredBy: string) {
    const id = randomUUID();
    await dbPool.query(
      `
        INSERT INTO simulation_runs
          (id, tenant_config_id, tenant_id, mode, status, results, triggered_by)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      `,
      [id, configVersion.tenant_config_id, configVersion.tenant_id, mode, status, JSON.stringify(results), triggeredBy],
    );
    return id;
  }

  async schemaValidation(configVersionId: string, triggeredBy = "simulator") {
    const config = await this.getConfigVersion(configVersionId);
    const nodes = Array.isArray(config.config_json?.dag?.nodes) ? config.config_json.dag.nodes : [];
    const mappings = Array.isArray(config.config_json?.field_mappings) ? config.config_json.field_mappings : [];
    const results: Array<Record<string, unknown>> = [];

    for (const node of nodes) {
      const adapterVersionId = String(node?.adapter_version_id ?? "");
      const adapterVersion = adapterVersionId ? await this.getAdapterVersion(adapterVersionId) : null;
      const requiredFields = this.getRequiredFields(adapterVersion?.schema_def?.request_schema);
      const mappedFields = mappings.map((mapping: any) => String(mapping?.target_field ?? ""));
      const missingFields = requiredFields.filter((field) => !mappedFields.includes(field));

      results.push({
        node_id: node?.id,
        adapter: adapterVersion?.adapter_name ?? "unknown",
        passed: missingFields.length === 0,
        missing_required_fields: missingFields,
        validation_type: "schema",
      });
    }

    const runId = await this.saveSimulationRun(config, "schema", "completed", results, triggeredBy);
    return { run_id: runId, mode: "schema", results };
  }

  async dryRun(configVersionId: string, testPayload: Record<string, unknown>, triggeredBy = "simulator") {
    const config = await this.getConfigVersion(configVersionId);
    const nodes = Array.isArray(config.config_json?.dag?.nodes) ? config.config_json.dag.nodes : [];
    const trace: Array<Record<string, unknown>> = [];

    for (const node of nodes) {
      const adapterVersionId = String(node?.adapter_version_id ?? "");
      const adapterVersion = adapterVersionId ? await this.getAdapterVersion(adapterVersionId) : null;
      if (!adapterVersion) {
        trace.push({ node_id: node?.id, status: "failed", error: "adapter_version_not_found" });
        continue;
      }

      const endpoint = adapterVersion.mock_endpoint || "";
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testPayload),
        });
        const body = await response.text();
        trace.push({
          node_id: node?.id,
          adapter: adapterVersion.adapter_name,
          endpoint,
          status: response.ok ? "ok" : "failed",
          status_code: response.status,
          body,
        });
      } catch (error) {
        trace.push({
          node_id: node?.id,
          adapter: adapterVersion.adapter_name,
          endpoint,
          status: "failed",
          error: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }

    const runId = await this.saveSimulationRun(config, "dryrun", "completed", trace, triggeredBy);
    return { run_id: runId, mode: "dryrun", results: trace };
  }

  async generateMockResponse(responseSchema: any, scenario: Scenario) {
    const response = await fetch(`${aiServiceUrl}/mock-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adapterSchema: responseSchema ?? {}, scenario }),
    });

    if (!response.ok) {
      return { error: `mock_generation_failed_${response.status}` };
    }
    const payload = await response.json();
    return payload?.response ?? payload;
  }

  async mockSimulation(configVersionId: string, scenario: Scenario = "success", triggeredBy = "simulator") {
    const config = await this.getConfigVersion(configVersionId);
    const nodes = Array.isArray(config.config_json?.dag?.nodes) ? config.config_json.dag.nodes : [];
    const mappings = Array.isArray(config.config_json?.field_mappings) ? config.config_json.field_mappings : [];
    const results: Array<Record<string, unknown>> = [];

    for (const node of nodes) {
      const adapterVersionId = String(node?.adapter_version_id ?? "");
      const adapterVersion = adapterVersionId ? await this.getAdapterVersion(adapterVersionId) : null;
      if (!adapterVersion) {
        results.push({ node_id: node?.id, status: "failed", error: "adapter_version_not_found", scenario });
        continue;
      }

      const mockResponse = await this.generateMockResponse(adapterVersion.schema_def?.response_schema, scenario);
      results.push({
        node_id: node?.id,
        adapter: adapterVersion.adapter_name,
        request: {
          mapped_fields: mappings.map((mapping: any) => ({
            source_field: mapping?.source_field,
            target_field: mapping?.target_field,
          })),
        },
        response: mockResponse,
        scenario,
        latency_ms: scenario === "timeout" ? 5001 : Math.floor(Math.random() * 200) + 50,
      });
    }

    const runId = await this.saveSimulationRun(config, "mock", "completed", results, triggeredBy);
    return { run_id: runId, mode: "mock", results };
  }
}

const simulationEngine = new SimulationEngine();
const parallelVersionTester = new ParallelVersionTester(dbPool);

const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  "document-parse",
  async (job) => {
    const response = await fetch(`${aiServiceUrl}/process-document`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(job.data),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AI service failed: ${response.status} ${text}`);
    }

    return response.json();
  },
  {
    connection,
    concurrency: 3,
  },
);

worker.on("completed", (job) => {
  process.stdout.write(`Processed job ${job.id}\n`);
});

worker.on("failed", (job, error) => {
  process.stderr.write(`Job ${job?.id ?? "unknown"} failed: ${error.message}\n`);
});

const server = createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url === "/simulate/schema" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const data = await simulationEngine.schemaValidation(String(payload.configVersionId), String(payload.triggeredBy ?? "simulator"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown_error" }));
      }
    });
    return;
  }

  if (req.url === "/simulate/dryrun" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const data = await simulationEngine.dryRun(
          String(payload.configVersionId),
          (payload.testPayload ?? {}) as Record<string, unknown>,
          String(payload.triggeredBy ?? "simulator"),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown_error" }));
      }
    });
    return;
  }

  if (req.url === "/simulate/mock" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const data = await simulationEngine.mockSimulation(
          String(payload.configVersionId),
          (payload.scenario ?? "success") as Scenario,
          String(payload.triggeredBy ?? "simulator"),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown_error" }));
      }
    });
    return;
  }

  if (req.url === "/simulate/parallel-version-test" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const tenantConfigId = String(payload.tenantConfigId ?? "");
        const versionAId = String(payload.versionAId ?? "");
        const versionBId = String(payload.versionBId ?? "");
        const testPayload = (payload.testPayload ?? {}) as Record<string, unknown>;

        if (!tenantConfigId || !versionAId || !versionBId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "tenantConfigId_versionAId_versionBId_required" }));
          return;
        }

        const data = await parallelVersionTester.runParallelTest(
          tenantConfigId,
          versionAId,
          versionBId,
          testPayload,
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown_error" }));
      }
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Simulator listening on ${port}\n`);
});

process.on("SIGINT", async () => {
  await worker.close();
  await connection.quit();
  await dbPool.end();
  process.exit(0);
});
