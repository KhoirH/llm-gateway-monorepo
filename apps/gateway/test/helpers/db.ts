import { PassThrough } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { createPool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { hashApiKey } from "../../src/auth/keys.js";
import type { Env } from "../../src/env.js";
import { vi } from "vitest";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://gateway:gateway@localhost:5432/gateway";

export function createTestPool(): Pool {
  return createPool(TEST_DATABASE_URL);
}

export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: 0,
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: "fatal",
    FAST_API_KEY: "",
    FAST_BASE_URL: "https://api.groq.com/openai/v1",
    FAST_MODEL: "llama-3.1-8b-instant",
    STRONG_API_KEY: "",
    STRONG_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    STRONG_MODEL: "gemini-2.0-flash",
    ...overrides,
  };
}

export interface LogCapture {
  stream: PassThrough;
  text(): string;
}

export function captureLogs(): LogCapture {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on("data", (chunk) => chunks.push(chunk.toString()));
  return { stream, text: () => chunks.join("") };
}

export async function dbReady(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE requests, routing_attempts, api_keys, tenants CASCADE");
}

export async function ensureMigrated(pool: Pool): Promise<void> {
  await runMigrations(pool);
}

export async function seedTenant(pool: Pool, id: string, quota: number, allowed: string[] = ["fast", "strong"]): Promise<void> {
  await pool.query(
    `INSERT INTO tenants (id, name, allowed_models, daily_token_quota, tokens_used)
     VALUES ($1, $2, $3, $4, 0) ON CONFLICT (id) DO UPDATE
     SET daily_token_quota = $4, allowed_models = $3, tokens_used = 0`,
    [id, `Test ${id}`, allowed, quota],
  );
}

export async function insertKey(pool: Pool, tenantId: string, revoked = false): Promise<string> {
  const key = `sk-gw-${randomBytes(24).toString("base64url")}`;
  await pool.query("INSERT INTO api_keys (tenant_id, key_hash, prefix, revoked_at) VALUES ($1, $2, $3, $4)", [
    tenantId,
    hashApiKey(key),
    key.slice(0, 12),
    revoked ? new Date() : null,
  ]);
  return key;
}

export async function tokensUsed(pool: Pool, tenantId: string): Promise<number> {
  const res = await pool.query<{ tokens_used: string }>("SELECT tokens_used::text FROM tenants WHERE id = $1", [tenantId]);
  return Number(res.rows[0].tokens_used);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function spyFn<TArgs extends unknown[], TResult>(impl: (...args: TArgs) => TResult) {
  const calls: TArgs[] = [];
  return {
    calls,
    impl,
    fn: (...args: TArgs): TResult => {
      calls.push(args);
      return impl(...args);
    },
    toHaveBeenCalledTimes: (n: number) => calls.length === n,
  };
}

export { vi };
