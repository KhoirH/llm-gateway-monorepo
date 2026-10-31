import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "../src/index.js";
import { MockAdapter } from "../src/adapters/mock.js";
import type { BackendAdapter, ChatRequest, StreamChunk } from "../src/adapters/types.js";
import {
  createTestPool,
  dbReady,
  ensureMigrated,
  insertKey,
  makeTestEnv,
  seedTenant,
  truncateAll,
} from "./helpers/db.js";

const HEADER = (intent: string, confidence: number) => `{"intent": "${intent}", "confidence": ${confidence}}`;

class ScriptedSupportAdapter implements BackendAdapter {
  name = "scripted";
  cancelled = false;
  private call = 0;
  constructor(private scripts: StreamChunk[][]) {}
  async *stream(_req: ChatRequest, opts: { signal: AbortSignal }): AsyncIterable<StreamChunk> {
    const script = this.scripts[Math.min(this.call, this.scripts.length - 1)];
    this.call++;
    for (const chunk of script) {
      await new Promise<void>((resolve, reject) => {
        if (opts.signal.aborted) {
          this.cancelled = true;
          reject(new Error("aborted"));
          return;
        }
        const timer = setTimeout(resolve, 2);
        const onAbort = () => {
          clearTimeout(timer);
          this.cancelled = true;
          reject(new Error("aborted"));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        setTimeout(() => opts.signal.removeEventListener("abort", onAbort), 10);
      });
      yield chunk;
    }
  }
  async health(): Promise<"ok" | "down"> {
    return "ok";
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => {
      const vec = new Array(768).fill(0);
      vec[0] = 1;
      return vec;
    });
  }
}

function happyScript(intent = "reset_password", confidence = 0.9): StreamChunk[] {
  return [
    { kind: "delta", text: HEADER(intent, confidence) + "\n" },
    { kind: "delta", text: "---\nGo to settings and click reset password." },
    { kind: "usage", inputTokens: 30, outputTokens: 25, usageEstimated: false },
  ];
}

function refusalScript(): StreamChunk[] {
  return [
    { kind: "delta", text: HEADER("reset_password", 0.2) + "\n" },
    ...Array.from({ length: 40 }, (_, i) => ({ kind: "delta" as const, text: `forbidden ${i} ` })),
    { kind: "usage", inputTokens: 30, outputTokens: 25, usageEstimated: false },
  ];
}

function badScript(): StreamChunk[] {
  return [
    { kind: "delta", text: "garbage without json\n" },
    { kind: "delta", text: "more garbage" },
    { kind: "usage", inputTokens: 10, outputTokens: 10, usageEstimated: false },
  ];
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split("\n\n")) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {}
  }
  return events;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function countRows(pool: Pool, table: string): Promise<number> {
  const res = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
  return Number(res.rows[0].count);
}

async function waitForCount(pool: Pool, table: string, minTotal: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await countRows(pool, table)) >= minTotal) return;
    if (Date.now() >= deadline) return;
    await sleep(50);
  }
}

describe("POST /v1/capabilities/support/answer", () => {
  let pool: Pool;
  let available: boolean;
  let key: string;

  beforeAll(async () => {
    pool = createTestPool();
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
    await pool.query("TRUNCATE kb_entries");
    const rows = [
      { q: "reset my account password", a: "Go to settings > security > reset.", i: "reset_password", v: 0 },
      { q: "track my order status", a: "Open the orders page.", i: "track_order", v: 1 },
      { q: "cancel my subscription", a: "Subscriptions > cancel.", i: "cancel_subscription", v: 2 },
      { q: "get a refund for my purchase", a: "Refunds take 5 days.", i: "get_refund", v: 3 },
    ];
    for (const r of rows) {
      const vec = new Array(768).fill(0);
      vec[r.v] = 1;
      await pool.query("INSERT INTO kb_entries (question, answer, intent, embedding) VALUES ($1, $2, $3, $4::vector)", [
        r.q,
        r.a,
        r.i,
        `[${vec.join(",")}]`,
      ]);
    }
    await seedTenant(pool, "sup", 100_000, ["fast", "strong"]);
    key = await insertKey(pool, "sup");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function startServer(adapters: Record<string, BackendAdapter>) {
    const app = buildApp(makeTestEnv(), pool, undefined, adapters);
    await app.listen({ port: 0, host: "127.0.0.1" });
    return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
  }

  function post(base: string, body: unknown) {
    return fetch(`${base}/v1/capabilities/support/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("streams meta, retrieval, deltas and a final answer", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countRows(pool, "routing_attempts");
    const adapter = new ScriptedSupportAdapter([happyScript()]);
    const { app, base } = await startServer({ fast: adapter, strong: adapter, embed: adapter });
    const res = await post(base, { message: "how do I reset my password" });
    const rid = res.headers.get("x-request-id")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("meta");
    expect(names[1]).toBe("retrieval");
    expect(names).toContain("delta");
    expect(names.at(-1)).toBe("final");
    const meta = events[0].data as { request_id: string; model: string };
    expect(meta.model).toBe("fast");
    expect(meta.request_id).toBe(rid);
    const retrieval = events[1].data as { entries: { intent: string }[] };
    expect(retrieval.entries).toHaveLength(4);
    expect(retrieval.entries[0].intent).toBe("reset_password");
    const final = events.at(-1)!.data as {
      answer: string;
      intent: string;
      confidence: number;
      confidence_components: { topSimilarity: number; intentAgreement: number; selfReported: number };
      refused: boolean;
      usage: { input_tokens: number; output_tokens: number; usage_estimated: boolean };
      latency_ms: number;
    };
    expect(final.refused).toBe(false);
    expect(final.intent).toBe("reset_password");
    expect(final.answer).toContain("reset password");
    expect(final.confidence).toBeCloseTo(0.4 * 1.0 + 0.3 * 0.25 + 0.3 * 0.9, 8);
    expect(final.confidence_components.selfReported).toBeCloseTo(0.9, 8);
    expect(final.usage.usage_estimated).toBe(false);
    expect(final.latency_ms).toBeGreaterThanOrEqual(0);
    await waitForCount(pool, "routing_attempts", before + 1);
    const attempt = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 1")).rows[0];
    expect(attempt.outcome).toBe("ok");
    const reqRow = (await pool.query<Record<string, unknown>>("SELECT * FROM requests WHERE id = $1", [rid])).rows[0];
    expect(reqRow.outcome).toBe("ok");
    expect(reqRow.capability).toBe("support");
    expect(reqRow.model_used).toBe("fast");
    await app.close();
  });

  it("refuses low-confidence answers, aborts upstream and never streams the answer", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countRows(pool, "routing_attempts");
    const adapter = new ScriptedSupportAdapter([refusalScript()]);
    const { app, base } = await startServer({ fast: adapter, strong: adapter, embed: adapter });
    const res = await post(base, { message: "how do I reset my password" });
    const rid = res.headers.get("x-request-id")!;
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSse(text);
    expect(events.filter((e) => e.event === "delta")).toHaveLength(0);
    const final = events.find((e) => e.event === "final")!.data as { refused: boolean; answer: string; refusal_message: string };
    expect(final.refused).toBe(true);
    expect(final.answer).toBe("");
    expect(final.refusal_message).toContain("not confident");
    expect(text.includes("forbidden")).toBe(false);
    expect(adapter.cancelled).toBe(true);
    await waitForCount(pool, "routing_attempts", before + 1);
    const reqRow = (await pool.query<Record<string, unknown>>("SELECT * FROM requests WHERE id = $1", [rid])).rows[0];
    expect(reqRow.outcome).toBe("refused");
    await app.close();
  });

  it("repairs an unparsable header once, recording the repair as its own attempt", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countRows(pool, "routing_attempts");
    const adapter = new ScriptedSupportAdapter([badScript(), happyScript("track_order", 0.8)]);
    const { app, base } = await startServer({ fast: adapter, strong: adapter, embed: adapter });
    const res = await post(base, { message: "where is my order" });
    const rid = res.headers.get("x-request-id")!;
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const final = events.find((e) => e.event === "final")!.data as { refused: boolean; intent: string };
    expect(final.refused).toBe(false);
    expect(final.intent).toBe("track_order");
    await waitForCount(pool, "routing_attempts", before + 2);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 2")).rows;
    expect(rows[1].outcome).toBe("bad_output");
    expect(rows[1].reason).toBe("primary");
    expect(rows[0].outcome).toBe("repaired");
    expect(rows[0].reason).toBe("repair");
    const reqRow = (await pool.query<Record<string, unknown>>("SELECT * FROM requests WHERE id = $1", [rid])).rows[0];
    expect(reqRow.outcome).toBe("ok");
    await app.close();
  });

  it("returns bad_output when the header is unusable even after repair", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countRows(pool, "routing_attempts");
    const adapter = new ScriptedSupportAdapter([badScript(), badScript()]);
    const { app, base } = await startServer({ fast: adapter, strong: adapter, embed: adapter });
    const res = await post(base, { message: "hello" });
    const rid = res.headers.get("x-request-id")!;
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const errorEvent = events.find((e) => e.event === "error")!.data as { code: string };
    expect(errorEvent.code).toBe("bad_output");
    await waitForCount(pool, "routing_attempts", before + 2);
    const reqRow = (await pool.query<Record<string, unknown>>("SELECT * FROM requests WHERE id = $1", [rid])).rows[0];
    expect(reqRow.outcome).toBe("bad_output");
    await app.close();
  });

  it("falls back to the next backend when the primary fails before any token", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countRows(pool, "routing_attempts");
    const failing = new MockAdapter({ failureRate: 1, failMode: "error5xx", seed: 8 });
    const ok = new ScriptedSupportAdapter([happyScript()]);
    const { app, base } = await startServer({ fast: failing, strong: ok, embed: ok });
    const res = await post(base, { message: "reset password please" });
    const rid = res.headers.get("x-request-id")!;
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const final = events.find((e) => e.event === "final")!.data as { refused: boolean; intent: string };
    expect(final.refused).toBe(false);
    expect(final.intent).toBe("reset_password");
    expect(res.headers.get("x-model-used")).toBe("strong");
    expect(res.headers.get("x-fallback-fired")).toBe("true");
    await waitForCount(pool, "routing_attempts", before + 2);
    const reqRow = (await pool.query<Record<string, unknown>>("SELECT * FROM requests WHERE id = $1", [rid])).rows[0];
    expect(reqRow.outcome).toBe("ok");
    await app.close();
  });
});
