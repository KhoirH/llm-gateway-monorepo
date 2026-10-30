import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "../src/index.js";
import {
  captureLogs,
  createTestPool,
  dbReady,
  ensureMigrated,
  insertKey,
  makeTestEnv,
  seedTenant,
  truncateAll,
} from "./helpers/db.js";

describe("auth middleware + error shape", () => {
  let pool: Pool;
  let available: boolean;
  let key: string;
  let logs: ReturnType<typeof captureLogs>;

  beforeAll(async () => {
    pool = createTestPool();
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
    await seedTenant(pool, "acme", 100_000);
    key = await insertKey(pool, "acme");
    logs = captureLogs();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects missing Authorization header with 401 invalid_api_key", async (ctx) => {
    if (!available) return ctx.skip();
    const app = buildApp(makeTestEnv(), pool);
    const res = await app.inject({ method: "GET", url: "/v1/usage" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("invalid_api_key");
    expect(body.error.request_id).toBeTruthy();
    await app.close();
  });

  it("rejects an unknown key with 401", async (ctx) => {
    if (!available) return ctx.skip();
    const app = buildApp(makeTestEnv(), pool);
    const res = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer sk-gw-notreal` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
    await app.close();
  });

  it("accepts a valid key and returns own-tenant usage", async (ctx) => {
    if (!available) return ctx.skip();
    const app = buildApp(makeTestEnv(), pool);
    const res = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant_id).toBe("acme");
    expect(body.quota.daily_token_quota).toBe(100_000);
    expect(body.quota.remaining).toBe(100_000);
    await app.close();
  });

  it("rejects a revoked key with 401", async (ctx) => {
    if (!available) return ctx.skip();
    const revokedKey = await insertKey(pool, "acme", true);
    const app = buildApp(makeTestEnv(), pool);
    const res = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${revokedKey}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
    await app.close();
  });

  it("never logs the raw API key", async (ctx) => {
    if (!available) return ctx.skip();
    const app = buildApp(makeTestEnv({ LOG_LEVEL: "info" }), pool, { stream: logs.stream });
    await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${key}` } });
    const text = logs.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text.includes(key)).toBe(false);
    await app.close();
  });
});
