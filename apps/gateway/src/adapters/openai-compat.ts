import OpenAI from "openai";
import { AdapterError, type BackendAdapter, type ChatRequest, type StreamChunk, type StreamOptions } from "./types.js";

export interface OpenAICompatOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  embedDim?: number;
  client?: OpenAI;
}

export function normalizeSdkError(err: unknown): AdapterError {
  const e = err as { status?: number; name?: string; message?: string };
  if (e?.name === "AbortError" || e?.name === "APIUserAbortError") {
    return new AdapterError("conn", "aborted");
  }
  if (e?.name === "APIConnectionTimeoutError" || e?.name === "TimeoutError") {
    return new AdapterError("timeout", "provider timeout");
  }
  if (typeof e?.status === "number" && e.status > 0) {
    return new AdapterError("http", `provider http ${e.status}: ${e?.message ?? ""}`, e.status);
  }
  return new AdapterError("conn", `connection error: ${e?.message ?? "unknown"}`);
}

export class OpenAICompatAdapter implements BackendAdapter {
  name: string;
  private model: string;
  private embedDim?: number;
  private client: OpenAI;

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.embedDim = opts.embedDim;
    this.client =
      opts.client ??
      new OpenAI({
        baseURL: opts.baseUrl,
        apiKey: opts.apiKey,
        maxRetries: 0,
        timeout: 20_000,
      });
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const res = await this.client.embeddings.create(
        {
          model: this.model,
          input: texts,
          ...(this.embedDim !== undefined ? { dimensions: this.embedDim } : {}),
        },
        { signal: AbortSignal.timeout(60_000) },
      );
      return res.data.map((d) => d.embedding);
    } catch (err) {
      throw normalizeSdkError(err);
    }
  }

  async *stream(req: ChatRequest, opts: StreamOptions): AsyncIterable<StreamChunk> {
    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: req.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        },
        { signal: opts.signal },
      );
    } catch (err) {
      throw normalizeSdkError(err);
    }

    let outChars = 0;
    let usageYielded = false;
    try {
      for await (const chunk of stream) {
        const reasoning = (chunk.choices?.[0]?.delta as { reasoning_content?: string } | undefined)?.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          yield { kind: "reasoning", text: reasoning };
        }
        const text = chunk.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) {
          outChars += text.length;
          yield { kind: "delta", text };
        }
        const usage = chunk.usage;
        if (typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number") {
          usageYielded = true;
          yield { kind: "usage", inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, usageEstimated: false };
        }
      }
    } catch (err) {
      throw normalizeSdkError(err);
    }

    if (!usageYielded) {
      const inChars = req.messages.reduce((n, m) => n + m.content.length, 0);
      yield { kind: "usage", inputTokens: Math.ceil(inChars / 4), outputTokens: Math.ceil(outChars / 4), usageEstimated: true };
    }
  }

  async health(): Promise<"ok" | "down"> {
    try {
      await this.client.models.list({ signal: AbortSignal.timeout(5000) });
      return "ok";
    } catch {
      return "down";
    }
  }
}
