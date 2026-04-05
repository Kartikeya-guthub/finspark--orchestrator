# Phase 2 Knowledge Base Report

## Scope Completed

Phase 2 delivered the following:

1. Shared TypeScript contracts in `packages/shared/types/index.ts`.
2. Golden adapter registry seed script in `scripts/seed-registry.ts`.
3. Basic API scaffold in `apps/api/index.ts` with:
   - `GET /health`
   - `GET /api/adapters`

## File Tree Delta

```text
.
├── apps/
│   └── api/
│       └── index.ts
├── packages/
│   └── shared/
│       └── types/
│           └── index.ts
└── scripts/
    └── seed-registry.ts
```

## packages/shared/types/index.ts (Exact Content)

```ts
export enum ServiceCategory {
  BUREAU = "BUREAU",
  KYC = "KYC",
  GST = "GST",
  PAYMENT = "PAYMENT",
  FRAUD = "FRAUD",
  OPEN_BANKING = "OPEN_BANKING",
}

export interface Tenant {
  id: string;
  name: string;
  status: string;
}

export interface Document {
  id: string;
  tenant_id: string;
  filename: string;
  storage_path: string;
  fingerprint: string;
  parse_status: string;
}

export interface Requirement {
  id: string;
  document_id: string;
  tenant_id: string;
  service_type: ServiceCategory | string;
  mandatory: boolean;
  confidence: number;
  source_sentence: string | null;
  conditions: Record<string, unknown>;
  api_action: string | null;
}

export interface Adapter {
  id: string;
  name: string;
  category: ServiceCategory | string;
  provider: string;
}

export interface AdapterVersion {
  id: string;
  adapter_id: string;
  api_version: string;
  request_schema: Record<string, unknown>;
  response_schema: Record<string, unknown>;
  embedding: number[] | null;
}

export interface ConfigVersion {
  id: string;
  tenant_config_id: string;
  version_number: number;
  config_json: Record<string, unknown>;
  status: string;
}

export interface DAGNode {
  id: string;
  tenant_config_version_id: string;
  adapter_version_id: string | null;
  node_type: string;
  condition: Record<string, unknown>;
}

export interface DAGEdge {
  id: string;
  tenant_config_version_id: string;
  from_node_id: string;
  to_node_id: string;
}

export interface FieldMapping {
  id: string;
  tenant_config_version_id: string;
  source_field: string;
  target_field: string;
  confidence: number;
}
```

## scripts/seed-registry.ts (Exact Content)

```ts
import { Pool } from "pg";

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

async function upsertAdapter(client: Awaited<ReturnType<typeof pool.connect>>, adapter: GoldenAdapter): Promise<string> {
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
  client: Awaited<ReturnType<typeof pool.connect>>,
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
```

## apps/api/index.ts (Exact Content)

```ts
import Fastify from "fastify";
import { Pool } from "pg";

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 8000);

const pool = new Pool({
  connectionString: "postgresql://finspark:finspark@localhost:5432/finspark",
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

app.addHook("onClose", async () => {
  await pool.end();
});

async function start(): Promise<void> {
  try {
    await app.listen({ host: "0.0.0.0", port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
```

## Run Notes

```bash
# Seed the golden adapter registry (requires tsx or ts-node)
npx tsx scripts/seed-registry.ts

# Start API scaffold
npx tsx apps/api/index.ts

# Verify endpoints
curl http://localhost:8000/health
curl http://localhost:8000/api/adapters
```