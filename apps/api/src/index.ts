import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { pool, closePool } from "./db.js";
import { closeQueue, enqueueDocumentParseJob } from "./queue.js";
import { SecretsService } from "./secrets.js";
import { putDocumentObject } from "./storage.js";
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

app.addHook("onClose", async () => {
  await closeQueue();
  await closePool();
});

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`API listening on ${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
