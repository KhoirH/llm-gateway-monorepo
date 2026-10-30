import type { Pool } from "pg";
import { z } from "zod";
import { Errors } from "../errors.js";
import { hashApiKey } from "./keys.js";

export interface AuthContext {
  tenantId: string;
  tenantName: string;
  allowedModels: string[];
  keyId: string;
  keyPrefix: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const authorizationSchema = z
  .string()
  .regex(/^Bearer\s+([A-Za-z0-9._~-]+)$/i)
  .transform((value) => value.replace(/^Bearer\s+/i, "").trim());

export function requireAuth(pool: Pool) {
  return async function authenticate(req: import("fastify").FastifyRequest) {
    const header = req.headers.authorization;
    const parsed = authorizationSchema.safeParse(header);
    if (!parsed.success) {
      throw Errors.invalidApiKey();
    }
    const keyHash = hashApiKey(parsed.data);
    let row: { tenant_id: string; tenant_name: string; allowed_models: string[]; key_id: string; prefix: string; revoked_at: Date | null } | undefined;
    try {
      const res = await pool.query<{
        tenant_id: string;
        tenant_name: string;
        allowed_models: string[];
        key_id: string;
        prefix: string;
        revoked_at: Date | null;
      }>(
        `SELECT k.tenant_id, t.name AS tenant_name, t.allowed_models, k.id AS key_id, k.prefix, k.revoked_at
         FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
         WHERE k.key_hash = $1`,
        [keyHash],
      );
      row = res.rows[0];
    } catch (err) {
      throw Errors.quotaUnavailable(`Auth lookup failed: ${(err as { code?: string }).code ?? "unknown"}`);
    }
    if (!row || row.revoked_at !== null) {
      throw Errors.invalidApiKey();
    }
    req.auth = {
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      allowedModels: row.allowed_models,
      keyId: row.key_id,
      keyPrefix: row.prefix,
    };
  };
}
