# Approach B: No LiteLLM (everything in the Node gateway)

Prepared for: Hilmi Khoirulloh | Purpose: input for an AI coding agent | Target effort: about 12 hours | Stack: React (Vite), Node.js 20 + Fastify + TypeScript, PostgreSQL + pgvector, direct provider calls

> Provider endpoints and model names are written from memory. **Verify them in B0** (free-tier model names, rate limits, OpenAI-compatible base URLs, embedding availability) and fix this file where it differs.

## 1. Thesis

One Node service owns the whole request path: auth, quota, routing, fallback, streaming, metering and trace. Providers are reached through a thin `BackendAdapter`. Groq, Gemini (OpenAI-compatible endpoint, verify) and Ollama all speak the OpenAI chat protocol, so **one generic `OpenAICompatAdapter` configured by base URL, key and model name covers all real backends**, plus an in-process `MockAdapter`. No extra service to deploy.

This maximises what the assessment grades directly: correctness of the request path, observable fallback, and code structure.

## 2. Agent rules

1. One milestone at a time. Restate the plan in five lines, list assumptions and files first.
2. Tests with the code. Report acceptance checks as a checklist and stop at CHECKPOINTs.
3. Never invent numbers; every figure comes from a recorded run.
4. Log each cut in docs/CUTS.md when it happens.
5. No secrets in the repo; keep .env.example current.
6. Human review is mandatory for: auth, quota SQL, routing, fallback loop, stream handling.

## 3. Scope (cuts already made)

Cut: admin key and cross-tenant usage, `eval_runs`/`eval_results` and `model_catalog` tables (results are JSON and Markdown; prices in `config/models.ts`), quota reset schedule (manual reset script), circuit breaker (stretch only), Ollama in production, LLM-as-judge (optional), CI (optional), capability filter and budget guard rules (listed as future work unless time remains).
Kept: everything the assessment names.

## 4. Architecture

```
React console --> Fastify gateway --> OpenAICompatAdapter(fast: Groq) 
                       |          --> OpenAICompatAdapter(strong: Gemini)
                       |          --> MockAdapter (latency, failure, mid-stream break)
                       +--> PostgreSQL (+pgvector)
```

Gateway pipeline per request: request id -> zod validation -> auth -> quota reserve -> (support only: embed + retrieve) -> route -> attempt loop with SSE -> reconcile quota -> write `requests` row (in `finally`).

## 5. Backends

```ts
interface BackendAdapter {
  name: string;
  stream(req: ChatRequest, o: { signal: AbortSignal }): AsyncIterable<StreamChunk>; // deltas + final usage
  embed?(texts: string[]): Promise<number[][]>;
  health(): Promise<'ok'|'down'>;
}
```

- `OpenAICompatAdapter({ baseUrl, apiKey, model })`: `fetch` with `stream: true` and `stream_options.include_usage` (verify support per provider). Normalise errors to `http(status) | conn | timeout`. Estimate usage (chars/4) and flag `usage_estimated` when the provider omits it.
- `MockAdapter`: `latencyMs`, `ttftMs`, `failureRate`, `failMode` (`error5xx`, `429`, `hang`, `midStream`), seedable RNG for deterministic tests, `cancelled` flag for abort tests.
- Embeddings: Groq has no embeddings (verify). Use the Gemini embedding endpoint (verify) for both KB build and query time. Vector dimension must match the model.
- Prices live in `config/models.ts` as list prices; docs must say estimated cost uses list prices.

## 6. Data model

- `tenants(id, name, allowed_models, daily_token_quota, tokens_used)`
- `api_keys(id, tenant_id, key_hash, prefix, revoked_at)`
- `requests(id, tenant_id, capability, model_used, input_tokens, output_tokens, usage_estimated, latency_ms, ttft_ms, estimated_cost, outcome, fallback_fired, created_at)`
- `routing_attempts(request_id, attempt, backend, reason, outcome, latency_ms, error)`
- `kb_entries(id, question, answer, intent, embedding vector(N))`

Quota reserve (atomic, fail closed):

```sql
UPDATE tenants SET tokens_used = tokens_used + $2
WHERE id = $1 AND tokens_used + $2 <= daily_token_quota
RETURNING tokens_used;
```

Zero rows -> 429 `quota_exhausted`. Any DB error -> 503 `quota_unavailable` before any backend call. Reconcile with `GREATEST(0, tokens_used + actual - reserved)`; refund fully if no model call succeeded.

Seed tenants: `acme` (all models, normal quota), `globex` (tiny quota, `fast` only), `chaos` (mock primary with configurable failure rate).

## 7. Routing and fallback

Pure function `route(input, cfg) -> { chain, steps }`, config-driven thresholds:

1. **Tenant policy** (hard filter): only `allowed_models`; empty means 403 `model_not_allowed`.
2. **Tier selection** (support): top-1 similarity >= 0.80 and input under ~120 tokens -> `fast`, else `strong`. Rationale: easy, well-covered questions do not need the expensive model.
3. **Fallback chain**: chosen backend, then the other real model. `chaos` tenant: mock first.

Fallback triggers: 5xx, 429, connection error, any provider 4xx, no first token within 3000 ms, total timeout 20 s. At most `MAX_CONSECUTIVE_RETRIES` (3) consecutive failed attempts, cycling the fallback chain (fast -> strong -> fast ...); after that the chat is closed with the mapped error. Retry policy and error mapping live only in `src/retry.ts` (previously duplicated in both route files; 4xx used to fail fast). **Fallback only before the first token is written to the client.** A mid-stream break emits an `error` event with partial text and stores `partial_failure`. Delay `writeHead` until the first token so `x-model-used` and `x-fallback-fired` are correct. Each attempt writes a `routing_attempts` row; `GET /v1/requests/:id` returns the trace plus the `steps` from `route()`.

One test per rule, one per fallback trigger, one for mid-stream failure.

## 8. API

- `POST /v1/chat/completions`: Bearer key, OpenAI-style body, SSE. Headers: `x-request-id`, `x-model-used`, `x-fallback-fired`.
- `POST /v1/capabilities/support/answer`: SSE events `meta`, `retrieval`, `delta`, `final`, `error`.
- `GET /v1/usage`: the caller's own requests, cost, tokens, remaining quota.
- `GET /v1/requests/:id`: trace, scoped to the caller's tenant.
- `GET /healthz`.
- One error shape: `{error:{code,message,request_id}}`. Codes: invalid_request 400, invalid_api_key 401, model_not_allowed 403, quota_exhausted 429, all_backends_failed / bad_output 502, quota_unavailable 503, timeout 504.

Non-functional: zod everywhere, body size limit, timeout on every outbound call, keys hashed and never logged (redact the Authorization header), structured JSON logs with request id.

## 9. Support assistant

Embed message, retrieve top-4 by cosine (`1 - (embedding <=> $1)`), prompt with the pairs and intent labels. Model output: JSON header line `{"intent","confidence"}`, then `---`, then the answer. A pure, unit-tested chunk parser validates the header with zod before anything is streamed. Invalid header: one repair retry (recorded as its own attempt), then a safe error with outcome `bad_output`.

Confidence = 0.4 * top-1 similarity + 0.3 * intent agreement (share of top-k entries with the model's intent) + 0.3 * self-reported confidence. **Weights are fixed; only the threshold is tuned (start 0.55).** Below threshold: abort the upstream stream as soon as the header is known, return a fixed refusal asking for clarification, `refused: true`, no generated answer.

Data: Bitext customer support dataset (verify id and licence). Split 30 held-out rows first (stratified by intent) plus about 5 hand-written out-of-scope messages, then slice about 600 KB entries across all intents. A test asserts zero overlap.

## 10. Milestones (about 12 h)

| ID | Scope | h |
|---|---|---|
| B0 | Repo, docker-compose (Postgres+pgvector), health endpoint, verify provider endpoints and free-tier limits, **one real completion from the deployed gateway** | 0.75 |
| B1 | Migrations, seed, key hashing, auth, atomic quota, metering, error handler, zod | 2 |
| B2 | Adapters, mock controls, SSE endpoint, abort handling, TTFT. CHECKPOINT | 2 |
| B3 | Router, fallback loop, `routing_attempts`, trace endpoint | 1.5 |
| B4 | Dataset split and slice, batched embeddings with backoff and cache, retrieval | 1 |
| B5 | Support capability, parser, repair, confidence, refusal. CHECKPOINT | 1.5 |
| B6 | Console: playground (stream, model, fallback badge, entries, intent, tokens, latency, cost) and usage view | 1.25 |
| B7 | Eval runner and report, deploy, README, REPORT, CUTS, video. CHECKPOINT | 2 |

## 11. Acceptance highlights

- 401 invalid key; 429 `quota_exhausted` on `globex`; DB killed gives 503 with a spy proving no backend call; **50 parallel requests never exceed quota**; no raw key in logs.
- Client abort cancels the upstream call (mock `cancelled` flag).
- `chaos` tenant: fallback fires and the trace explains why; mid-stream break stored as `partial_failure`.
- Garbage model output gives a safe error; out-of-scope message is refused.
- One command reproduces the eval report (A vs B configs, intent accuracy, cosine quality, p50/p95, tokens, cost per 100 requests, counts as well as percentages).

## 12. Evaluation

About 30 held-out cases (about 25 in-scope, 5 out-of-scope). Config A = prompt v1 + `fast`; config B = prompt v2 (few-shot) + `strong`, run sequentially and throttled. Quality = embedding cosine to the reference answer (LLM-as-judge optional; if used, a different model from the generator, and state the bias risk). Report refusal precision. With 30 cases differences are noisy: say so and say what you would do with more time.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Providers differ in streaming usage fields | Estimate and flag `usage_estimated` |
| Free-tier rate limits during eval | Throttle, cache embeddings, run configs sequentially, treat 429 as fallback |
| More own code than Approach A | Keep adapters generic; keep routing pure and tested |
| Streaming plus structured output fragile | Header-then-answer parser with one repair |
| Cold start on free hosting | Note in README, warm before recording |

## 14. Repo

```
/apps/gateway   Fastify API, router, adapters, migrations, tests
/apps/console   React (Vite)
/infra          docker-compose, render.yaml
/scripts        dataset slice, embeddings, eval runner, smoke
/docs           README.md, REPORT.md, CUTS.md, eval results
```

Report trade-offs to state: no fallback after the first token; list-price cost estimates; small KB slice; seeded demo keys instead of login; direct provider calls mean new providers need an adapter config entry.