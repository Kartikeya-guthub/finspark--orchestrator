import "dotenv/config";
import { createServer } from "node:http";
import { Worker } from "bullmq";
import { Redis } from "ioredis";

const port = Number(process.env.SIMULATOR_PORT ?? 8003);
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://127.0.0.1:8002";

const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  "document-parse",
  async (job) => {
    const response = await fetch(`${aiServiceUrl}/process-document`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(job.data),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AI service failed: ${response.status} ${text}`);
    }

    return response.json();
  },
  {
    connection,
    concurrency: 3,
  },
);

worker.on("completed", (job) => {
  process.stdout.write(`Processed job ${job.id}\n`);
});

worker.on("failed", (job, error) => {
  process.stderr.write(`Job ${job?.id ?? "unknown"} failed: ${error.message}\n`);
});

const server = createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Simulator listening on ${port}\n`);
});

process.on("SIGINT", async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});
