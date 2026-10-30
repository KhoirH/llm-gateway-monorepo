import { AdapterError, type BackendAdapter, type ChatRequest, type StreamChunk, type StreamOptions } from "./types.js";

export type MockFailMode = "error5xx" | "429" | "hang" | "midStream";

export interface MockOptions {
  name?: string;
  latencyMs?: number;
  ttftMs?: number;
  failureRate?: number;
  failMode?: MockFailMode;
  seed?: number;
  chunkCount?: number;
  chunkText?: string;
}

export class MockAdapter implements BackendAdapter {
  name: string;
  private opts: MockOptions;
  private state: number;
  private _cancelled = false;

  constructor(opts: MockOptions = {}) {
    this.name = opts.name ?? "mock";
    this.opts = opts;
    this.state = opts.seed ?? 42;
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  private next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        this._cancelled = true;
        reject(new AdapterError("conn", "aborted"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        this._cancelled = true;
        reject(new AdapterError("conn", "aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async *stream(req: ChatRequest, opts: StreamOptions): AsyncIterable<StreamChunk> {
    const signal = opts.signal;
    await this.sleep(this.opts.latencyMs ?? 0, signal);
    await this.sleep(this.opts.ttftMs ?? 0, signal);
    const failureRate = this.opts.failureRate ?? 0;
    const fail = failureRate > 0 && this.next() < failureRate;
    if (fail && this.opts.failMode === "error5xx") {
      throw new AdapterError("http", "mock http 500", 500);
    }
    if (fail && this.opts.failMode === "429") {
      throw new AdapterError("http", "mock http 429", 429);
    }
    if (fail && this.opts.failMode === "hang") {
      await new Promise<void>((_, reject) => {
        if (signal.aborted) {
          this._cancelled = true;
          reject(new AdapterError("conn", "aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            this._cancelled = true;
            reject(new AdapterError("conn", "aborted"));
          },
          { once: true },
        );
      });
      return;
    }
    if (fail && this.opts.failMode === "midStream") {
      yield { kind: "delta", text: "partial " };
      yield { kind: "delta", text: "text " };
      throw new AdapterError("conn", "mock mid-stream break");
    }
    const chunks = this.opts.chunkCount ?? 3;
    const text = this.opts.chunkText ?? "mock";
    for (let i = 1; i <= chunks; i++) {
      await this.sleep(5, signal);
      yield { kind: "delta", text: `${text}-${i} ` };
    }
    yield { kind: "usage", inputTokens: 10, outputTokens: chunks * 3, usageEstimated: false };
  }

  async health(): Promise<"ok" | "down"> {
    return "ok";
  }
}
