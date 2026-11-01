import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "../src/index.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { AdapterError, type BackendAdapter, type StreamChunk } from "../src/adapters/types.js";
import {
  createTestPool,
  dbReady,
  ensureMigrated,
  insertKey,
  makeTestEnv,
  seedTenant,
  truncateAll,
} from "./helpers/db.js";

class ConnFailAdapter implements BackendAdapter {
  name = "connfail";
  async *stream(): AsyncIterable<StreamChunk> {
    throw new AdapterError("conn", "simulated connection reset");
    yield {} as never;
  }
  async health(): Promise<"ok" | "down"> {
    return "ok";
  }
}

class HttpFailAdapter implements BackendAdapter {
  name = "httpfail";
  constructor(private status: number) {}
  async *stream(): AsyncIterable<StreamChunk> {
    throw new AdapterError("http", `simulated http ${this.status}`, this.status);
    yield {} as never;
  }
  async health(): Promise<"ok" | "down"> {
    return "ok";
  }
}

function parseSse(raw: string): { events: Record<string, unknown>[]; done: boolean } {
  const events: Record<string, unknown>[] = [];
  let done = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    try {
      events.push(JSON.parse(payload));
    } catch {}
  }
  return { events, done };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function countAttempts(pool: Pool): Promise<number> {
  const res = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM routing_attempts");
  return Number(res.rows[0].count);
}

async function waitForAttempts(pool: Pool, minTotal: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await countAttempts(pool)) >= minTotal) return;
    if (Date.now() >= deadline) return;
    await sleep(50);
  }
}

describe("routing and fallback (B3)", () => {
  let pool: Pool;
  let available: boolean;
  let key: string;
  let chaosKey: string;

  beforeAll(async () => {
    pool = createTestPool();
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
    await seedTenant(pool, "fb", 100_000, ["fast", "strong"]);
    await seedTenant(pool, "chaos", 100_000, ["fast", "strong"]);
    key = await insertKey(pool, "fb");
    chaosKey = await insertKey(pool, "chaos");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function startServer(adapters: Record<string, BackendAdapter>, envOverrides: Record<string, unknown> = {}) {
    const app = buildApp(makeTestEnv(envOverrides as never), pool, undefined, adapters);
    await app.listen({ port: 0, host: "127.0.0.1" });
    return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
  }

  function post(base: string, authKey: string, body: unknown) {
    return fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${authKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("falls back on http 5xx and serves from the next backend", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const ok = new MockAdapter({ chunkCount: 2, chunkText: "ok" });
    const { app, base } = await startServer({ fast: new HttpFailAdapter(500), strong: ok });
    const res = await post(base, key, { model: "fast", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-used")).toBe("strong");
    expect(res.headers.get("x-fallback-fired")).toBe("true");
    await waitForAttempts(pool, before + 2);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 2")).rows;
    expect(rows[1].outcome).toBe("error");
    expect(rows[1].backend).toBe("fast");
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].backend).toBe("strong");
    await app.close();
  });

  it("falls back on 429", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const ok = new MockAdapter({ chunkCount: 1, chunkText: "ok" });
    const { app, base } = await startServer({ fast: new HttpFailAdapter(429), strong: ok });
    const res = await post(base, key, { model: "fast", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-used")).toBe("strong");
    await waitForAttempts(pool, before + 2);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 2")).rows;
    expect(rows.map((r) => r.outcome).sort()).toEqual(["error", "ok"]);
    await app.close();
  });

  it("falls back on connection error", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const ok = new MockAdapter({ chunkCount: 1, chunkText: "ok" });
    const { app, base } = await startServer({ fast: new ConnFailAdapter(), strong: ok });
    const res = await post(base, key, { model: "fast", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-used")).toBe("strong");
    await waitForAttempts(pool, before + 2);
    await app.close();
  });

  it("falls back when no first token within the TTFT timeout", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const hang = new MockAdapter({ failureRate: 1, failMode: "hang", seed: 3 });
    const ok = new MockAdapter({ chunkCount: 1, chunkText: "ok" });
    const { app, base } = await startServer({ fast: hang, strong: ok }, { TTFT_TIMEOUT_MS: 200 });
    const t0 = Date.now();
    const res = await post(base, key, { model: "fast", messages: [{ role: "user", content: "hi" }] });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-used")).toBe("strong");
    expect(elapsed).toBeLessThan(3000);
    await waitForAttempts(pool, before + 2);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 2")).rows;
    expect(rows[0].outcome).toBe("ok");
    expect(String(rows[1].error)).toContain("aborted");
    await app.close();
  });

  it("returns 504 timeout when the total deadline passes before any token", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const slow = new MockAdapter({ latencyMs: 1000, chunkCount: 1 });
    const shouldNotBeCalled = new MockAdapter({ chunkCount: 1 });
    const { app, base } = await startServer({ fast: slow, strong: shouldNotBeCalled }, { TOTAL_TIMEOUT_MS: 300 });
    const res = await post(base, key, { model: "fast", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("timeout");
    await waitForAttempts(pool, before + 1);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 1")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].backend).toBe("fast");
    await app.close();
  });

  it("falls back to the next backend when the primary returns a 4xx", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const ok = new MockAdapter({ chunkCount: 1, chunkText: "ok" });
    const { app, base } = await startServer({ fast: new HttpFailAdapter(401), strong: ok });
    const res = await post(base, key, { model: "fast", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-used")).toBe("strong");
    expect(res.headers.get("x-fallback-fired")).toBe("true");
    await waitForAttempts(pool, before + 2);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 2")).rows;
    expect(rows[1].backend).toBe("fast");
    expect(rows[1].outcome).toBe("error");
    expect(rows[0].backend).toBe("strong");
    expect(rows[0].outcome).toBe("ok");
    await app.close();
  });

  it("retries 4xx up to 3 consecutive attempts then closes the chat", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const { app, base } = await startServer({ fast: new HttpFailAdapter(401), strong: new HttpFailAdapter(401) });
    const res = await post(base, key, { model: "fast", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    await waitForAttempts(pool, before + 3);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 3")).rows;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.backend)).toEqual(["fast", "strong", "fast"]);
    expect(rows.map((r) => r.outcome)).toEqual(["error", "error", "error"]);
    expect(rows.map((r) => r.reason)).toEqual(["retry", "fallback", "primary"]);
    const reqRow = (
      await pool.query<Record<string, unknown>>("SELECT outcome, fallback_fired FROM requests ORDER BY created_at DESC LIMIT 1")
    ).rows[0];
    expect(reqRow.outcome).toBe("error");
    expect(reqRow.fallback_fired).toBe(true);
    await app.close();
  });

  it("mid-stream break emits an error event with partial text and does not fall back", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const breaking = new MockAdapter({ failureRate: 1, failMode: "midStream", seed: 9 });
    const shouldNotBeCalled = new MockAdapter({ chunkCount: 1 });
    const { app, base } = await startServer({ fast: breaking, strong: shouldNotBeCalled });
    const res = await post(base, key, {
      model: "fast",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-used")).toBe("fast");
    expect(res.headers.get("x-fallback-fired")).toBe("false");
    const text = await res.text();
    const { events, done } = parseSse(text);
    expect(done).toBe(false);
    const errorEvent = events.find((e) => (e as { error?: { partial?: boolean } }).error?.partial) as
      | { error: { code: string; partial: boolean; request_id: string } }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error.code).toBe("all_backends_failed");
    expect(errorEvent!.error.request_id).toBeTruthy();
    await waitForAttempts(pool, before + 1);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 1")).rows;
    expect(rows[0].outcome).toBe("partial_failure");
    const reqRow = (await pool.query<Record<string, unknown>>("SELECT outcome FROM requests ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(reqRow.outcome).toBe("partial_failure");
    await app.close();
  });

  it("chaos tenant routes mock first and falls back with a trace explaining why", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const failing = new MockAdapter({ failureRate: 1, failMode: "error5xx", seed: 5 });
    const ok = new MockAdapter({ chunkCount: 2, chunkText: "rescued" });
    const { app, base } = await startServer({ mock: failing, fast: ok, strong: ok });
    const res = await post(base, chaosKey, { messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-used")).toBe("fast");
    expect(res.headers.get("x-fallback-fired")).toBe("true");
    await waitForAttempts(pool, before + 2);
    const rows = (await pool.query<Record<string, unknown>>("SELECT * FROM routing_attempts ORDER BY id DESC LIMIT 2")).rows;
    expect(rows[1].backend).toBe("mock");
    expect(rows[1].outcome).toBe("error");
    expect(rows[0].backend).toBe("fast");
    expect(rows[0].outcome).toBe("ok");
    await app.close();
  });

  it("GET /v1/requests/:id returns trace with attempts and route steps, scoped to tenant", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await countAttempts(pool);
    const ok = new MockAdapter({ chunkCount: 1, chunkText: "traced" });
    const { app, base } = await startServer({ fast: ok, strong: ok });
    const res = await post(base, key, { model: "fast", messages: [{ role: "user", content: "trace me" }] });
    expect(res.status).toBe(200);
    const requestId = res.headers.get("x-request-id")!;
    await waitForAttempts(pool, before + 1);
    const traceRes = await fetch(`${base}/v1/requests/${requestId}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(traceRes.status).toBe(200);
    const trace = (await traceRes.json()) as {
      request: Record<string, unknown>;
      routing_attempts: Record<string, unknown>[];
    };
    expect(trace.request.outcome).toBe("ok");
    expect(trace.request.model_used).toBe("fast");
    expect(trace.request.route_steps).toHaveLength(2);
    expect(trace.routing_attempts).toHaveLength(1);
    expect(trace.routing_attempts[0].outcome).toBe("ok");

    const otherTenant = await fetch(`${base}/v1/requests/${requestId}`, {
      headers: { authorization: `Bearer ${chaosKey}` },
    });
    expect(otherTenant.status).toBe(404);

    const invalid = await fetch(`${base}/v1/requests/not-a-uuid`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(invalid.status).toBe(400);
    await app.close();
  });
});
