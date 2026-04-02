import { Pool } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    `postgresql://${process.env.POSTGRES_USER ?? "finspark"}:${process.env.POSTGRES_PASSWORD ?? "finspark"}@${process.env.POSTGRES_HOST ?? "127.0.0.1"}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "finspark"}`,
});

export async function closePool(): Promise<void> {
  await pool.end();
}
