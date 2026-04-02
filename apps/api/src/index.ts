import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { pool, closePool } from "./db.js";
import { closeQueue, documentParseQueueName, enqueueDocumentParseJob } from "./queue.js";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { SecretsService } from "./secrets.js";
import { putDocumentObject } from "./storage.js";
import { detectConfigDrift } from "./jobs/drift-detection.js";
import {
  createTenantApiKey,
  hashTenantApiKey,
  requireTenant,
  signTenantJwt,
  tenantMiddleware,
} from "./tenant-middleware.js";

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 8000);
const secretsService = new SecretsService(
  process.env.SECRET_ENCRYPTION_KEY ?? "change-me-in-dev",
);
const AI_SERVICE_URL = process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8002";
const SIMULATOR_URL = process.env.SIMULATOR_URL ?? "http://127.0.0.1:8003";
const REQUIRED_APPROVAL_ROLES = (process.env.CONFIG_REQUIRED_APPROVAL_ROLES ?? "ops,security,compliance")
  .split(",")
  .map((role) => role.trim().toLowerCase())
  .filter(Boolean);
const REQUIRED_APPROVAL_SCOPES = (process.env.CONFIG_REQUIRED_APPROVAL_SCOPES ?? "field_mappings,dag,hooks")
  .split(",")
  .map((scope) => scope.trim().toLowerCase())
  .filter(Boolean);
const API_DOCUMENT_WORKER_ENABLED =
  (process.env.API_DOCUMENT_WORKER_ENABLED ?? "false").toLowerCase() === "true";
const DRIFT_DETECTION_ENABLED = (process.env.DRIFT_DETECTION_ENABLED ?? "false").toLowerCase() === "true";
const DRIFT_DETECTION_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.DRIFT_DETECTION_INTERVAL_MS ?? 3_600_000),
);
let driftInterval: NodeJS.Timeout | undefined;

function toObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getActor(request: { headers: Record<string, unknown> }): { userId: string; role: string } {
  const headerRole = request.headers["x-user-role"];
  const headerUserId = request.headers["x-user-id"];
  const role = String(headerRole ?? "admin").trim().toLowerCase() || "admin";
  const userId = String(headerUserId ?? "system").trim() || "system";
  return { userId, role };
}

function canApprove(role: string, scope: string): boolean {
  const permissions: Record<string, string[]> = {
    engineer: ["field_mappings"],
    architect: ["field_mappings", "dag", "hooks", "full"],
    admin: ["field_mappings", "dag", "hooks", "full"],
  };
  return Boolean(permissions[role]?.includes(scope));
}

function summarizeDiff(previousConfig: unknown, currentConfig: unknown): Record<string, unknown> {
  const previous = toObject(previousConfig);
  const current = toObject(currentConfig);

  const previousMappings = toArray(previous.field_mappings).map((item) => toObject(item));
  const currentMappings = toArray(current.field_mappings).map((item) => toObject(item));

  const previousMappingKeys = new Set(
    previousMappings.map((mapping) =>
      `${String(mapping.source_field ?? "")}|${String(mapping.target_field ?? "")}|${String(mapping.transformation_rule ?? "")}`,
    ),
  );
  const currentMappingKeys = new Set(
    currentMappings.map((mapping) =>
      `${String(mapping.source_field ?? "")}|${String(mapping.target_field ?? "")}|${String(mapping.transformation_rule ?? "")}`,
    ),
  );

  const addedMappings = [...currentMappingKeys].filter((item) => !previousMappingKeys.has(item));
  const removedMappings = [...previousMappingKeys].filter((item) => !currentMappingKeys.has(item));

  const previousDag = toObject(previous.dag);
  const currentDag = toObject(current.dag);
  const previousNodes = toArray(previousDag.nodes).map((node) => toObject(node));
  const currentNodes = toArray(currentDag.nodes).map((node) => toObject(node));
  const previousNodeIds = new Set(previousNodes.map((node) => String(node.id ?? "")));
  const currentNodeIds = new Set(currentNodes.map((node) => String(node.id ?? "")));

  const addedNodes = [...currentNodeIds].filter((id) => id && !previousNodeIds.has(id));
  const removedNodes = [...previousNodeIds].filter((id) => id && !currentNodeIds.has(id));

  return {
    mapping_changes: {
      added_count: addedMappings.length,
      removed_count: removedMappings.length,
      added: addedMappings,
      removed: removedMappings,
    },
    dag_changes: {
      added_nodes_count: addedNodes.length,
      removed_nodes_count: removedNodes.length,
      added_node_ids: addedNodes,
      removed_node_ids: removedNodes,
    },
  };
}

// ── BullMQ Worker: consume document-parse jobs by calling the AI service ────
let _workerRedis: Redis | undefined;
let _documentWorker: Worker | undefined;
if (API_DOCUMENT_WORKER_ENABLED) {
  _workerRedis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });
  _documentWorker = new Worker(
    documentParseQueueName,
    async (job) => {
      const res = await fetch(`${AI_SERVICE_URL}/process-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job.data),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "unknown");
        throw new Error(`AI service returned ${res.status}: ${detail.slice(0, 200)}`);
      }
    },
    { connection: _workerRedis },
  );
  _documentWorker.on("failed", (job, err) => {
    app.log.error({ jobId: job?.id, err: err.message }, "document-parse job failed");
  });
  _documentWorker.on("completed", (job) => {
    app.log.info({ jobId: job.id }, "document-parse job completed");
  });
}

app.register(multipart, {
  limits: {
    files: 1,
    fileSize: 25 * 1024 * 1024,
  },
});

app.addHook("preHandler", tenantMiddleware);

app.get("/health", async () => {
  return { status: "ok" };
});

app.post<{
  Body: {
    tenant_name: string;
    created_by: string;
    secrets?: Record<string, string>;
  };
}>("/api/tenants/bootstrap", async (request, reply) => {
  const tenantName = request.body?.tenant_name?.trim();
  const createdBy = request.body?.created_by?.trim();

  if (!tenantName || !createdBy) {
    return reply.code(400).send({ error: "tenant_name_and_created_by_required" });
  }

  const pendingSecrets = request.body.secrets
    ? Object.entries(request.body.secrets).filter(([, value]) => Boolean(value))
    : [];

  const client = await pool.connect();
  let tenantId = "";
  let tenantNameResponse = "";
  let configId = "";
  let versionId = "";
  let versionNumber = 1;
  let apiKey = "";
  let token = "";
  try {
    await client.query("BEGIN");

    const tenant = await client.query<{ id: string; name: string }>(
      `
        INSERT INTO tenants (name, status)
        VALUES ($1, 'active')
        RETURNING id, name
      `,
      [tenantName],
    );
    tenantId = tenant.rows[0].id;
    tenantNameResponse = tenant.rows[0].name;

    const defaultVaultRef = `vault://${tenantId}/cibil-prod-key`;
    const config = await client.query<{ id: string }>(
      `
        INSERT INTO tenant_configs (tenant_id, name)
        VALUES ($1, 'default')
        RETURNING id
      `,
      [tenantId],
    );
    configId = config.rows[0].id;

    const configJson = {
      service_credentials: {
        cibil_api_key: defaultVaultRef,
      },
    };

    const version = await client.query<{ id: string; version_number: number }>(
      `
        INSERT INTO tenant_config_versions
          (tenant_config_id, tenant_id, version_number, config_json, created_by, status)
        VALUES ($1, $2, 1, $3::jsonb, $4, 'draft')
        RETURNING id, version_number
      `,
      [config.rows[0].id, tenantId, JSON.stringify(configJson), createdBy],
    );
    versionId = version.rows[0].id;
    versionNumber = version.rows[0].version_number;

    await client.query(
      `
        UPDATE tenant_configs
        SET current_version_id = $2
        WHERE id = $1
      `,
      [config.rows[0].id, version.rows[0].id],
    );

    await client.query(
      `
        INSERT INTO secrets_refs (tenant_id, ref_key, vault_path)
        VALUES ($1, 'cibil-prod-key', $2)
        ON CONFLICT (tenant_id, ref_key) DO NOTHING
      `,
      [tenantId, defaultVaultRef],
    );

    apiKey = createTenantApiKey();
    await client.query(
      `
        INSERT INTO tenant_api_keys (tenant_id, key_hash, label)
        VALUES ($1, $2, 'bootstrap')
      `,
      [tenantId, hashTenantApiKey(apiKey)],
    );

    token = signTenantJwt(tenantId);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  for (const [refKey, value] of pendingSecrets) {
    await secretsService.store(tenantId, refKey, value);
  }

  return reply.code(201).send({
    tenant: {
      id: tenantId,
      name: tenantNameResponse,
    },
    default_config: {
      config_id: configId,
      version_id: versionId,
      version_number: versionNumber,
      config_json: {
        service_credentials: {
          cibil_api_key: `vault://${tenantId}/cibil-prod-key`,
        },
      },
    },
    credentials: {
      jwt: token,
      api_key: apiKey,
    },
  });
});

app.get("/api/secrets/refs", async (request, reply) => {
  const tenant = requireTenant(request);
  const result = await pool.query(
    `
      SELECT ref_key, vault_path, created_at
      FROM secrets_refs
      WHERE tenant_id = $1
      ORDER BY created_at DESC
    `,
    [tenant.id],
  );

  return reply.send({ items: result.rows, count: result.rowCount });
});

app.get<{ Params: { tenantId: string } }>(
  "/api/tenants/:tenantId/config/current",
  async (request, reply) => {
    const tenant = requireTenant(request);
    if (request.params.tenantId !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const result = await pool.query(
      `
        SELECT tc.id, tc.tenant_id, tc.name, tcv.version_number, tcv.config_json
        FROM tenant_configs tc
        JOIN tenant_config_versions tcv ON tcv.id = tc.current_version_id
        WHERE tc.tenant_id = $1
          AND tc.name = 'default'
        LIMIT 1
      `,
      [tenant.id],
    );

    if (!result.rowCount) {
      return reply.code(404).send({ error: "default_config_not_found" });
    }

    return reply.send(result.rows[0]);
  },
);

app.get<{ Params: { tenantId: string } }>(
  "/api/tenants/:tenantId/config/versions",
  async (request, reply) => {
    const tenant = requireTenant(request);
    if (request.params.tenantId !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const result = await pool.query(
      `
        SELECT
          tcv.id,
          tcv.tenant_config_id,
          tcv.version_number,
          tcv.status,
          tcv.created_by,
          tcv.created_at,
          tcv.generator_model,
          tcv.source_document_id,
          COALESCE(json_array_length(tcv.match_results), 0) AS match_count,
          COALESCE(approval_stats.approved_count, 0) AS approved_count,
          COALESCE(approval_stats.rejected_count, 0) AS rejected_count
        FROM tenant_config_versions tcv
        LEFT JOIN (
          SELECT
            tenant_config_version_id,
            COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
            COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_count
          FROM approvals
          GROUP BY tenant_config_version_id
        ) AS approval_stats ON approval_stats.tenant_config_version_id = tcv.id
        WHERE tcv.tenant_id = $1
        ORDER BY tcv.created_at DESC
        LIMIT 100
      `,
      [tenant.id],
    );

    return reply.send({ items: result.rows, count: result.rowCount });
  },
);

app.get<{ Params: { versionId: string } }>(
  "/api/config-versions/:versionId/diff",
  async (request, reply) => {
    const tenant = requireTenant(request);

    const current = await pool.query<{
      id: string;
      tenant_id: string;
      tenant_config_id: string;
      version_number: number;
      config_json: unknown;
      status: string;
      match_results: unknown;
    }>(
      `
        SELECT id, tenant_id, tenant_config_id, version_number, config_json, status, match_results
        FROM tenant_config_versions
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.versionId],
    );

    if (!current.rowCount) {
      return reply.code(404).send({ error: "config_version_not_found" });
    }
    if (current.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const previous = await pool.query<{
      id: string;
      version_number: number;
      config_json: unknown;
    }>(
      `
        SELECT id, version_number, config_json
        FROM tenant_config_versions
        WHERE tenant_config_id = $1
          AND version_number < $2
        ORDER BY version_number DESC
        LIMIT 1
      `,
      [current.rows[0].tenant_config_id, current.rows[0].version_number],
    );

    const previousConfig = previous.rowCount ? previous.rows[0].config_json : {};
    const currentConfig = current.rows[0].config_json;
    const summary = summarizeDiff(previousConfig, currentConfig);

    return reply.send({
      current: {
        id: current.rows[0].id,
        version_number: current.rows[0].version_number,
        status: current.rows[0].status,
        config_json: currentConfig,
      },
      previous: previous.rowCount
        ? {
          id: previous.rows[0].id,
          version_number: previous.rows[0].version_number,
          config_json: previous.rows[0].config_json,
        }
        : null,
      citations: toArray(current.rows[0].match_results),
      summary,
    });
  },
);

app.get<{ Params: { versionId: string } }>(
  "/api/config-versions/:versionId/approvals",
  async (request, reply) => {
    const tenant = requireTenant(request);

    const versionResult = await pool.query<{ tenant_id: string; status: string }>(
      `
        SELECT tenant_id, status
        FROM tenant_config_versions
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.versionId],
    );
    if (!versionResult.rowCount) {
      return reply.code(404).send({ error: "config_version_not_found" });
    }
    if (versionResult.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const approvals = await pool.query(
      `
        SELECT id, approver_role, status, comment, decided_at, created_at
        FROM approvals
        WHERE tenant_config_version_id = $1
        ORDER BY created_at ASC
      `,
      [request.params.versionId],
    );

    const approvedRoles = new Set(
      approvals.rows
        .filter((row) => String(row.status) === "approved")
        .map((row) => String(row.approver_role).toLowerCase()),
    );
    const remainingRoles = REQUIRED_APPROVAL_ROLES.filter((role) => !approvedRoles.has(role));

    return reply.send({
      version_id: request.params.versionId,
      config_status: versionResult.rows[0].status,
      required_roles: REQUIRED_APPROVAL_ROLES,
      remaining_roles: remainingRoles,
      items: approvals.rows,
      count: approvals.rowCount,
    });
  },
);

app.post<{ Params: { versionId: string }; Body: { approver_role: string; status: string; comment?: string } }>(
  "/api/config-versions/:versionId/approvals",
  async (request, reply) => {
    const tenant = requireTenant(request);
    const approverRole = String(request.body?.approver_role ?? "").trim().toLowerCase();
    const decisionStatus = String(request.body?.status ?? "").trim().toLowerCase();
    const comment = request.body?.comment?.trim() ?? null;

    if (!approverRole) {
      return reply.code(400).send({ error: "approver_role_required" });
    }
    if (!["approved", "rejected"].includes(decisionStatus)) {
      return reply.code(400).send({ error: "status_must_be_approved_or_rejected" });
    }

    const versionResult = await pool.query<{ tenant_id: string; status: string }>(
      `
        SELECT tenant_id, status
        FROM tenant_config_versions
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.versionId],
    );
    if (!versionResult.rowCount) {
      return reply.code(404).send({ error: "config_version_not_found" });
    }
    if (versionResult.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }
    if (versionResult.rows[0].status === "blocked") {
      return reply.code(409).send({ error: "config_blocked_by_safety_guard" });
    }

    const existing = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM approvals
        WHERE tenant_config_version_id = $1
          AND lower(approver_role) = $2
        LIMIT 1
      `,
      [request.params.versionId, approverRole],
    );

    if (existing.rowCount) {
      await pool.query(
        `
          UPDATE approvals
          SET status = $1,
              comment = $2,
              decided_at = now()
          WHERE id = $3
        `,
        [decisionStatus, comment, existing.rows[0].id],
      );
    } else {
      await pool.query(
        `
          INSERT INTO approvals
            (tenant_config_version_id, tenant_id, approver_role, status, comment, decided_at)
          VALUES ($1, $2, $3, $4, $5, now())
        `,
        [request.params.versionId, tenant.id, approverRole, decisionStatus, comment],
      );
    }

    const allApprovals = await pool.query<{ approver_role: string; status: string }>(
      `
        SELECT approver_role, status
        FROM approvals
        WHERE tenant_config_version_id = $1
      `,
      [request.params.versionId],
    );

    const hasRejected = allApprovals.rows.some((row) => row.status === "rejected");
    const approvedRoles = new Set(
      allApprovals.rows
        .filter((row) => row.status === "approved")
        .map((row) => row.approver_role.toLowerCase()),
    );
    const allRequiredApproved = REQUIRED_APPROVAL_ROLES.every((role) => approvedRoles.has(role));

    let finalStatus = "pending_review";
    if (hasRejected) {
      finalStatus = "rejected";
    } else if (allRequiredApproved) {
      finalStatus = "approved";
    } else if (approvedRoles.size > 0) {
      finalStatus = "partially_approved";
    }

    await pool.query(
      `
        UPDATE tenant_config_versions
        SET status = $1
        WHERE id = $2
      `,
      [finalStatus, request.params.versionId],
    );

    await pool.query(
      `
        INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
        VALUES ($1, 'tenant_config', $2, 'config_approval_decision', NULL, $3::jsonb, $4)
      `,
      [
        tenant.id,
        request.params.versionId,
        JSON.stringify({
          approver_role: approverRole,
          decision: decisionStatus,
          final_status: finalStatus,
          required_roles: REQUIRED_APPROVAL_ROLES,
        }),
        `approver:${approverRole}`,
      ],
    );

    const remainingRoles = REQUIRED_APPROVAL_ROLES.filter((role) => !approvedRoles.has(role));
    return reply.send({
      version_id: request.params.versionId,
      status: finalStatus,
      required_roles: REQUIRED_APPROVAL_ROLES,
      remaining_roles: remainingRoles,
      partial_approval: finalStatus === "partially_approved",
    });
  },
);

app.post<{ Params: { versionId: string } }>(
  "/api/configs/:versionId/submit-review",
  async (request, reply) => {
    const tenant = requireTenant(request);
    const actor = getActor(request as unknown as { headers: Record<string, unknown> });

    const versionResult = await pool.query<{ tenant_id: string; status: string }>(
      `
        SELECT tenant_id, status
        FROM tenant_config_versions
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.versionId],
    );
    if (!versionResult.rowCount) {
      return reply.code(404).send({ error: "config_version_not_found" });
    }
    if (versionResult.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }
    if (versionResult.rows[0].status === "blocked") {
      return reply.code(409).send({ error: "config_blocked_by_safety_guard" });
    }

    await pool.query(
      `
        UPDATE tenant_config_versions
        SET status = 'pending_review'
        WHERE id = $1
      `,
      [request.params.versionId],
    );

    await pool.query(
      `
        INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
        VALUES ($1, 'tenant_config', $2, 'submitted_for_review', NULL, $3::jsonb, $4)
      `,
      [
        tenant.id,
        request.params.versionId,
        JSON.stringify({ status: "pending_review" }),
        `${actor.role}:${actor.userId}`,
      ],
    );

    return reply.send({ status: "pending_review" });
  },
);

app.post<{ Params: { versionId: string }; Body: { scope: string; comment?: string } }>(
  "/api/configs/:versionId/approve",
  async (request, reply) => {
    const tenant = requireTenant(request);
    const actor = getActor(request as unknown as { headers: Record<string, unknown> });
    const scope = String(request.body?.scope ?? "").trim().toLowerCase();
    const comment = request.body?.comment?.trim() ?? null;

    if (!scope) {
      return reply.code(400).send({ error: "scope_required" });
    }
    if (!canApprove(actor.role, scope)) {
      return reply.code(403).send({ error: "insufficient_role_for_scope" });
    }

    const versionResult = await pool.query<{ tenant_id: string; status: string }>(
      `
        SELECT tenant_id, status
        FROM tenant_config_versions
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.versionId],
    );
    if (!versionResult.rowCount) {
      return reply.code(404).send({ error: "config_version_not_found" });
    }
    if (versionResult.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }
    if (versionResult.rows[0].status === "blocked") {
      return reply.code(409).send({ error: "config_blocked_by_safety_guard" });
    }

    await pool.query(
      `
        INSERT INTO approvals
          (tenant_config_version_id, tenant_id, approver_role, approver_id, scope, status, comment, decided_at)
        VALUES ($1, $2, $3, $4, $5, 'approved', $6, now())
      `,
      [request.params.versionId, tenant.id, actor.role, actor.userId, scope, comment],
    );

    const approvals = await pool.query<{ scope: string; status: string }>(
      `
        SELECT scope, status
        FROM approvals
        WHERE tenant_config_version_id = $1
      `,
      [request.params.versionId],
    );

    const approvedScopes = new Set(
      approvals.rows.filter((row) => row.status === "approved").map((row) => row.scope.toLowerCase()),
    );
    const hasFullApproval = approvedScopes.has("full");
    const allApproved = hasFullApproval || REQUIRED_APPROVAL_SCOPES.every((requiredScope) => approvedScopes.has(requiredScope));

    if (allApproved) {
      await pool.query(
        `
          UPDATE tenant_config_versions
          SET status = 'approved'
          WHERE id = $1
        `,
        [request.params.versionId],
      );
    } else {
      await pool.query(
        `
          UPDATE tenant_config_versions
          SET status = 'partially_approved'
          WHERE id = $1
        `,
        [request.params.versionId],
      );
    }

    await pool.query(
      `
        INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
        VALUES ($1, 'tenant_config', $2, 'approved', NULL, $3::jsonb, $4)
      `,
      [
        tenant.id,
        request.params.versionId,
        JSON.stringify({ scope, comment, all_approved: allApproved }),
        `${actor.role}:${actor.userId}`,
      ],
    );

    return reply.send({ status: "approved", all_approved: allApproved });
  },
);

app.post<{ Params: { versionId: string }; Body: { scope: string; comment?: string } }>(
  "/api/configs/:versionId/reject",
  async (request, reply) => {
    const tenant = requireTenant(request);
    const actor = getActor(request as unknown as { headers: Record<string, unknown> });
    const scope = String(request.body?.scope ?? "").trim().toLowerCase();
    const comment = request.body?.comment?.trim() ?? null;

    if (!scope) {
      return reply.code(400).send({ error: "scope_required" });
    }
    if (!canApprove(actor.role, scope)) {
      return reply.code(403).send({ error: "insufficient_role_for_scope" });
    }

    const versionResult = await pool.query<{ tenant_id: string }>(
      `
        SELECT tenant_id
        FROM tenant_config_versions
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.versionId],
    );
    if (!versionResult.rowCount) {
      return reply.code(404).send({ error: "config_version_not_found" });
    }
    if (versionResult.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    await pool.query(
      `
        INSERT INTO approvals
          (tenant_config_version_id, tenant_id, approver_role, approver_id, scope, status, comment, decided_at)
        VALUES ($1, $2, $3, $4, $5, 'rejected', $6, now())
      `,
      [request.params.versionId, tenant.id, actor.role, actor.userId, scope, comment],
    );

    await pool.query(
      `
        UPDATE tenant_config_versions
        SET status = 'rejected'
        WHERE id = $1
      `,
      [request.params.versionId],
    );

    await pool.query(
      `
        INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
        VALUES ($1, 'tenant_config', $2, 'rejected', NULL, $3::jsonb, $4)
      `,
      [tenant.id, request.params.versionId, JSON.stringify({ scope, comment }), `${actor.role}:${actor.userId}`],
    );

    return reply.send({ status: "rejected" });
  },
);

app.get("/api/simulations", async (request, reply) => {
  const tenant = requireTenant(request);
  const result = await pool.query(
    `
      SELECT id, tenant_config_id, mode, status, results, triggered_by, created_at
      FROM simulation_runs
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `,
    [tenant.id],
  );
  return reply.send({ items: result.rows, count: result.rowCount });
});

app.post<{
  Body: {
    tenant_config_version_id: string;
    mode: "schema" | "dryrun" | "mock";
    scenario?: "success" | "partial_failure" | "timeout" | "schema_mismatch";
  };
}>("/api/simulations/run", async (request, reply) => {
  const tenant = requireTenant(request);
  const versionId = request.body?.tenant_config_version_id;
  const mode = request.body?.mode;
  const scenario = request.body?.scenario ?? "success";

  if (!versionId || !mode) {
    return reply.code(400).send({ error: "tenant_config_version_id_and_mode_required" });
  }

  const versionResult = await pool.query<{
    tenant_id: string;
    tenant_config_id: string;
    config_json: unknown;
  }>(
    `
      SELECT tenant_id, tenant_config_id, config_json
      FROM tenant_config_versions
      WHERE id = $1
      LIMIT 1
    `,
    [versionId],
  );

  if (!versionResult.rowCount) {
    return reply.code(404).send({ error: "config_version_not_found" });
  }
  if (versionResult.rows[0].tenant_id !== tenant.id) {
    return reply.code(403).send({ error: "cross_tenant_forbidden" });
  }

  const simulationRunId = crypto.randomUUID();
  await pool.query(
    `
      INSERT INTO simulation_runs
        (id, tenant_config_id, tenant_id, mode, status, results, triggered_by)
      VALUES ($1, $2, $3, $4, 'running', '{}'::jsonb, 'api')
    `,
    [simulationRunId, versionResult.rows[0].tenant_config_id, tenant.id, mode],
  );

  const configJson = toObject(versionResult.rows[0].config_json);
  const dag = toObject(configJson.dag);
  const nodes = toArray(dag.nodes).map((node) => toObject(node));

  let results: Record<string, unknown> = { mode, scenario, run_id: simulationRunId };

  if (mode === "schema") {
    const issues: string[] = [];
    for (const [index, node] of nodes.entries()) {
      if (!node.node_type) {
        issues.push(`nodes[${index}] missing node_type`);
      }
      if (!node.adapter_version_id) {
        issues.push(`nodes[${index}] missing adapter_version_id`);
      }
    }
    results = {
      ...results,
      valid: issues.length === 0,
      issues,
      checked_nodes: nodes.length,
    };
  } else if (mode === "dryrun") {
    results = {
      ...results,
      executed_nodes: nodes.length,
      traces: nodes.map((node, index) => ({
        node_id: node.id,
        node_type: node.node_type,
        adapter_version_id: node.adapter_version_id,
        dryrun_result: "ok",
        simulated_latency_ms: 100 + index * 25,
      })),
    };
  } else {
    const traces: Array<Record<string, unknown>> = [];
    for (const node of nodes) {
      const adapterVersionId = String(node.adapter_version_id ?? "");
      if (!adapterVersionId) {
        traces.push({ node_id: node.id, error: "missing_adapter_version_id" });
        continue;
      }

      const schemaResult = await pool.query<{ schema_def: unknown }>(
        `
          SELECT schema_def
          FROM adapter_versions
          WHERE id = $1
          LIMIT 1
        `,
        [adapterVersionId],
      );
      const schemaDef = schemaResult.rowCount ? schemaResult.rows[0].schema_def : {};

      let mockResponse: unknown = null;
      try {
        const response = await fetch(`${AI_SERVICE_URL}/mock-response`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adapterSchema: schemaDef, scenario }),
        });
        mockResponse = response.ok ? await response.json() : { error: `mock_service_${response.status}` };
      } catch (error) {
        mockResponse = { error: error instanceof Error ? error.message : "mock_service_unavailable" };
      }

      traces.push({
        node_id: node.id,
        node_type: node.node_type,
        adapter_version_id: adapterVersionId,
        scenario,
        response: mockResponse,
      });
    }

    results = {
      ...results,
      executed_nodes: nodes.length,
      traces,
    };
  }

  await pool.query(
    `
      UPDATE simulation_runs
      SET status = 'completed',
          results = $2::jsonb
      WHERE id = $1
    `,
    [simulationRunId, JSON.stringify(results)],
  );

  await pool.query(
    `
      INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
      VALUES ($1, 'simulation_run', $2, 'simulation_run_completed', NULL, $3::jsonb, 'api')
    `,
    [tenant.id, simulationRunId, JSON.stringify(results)],
  );

  return reply.send({ simulation_run_id: simulationRunId, status: "completed", results });
});

app.post<{
  Body: {
    tenant_config_id: string;
    version_a_id: string;
    version_b_id: string;
    test_payload?: Record<string, unknown>;
  };
}>("/api/simulations/parallel-test", async (request, reply) => {
  const tenant = requireTenant(request);
  const tenantConfigId = String(request.body?.tenant_config_id ?? "").trim();
  const versionAId = String(request.body?.version_a_id ?? "").trim();
  const versionBId = String(request.body?.version_b_id ?? "").trim();

  if (!tenantConfigId || !versionAId || !versionBId) {
    return reply.code(400).send({ error: "tenant_config_id_version_a_id_version_b_id_required" });
  }

  const ownerCheck = await pool.query<{ tenant_id: string }>(
    `
      SELECT tenant_id
      FROM tenant_configs
      WHERE id = $1
      LIMIT 1
    `,
    [tenantConfigId],
  );
  if (!ownerCheck.rowCount) {
    return reply.code(404).send({ error: "tenant_config_not_found" });
  }
  if (ownerCheck.rows[0].tenant_id !== tenant.id) {
    return reply.code(403).send({ error: "cross_tenant_forbidden" });
  }

  try {
    const response = await fetch(`${SIMULATOR_URL}/simulate/parallel-version-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantConfigId,
        versionAId,
        versionBId,
        testPayload: request.body?.test_payload ?? {},
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      return reply.code(502).send({ error: payload?.error ?? "parallel_simulation_failed" });
    }

    return reply.send(payload);
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "simulator_unreachable" });
  }
});

app.get("/api/adapters", async (_request, reply) => {
  const result = await pool.query(
    `
      SELECT
        a.id,
        a.name,
        a.category,
        a.provider,
        a.description,
        a.capability_tags,
        a.auth_type,
        COALESCE(
          json_agg(
            json_build_object(
              'id', av.id,
              'api_version', av.api_version,
              'schema_def', av.schema_def,
              'lifecycle_status', av.lifecycle_status,
              'mock_endpoint', av.mock_endpoint
            )
            ORDER BY av.api_version
          ) FILTER (WHERE av.id IS NOT NULL),
          '[]'::json
        ) AS versions
      FROM adapters a
      LEFT JOIN adapter_versions av ON av.adapter_id = a.id
      GROUP BY a.id
      ORDER BY a.category, a.name
    `,
  );

  return reply.send({ items: result.rows, count: result.rowCount });
});

app.get<{ Params: { category: string } }>(
  "/api/adapters/:category",
  async (request, reply) => {
    const result = await pool.query(
      `
        SELECT
          a.id,
          a.name,
          a.category,
          a.provider,
          a.description,
          a.capability_tags,
          a.auth_type,
          COALESCE(
            json_agg(
              json_build_object(
                'id', av.id,
                'api_version', av.api_version,
                'schema_def', av.schema_def,
                'lifecycle_status', av.lifecycle_status,
                'mock_endpoint', av.mock_endpoint
              )
              ORDER BY av.api_version
            ) FILTER (WHERE av.id IS NOT NULL),
            '[]'::json
          ) AS versions
        FROM adapters a
        LEFT JOIN adapter_versions av ON av.adapter_id = a.id
        WHERE a.category = $1
        GROUP BY a.id
        ORDER BY a.name
      `,
      [request.params.category],
    );

    return reply.send({
      category: request.params.category,
      items: result.rows,
      count: result.rowCount,
    });
  },
);

app.post("/api/documents/upload", async (request, reply) => {
  const tenant = requireTenant(request);
  const file = await request.file();
  if (!file) {
    return reply.code(400).send({ error: "file_required" });
  }

  const ext = path.extname(file.filename).toLowerCase();
  const allowedExt = new Set([".pdf", ".docx", ".txt"]);
  if (!allowedExt.has(ext)) {
    return reply.code(400).send({ error: "unsupported_file_type" });
  }

  const buffer = await file.toBuffer();
  const fingerprint = crypto.createHash("sha256").update(buffer).digest("hex");

  const existing = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM documents
      WHERE tenant_id = $1
        AND fingerprint = $2
      LIMIT 1
    `,
    [tenant.id, fingerprint],
  );
  if (existing.rowCount) {
    return reply.send({ document_id: existing.rows[0].id, status: "existing" });
  }

  const documentId = crypto.randomUUID();
  const objectPath = `tenants/${tenant.id}/docs/${documentId}/${file.filename}`;

  await putDocumentObject(
    objectPath,
    buffer,
    file.mimetype || "application/octet-stream",
  );

  await pool.query(
    `
      INSERT INTO documents
        (id, tenant_id, filename, storage_path, fingerprint, parse_status)
      VALUES ($1, $2, $3, $4, $5, 'uploaded')
    `,
    [documentId, tenant.id, file.filename, objectPath, fingerprint],
  );

  await enqueueDocumentParseJob({
    documentId,
    tenantId: tenant.id,
    objectPath,
    filename: file.filename,
    contentType: file.mimetype || "application/octet-stream",
  });

  return reply.code(201).send({ document_id: documentId, status: "queued" });
});

app.get("/api/documents", async (request, reply) => {
  const tenant = requireTenant(request);
  const result = await pool.query(
    `
      SELECT id, tenant_id, filename, storage_path, fingerprint, parse_status, created_at
      FROM documents
      WHERE tenant_id = $1
      ORDER BY created_at DESC
    `,
    [tenant.id],
  );
  return reply.send({ items: result.rows, count: result.rowCount });
});

app.get<{ Params: { documentId: string } }>(
  "/api/documents/:documentId",
  async (request, reply) => {
    const tenant = requireTenant(request);
    const result = await pool.query<{ id: string; tenant_id: string }>(
      `
        SELECT id, tenant_id, filename, storage_path, fingerprint, parse_status, created_at
        FROM documents
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.documentId],
    );

    if (!result.rowCount) {
      return reply.code(404).send({ error: "document_not_found" });
    }

    if (result.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    return reply.send(result.rows[0]);
  },
);

app.get("/api/audit-events", async (request, reply) => {
  const tenant = requireTenant(request);
  const result = await pool.query(
    `
      SELECT id, entity_type, entity_id, action, before, after, actor, created_at
      FROM audit_events
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `,
    [tenant.id],
  );

  return reply.send({ items: result.rows, count: result.rowCount });
});

app.get<{ Params: { tenantId: string } }>("/api/audit/:tenantId", async (request, reply) => {
  const tenant = requireTenant(request);
  if (tenant.id !== request.params.tenantId) {
    return reply.code(403).send({ error: "cross_tenant_forbidden" });
  }

  const result = await pool.query(
    `
      SELECT id, entity_type, entity_id, action, before, after, actor, created_at
      FROM audit_events
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `,
    [tenant.id],
  );
  return reply.send({ items: result.rows, count: result.rowCount });
});

app.get<{ Params: { tenantId: string; entityId: string } }>(
  "/api/audit/:tenantId/entity/:entityId",
  async (request, reply) => {
    const tenant = requireTenant(request);
    if (tenant.id !== request.params.tenantId) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const result = await pool.query(
      `
        SELECT id, entity_type, entity_id, action, before, after, actor, created_at
        FROM audit_events
        WHERE tenant_id = $1
          AND entity_id = $2::uuid
        ORDER BY created_at DESC
      `,
      [tenant.id, request.params.entityId],
    );
    return reply.send({ items: result.rows, count: result.rowCount });
  },
);

app.post<{
  Params: { configId: string };
  Body: {
    target_version: string;
    scope: "field_mapping_id" | "adapter_node" | "full_config";
    reason: string;
    field_mapping_id?: string;
  };
}>("/api/configs/:configId/rollback", async (request, reply) => {
  const tenant = requireTenant(request);
  const { target_version, scope, reason, field_mapping_id } = request.body ?? {};
  const actor = getActor(request as unknown as { headers: Record<string, unknown> });

  if (!target_version || !scope || !reason) {
    return reply.code(400).send({ error: "target_version_scope_reason_required" });
  }

  const configResult = await pool.query<{ tenant_id: string }>(
    `
      SELECT tenant_id
      FROM tenant_configs
      WHERE id = $1
      LIMIT 1
    `,
    [request.params.configId],
  );
  if (!configResult.rowCount) {
    return reply.code(404).send({ error: "tenant_config_not_found" });
  }
  if (configResult.rows[0].tenant_id !== tenant.id) {
    return reply.code(403).send({ error: "cross_tenant_forbidden" });
  }

  if (scope === "full_config") {
    const targetVersion = await pool.query<{
      id: string;
      tenant_config_id: string;
      tenant_id: string;
      config_json: unknown;
      source_document_id: string | null;
      generator_model: string | null;
      match_results: unknown;
    }>(
      `
        SELECT id, tenant_config_id, tenant_id, config_json, source_document_id, generator_model, match_results
        FROM tenant_config_versions
        WHERE id = $1
        LIMIT 1
      `,
      [target_version],
    );

    if (!targetVersion.rowCount) {
      return reply.code(404).send({ error: "target_version_not_found" });
    }
    if (targetVersion.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const nextVersionResult = await pool.query<{ next_version: number }>(
      `
        SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
        FROM tenant_config_versions
        WHERE tenant_config_id = $1
      `,
      [request.params.configId],
    );

    const nextVersion = nextVersionResult.rows[0].next_version;
    const newVersionId = crypto.randomUUID();

    await pool.query(
      `
        INSERT INTO tenant_config_versions
          (id, tenant_config_id, tenant_id, version_number, config_json, created_by, status, source_document_id, generator_model, match_results)
        VALUES ($1, $2, $3, $4, $5::jsonb, 'rollback', 'draft', $6, $7, $8::jsonb)
      `,
      [
        newVersionId,
        request.params.configId,
        tenant.id,
        nextVersion,
        JSON.stringify(targetVersion.rows[0].config_json),
        targetVersion.rows[0].source_document_id,
        targetVersion.rows[0].generator_model,
        JSON.stringify(targetVersion.rows[0].match_results ?? []),
      ],
    );

    await pool.query(
      `
        INSERT INTO config_rollbacks
          (tenant_config_id, tenant_id, source_version_id, new_version_id, scope, reason)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [request.params.configId, tenant.id, target_version, newVersionId, scope, reason],
    );

    await pool.query(
      `
        INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
        VALUES ($1, 'tenant_config', $2, 'rollback', NULL, $3::jsonb, $4)
      `,
      [
        tenant.id,
        newVersionId,
        JSON.stringify({ rolled_back_to: target_version, reason, new_version: newVersionId }),
        `${actor.role}:${actor.userId}`,
      ],
    );

    return reply.send({ new_version_id: newVersionId, status: "draft" });
  }

  if (scope === "field_mapping_id") {
    if (!field_mapping_id) {
      return reply.code(400).send({ error: "field_mapping_id_required" });
    }

    const currentMapping = await pool.query<{
      id: string;
      tenant_id: string;
      tenant_config_id: string;
      source_field: string;
      target_field: string;
      created_at: string;
    }>(
      `
        SELECT id, tenant_id, tenant_config_id, source_field, target_field, created_at
        FROM field_mappings
        WHERE id = $1
        LIMIT 1
      `,
      [field_mapping_id],
    );

    if (!currentMapping.rowCount) {
      return reply.code(404).send({ error: "field_mapping_not_found" });
    }
    if (currentMapping.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const previousMapping = await pool.query<{ transformation_rule: string | null }>(
      `
        SELECT transformation_rule
        FROM field_mappings
        WHERE tenant_config_id = $1
          AND source_field = $2
          AND target_field = $3
          AND created_at < $4::timestamptz
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [
        currentMapping.rows[0].tenant_config_id,
        currentMapping.rows[0].source_field,
        currentMapping.rows[0].target_field,
        currentMapping.rows[0].created_at,
      ],
    );

    if (!previousMapping.rowCount) {
      return reply.code(404).send({ error: "no_previous_field_mapping_version" });
    }

    await pool.query(
      `
        UPDATE field_mappings
        SET transformation_rule = $1
        WHERE id = $2
      `,
      [previousMapping.rows[0].transformation_rule, field_mapping_id],
    );

    await pool.query(
      `
        INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
        VALUES ($1, 'field_mapping', $2, 'rollback', NULL, $3::jsonb, $4)
      `,
      [tenant.id, field_mapping_id, JSON.stringify({ reason, scope }), `${actor.role}:${actor.userId}`],
    );

    return reply.send({ status: "field_mapping_reverted" });
  }

  return reply.code(400).send({ error: "unsupported_rollback_scope" });
});

app.get<{ Params: { tenantId: string } }>("/api/dashboard/:tenantId", async (request, reply) => {
  const tenant = requireTenant(request);
  if (tenant.id !== request.params.tenantId) {
    return reply.code(403).send({ error: "cross_tenant_forbidden" });
  }

  const [configHealth, adapterWarnings, pendingApprovals, simulationHistory, quotaUsage] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE status = 'approved') AS approved_configs,
          COUNT(*) FILTER (WHERE status IN ('pending_review', 'partially_approved')) AS configs_under_review,
          COUNT(*) FILTER (WHERE status = 'blocked') AS blocked_configs
        FROM tenant_config_versions
        WHERE tenant_id = $1
      `,
      [tenant.id],
    ),
    pool.query(
      `
        SELECT DISTINCT
          av.id AS adapter_version_id,
          av.api_version,
          av.lifecycle_status,
          a.name AS adapter_name
        FROM dag_nodes dn
        JOIN adapter_versions av ON av.id = dn.adapter_version_id
        JOIN adapters a ON a.id = av.adapter_id
        WHERE dn.tenant_id = $1
          AND av.lifecycle_status <> 'active'
      `,
      [tenant.id],
    ),
    pool.query(
      `
        SELECT id, version_number, status, created_at
        FROM tenant_config_versions
        WHERE tenant_id = $1
          AND status IN ('pending_review', 'partially_approved')
        ORDER BY created_at DESC
      `,
      [tenant.id],
    ),
    pool.query(
      `
        SELECT id, mode, status, results, created_at
        FROM simulation_runs
        WHERE tenant_id = $1
          AND created_at >= now() - interval '30 days'
        ORDER BY created_at DESC
      `,
      [tenant.id],
    ),
    pool.query(
      `
        SELECT
          COUNT(*) AS simulation_runs_this_month,
          COUNT(*) FILTER (WHERE mode = 'mock') AS mock_runs_this_month
        FROM simulation_runs
        WHERE tenant_id = $1
          AND date_trunc('month', created_at) = date_trunc('month', now())
      `,
      [tenant.id],
    ),
  ]);

  return reply.send({
    integration_health: configHealth.rows[0],
    adapter_warnings: adapterWarnings.rows,
    pending_approvals: pendingApprovals.rows,
    simulation_history: simulationHistory.rows,
    quota_usage: quotaUsage.rows[0],
  });
});

app.post("/api/jobs/drift-detection/run", async (request, reply) => {
  const tenant = requireTenant(request);
  const actor = getActor(request as unknown as { headers: Record<string, unknown> });
  if (actor.role !== "admin" && actor.role !== "architect") {
    return reply.code(403).send({ error: "insufficient_role" });
  }

  const result = await detectConfigDrift(pool);
  return reply.send({
    triggered_by: `${actor.role}:${actor.userId}`,
    scoped_tenant: tenant.id,
    ...result,
  });
});

app.get<{ Params: { tenantId: string } }>("/api/drift-alerts/:tenantId", async (request, reply) => {
  const tenant = requireTenant(request);
  if (tenant.id !== request.params.tenantId) {
    return reply.code(403).send({ error: "cross_tenant_forbidden" });
  }

  const result = await pool.query(
    `
      SELECT id, entity_id, after, created_at
      FROM audit_events
      WHERE tenant_id = $1
        AND action = 'drift_detected'
      ORDER BY created_at DESC
      LIMIT 100
    `,
    [tenant.id],
  );

  return reply.send({ items: result.rows, count: result.rowCount });
});

app.get("/api/secrets/resolve", async (request, reply) => {
  const tenant = requireTenant(request);
  const pathQuery = (request.query as { path?: string }).path;
  if (!pathQuery) {
    return reply.code(400).send({ error: "path_query_required" });
  }

  try {
    await secretsService.resolve(pathQuery, tenant.id);
    return reply.send({ path: pathQuery, status: "resolved" });
  } catch {
    return reply.code(404).send({ error: "secret_not_found_or_forbidden" });
  }
});

// ── Document pipeline status (lightweight poll) ───────────────────────────
app.get<{ Params: { documentId: string } }>(
  "/api/documents/:documentId/status",
  async (request, reply) => {
    const tenant = requireTenant(request);
    const result = await pool.query<{ id: string; tenant_id: string; parse_status: string; updated_at: string }>(
      `
        SELECT id, tenant_id, parse_status, updated_at
        FROM documents
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.documentId],
    );

    if (!result.rowCount) {
      return reply.code(404).send({ error: "document_not_found" });
    }
    if (result.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const { id, parse_status, updated_at } = result.rows[0];
    return reply.send({ document_id: id, parse_status, updated_at });
  },
);

// ── Requirements listing ──────────────────────────────────────────────────
app.get("/api/requirements", async (request, reply) => {
  const tenant = requireTenant(request);
  const { document_id } = request.query as { document_id?: string };

  const result = await pool.query(
    `
      SELECT
        r.id, r.document_id, r.service_type, r.mandatory, r.confidence,
        r.source_sentence, r.status, r.requirement_id, r.provider_hint,
        r.fields_needed, r.conditions, r.api_action, r.notes,
        r.extraction_attempt, r.created_at
      FROM requirements r
      WHERE r.tenant_id = $1
        ${document_id ? "AND r.document_id = $2" : ""}
      ORDER BY r.created_at DESC
      LIMIT 200
    `,
    document_id ? [tenant.id, document_id] : [tenant.id],
  );

  return reply.send({ items: result.rows, count: result.rowCount });
});

// ── Requirements for a specific document ─────────────────────────────────
app.get<{ Params: { documentId: string } }>(
  "/api/documents/:documentId/requirements",
  async (request, reply) => {
    const tenant = requireTenant(request);

    // Verify document ownership first
    const docCheck = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM documents WHERE id = $1 LIMIT 1",
      [request.params.documentId],
    );
    if (!docCheck.rowCount) {
      return reply.code(404).send({ error: "document_not_found" });
    }
    if (docCheck.rows[0].tenant_id !== tenant.id) {
      return reply.code(403).send({ error: "cross_tenant_forbidden" });
    }

    const result = await pool.query(
      `
        SELECT
          id, service_type, mandatory, confidence, source_sentence, status,
          requirement_id, provider_hint, fields_needed, conditions,
          api_action, notes, created_at
        FROM requirements
        WHERE document_id = $1 AND tenant_id = $2
        ORDER BY mandatory DESC, confidence DESC
      `,
      [request.params.documentId, tenant.id],
    );

    return reply.send({ document_id: request.params.documentId, items: result.rows, count: result.rowCount });
  },
);

app.addHook("onClose", async () => {
  if (driftInterval) {
    clearInterval(driftInterval);
  }
  if (_documentWorker) {
    await _documentWorker.close();
  }
  if (_workerRedis) {
    await _workerRedis.quit();
  }
  await closeQueue();
  await closePool();
});

if (DRIFT_DETECTION_ENABLED) {
  driftInterval = setInterval(() => {
    void detectConfigDrift(pool).catch((error: unknown) => {
      app.log.error({ error }, "drift detection cycle failed");
    });
  }, DRIFT_DETECTION_INTERVAL_MS);
}


app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`API listening on ${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
