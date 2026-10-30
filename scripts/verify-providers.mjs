import OpenAI from "openai";

const TIMEOUT_MS = 20000;

function buildProviders() {
  const providers = [];
  if (process.env.FAST_API_KEY) {
    providers.push({
      name: "fast",
      client: new OpenAI({ baseURL: process.env.FAST_BASE_URL || "https://api.groq.com/openai/v1", apiKey: process.env.FAST_API_KEY, maxRetries: 0, timeout: TIMEOUT_MS }),
      model: process.env.FAST_MODEL || "llama-3.1-8b-instant",
    });
  } else {
    console.log("SKIP fast: FAST_API_KEY not set");
  }
  if (process.env.STRONG_API_KEY) {
    providers.push({
      name: "strong",
      client: new OpenAI({ baseURL: process.env.STRONG_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: process.env.STRONG_API_KEY, maxRetries: 0, timeout: TIMEOUT_MS }),
      model: process.env.STRONG_MODEL || "gemini-2.0-flash",
    });
  } else {
    console.log("SKIP strong: STRONG_API_KEY not set");
  }
  return providers;
}

function classify(err) {
  if (err?.name === "APIConnectionTimeoutError" || err?.name === "TimeoutError") return "timeout";
  if (err?.name === "APIConnectionError" || err?.name === "AbortError") return "conn";
  if (typeof err?.status === "number") return `http(${err.status})`;
  return "conn";
}

async function probeCompletion(p) {
  const started = Date.now();
  try {
    const res = await p.client.chat.completions.create({
      model: p.model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 5,
    });
    const ms = Date.now() - started;
    const content = res.choices?.[0]?.message?.content ?? "";
    const usage = res.usage ? `in=${res.usage.prompt_tokens} out=${res.usage.completion_tokens}` : "usage MISSING";
    console.log(`PASS ${p.name} completion model=${res.model ?? p.model} latency=${ms}ms usage=${usage} content=${JSON.stringify(content)}`);
    return true;
  } catch (err) {
    console.log(`FAIL ${p.name} completion error=${classify(err)} detail=${err.message?.slice(0, 200)}`);
    return false;
  }
}

async function probeStreamingUsage(p) {
  try {
    const stream = await p.client.chat.completions.create({
      model: p.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Say OK" }],
      max_tokens: 5,
    });
    let hasUsage = false;
    let hasDelta = false;
    for await (const chunk of stream) {
      if (chunk.choices?.[0]?.delta) hasDelta = true;
      if (chunk.usage) hasUsage = true;
    }
    console.log(`PASS ${p.name} stream include_usage=${hasUsage ? "yes" : "NO"} deltas=${hasDelta ? "yes" : "no"}`);
    return true;
  } catch (err) {
    console.log(`FAIL ${p.name} stream error=${classify(err)} detail=${err.message?.slice(0, 200)}`);
    return false;
  }
}

async function main() {
  const providers = buildProviders();
  if (providers.length === 0) {
    console.log("No provider keys set. Copy .env.example to .env and fill in keys.");
    console.log("Contoh GLM (Zhipu): FAST_BASE_URL=https://open.bigmodel.cn/api/paas/v4 FAST_MODEL=glm-4.5-flash");
    process.exit(0);
  }
  let allOk = true;
  for (const p of providers) {
    const ok = (await probeCompletion(p)) && (await probeStreamingUsage(p));
    if (!ok) allOk = false;
  }
  console.log(allOk ? "RESULT: all providers verified" : "RESULT: some probes failed; fix model names or base URLs in .env and AGENT.md");
  process.exit(allOk ? 0 : 1);
}

main();
