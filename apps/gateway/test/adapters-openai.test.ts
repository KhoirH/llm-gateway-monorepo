import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { OpenAICompatAdapter, normalizeSdkError } from "../src/adapters/openai-compat.js";
import { AdapterError, type StreamChunk } from "../src/adapters/types.js";

const req = { messages: [{ role: "user" as const, content: "abcd" }] };

async function* streamOf(chunks: unknown[]) {
  for (const c of chunks) {
    yield c;
  }
}

function fakeClient(createImpl: (...args: unknown[]) => Promise<unknown>, capture?: (args: unknown) => void): OpenAI {
  return {
    chat: {
      completions: {
        create: (async (...args: unknown[]) => {
          capture?.(args);
          return createImpl(...args);
        }) as never,
      },
    },
    models: {
      list: (async () => ({ data: [] })) as never,
    },
  } as unknown as OpenAI;
}

async function collect(adapter: OpenAICompatAdapter): Promise<{ chunks: StreamChunk[]; error: unknown }> {
  const chunks: StreamChunk[] = [];
  let error: unknown;
  try {
    for await (const c of adapter.stream(req, { signal: new AbortController().signal })) {
      chunks.push(c);
    }
  } catch (err) {
    error = err;
  }
  return { chunks, error };
}

function adapterWith(client: OpenAI): OpenAICompatAdapter {
  return new OpenAICompatAdapter({ name: "fast", baseUrl: "https://provider.example/v1", apiKey: "k", model: "m1", client });
}

describe("OpenAICompatAdapter (OpenAI SDK)", () => {
  it("parses deltas and a real usage chunk", async () => {
    const adapter = adapterWith(
      fakeClient(async () =>
        streamOf([
          { choices: [{ delta: { content: "Hello " } }] },
          { choices: [{ delta: { content: "world" } }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } },
        ]),
      ),
    );
    const { chunks, error } = await collect(adapter);
    expect(error).toBeUndefined();
    expect(chunks.filter((c) => c.kind === "delta").map((c) => (c as { text: string }).text)).toEqual(["Hello ", "world"]);
    const usage = chunks.at(-1) as Extract<StreamChunk, { kind: "usage" }>;
    expect(usage).toEqual({ kind: "usage", inputTokens: 12, outputTokens: 34, usageEstimated: false });
  });

  it("estimates usage chars/4 when the provider omits it", async () => {
    const adapter = adapterWith(fakeClient(async () => streamOf([{ choices: [{ delta: { content: "12345678" } }] }])));
    const { chunks } = await collect(adapter);
    const usage = chunks.at(-1) as Extract<StreamChunk, { kind: "usage" }>;
    expect(usage.usageEstimated).toBe(true);
    expect(usage.inputTokens).toBe(1);
    expect(usage.outputTokens).toBe(2);
  });

  it("sends model, stream:true and include_usage to the SDK", async () => {
    let captured: unknown;
    const adapter = adapterWith(
      fakeClient(async () => streamOf([]), (args) => {
        captured = args;
      }),
    );
    await collect(adapter);
    const [params, options] = captured as [{ model: string; stream: boolean; stream_options: { include_usage: boolean } }, { signal: AbortSignal }];
    expect(params.model).toBe("m1");
    expect(params.stream).toBe(true);
    expect(params.stream_options.include_usage).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("yields reasoning chunks for reasoning_content deltas and keeps content separate", async () => {
    const adapter = adapterWith(
      fakeClient(async () =>
        streamOf([
          { choices: [{ delta: { reasoning_content: "thinking..." } }] },
          { choices: [{ delta: { content: "answer" } }] },
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 10 } },
        ]),
      ),
    );
    const { chunks } = await collect(adapter);
    expect(chunks[0]).toEqual({ kind: "reasoning", text: "thinking..." });
    expect(chunks[1]).toEqual({ kind: "delta", text: "answer" });
    expect(chunks[2]).toEqual({ kind: "usage", inputTokens: 5, outputTokens: 10, usageEstimated: false });
  });

  it("normalizes provider http errors", async () => {
    const adapter = adapterWith(
      fakeClient(async () => {
        const err = new Error("rate limited");
        (err as { status: number }).status = 429;
        throw err;
      }),
    );
    const { error } = await collect(adapter);
    expect((error as AdapterError).kind).toBe("http");
    expect((error as AdapterError).status).toBe(429);
  });

  it("normalizes SDK timeout to kind timeout", async () => {
    const adapter = adapterWith(
      fakeClient(async () => {
        const err = new Error("connection timed out");
        err.name = "APIConnectionTimeoutError";
        throw err;
      }),
    );
    const { error } = await collect(adapter);
    expect((error as AdapterError).kind).toBe("timeout");
  });

  it("normalizes abort to kind conn", async () => {
    const adapter = adapterWith(
      fakeClient(async () => {
        const err = new Error("request was aborted");
        err.name = "APIUserAbortError";
        throw err;
      }),
    );
    const { error } = await collect(adapter);
    expect((error as AdapterError).kind).toBe("conn");
    expect((error as AdapterError).message).toBe("aborted");
  });

  it("normalizeSdkError maps status-bearing errors to http", () => {
    const mapped = normalizeSdkError(Object.assign(new Error("boom"), { status: 503 }));
    expect(mapped.kind).toBe("http");
    expect(mapped.status).toBe(503);
  });

  it("health returns ok when models.list succeeds and down when it throws", async () => {
    const ok = adapterWith(fakeClient(async () => streamOf([])));
    expect(await ok.health()).toBe("ok");
    const down = adapterWith({
      chat: { completions: { create: (async () => streamOf([])) as never } },
      models: {
        list: (async () => {
          throw new Error("nope");
        }) as never,
      },
    } as unknown as OpenAI);
    expect(await down.health()).toBe("down");
  });
});
