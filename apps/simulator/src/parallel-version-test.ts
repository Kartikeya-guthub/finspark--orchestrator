import { Pool } from "pg";

type VersionSimulationResult = {
  version_id: string;
  response_fields: string[];
  avg_latency_ms: number;
  sample_response: Record<string, unknown>;
};

type BreakingChange = {
  old_name: string;
  new_name: string;
  type: "removed" | "renamed";
};

function extractResponseFields(schemaDef: unknown): string[] {
  if (!schemaDef || typeof schemaDef !== "object") {
    return [];
  }
  const responseSchema = (schemaDef as { response_schema?: { fields?: unknown[] } }).response_schema;
  const fields = Array.isArray(responseSchema?.fields) ? responseSchema.fields : [];
  return fields.map((field) => String(field)).filter(Boolean);
}

function buildSampleResponse(fields: string[], suffix: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    payload[field] = `${field}_${suffix}`;
  }
  return payload;
}

function detectRenames(removed: string[], added: string[]): Array<{ old_name: string; new_name: string }> {
  const renamed: Array<{ old_name: string; new_name: string }> = [];

  for (const oldField of removed) {
    const normalizedOld = oldField.toLowerCase().replace(/[_\s-]+/g, "");
    const candidate = added.find((addedField) => {
      const normalizedAdded = addedField.toLowerCase().replace(/[_\s-]+/g, "");
      return normalizedOld.includes(normalizedAdded) || normalizedAdded.includes(normalizedOld);
    });

    if (candidate) {
      renamed.push({ old_name: oldField, new_name: candidate });
    }
  }

  return renamed;
}

export class ParallelVersionTester {
  constructor(private readonly dbPool: Pool) {}

  private async simulateWithVersion(versionId: string, testPayload: Record<string, unknown>): Promise<VersionSimulationResult> {
    const versionResult = await this.dbPool.query<{ schema_def: unknown }>(
      `
        SELECT schema_def
        FROM adapter_versions
        WHERE id = $1
        LIMIT 1
      `,
      [versionId],
    );

    if (!versionResult.rowCount) {
      throw new Error(`adapter_version_not_found:${versionId}`);
    }

    const responseFields = extractResponseFields(versionResult.rows[0].schema_def);
    const payloadSize = JSON.stringify(testPayload).length;
    const avgLatency = Math.max(40, 140 - Math.min(payloadSize / 10, 60));

    return {
      version_id: versionId,
      response_fields: responseFields,
      avg_latency_ms: Math.round(avgLatency),
      sample_response: buildSampleResponse(responseFields, versionId.slice(0, 8)),
    };
  }

  private compareVersionResults(resultA: VersionSimulationResult, resultB: VersionSimulationResult) {
    const added = resultB.response_fields.filter((field) => !resultA.response_fields.includes(field));
    const removed = resultA.response_fields.filter((field) => !resultB.response_fields.includes(field));
    const renamed = detectRenames(removed, added);

    const renamedOld = new Set(renamed.map((item) => item.old_name));
    const renamedNew = new Set(renamed.map((item) => item.new_name));

    const pureRemoved = removed.filter((item) => !renamedOld.has(item));
    const pureAdded = added.filter((item) => !renamedNew.has(item));

    const breaking: BreakingChange[] = [
      ...pureRemoved.map((field) => ({ old_name: field, new_name: "", type: "removed" as const })),
      ...renamed.map((item) => ({ old_name: item.old_name, new_name: item.new_name, type: "renamed" as const })),
    ];

    return {
      added: pureAdded,
      removed: pureRemoved,
      renamed,
      breaking,
      schema_changes: {
        version_a_fields: resultA.response_fields,
        version_b_fields: resultB.response_fields,
      },
    };
  }

  private async computeMigrationImpact(tenantConfigId: string, breakingChanges: BreakingChange[]) {
    const impactedTargets = breakingChanges
      .map((item) => item.old_name)
      .filter((item) => item.length > 0);

    if (impactedTargets.length === 0) {
      return [];
    }

    const mappings = await this.dbPool.query<{
      id: string;
      source_field: string;
      target_field: string;
    }>(
      `
        SELECT id, source_field, target_field
        FROM field_mappings
        WHERE tenant_config_id = $1
          AND target_field = ANY($2::text[])
      `,
      [tenantConfigId, impactedTargets],
    );

    return mappings.rows.map((mapping) => {
      const matchedChange = breakingChanges.find((change) => change.old_name === mapping.target_field);
      return {
        mapping_id: mapping.id,
        source_field: mapping.source_field,
        old_target: mapping.target_field,
        new_target: matchedChange?.new_name || null,
        auto_fixable: Boolean(matchedChange?.new_name),
      };
    });
  }

  async runParallelTest(
    tenantConfigId: string,
    versionAId: string,
    versionBId: string,
    testPayload: Record<string, unknown>,
  ) {
    const [resultA, resultB] = await Promise.all([
      this.simulateWithVersion(versionAId, testPayload),
      this.simulateWithVersion(versionBId, testPayload),
    ]);

    const diff = this.compareVersionResults(resultA, resultB);

    return {
      version_a: { version: versionAId, results: resultA },
      version_b: { version: versionBId, results: resultB },
      comparison: {
        response_schema_diff: diff.schema_changes,
        added_fields: diff.added,
        removed_fields: diff.removed,
        renamed_fields: diff.renamed,
        performance_delta_ms: resultB.avg_latency_ms - resultA.avg_latency_ms,
        breaking_changes: diff.breaking,
        migration_impact: await this.computeMigrationImpact(tenantConfigId, diff.breaking),
        recommendation: diff.breaking.length === 0 ? "safe_to_upgrade" : "review_required",
      },
    };
  }
}
