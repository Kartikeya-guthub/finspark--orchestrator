import { Client as MinioClient } from "minio";

const endPoint = process.env.MINIO_ENDPOINT ?? "127.0.0.1";
const port = Number(process.env.MINIO_API_PORT ?? "9000");
const useSSL = (process.env.MINIO_USE_SSL ?? "false") === "true";
const accessKey = process.env.MINIO_ROOT_USER ?? "minioadmin";
const secretKey = process.env.MINIO_ROOT_PASSWORD ?? "minioadmin";

export const documentsBucket = process.env.MINIO_BUCKET_DOCS ?? "finspark-documents";

const client = new MinioClient({
  endPoint,
  port,
  useSSL,
  accessKey,
  secretKey,
});

export async function ensureDocumentBucket(): Promise<void> {
  const exists = await client.bucketExists(documentsBucket);
  if (!exists) {
    await client.makeBucket(documentsBucket, "us-east-1");
  }
}

export async function putDocumentObject(
  objectPath: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await ensureDocumentBucket();
  await client.putObject(documentsBucket, objectPath, buffer, buffer.length, {
    "Content-Type": contentType,
  });
}
