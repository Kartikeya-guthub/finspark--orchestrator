import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "change-me-in-dev";

type JwtPayload = {
  tenant_id: string;
};

function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export async function tenantMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const PUBLIC_PATHS = ["/health", "/api/tenants/bootstrap"];
  const isPublic = PUBLIC_PATHS.includes(request.url) ||
    request.url.startsWith("/api/adapters");
  if (isPublic) {
    return;
  }

  const authHeader = request.headers.authorization;
  const apiKey = request.headers["x-api-key"];

  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    try {
      const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
      request.tenant = { id: payload.tenant_id, authType: "jwt" };
      return;
    } catch {
      reply.code(401).send({ error: "invalid_token" });
      return;
    }
  }

  if (typeof apiKey === "string" && apiKey.length > 0) {
    const keyHash = hashApiKey(apiKey);
    const keyResult = await pool.query(
      `
        UPDATE tenant_api_keys
        SET last_used_at = now()
        WHERE key_hash = $1 AND is_active = true
        RETURNING tenant_id
      `,
      [keyHash],
    );

    if (!keyResult.rowCount) {
      reply.code(401).send({ error: "invalid_api_key" });
      return;
    }

    request.tenant = {
      id: (keyResult.rows[0] as { tenant_id: string }).tenant_id,
      authType: "api_key",
    };
    return;
  }

  reply.code(401).send({ error: "tenant_auth_required" });
}

export function requireTenant(request: FastifyRequest): { id: string } {
  if (!request.tenant) {
    throw new Error("Tenant context is required");
  }
  return { id: request.tenant.id };
}

export function signTenantJwt(tenantId: string): string {
  return jwt.sign({ tenant_id: tenantId }, JWT_SECRET, { expiresIn: "1h" });
}

export function createTenantApiKey(): string {
  return `tsk_${crypto.randomBytes(24).toString("hex")}`;
}

export function hashTenantApiKey(apiKey: string): string {
  return hashApiKey(apiKey);
}
