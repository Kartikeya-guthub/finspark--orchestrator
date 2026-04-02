import { Queue } from "bullmq";
import { Redis } from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const documentParseQueueName = "document-parse";

export const documentParseQueue = new Queue(documentParseQueueName, {
  connection,
});

export type DocumentParseJob = {
  documentId: string;
  tenantId: string;
  objectPath: string;
  filename: string;
  contentType: string;
};

export async function enqueueDocumentParseJob(job: DocumentParseJob): Promise<void> {
  await documentParseQueue.add("process-document", job, {
    attempts: 5,
    removeOnComplete: 100,
    removeOnFail: 100,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  });
}

export async function closeQueue(): Promise<void> {
  await documentParseQueue.close();
  await connection.quit();
}
