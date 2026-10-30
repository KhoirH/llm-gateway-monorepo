import { describe, expect, it } from "vitest";
import { MockAdapter } from "../src/adapters/mock.js";
import { AdapterError, type StreamChunk } from "../src/adapters/types.js";

const req = { messages: [{ role: "user" as const, content: "hello" }] };

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function collect(adapter: MockAdapter, sig: AbortSignal): Promise<{ chunks: StreamChunk[]; error: unknown }> {
  const chunks: StreamChunk[] = [];
  let error: unknown;
  try {
    for await (const c of adapter.stream(req, { signal: sig })) {
      chunks.push(c);
    }
  } catch (err) {
    error = err;
  }
  return { chunks, error };
}

describe("MockAdapter", () => {
  it("streams deterministic deltas then usage when healthy", async () => {
    const adapter = new MockAdapter({ seed: 7, chunkCount: 3, chunkText: "tok" });
    const { chunks, error } = await collect(adapter, signal());
    expect(error).toBeUndefined();
    const deltas = chunks.filter((c) => c.kind === "delta") as Extract<StreamChunk, { kind: "delta" }>[];
    expect(deltas.map((d) => d.text)).toEqual(["tok-1 ", "tok-2 ", "tok-3 "]);
    const usage = chunks.at(-1) as Extract<StreamChunk, { kind: "usage" }>;
    expect(usage.kind).toBe("usage");
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(9);
    expect(usage.usageEstimated).toBe(false);
  });

  it("throws http 500 on failMode error5xx", async () => {
    const adapter = new MockAdapter({ failureRate: 1, failMode: "error5xx", seed: 1 });
    const { error } = await collect(adapter, signal());
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).kind).toBe("http");
    expect((error as AdapterError).status).toBe(500);
  });

  it("throws http 429 on failMode 429", async () => {
    const adapter = new MockAdapter({ failureRate: 1, failMode: "429", seed: 2 });
    const { error } = await collect(adapter, signal());
    expect((error as AdapterError).status).toBe(429);
  });

  it("hangs until abort on failMode hang and marks cancelled", async () => {
    const adapter = new MockAdapter({ failureRate: 1, failMode: "hang", seed: 3 });
    const controller = new AbortController();
    const promise = collect(adapter, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const { error } = await promise;
    expect((error as AdapterError).kind).toBe("conn");
    expect(adapter.cancelled).toBe(true);
  });

  it("emits deltas then breaks on failMode midStream", async () => {
    const adapter = new MockAdapter({ failureRate: 1, failMode: "midStream", seed: 4 });
    const { chunks, error } = await collect(adapter, signal());
    const deltas = chunks.filter((c) => c.kind === "delta");
    expect(deltas.length).toBe(2);
    expect((error as AdapterError).kind).toBe("conn");
  });

  it("marks cancelled when aborted mid-stream", async () => {
    const adapter = new MockAdapter({ seed: 5, chunkCount: 100, chunkText: "x" });
    const controller = new AbortController();
    const deltas: string[] = [];
    let error: unknown;
    try {
      for await (const c of adapter.stream(req, { signal: controller.signal })) {
        if (c.kind === "delta") {
          deltas.push(c.text);
          if (deltas.length === 2) {
            controller.abort();
          }
        }
      }
    } catch (err) {
      error = err;
    }
    expect(deltas.length).toBe(2);
    expect((error as AdapterError).kind).toBe("conn");
    expect(adapter.cancelled).toBe(true);
  });

  it("same seed produces same failure decision sequence", async () => {
    const a = new MockAdapter({ failureRate: 0.5, seed: 99 });
    const b = new MockAdapter({ failureRate: 0.5, seed: 99 });
    const ra = await collect(a, signal());
    const rb = await collect(b, signal());
    expect(ra.error === undefined).toBe(rb.error === undefined);
  });
});
