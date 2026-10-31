import type { Env } from "../env.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { MockAdapter } from "./mock.js";
import type { BackendAdapter } from "./types.js";

export function defaultAdapters(env: Env): Record<string, BackendAdapter> {
  return {
    fast: new OpenAICompatAdapter({ name: "fast", baseUrl: env.FAST_BASE_URL, apiKey: env.FAST_API_KEY, model: env.FAST_MODEL }),
    strong: new OpenAICompatAdapter({ name: "strong", baseUrl: env.STRONG_BASE_URL, apiKey: env.STRONG_API_KEY, model: env.STRONG_MODEL }),
    mock: new MockAdapter({ failureRate: env.MOCK_FAILURE_RATE, failMode: env.MOCK_FAIL_MODE }),
    embed: new OpenAICompatAdapter({
      name: "embed",
      baseUrl: env.EMBED_BASE_URL ?? env.FAST_BASE_URL,
      apiKey: env.EMBED_API_KEY ?? env.FAST_API_KEY,
      model: env.EMBED_MODEL,
      embedDim: env.EMBED_DIM,
    }),
  };
}
