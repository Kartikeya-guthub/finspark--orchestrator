import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive(),
  REDIS_PORT: z.coerce.number().int().positive(),
  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
  MINIO_API_PORT: z.coerce.number().int().positive(),
  MINIO_CONSOLE_PORT: z.coerce.number().int().positive(),
  WEB_PORT: z.coerce.number().int().positive(),
  API_PORT: z.coerce.number().int().positive(),
  AI_SERVICE_PORT: z.coerce.number().int().positive(),
  SIMULATOR_PORT: z.coerce.number().int().positive(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  return EnvSchema.parse(env);
}
