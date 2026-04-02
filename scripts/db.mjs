import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

export function loadEnvFromDotEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function getPostgresConnectionString() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const user = process.env.POSTGRES_USER ?? "finspark";
  const password = process.env.POSTGRES_PASSWORD ?? "finspark";
  const host = process.env.POSTGRES_HOST ?? "127.0.0.1";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const db = process.env.POSTGRES_DB ?? "finspark";
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

export async function withDbClient(run) {
  loadEnvFromDotEnv();
  const client = new Client({ connectionString: getPostgresConnectionString() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export function getMigrationFiles(filterFn) {
  const migrationsDir = path.join(repoRoot, "infra", "postgres", "migrations");
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .filter(filterFn)
    .sort()
    .map((name) => ({
      name,
      fullPath: path.join(migrationsDir, name),
      sql: fs.readFileSync(path.join(migrationsDir, name), "utf8"),
    }));
}
