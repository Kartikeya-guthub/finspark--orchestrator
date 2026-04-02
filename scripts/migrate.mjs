import { getMigrationFiles, withDbClient } from "./db.mjs";

await withDbClient(async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrations = getMigrationFiles((name) => !name.includes("seed"));

  for (const migration of migrations) {
    const alreadyApplied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [migration.name],
    );

    if (alreadyApplied.rowCount) {
      process.stdout.write(`Skipping ${migration.name} (already applied)\n`);
      continue;
    }

    process.stdout.write(`Applying ${migration.name}...\n`);
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [
        migration.name,
      ]);
      await client.query("COMMIT");
      process.stdout.write(`Applied ${migration.name}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  process.stdout.write("Migrations complete.\n");
});
