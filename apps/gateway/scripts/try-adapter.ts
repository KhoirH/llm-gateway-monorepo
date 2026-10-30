import { loadEnv } from "../src/env.js";
import { OpenAICompatAdapter } from "../src/adapters/openai-compat.js";

const env = loadEnv();
console.log("key length:", env.FAST_API_KEY.length, "baseURL:", env.FAST_BASE_URL, "model:", env.FAST_MODEL);
const adapter = new OpenAICompatAdapter({ name: "fast", baseUrl: env.FAST_BASE_URL, apiKey: env.FAST_API_KEY, model: env.FAST_MODEL });
try {
  for await (const chunk of adapter.stream({ messages: [{ role: "user", content: "Say OK" }] }, { signal: new AbortController().signal })) {
    console.log(chunk.kind, chunk.kind === "delta" ? JSON.stringify(chunk.text) : JSON.stringify(chunk));
  }
  console.log("ADAPTER DIRECT: PASS");
} catch (err) {
  console.log("ADAPTER DIRECT: FAIL", err);
}
