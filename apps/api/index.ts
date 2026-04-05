import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import { Pool } from "pg";
import { Client as MinioClient } from "minio";
import { createHash } from "node:crypto";
import path from "node:path";

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 8000);

const pool = new Pool({
  connectionString: "postgresql://finspark:finspark@localhost:5432/finspark",
});

const minio = new MinioClient({
  endPoint: "127.0.0.1",
  port: 9000,
  useSSL: false,
  accessKey: "minioadmin",
  secretKey: "minioadmin",
});

const documentsBucket = process.env.MINIO_BUCKET_DOCS ?? "documents";

type AuditData = Record<string, unknown>;

async function writeAuditEvent(
  tenantId: string,
  entityType: string,
  entityId: string,
  action: string,
  actor: string,
  data: AuditData,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, actor, data)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [tenantId, entityType, entityId, action, actor, JSON.stringify(data ?? {})],
  );
}

async function ensureGovernanceTables(): Promise<void> {
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS approvals (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      config_version_id UUID NOT NULL REFERENCES tenant_config_versions(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      role TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'approved',
      comment TEXT,
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function normalizeFieldMappings(configJson: unknown): Array<Record<string, unknown>> {
  if (!configJson || typeof configJson !== "object") {
    return [];
  }
  const mappings = (configJson as { field_mappings?: unknown }).field_mappings;
  return Array.isArray(mappings)
    ? mappings.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function normalizeDagNodes(configJson: unknown): Array<Record<string, unknown>> {
  if (!configJson || typeof configJson !== "object") {
    return [];
  }
  const dag = (configJson as { dag?: unknown }).dag;
  if (!dag || typeof dag !== "object") {
    return [];
  }
  const nodes = (dag as { nodes?: unknown }).nodes;
  return Array.isArray(nodes)
    ? nodes.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

async function ensureDocumentsBucket(): Promise<void> {
  const exists = await minio.bucketExists(documentsBucket);
  if (!exists) {
    await minio.makeBucket(documentsBucket, "us-east-1");
  }
}

async function streamToBufferAndFingerprint(stream: NodeJS.ReadableStream): Promise<{ buffer: Buffer; fingerprint: string }> {
  const hasher = createHash("sha256");
  const chunks: Buffer[] = [];

  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hasher.update(data);
    chunks.push(data);
  }

  return {
    buffer: Buffer.concat(chunks),
    fingerprint: hasher.digest("hex"),
  };
}

function triggerDocumentProcessing(documentId: string): void {
  void fetch(`http://127.0.0.1:8002/process/${documentId}`, { method: "POST" }).catch((error) => {
    app.log.error(
      {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "failed to trigger ai service processing",
    );
  });
}

app.register(multipart);
app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

app.get("/health", async () => {
  return { status: "ok" };
});

app.get("/api/adapters", async (_request, reply) => {
  try {
    const result = await pool.query(
      "SELECT id, name, category, provider FROM adapters ORDER BY name ASC",
    );
    return reply.send(result.rows);
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_fetch_adapters" });
  }
});

app.get("/api/documents/:id/requirements", async (request, reply) => {
  try {
    const { id } = request.params as { id: string };
    const result = await pool.query(
      `SELECT id, document_id, tenant_id, service_type, mandatory, confidence, source_sentence, conditions, api_action,
              matched_adapter_version_id, match_explanation
       FROM requirements
       WHERE document_id = $1
       ORDER BY confidence DESC, service_type ASC`,
      [id],
    );

    return reply.send(result.rows);
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_fetch_document_requirements" });
  }
});

app.get("/api/documents/:id", async (request, reply) => {
  try {
    const { id } = request.params as { id: string };
    const result = await pool.query(
      `SELECT id, tenant_id, filename, storage_path, fingerprint, parse_status, raw_text, redacted_content
       FROM documents
       WHERE id = $1
       LIMIT 1`,
      [id],
    );

    if (!result.rowCount || !result.rows[0]) {
      return reply.code(404).send({ error: "document_not_found" });
    }

    return reply.send(result.rows[0]);
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_fetch_document" });
  }
});

app.get("/api/tenants/bootstrap", async (_request, reply) => {
  try {
    const existing = await pool.query<{ id: string; name: string; status: string }>(
      "SELECT id, name, status FROM tenants WHERE name = $1 LIMIT 1",
      ["DemoBank"],
    );

    if (existing.rowCount && existing.rows[0]) {
      await writeAuditEvent(
        existing.rows[0].id,
        "tenant",
        existing.rows[0].id,
        "tenant_bootstrap_existing",
        "api_service",
        { name: existing.rows[0].name, status: existing.rows[0].status },
      );
      return reply.send({ tenant_id: existing.rows[0].id, name: existing.rows[0].name, status: existing.rows[0].status });
    }

    const created = await pool.query<{ id: string; name: string; status: string }>(
      "INSERT INTO tenants (name, status) VALUES ($1, $2) RETURNING id, name, status",
      ["DemoBank", "active"],
    );

    await writeAuditEvent(
      created.rows[0].id,
      "tenant",
      created.rows[0].id,
      "tenant_bootstrap_created",
      "api_service",
      { name: created.rows[0].name, status: created.rows[0].status },
    );

    return reply.send({ tenant_id: created.rows[0].id, name: created.rows[0].name, status: created.rows[0].status });
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_bootstrap_tenant" });
  }
});

app.get("/api/tenants/:id/config/latest", async (request, reply) => {
  try {
    const { id } = request.params as { id: string };

    const result = await pool.query(
      `SELECT tcv.id,
              tcv.tenant_config_id,
              tcv.version_number,
              tcv.config_json,
              tcv.status
       FROM tenant_configs tc
       JOIN tenant_config_versions tcv ON tcv.tenant_config_id = tc.id
       WHERE tc.tenant_id = $1
       ORDER BY tcv.version_number DESC
       LIMIT 1`,
      [id],
    );

    if (!result.rowCount || !result.rows[0]) {
      return reply.code(404).send({ error: "tenant_config_not_found" });
    }

    return reply.send(result.rows[0]);
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_fetch_latest_tenant_config" });
  }
});

app.post("/api/documents/upload", async (request, reply) => {
  try {
    const tenantId = String((request.query as { tenant_id?: string } | undefined)?.tenant_id ?? "").trim();
    if (!tenantId) {
      return reply.code(400).send({ error: "tenant_id_required" });
    }

    const tenant = await pool.query<{ id: string }>("SELECT id FROM tenants WHERE id = $1 LIMIT 1", [tenantId]);
    if (!tenant.rowCount) {
      return reply.code(404).send({ error: "tenant_not_found" });
    }

    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: "file_required" });
    }

    const ext = path.extname(file.filename || "").toLowerCase();
    if (ext !== ".pdf" && ext !== ".docx" && ext !== ".txt") {
      return reply.code(400).send({ error: "only_pdf_docx_txt_allowed" });
    }

    const { buffer, fingerprint } = await streamToBufferAndFingerprint(file.file);

    const existing = await pool.query(
      "SELECT id, tenant_id, filename, storage_path, fingerprint, parse_status FROM documents WHERE tenant_id = $1 AND fingerprint = $2 LIMIT 1",
      [tenantId, fingerprint],
    );

    if (existing.rowCount && existing.rows[0]) {
      const existingStatus = String(existing.rows[0].parse_status);
      if (existingStatus !== "config_generated" && existingStatus !== "processing") {
        triggerDocumentProcessing(String(existing.rows[0].id));
      }

      await writeAuditEvent(
        tenantId,
        "document",
        String(existing.rows[0].id),
        "document_upload_idempotent",
        "api_service",
        {
          filename: String(existing.rows[0].filename),
          fingerprint,
          parse_status: existingStatus,
          processing_retriggered: existingStatus !== "config_generated" && existingStatus !== "processing",
        },
      );
      return reply.send({ idempotent: true, document: existing.rows[0] });
    }

    const objectPath = `tenants/${tenantId}/${fingerprint}${ext}`;
    await minio.putObject(documentsBucket, objectPath, buffer, buffer.length, {
      "Content-Type": file.mimetype || "application/octet-stream",
    });

    const inserted = await pool.query(
      "INSERT INTO documents (tenant_id, filename, storage_path, fingerprint, parse_status) VALUES ($1, $2, $3, $4, 'uploaded') RETURNING id, tenant_id, filename, storage_path, fingerprint, parse_status",
      [tenantId, file.filename, objectPath, fingerprint],
    );

    await writeAuditEvent(
      tenantId,
      "document",
      String(inserted.rows[0].id),
      "document_uploaded",
      "api_service",
      {
        filename: String(inserted.rows[0].filename),
        storage_path: String(inserted.rows[0].storage_path),
        fingerprint,
      },
    );

    triggerDocumentProcessing(inserted.rows[0].id);
    return reply.code(201).send({ idempotent: false, document: inserted.rows[0] });
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_upload_document" });
  }
});

app.addHook("onClose", async () => {
  await pool.end();
});

app.post("/api/configs/:version_id/approve", async (request, reply) => {
  try {
    const { version_id: versionId } = request.params as { version_id: string };
    const body = (request.body ?? {}) as {
      scope?: string;
      role?: string;
      comment?: string;
      actor?: string;
    };

    const scope = String(body.scope ?? "").trim();
    const role = String(body.role ?? "").trim();
    const comment = String(body.comment ?? "").trim();
    const actor = String(body.actor ?? `${role || "unknown"}_user`).trim();

    const allowedScopes = new Set(["field_mappings", "dag", "full"]);
    const allowedRoles = new Set(["engineer", "architect"]);

    if (!allowedScopes.has(scope)) {
      return reply.code(400).send({ error: "invalid_scope" });
    }
    if (!allowedRoles.has(role)) {
      return reply.code(400).send({ error: "invalid_role" });
    }

    if (role === "engineer" && scope !== "field_mappings") {
      return reply.code(403).send({ error: "engineer_can_only_approve_field_mappings" });
    }
    if (role === "architect" && scope === "field_mappings") {
      return reply.code(403).send({ error: "architect_scope_must_be_dag_or_full" });
    }

    const configRow = await pool.query<{
      id: string;
      tenant_id: string;
      status: string;
    }>(
      `
      SELECT tcv.id, tc.tenant_id, tcv.status
      FROM tenant_config_versions tcv
      JOIN tenant_configs tc ON tc.id = tcv.tenant_config_id
      WHERE tcv.id = $1
      LIMIT 1
      `,
      [versionId],
    );

    if (!configRow.rowCount || !configRow.rows[0]) {
      return reply.code(404).send({ error: "config_version_not_found" });
    }

    const tenantId = configRow.rows[0].tenant_id;

    await pool.query(
      `
      INSERT INTO approvals (tenant_id, config_version_id, scope, role, decision, comment, actor)
      VALUES ($1, $2, $3, $4, 'approved', $5, $6)
      `,
      [tenantId, versionId, scope, role, comment || null, actor],
    );

    let configStatus = configRow.rows[0].status;
    if (role === "architect" && scope === "full") {
      await pool.query(
        "UPDATE tenant_config_versions SET status = 'approved' WHERE id = $1",
        [versionId],
      );
      configStatus = "approved";
    }

    await writeAuditEvent(
      tenantId,
      "tenant_config_version",
      versionId,
      "config_approved",
      actor,
      { role, scope, comment, status: configStatus },
    );

    return reply.send({
      version_id: versionId,
      tenant_id: tenantId,
      role,
      scope,
      status: configStatus,
    });
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_approve_config" });
  }
});

app.get("/api/configs/:version_id/diff", async (request, reply) => {
  try {
    const { version_id: versionId } = request.params as { version_id: string };

    const currentResult = await pool.query<{
      id: string;
      tenant_config_id: string;
      version_number: number;
      config_json: unknown;
    }>(
      "SELECT id, tenant_config_id, version_number, config_json FROM tenant_config_versions WHERE id = $1 LIMIT 1",
      [versionId],
    );

    if (!currentResult.rowCount || !currentResult.rows[0]) {
      return reply.code(404).send({ error: "config_version_not_found" });
    }

    const current = currentResult.rows[0];

    const previousResult = await pool.query<{
      id: string;
      version_number: number;
      config_json: unknown;
    }>(
      `
      SELECT id, version_number, config_json
      FROM tenant_config_versions
      WHERE tenant_config_id = $1 AND version_number = $2
      LIMIT 1
      `,
      [current.tenant_config_id, current.version_number - 1],
    );

    const previous = previousResult.rows[0];
    const currentMappings = normalizeFieldMappings(current.config_json);
    const previousMappings = previous ? normalizeFieldMappings(previous.config_json) : [];

    const mappingKey = (mapping: Record<string, unknown>): string =>
      [
        String(mapping.requirement_id ?? ""),
        String(mapping.source_field ?? ""),
        String(mapping.target_field ?? ""),
      ].join("::");

    const previousMappingMap = new Map(previousMappings.map((item) => [mappingKey(item), item]));
    const currentMappingMap = new Map(currentMappings.map((item) => [mappingKey(item), item]));

    const addedMappings = currentMappings.filter((item) => !previousMappingMap.has(mappingKey(item)));
    const removedMappings = previousMappings.filter((item) => !currentMappingMap.has(mappingKey(item)));

    const currentNodes = normalizeDagNodes(current.config_json);
    const previousNodes = previous ? normalizeDagNodes(previous.config_json) : [];

    const nodeIdentity = (node: Record<string, unknown>): string =>
      String(node.requirement_id ?? node.node_id ?? "");

    const previousNodeMap = new Map(previousNodes.map((node) => [nodeIdentity(node), node]));
    const currentNodeMap = new Map(currentNodes.map((node) => [nodeIdentity(node), node]));

    const changedDagNodes: Array<Record<string, unknown>> = [];

    for (const node of currentNodes) {
      const key = nodeIdentity(node);
      const previousNode = previousNodeMap.get(key);
      if (!previousNode) {
        changedDagNodes.push({ change_type: "added", node });
        continue;
      }
      if (JSON.stringify(previousNode) !== JSON.stringify(node)) {
        changedDagNodes.push({ change_type: "modified", before: previousNode, after: node });
      }
    }

    for (const node of previousNodes) {
      const key = nodeIdentity(node);
      if (!currentNodeMap.has(key)) {
        changedDagNodes.push({ change_type: "removed", node });
      }
    }

    return reply.send({
      current_version_id: current.id,
      current_version_number: current.version_number,
      previous_version_id: previous?.id ?? null,
      previous_version_number: previous?.version_number ?? null,
      added_field_mappings: addedMappings,
      removed_field_mappings: removedMappings,
      changed_dag_nodes: changedDagNodes,
    });
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_diff_config_version" });
  }
});

app.get("/api/tenants/:id/audit", async (request, reply) => {
  try {
    const { id } = request.params as { id: string };
    const result = await pool.query(
      `
      SELECT id, tenant_id, entity_type, entity_id, action, actor, data, created_at
      FROM audit_events
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [id],
    );

    return reply.send(result.rows);
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: "failed_to_fetch_audit_events" });
  }
});

async function start(): Promise<void> {
  try {
    await ensureDocumentsBucket();
    await ensureGovernanceTables();
    await app.listen({ host: "0.0.0.0", port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();