type Queryable = {
  query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
};

export type DriftAlert = {
  tenant_id: string;
  tenant_config_id: string;
  tenant_config_version_id: string;
  type: "deprecated_adapter" | "simulation_stale" | "upgrade_available";
  severity: "warning" | "info";
  message: string;
  action: string;
  metadata?: Record<string, unknown>;
};

async function writeAlertAudit(db: Queryable, alert: DriftAlert) {
  await db.query(
    `
      INSERT INTO audit_events (tenant_id, entity_type, entity_id, action, before, after, actor)
      VALUES ($1, 'tenant_config', $2, 'drift_detected', NULL, $3::jsonb, 'drift-detector')
    `,
    [
      alert.tenant_id,
      alert.tenant_config_version_id,
      JSON.stringify({
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        action: alert.action,
        metadata: alert.metadata ?? {},
      }),
    ],
  );
}

export async function detectConfigDrift(db: Queryable) {
  const tenants = await db.query<{ id: string }>(
    `
      SELECT id
      FROM tenants
      WHERE status = 'active'
    `,
  );

  const alerts: DriftAlert[] = [];

  for (const tenant of tenants.rows) {
    const configs = await db.query<{
      tenant_config_id: string;
      current_version_id: string | null;
      updated_at: string;
    }>(
      `
        SELECT tc.id AS tenant_config_id,
               tc.current_version_id,
               COALESCE(tcv.created_at, tc.created_at) AS updated_at
        FROM tenant_configs tc
        LEFT JOIN tenant_config_versions tcv ON tcv.id = tc.current_version_id
        WHERE tc.tenant_id = $1
      `,
      [tenant.id],
    );

    for (const config of configs.rows) {
      if (!config.current_version_id) {
        continue;
      }

      const deprecatedAdapters = await db.query<{
        api_version: string;
        adapter_name: string;
      }>(
        `
          SELECT av.api_version, a.name AS adapter_name
          FROM dag_nodes dn
          JOIN adapter_versions av ON av.id = dn.adapter_version_id
          JOIN adapters a ON a.id = av.adapter_id
          WHERE dn.tenant_config_id = $1
            AND dn.tenant_id = $2
            AND av.lifecycle_status = 'deprecated'
          LIMIT 3
        `,
        [config.tenant_config_id, tenant.id],
      );

      if (deprecatedAdapters.rowCount) {
        const first = deprecatedAdapters.rows[0];
        alerts.push({
          tenant_id: tenant.id,
          tenant_config_id: config.tenant_config_id,
          tenant_config_version_id: config.current_version_id,
          type: "deprecated_adapter",
          severity: "warning",
          message: `${first.adapter_name} ${first.api_version} is deprecated`,
          action: "Migrate to newer version",
          metadata: { adapters: deprecatedAdapters.rows },
        });
      }

      const lastSimulation = await db.query<{ created_at: string }>(
        `
          SELECT created_at
          FROM simulation_runs
          WHERE tenant_config_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [config.tenant_config_id],
      );

      if (!lastSimulation.rowCount || new Date(lastSimulation.rows[0].created_at) < new Date(config.updated_at)) {
        alerts.push({
          tenant_id: tenant.id,
          tenant_config_id: config.tenant_config_id,
          tenant_config_version_id: config.current_version_id,
          type: "simulation_stale",
          severity: "warning",
          message: "Config modified since last simulation",
          action: "Re-run simulation before production use",
        });
      }

      const upgrades = await db.query<{
        api_version: string;
        adapter_name: string;
      }>(
        `
          SELECT DISTINCT newer.api_version, a.name AS adapter_name
          FROM dag_nodes dn
          JOIN adapter_versions current_av ON current_av.id = dn.adapter_version_id
          JOIN adapter_versions newer ON newer.adapter_id = current_av.adapter_id
          JOIN adapters a ON a.id = newer.adapter_id
          WHERE dn.tenant_config_id = $1
            AND dn.tenant_id = $2
            AND newer.lifecycle_status = 'recommended'
            AND newer.id <> current_av.id
          LIMIT 3
        `,
        [config.tenant_config_id, tenant.id],
      );

      if (upgrades.rowCount) {
        const first = upgrades.rows[0];
        alerts.push({
          tenant_id: tenant.id,
          tenant_config_id: config.tenant_config_id,
          tenant_config_version_id: config.current_version_id,
          type: "upgrade_available",
          severity: "info",
          message: `New version ${first.api_version} available for ${first.adapter_name}`,
          action: "Run parallel version test before upgrading",
          metadata: { available: upgrades.rows },
        });
      }
    }
  }

  for (const alert of alerts) {
    await writeAlertAudit(db, alert);
  }

  return {
    scanned_tenants: tenants.rowCount ?? tenants.rows.length,
    alerts_count: alerts.length,
    alerts,
  };
}
