import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMetered } from "../src/pipeline.js";

import { reserveTokens } from "../src/quota.js";
import { AppError } from "../src/errors.js";
import { createTestPool, dbReady, ensureMigrated, seedTenant, tokensUsed, truncateAll } from "./helpers/db.js";

const DEAD_DATABASE_URL = "postgres://gateway:gateway@127.0.0.1:1/gateway";

describe("database outage fails closed", () => {
  let pool: Pool;
  let deadPool: Pool;
  let available: boolean;

  beforeAll(async () => {
    pool = createTestPool();
    deadPool = new Pool({ connectionString: DEAD_DATABASE_URL, connectionTimeoutMillis: 1000, max: 1 });
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
    await seedTenant(pool, "acme", 100_000);
  });

  afterAll(async () => {
    await pool?.end();
    await deadPool.end();
  });

  it("reserve on a dead quota store throws 503 quota_unavailable", async () => {
    await expect(
      reserveTokens(deadPool, "acme", 10),
    ).rejects.toMatchObject({ status: 503, code: "quota_unavailable" });
  });

  it("runMetered rejects 503 before calling the backend (spy proves no model call)", async (ctx) => {
    if (!available) return ctx.skip();
    let modelCalls = 0;
    let caught: unknown;
    try {
      await runMetered(
        deadPool,
        { tenantId: "acme", capability: "chat", tier: "fast", estimateTokens: 100 },
        async () => {
          modelCalls++;
          return { value: "never", usage: { inputTokens: 1, outputTokens: 1, usageEstimated: false, modelUsed: "fast", ttftMs: 0, latencyMs: 0 } };
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const appErr = caught as AppError;
    expect(appErr.status).toBe(503);
    expect(appErr.code).toBe("quota_unavailable");
    expect(modelCalls).toBe(0);
  });

  it("stores no metering row when the quota store is down", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM requests WHERE tenant_id = 'acme'");
    expect(Number(res.rows[0].count)).toBe(0);
    expect(await tokensUsed(pool, "acme")).toBe(0);
  });
});
