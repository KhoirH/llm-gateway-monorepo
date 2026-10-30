import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "../src/index.js";
import { MockAdapter } from "../src/adapters/mock.js";
import type { BackendAdapter, StreamChunk } from "../src/adapters/types.js";
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

async function countRequests(pool: Pool, tenantId: string): Promise<number> {
  const res = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM requests WHERE tenant_id = $1", [tenantId]);
  return Number(res.rows[0].count);
}

async function waitForCount(pool: Pool, tenantId: string, minCount: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await countRequests(pool, tenantId)) >= minCount) return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ReasoningMockAdapter implements BackendAdapter {
  name = "mock";
  async *stream(): AsyncIterable<StreamChunk> {
    yield { kind: "reasoning", text: "let me think. " };
    yield { kind: "delta", text: "final answer" };
    yield { kind: "usage", inputTokens: 4, outputTokens: 6, usageEstimated: false };
  }
  async health(): Promise<"ok" | "down"> {
    return "ok";
  }
}

describe("POST /v1/chat/completions (SSE)", () => {
  let pool: Pool;
  let available: boolean;
  let key: string;

  beforeAll(async () => {
    pool = createTestPool();
    available = await dbReady(pool);
    if (!available) return;
    await ensureMigrated(pool);
    await truncateAll(pool);
    await seedTenant(pool, "sse", 100_000, ["mock", "fast"]);
    await seedTenant(pool, "nofix", 100_000, []);
    await seedTenant(pool, "tiny", 10, ["mock"]);
    key = await insertKey(pool, "sse");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function startServer(adapters: Record<string, BackendAdapter>) {
    const app = buildApp(makeTestEnv(), pool, undefined, adapters);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    return { app, base: `http://127.0.0.1:${address.port}` };
  }

  it("streams OpenAI-compatible SSE with correct headers and usage", async (ctx) => {
    if (!available) return ctx.skip();
    const mock = new MockAdapter({ chunkCount: 3, chunkText: "tok" });
    const { app, base } = await startServer({ fast: mock, mock });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", stream: true, messages: [{ role: "user", content: "hello mock" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-model-used")).toBe("mock");
    expect(res.headers.get("x-fallback-fired")).toBe("false");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const text = await res.text();
    const { events, done } = parseSse(text);
    expect(done).toBe(true);
    const contents = events
      .filter((e) => (e as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content !== undefined)
      .map((e) => (e as { choices: { delta: { content: string } }[] }).choices[0].delta.content);
    expect(contents).toEqual(["tok-1 ", "tok-2 ", "tok-3 "]);
    const usageEvent = events.at(-1) as { usage?: { prompt_tokens: number; completion_tokens: number; usage_estimated: boolean } };
    expect(usageEvent.usage).toEqual({ prompt_tokens: 10, completion_tokens: 9, usage_estimated: false });
    await waitForCount(pool, "sse", 1);
    await app.close();
  });

  it("writes a metering row and reconciles quota after the stream", async (ctx) => {
    if (!available) return ctx.skip();
    const mock = new MockAdapter({ chunkCount: 2, chunkText: "z" });
    const { app, base } = await startServer({ fast: mock, mock });
    const beforeCount = await countRequests(pool, "sse");
    const beforeUsed = Number((await pool.query<{ tokens_used: string }>("SELECT tokens_used::text FROM tenants WHERE id = 'sse'")).rows[0].tokens_used);
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hi" }] }),
    });
    await res.text();
    await waitForCount(pool, "sse", beforeCount + 1);
    const row = (
      await pool.query<Record<string, unknown>>("SELECT * FROM requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", ["sse"])
    ).rows[0];
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe("ok");
    expect(row!.model_used).toBe("mock");
    expect(Number(row!.input_tokens)).toBe(10);
    expect(Number(row!.output_tokens)).toBe(6);
    expect(row!.usage_estimated).toBe(false);
    const used = await pool.query<{ tokens_used: string }>("SELECT tokens_used::text FROM tenants WHERE id = 'sse'");
    expect(Number(used.rows[0].tokens_used) - beforeUsed).toBe(16);
    await app.close();
  });

  it("aborting the client cancels the upstream call (mock cancelled flag)", async (ctx) => {
    if (!available) return ctx.skip();
    const mock = new MockAdapter({ chunkCount: 100, chunkText: "x" });
    const { app, base } = await startServer({ fast: mock, mock });
    const beforeCount = await countRequests(pool, "sse");
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", stream: true, messages: [{ role: "user", content: "abort me" }] }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await sleep(300);
    expect(mock.cancelled).toBe(true);
    await waitForCount(pool, "sse", beforeCount + 1);
    const row = (
      await pool.query<Record<string, unknown>>("SELECT * FROM requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", ["sse"])
    ).rows[0];
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe("error");
    expect(row!.usage_estimated).toBe(true);
    expect(Number(row!.output_tokens)).toBeGreaterThan(0);
    await app.close();
  });

  it("returns a JSON completion when stream is false (default)", async (ctx) => {
    if (!available) return ctx.skip();
    const mock = new MockAdapter({ chunkCount: 3, chunkText: "tok" });
    const { app, base } = await startServer({ fast: mock, mock });
    const beforeCount = await countRequests(pool, "sse");
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hello json" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-model-used")).toBe("mock");
    const body = (await res.json()) as {
      id: string;
      object: string;
      model: string;
      choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number; usage_estimated: boolean };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("mock");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("tok-1 tok-2 tok-3 ");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 9, usage_estimated: false });
    await waitForCount(pool, "sse", beforeCount + 1);
    const row = (
      await pool.query<Record<string, unknown>>("SELECT * FROM requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", ["sse"])
    ).rows[0];
    expect(row.outcome).toBe("ok");
    expect(Number(row.output_tokens)).toBe(9);
    await app.close();
  });

  it("returns a JSON completion with estimated usage when the backend breaks mid-call", async (ctx) => {
    if (!available) return ctx.skip();
    const mock = new MockAdapter({ failureRate: 1, failMode: "midStream", seed: 11 });
    const { app, base } = await startServer({ fast: mock, mock });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "break me" }] }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("all_backends_failed");
    await app.close();
  });

  it("non-streaming includes reasoning_content when the model reasons (GLM-style)", async (ctx) => {
    if (!available) return ctx.skip();
    const { app, base } = await startServer({ fast: new ReasoningMockAdapter(), mock: new ReasoningMockAdapter() });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "think then answer" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string; reasoning_content?: string } }[] };
    expect(body.choices[0].message.content).toBe("final answer");
    expect(body.choices[0].message.reasoning_content).toBe("let me think. ");
    await app.close();
  });

  it("streaming emits delta.reasoning_content events before content deltas", async (ctx) => {
    if (!available) return ctx.skip();
    const { app, base } = await startServer({ fast: new ReasoningMockAdapter(), mock: new ReasoningMockAdapter() });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", stream: true, messages: [{ role: "user", content: "think then answer" }] }),
    });
    const text = await res.text();
    const { events } = parseSse(text);
    const deltas = events
      .filter((e) => (e as { choices?: { delta?: Record<string, unknown> }[] }).choices?.[0]?.delta !== undefined)
      .map((e) => (e as { choices: { delta: Record<string, unknown> }[] }).choices[0].delta);
    expect(deltas[0]).toEqual({ reasoning_content: "let me think. " });
    expect(deltas[1]).toEqual({ content: "final answer" });
    await app.close();
  });

  it("rejects a model outside the tenant allowlist with 403", async (ctx) => {
    if (!available) return ctx.skip();
    const { app, base } = await startServer({ mock: new MockAdapter() });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "strong", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_allowed");
    await app.close();
  });

  it("rejects an invalid body with 400 invalid_request", async (ctx) => {
    if (!available) return ctx.skip();
    const { app, base } = await startServer({ mock: new MockAdapter() });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    await app.close();
  });

  it("maps a malformed JSON body to 400 invalid_request", async (ctx) => {
    if (!available) return ctx.skip();
    const { app, base } = await startServer({ mock: new MockAdapter() });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    await app.close();
  });

  it("rejects when quota is exhausted with 429 (fail closed before streaming)", async (ctx) => {
    if (!available) return ctx.skip();
    const tinyKey = await insertKey(pool, "tiny");
    const { app, base } = await startServer({ mock: new MockAdapter() });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tinyKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("quota_exhausted");
    await app.close();
  });

  it("tenant with empty allowlist gets 403 model_not_allowed", async (ctx) => {
    if (!available) return ctx.skip();
    const nofixKey = await insertKey(pool, "nofix");
    const { app, base } = await startServer({ mock: new MockAdapter() });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${nofixKey}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_allowed");
    await app.close();
  });
});
