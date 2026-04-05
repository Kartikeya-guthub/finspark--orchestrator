import { Pool, type PoolClient } from "pg";

type GoldenAdapter = {
  name: string;
  category: string;
  provider: string;
  apiVersion: string;
  requestSchema: Record<string, string>;
};

const pool = new Pool({
  connectionString: "postgresql://finspark:finspark@localhost:5432/finspark",
});

const goldenAdapters: GoldenAdapter[] = [
  {
    name: "CIBIL Credit Report",
    category: "BUREAU",
    provider: "TransUnion",
    apiVersion: "v3.0",
    requestSchema: {
      pan: "string",
      name: "string",
      consent: "boolean",
    },
  },
  {
    name: "Aadhaar eKYC",
    category: "KYC",
    provider: "UIDAI",
    apiVersion: "v2.0",
    requestSchema: {
      aadhaar_no: "string",
      otp: "string",
    },
  },
  {
    name: "Razorpay Disburse",
    category: "PAYMENT",
    provider: "Razorpay",
    apiVersion: "v1.0",
    requestSchema: {
      amount: "number",
      account_no: "string",
      ifsc: "string",
    },
  },
  {
    name: "FraudShield",
    category: "FRAUD",
    provider: "internal",
    apiVersion: "v2.0",
    requestSchema: {
      ip: "string",
      phone: "string",
    },
  },
];

async function upsertAdapter(client: PoolClient, adapter: GoldenAdapter): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM adapters WHERE name = $1 AND provider = $2 LIMIT 1",
    [adapter.name, adapter.provider],
  );

  if (existing.rowCount && existing.rows[0]) {
    await client.query(
      "UPDATE adapters SET category = $1 WHERE id = $2",
      [adapter.category, existing.rows[0].id],
    );
    return existing.rows[0].id;
  }

  const inserted = await client.query<{ id: string }>(
    "INSERT INTO adapters (name, category, provider) VALUES ($1, $2, $3) RETURNING id",
    [adapter.name, adapter.category, adapter.provider],
  );

  return inserted.rows[0].id;
}

async function upsertAdapterVersion(
  client: PoolClient,
  adapterId: string,
  adapter: GoldenAdapter,
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM adapter_versions WHERE adapter_id = $1 AND api_version = $2 LIMIT 1",
    [adapterId, adapter.apiVersion],
  );

  const requestSchema = adapter.requestSchema;
  const responseSchema = {
    status: "string",
    data: requestSchema,
  };

  if (existing.rowCount && existing.rows[0]) {
    await client.query(
      "UPDATE adapter_versions SET request_schema = $1::jsonb, response_schema = $2::jsonb WHERE id = $3",
      [JSON.stringify(requestSchema), JSON.stringify(responseSchema), existing.rows[0].id],
    );
    return;
  }

  await client.query(
    "INSERT INTO adapter_versions (adapter_id, api_version, request_schema, response_schema) VALUES ($1, $2, $3::jsonb, $4::jsonb)",
    [adapterId, adapter.apiVersion, JSON.stringify(requestSchema), JSON.stringify(responseSchema)],
  );
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const adapter of goldenAdapters) {
      const adapterId = await upsertAdapter(client, adapter);
      await upsertAdapterVersion(client, adapterId, adapter);
    }

    await client.query("COMMIT");
    console.log("Golden adapter registry seeded successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();