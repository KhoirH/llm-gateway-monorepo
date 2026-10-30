import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { reserveTokens, reconcileQuota } from "../src/quota.js";
import { AppError } from "../src/errors.js";
import { createTestPool, dbReady, ensureMigrated, seedTenant, tokensUsed, truncateAll } from "./helpers/db.js";

describe("atomic quota reserve + reconcile", () => {
  let pool: Pool;
  let available: boolean;

  beforeAll(async () => {
    pool = createTestPool();
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reserves within quota and accumulates tokens_used", async (ctx) => {
    if (!available) return ctx.skip();
    await seedTenant(pool, "q1", 1000);
    await reserveTokens(pool, "q1", 300);
    expect(await tokensUsed(pool, "q1")).toBe(300);
  });

  it("rejects a reserve that would exceed quota with 429 quota_exhausted", async (ctx) => {
    if (!available) return ctx.skip();
    await expect(reserveTokens(pool, "q1", 800)).rejects.toMatchObject({ status: 429, code: "quota_exhausted" });
  });

  it("allows reserving exactly up to the limit, then rejects", async (ctx) => {
    if (!available) return ctx.skip();
    await reserveTokens(pool, "q1", 700);
    expect(await tokensUsed(pool, "q1")).toBe(1000);
    await expect(reserveTokens(pool, "q1", 1)).rejects.toBeInstanceOf(AppError);
    expect(await tokensUsed(pool, "q1")).toBe(1000);
  });

  it("reconciles down to actual usage", async (ctx) => {
    if (!available) return ctx.skip();
    await seedTenant(pool, "q2", 10_000);
    await reserveTokens(pool, "q2", 500);
    const used = await reconcileQuota(pool, "q2", 500, 200);
    expect(used).toBe(200);
    expect(await tokensUsed(pool, "q2")).toBe(200);
  });

  it("refunds fully when no model call succeeded (actual = 0)", async (ctx) => {
    if (!available) return ctx.skip();
    await seedTenant(pool, "q3", 10_000);
    await reserveTokens(pool, "q3", 500);
    const used = await reconcileQuota(pool, "q3", 500, 0);
    expect(used).toBe(0);
    expect(await tokensUsed(pool, "q3")).toBe(0);
  });
});
