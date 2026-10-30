export type AdapterErrorKind = "http" | "conn" | "timeout";

export class AdapterError extends Error {
  constructor(
    public kind: AdapterErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export type StreamChunk =
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number; usageEstimated: boolean };

export interface StreamOptions {
  signal: AbortSignal;
}

export interface BackendAdapter {
  name: string;
  stream(req: ChatRequest, opts: StreamOptions): AsyncIterable<StreamChunk>;
  embed?(texts: string[]): Promise<number[][]>;
  health(): Promise<"ok" | "down">;
}
