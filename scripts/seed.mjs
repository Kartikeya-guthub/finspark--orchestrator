import crypto from "node:crypto";

import { getMigrationFiles, withDbClient } from "./db.mjs";

function localEmbedding(text, dimensions = 256) {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  for (const token of tokens) {
    const digest = crypto.createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4] % 2 === 0 ? -1 : 1;
    const magnitude = digest.readUInt32BE(5) / 0xffffffff;
    vector[index] += sign * (0.25 + magnitude);
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

await withDbClient(async (client) => {
  const seeds = getMigrationFiles((name) => name.includes("seed"));

  for (const seedFile of seeds) {
    process.stdout.write(`Seeding via ${seedFile.name}...\n`);
    await client.query("BEGIN");
    try {
      await client.query(seedFile.sql);
      await client.query("COMMIT");
      process.stdout.write(`Seeded ${seedFile.name}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  const embeddingModel = process.env.NVIDIA_EMBEDDINGS_MODEL ?? "nvidia/llama-3.2-nv-embedqa-1b-v2";
  const adapterRows = await client.query(
    `
      SELECT id, name, category, provider, description, capability_tags
      FROM adapters
      ORDER BY name
    `,
  );

  await client.query("BEGIN");
  try {
    for (const adapter of adapterRows.rows) {
      const embeddingText = [adapter.name, adapter.category, adapter.provider, adapter.description, ...(adapter.capability_tags ?? [])].join(" ");
      const embedding = localEmbedding(embeddingText);

      await client.query(
        `
          INSERT INTO adapter_embeddings (adapter_id, embedding_model, embedding)
          VALUES ($1, $2, $3::jsonb)
          ON CONFLICT (adapter_id)
          DO UPDATE SET
            embedding_model = EXCLUDED.embedding_model,
            embedding = EXCLUDED.embedding,
            updated_at = now()
        `,
        [adapter.id, embeddingModel, JSON.stringify(embedding)],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  process.stdout.write("Seed complete.\n");
});
