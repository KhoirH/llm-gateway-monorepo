import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { retrieve } from "../src/retrieval.js";
import { createTestPool, dbReady, ensureMigrated, truncateAll } from "./helpers/db.js";

function unitVector(dim: number, index: number): string {
  const vec = new Array(dim).fill(0);
  vec[index] = 1;
  return `[${vec.join(",")}]`;
}

const fakeEmbedAdapter = {
  name: "fake-embed",
  async *stream() {
    yield {} as never;
  },
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const idx = Number(t);
      const vec = new Array(768).fill(0);
      vec[idx] = 1;
      return vec;
    });
  },
  async health(): Promise<"ok" | "down"> {
    return "ok";
  },
};

describe("retrieval (pgvector top-k)", () => {
  let pool: Pool;
  let available: boolean;

  beforeAll(async () => {
    pool = createTestPool();
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
    await pool.query("TRUNCATE kb_entries");
    const rows = [
      { q: "reset my password please", a: "Go to settings > security.", i: "reset_password", v: 0 },
      { q: "where is my package", a: "Track it in Orders.", i: "track_order", v: 1 },
      { q: "cancel my subscription now", a: "Open subscriptions > cancel.", i: "cancel_subscription", v: 2 },
      { q: "refund my last purchase", a: "Refunds take 5 days.", i: "get_refund", v: 3 },
    ];
    for (const r of rows) {
      await pool.query("INSERT INTO kb_entries (question, answer, intent, embedding) VALUES ($1, $2, $3, $4::vector)", [
        r.q,
        r.a,
        r.i,
        unitVector(768, r.v),
      ]);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns the exact match first and only k results", async (ctx) => {
    if (!available) return ctx.skip();
    const results = await retrieve(pool, fakeEmbedAdapter as never, "0", 4);
    expect(results).toHaveLength(4);
    expect(results[0].intent).toBe("reset_password");
    expect(results[0].similarity).toBeGreaterThan(0.99);
    const restIntents = results.slice(1).map((r) => r.intent).sort();
    expect(restIntents).toEqual(["cancel_subscription", "get_refund", "track_order"]);
    for (const r of results.slice(1)) {
      expect(r.similarity).toBeLessThan(0.01);
    }
  });

  it("respects the k parameter", async (ctx) => {
    if (!available) return ctx.skip();
    const results = await retrieve(pool, fakeEmbedAdapter as never, "3", 2);
    expect(results).toHaveLength(2);
    expect(results[0].intent).toBe("get_refund");
    expect(results[0].similarity).toBeGreaterThan(0.99);
    expect(results[1].similarity).toBeLessThan(0.01);
  });

  it("similarity decreases monotonically", async (ctx) => {
    if (!available) return ctx.skip();
    const results = await retrieve(pool, fakeEmbedAdapter as never, "0", 4);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].similarity).toBeLessThanOrEqual(results[i - 1].similarity);
    }
  });
});
