import { pool } from "./db.js";

function parseVaultPath(path: string): { tenantId: string; refKey: string } {
  if (!path.startsWith("vault://")) {
    throw new Error("Secret reference must start with vault://");
  }

  const normalized = path.replace("vault://", "");
  const [tenantId, ...rest] = normalized.split("/");
  const refKey = rest.join("/");

  if (!tenantId || !refKey) {
    throw new Error("Secret reference must be vault://<tenant_id>/<ref_key>");
  }

  return { tenantId, refKey };
}

export class SecretsService {
  private encryptionKey: string;

  constructor(encryptionKey: string) {
    this.encryptionKey = encryptionKey;
  }

  async store(tenantId: string, refKey: string, value: string): Promise<string> {
    const vaultPath = `vault://${tenantId}/${refKey}`;

    await pool.query(
      `
        INSERT INTO secrets_refs (tenant_id, ref_key, vault_path)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, ref_key)
        DO UPDATE SET vault_path = EXCLUDED.vault_path
      `,
      [tenantId, refKey, vaultPath],
    );

    await pool.query(
      `
        INSERT INTO encrypted_secrets (tenant_id, vault_path, encrypted_value)
        VALUES ($1, $2, pgp_sym_encrypt($3, $4, 'cipher-algo=aes256,compress-algo=1'))
        ON CONFLICT (vault_path)
        DO UPDATE SET
          encrypted_value = EXCLUDED.encrypted_value,
          updated_at = now()
      `,
      [tenantId, vaultPath, value, this.encryptionKey],
    );

    return vaultPath;
  }

  async resolve(path: string, tenantId: string): Promise<string> {
    const parsed = parseVaultPath(path);
    if (parsed.tenantId !== tenantId) {
      throw new Error("Cross-tenant secret access forbidden");
    }

    const result = await pool.query(
      `
        SELECT pgp_sym_decrypt(es.encrypted_value, $2)::text AS value
        FROM encrypted_secrets es
        WHERE es.vault_path = $1
          AND es.tenant_id = $3
      `,
      [path, this.encryptionKey, tenantId],
    );

    if (!result.rowCount) {
      throw new Error("Secret not found");
    }

    return (result.rows[0] as { value: string }).value;
  }
}
