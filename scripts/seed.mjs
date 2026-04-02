import crypto from "node:crypto";
import https from "node:https";

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

/**
 * Call NVIDIA embeddings API — mirrors matcher.py embed_text() exactly so that
 * seed-time and query-time embeddings live in the same vector space.
 */
async function nvidiaEmbed(text, apiKey, endpoint, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, input: text, input_type: "passage" });
    const url = new URL(endpoint);
    const options = {
      hostname: url.hostname,
      port: Number(url.port) || 443,
      path: url.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const embedding = data?.data?.[0]?.embedding ?? data?.embedding;
          if (Array.isArray(embedding)) resolve(embedding.map(Number));
          else reject(new Error(`No embedding vector in response: ${JSON.stringify(data).slice(0, 200)}`));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
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

  const embeddingModel    = process.env.NVIDIA_EMBEDDINGS_MODEL    ?? "nvidia/llama-3.2-nv-embedqa-1b-v2";
  const embeddingEndpoint = process.env.NVIDIA_EMBEDDINGS_ENDPOINT ?? "https://integrate.api.nvidia.com/v1/embeddings";
  const apiKey            = (process.env.NVIDIA_EMBEDDINGS_API_KEY ?? "").trim();

  const useNvidia = Boolean(apiKey);
  process.stdout.write(
    useNvidia
      ? `Using NVIDIA embeddings API (model: ${embeddingModel})\n`
      : "NVIDIA_EMBEDDINGS_API_KEY not set — falling back to local hash embeddings (lower matching quality)\n",
  );

  const adapterRows = await client.query(
    `
      SELECT id, name, category, provider, description, capability_tags
      FROM adapters
      ORDER BY name
    `,
  );

  await client.query("BEGIN");
  let apiSuccesses = 0;
  let apiFallbacks = 0;

  try {
    for (const adapter of adapterRows.rows) {
      const embeddingText = [
        adapter.name,
        adapter.category,
        adapter.provider,
        adapter.description,
        ...(adapter.capability_tags ?? []),
      ].join(" ");

      let embedding;
      let rowEmbeddingModel = "local-hash-256";
      if (useNvidia) {
        try {
          embedding = await nvidiaEmbed(embeddingText, apiKey, embeddingEndpoint, embeddingModel);
          rowEmbeddingModel = embeddingModel;
          apiSuccesses++;
          process.stdout.write(`  [NVIDIA] ${adapter.name} (${embedding.length}d)\n`);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          process.stdout.write(`  [LOCAL ] ${adapter.name} — NVIDIA failed: ${detail}\n`);
          embedding = localEmbedding(embeddingText);
          apiFallbacks++;
        }
      } else {
        embedding = localEmbedding(embeddingText);
        apiFallbacks++;
      }

      await client.query(
        `
          INSERT INTO adapter_embeddings (adapter_id, embedding_model, embedding)
          VALUES ($1, $2, $3::jsonb)
          ON CONFLICT (adapter_id)
          DO UPDATE SET
            embedding_model = EXCLUDED.embedding_model,
            embedding       = EXCLUDED.embedding,
            updated_at      = now()
        `,
        [adapter.id, rowEmbeddingModel, JSON.stringify(embedding)],
      );
    }

    await client.query("COMMIT");
    process.stdout.write(
      `Embeddings complete: ${apiSuccesses} via NVIDIA API, ${apiFallbacks} via local fallback.\n`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  process.stdout.write("Seed complete.\n");
});
