import crypto from "node:crypto";
import { withDbClient } from "./db.mjs";

const now = new Date().toISOString();
const tenantId = crypto.randomUUID();
const tenantConfigId = crypto.randomUUID();
const version1 = crypto.randomUUID();
const version2 = crypto.randomUUID();
const simulationId = crypto.randomUUID();

await withDbClient(async (client) => {
  await client.query("BEGIN");
  try {
    await client.query(
      `
        INSERT INTO tenants (id, name, status, created_at)
        VALUES ($1, 'FirstCapital Bank', 'active', now())
        ON CONFLICT (id) DO NOTHING
      `,
      [tenantId],
    );

    await client.query(
      `
        INSERT INTO tenant_configs (id, tenant_id, name, current_version_id, created_at)
        VALUES ($1, $2, 'default', $3, now())
        ON CONFLICT (id) DO NOTHING
      `,
      [tenantConfigId, tenantId, version1],
    );

    const baseConfig = {
      service_credentials: { cibil_api_key: `vault://${tenantId}/cibil-prod-key` },
      field_mappings: [
        {
          source_field: "customer.pan",
          target_field: "pan",
          transformation_rule: "direct",
          source_sentence: "PAN verification must be performed for all applicants.",
          confidence: 0.95,
          requires_human_review: false,
        },
      ],
      dag: {
        nodes: [
          { id: crypto.randomUUID(), node_type: "verify", adapter_version_id: null, timeout_ms: 5000, retry_policy: { max_attempts: 3 } },
        ],
        edges: [],
      },
      match_results: [],
    };

    const draftConfig = {
      ...baseConfig,
      field_mappings: [
        ...baseConfig.field_mappings,
        {
          source_field: "customer.aadhaar",
          target_field: "aadhaar_hash",
          transformation_rule: "compute",
          transformation_expression: "sha256(customer.aadhaar)",
          source_sentence: "Aadhaar eKYC is required for all individual applicants.",
          confidence: 0.81,
          requires_human_review: true,
        },
      ],
    };

    await client.query(
      `
        INSERT INTO tenant_config_versions
          (id, tenant_config_id, tenant_id, version_number, config_json, created_by, status, created_at)
        VALUES
          ($1, $2, $3, 1, $4::jsonb, 'demo-seed', 'approved', now()),
          ($5, $2, $3, 2, $6::jsonb, 'demo-seed', 'pending_review', now())
        ON CONFLICT (id) DO NOTHING
      `,
      [version1, tenantConfigId, tenantId, JSON.stringify(baseConfig), version2, JSON.stringify(draftConfig)],
    );

    await client.query(
      `
        INSERT INTO approvals
          (tenant_config_version_id, tenant_id, approver_role, approver_id, scope, status, comment, decided_at, created_at)
        VALUES
          ($1, $2, 'engineer', 'demo-engineer', 'field_mappings', 'approved', 'field mappings look good', now(), now())
      `,
      [version2, tenantId],
    );

    await client.query(
      `
        INSERT INTO simulation_runs
          (id, tenant_config_id, tenant_id, mode, status, results, triggered_by, created_at)
        VALUES
          ($1, $2, $3, 'mock', 'completed', $4::jsonb, 'demo-seed', now())
      `,
      [simulationId, tenantConfigId, tenantId, JSON.stringify({
        scenario: "partial_failure",
        traces: [{ adapter: "CIBIL", status: "failed", error: "sandbox_timeout" }],
      })],
    );

    await client.query(
      `
        INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor, created_at)
        VALUES
          ($1, 'tenant_config', $2, 'demo_seeded', NULL, $3::jsonb, 'demo-seed', now())
      `,
      [tenantId, version2, JSON.stringify({
        tenant: "FirstCapital Bank",
        baseline_version: 1,
        draft_version: 2,
        seeded_at: now,
      })],
    );

    await client.query(
      `
        UPDATE tenant_configs
        SET current_version_id = $1
        WHERE id = $2
      `,
      [version1, tenantConfigId],
    );

    await client.query("COMMIT");
    process.stdout.write(`Demo seed complete for tenant ${tenantId}\n`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
});
