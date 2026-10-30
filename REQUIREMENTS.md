# Requirements — LLM Gateway (Approach B: No LiteLLM)

Source of truth: `AGENT.md`. If this file and `AGENT.md` disagree, `AGENT.md` wins.
Stack: React (Vite), Node.js 20 + Fastify + TypeScript, PostgreSQL + pgvector, direct provider calls (no LiteLLM, no extra service).
Target effort: about 12 hours. Prepared for: Hilmi Khoirulloh.

> Provider endpoints and model names in `AGENT.md` are written from memory and must be verified in B0. Requirements below that depend on provider behaviour are marked **[VERIFY]**.

## 1. Product requirements (FR)

| ID | Requirement | Source |
|---|---|---|
| FR-1 | `POST /v1/chat/completions` accepts an OpenAI-style body, authenticates a per-tenant Bearer key. Body `stream` is optional, default `false`: `false` returns one JSON `chat.completion` object; `true` streams SSE OpenAI-compatible chunks. Response headers: `x-request-id`, `x-model-used`, `x-fallback-fired`. (Deviation from AGENT.md approved by Hilmi: stream param + default false.) | AGENT.md §8 |
| FR-2 | Per-tenant daily token quota. Reserve is atomic and fails closed: exhausted quota -> 429 `quota_exhausted`; quota store unreachable -> 503 `quota_unavailable` before any backend call. Reconcile after the call with `GREATEST(0, tokens_used + actual - reserved)`; refund fully if no model call succeeded. | AGENT.md §6 |
| FR-3 | Every request writes one `requests` metering row (in `finally`): tenant, capability, model used, input/output tokens, `usage_estimated`, latency, TTFT, estimated cost, outcome, `fallback_fired`. | AGENT.md §6, §8 |
| FR-4 | At least two real backends plus a mock backend, all behind one `BackendAdapter` interface (`stream`, optional `embed`, `health`). Groq and Gemini both go through a generic `OpenAICompatAdapter({ baseUrl, apiKey, model })`. **[VERIFY]** free-tier model names, OpenAI-compatible base URLs, `stream_options.include_usage` support, embedding availability. | AGENT.md §4, §5 |
| FR-5 | Config-driven routing via pure function `route(input, cfg) -> { chain, steps }`. Fallback fires on: 5xx, 429, connection error, no first token within 3000 ms, total timeout 20 s. Every attempt is stored in `routing_attempts` and is viewable via the trace endpoint. | AGENT.md §7 |
| FR-6 | `POST /v1/capabilities/support/answer` embeds the message, retrieves top-4 by cosine, and streams SSE events: `meta`, `retrieval`, `delta`, `final`, `error`. Output includes answer, detected intent, retrieved entries, confidence signal, refusal flag. | AGENT.md §8, §9 |
| FR-7 | Unusable model output is handled: header parsed by a pure, unit-tested chunk parser with zod; invalid header gets one repair retry (recorded as its own attempt), then a safe error with outcome `bad_output`. Low confidence produces a fixed refusal, no generated answer. | AGENT.md §9 |
| FR-8 | React console with: playground (streaming answer, model served, fallback badge, retrieved entries, intent, tokens, latency, cost) and usage view (requests, cost, tokens, remaining quota for the caller's own tenant). | AGENT.md §10 B6 |
| FR-9 | Evaluation script over ~30 held-out cases, run on two configurations (A vs B), producing a comparison report reproducible with one command. | AGENT.md §12 |

## 2. Non-functional requirements (NFR)

| ID | Requirement |
|---|---|
| NFR-1 | Zod validation on every endpoint; body size limit enforced. |
| NFR-2 | Timeout on every outbound call (TTFT 3000 ms, total 20 s defaults, config-driven). |
| NFR-3 | API keys stored hashed (`key_hash` + `prefix` only); never logged; Authorization header redacted in logs. |
| NFR-4 | Structured JSON logs carrying the request id. |
| NFR-5 | One error shape everywhere: `{error:{code,message,request_id}}`. Codes: `invalid_request` 400, `invalid_api_key` 401, `model_not_allowed` 403, `quota_exhausted` 429, `all_backends_failed` / `bad_output` 502, `quota_unavailable` 503, `timeout` 504. |
| NFR-6 | Usage estimation fallback: estimate tokens as chars/4 and flag `usage_estimated: true` when the provider omits usage. **[VERIFY]** per-provider support. |
| NFR-7 | No secrets in the repo; `.env.example` kept current. |
| NFR-8 | Adapter errors normalised to `http(status) | conn | timeout`. |

## 3. Routing rules (ordered, from AGENT.md §7)

1. **Tenant policy (hard filter):** only `allowed_models` are candidates; empty list -> 403 `model_not_allowed`.
2. **Tier selection (support capability only):** retrieval top-1 similarity >= 0.80 AND input under ~120 tokens -> `fast`; otherwise `strong`.
3. **Fallback chain:** chosen backend, then the other real model. `chaos` tenant: mock first.

Hard rules:

- Fallback only before the first token is written to the client. A mid-stream break emits an `error` event with the partial text and stores outcome `partial_failure`.
- Provider 4xx other than 429 fails fast (caller or config error) — no fallback.
- `writeHead` is delayed until the first token so `x-model-used` and `x-fallback-fired` are correct.
- Each attempt writes a `routing_attempts` row.
- `GET /v1/requests/:id` returns the trace plus the `steps` from `route()`, scoped to the caller's tenant.

## 4. Data model

| Table | Columns |
|---|---|
| `tenants` | id, name, allowed_models, daily_token_quota, tokens_used |
| `api_keys` | id, tenant_id, key_hash, prefix, revoked_at |
| `requests` | id, tenant_id, capability, model_used, input_tokens, output_tokens, usage_estimated, latency_ms, ttft_ms, estimated_cost, outcome, fallback_fired, created_at |
| `routing_attempts` | request_id, attempt, backend, reason, outcome, latency_ms, error |
| `kb_entries` | id, question, answer, intent, embedding vector(N) |

Quota reserve SQL (atomic, fail closed):

```sql
UPDATE tenants SET tokens_used = tokens_used + $2
WHERE id = $1 AND tokens_used + $2 <= daily_token_quota
RETURNING tokens_used;
```

- Zero rows -> 429 `quota_exhausted`.
- Any DB error -> 503 `quota_unavailable` before any backend call.

Seed tenants: `acme` (all models, normal quota), `globex` (tiny quota, `fast` only), `chaos` (mock primary with configurable failure rate). Quota reset is a manual script (no schedule). Prices live in `config/models.ts` as list prices; docs must state estimated cost uses list prices.

## 5. Support assistant (AGENT.md §9)

- Embed message, retrieve top-4 by cosine: `1 - (embedding <=> $1)`.
- Prompt contains the retrieved pairs and intent labels.
- Required model output: first line JSON header `{"intent","confidence"}`, then `---`, then the answer.
- A pure, unit-tested chunk parser validates the header with zod before anything is streamed.
- Invalid header: one repair retry, recorded as its own `routing_attempts` entry, then safe error with outcome `bad_output`.
- Confidence = `0.4 * top-1 similarity + 0.3 * intent agreement (share of top-k entries with the model's intent) + 0.3 * self-reported confidence`. Weights are fixed; only the threshold is tuned (start 0.55).
- Below threshold: abort the upstream stream as soon as the header is known, return a fixed refusal asking for clarification, `refused: true`, no generated answer.
- Data: Bitext customer support dataset **[VERIFY id and licence]**. Split 30 held-out rows first (stratified by intent) plus ~5 hand-written out-of-scope messages, then slice ~600 KB entries across all intents. A test asserts zero overlap between held-out and KB.
- Embeddings via the Gemini embedding endpoint for both KB build and query time **[VERIFY]** (Groq has no embeddings). Vector dimension must match the model.

## 6. Endpoints

| Endpoint | Behaviour |
|---|---|
| `POST /v1/chat/completions` | Bearer key, OpenAI-style body, SSE. Headers: `x-request-id`, `x-model-used`, `x-fallback-fired`. |
| `POST /v1/capabilities/support/answer` | SSE events `meta`, `retrieval`, `delta`, `final`, `error`. |
| `GET /v1/usage` | The caller's own requests, cost, tokens, remaining quota. No cross-tenant view (admin key cut). |
| `GET /v1/requests/:id` | Full trace incl. routing attempts + route `steps`; scoped to the caller's tenant. |
| `GET /healthz` | Liveness. |

## 7. Milestone acceptance criteria

### B0 — Foundation (0.75 h)
- [ ] Repo skeleton per §9 (repo layout below).
- [ ] `infra/docker-compose` runs Postgres + pgvector.
- [ ] `GET /healthz` returns ok.
- [ ] Provider endpoints, free-tier model names, rate limits, OpenAI-compatible base URLs, and embedding availability verified; discrepancies fixed in `AGENT.md`.
- [ ] **One real completion from the deployed gateway.**

### B1 — Auth, quota, metering (2 h)
- [ ] Migrations + seed script for the three tenants.
- [ ] Key hashing; auth middleware; invalid key -> 401 `invalid_api_key`.
- [ ] Atomic quota reserve; exhausted quota -> 429 `quota_exhausted` (test on `globex`).
- [ ] DB killed -> 503 `quota_unavailable` with a spy proving no backend call.
- [ ] **50 parallel requests never exceed quota.**
- [ ] Metering rows written on success and failure paths.
- [ ] No raw key in logs; Authorization header redacted.

### B2 — Adapters, streaming, abort (2 h) — **CHECKPOINT**
- [ ] `BackendAdapter` interface; generic `OpenAICompatAdapter`; `MockAdapter` with `latencyMs`, `ttftMs`, `failureRate`, `failMode` (`error5xx`, `429`, `hang`, `midStream`), seedable RNG, `cancelled` flag.
- [ ] SSE endpoint streams first token; usage recorded or flagged `usage_estimated`.
- [ ] Client abort cancels the upstream call (proven via mock `cancelled` flag).
- [ ] TTFT measured.

### B3 — Router, fallback, trace (1.5 h)
- [ ] Pure `route()` with one unit test per rule.
- [ ] One integration test per fallback trigger (5xx, 429, conn error, TTFT timeout, total timeout).
- [ ] `chaos` tenant: fallback fires and the trace explains why.
- [ ] Mid-stream break -> `error` event + outcome `partial_failure` (one test).
- [ ] `routing_attempts` rows written per attempt; `GET /v1/requests/:id` returns trace + `steps`.

### B4 — Dataset, embeddings, retrieval (1 h)
- [ ] Dataset split script: 30 held-out first, ~5 out-of-scope, ~600 KB slice, zero-overlap test.
- [ ] Batched embeddings with backoff and cache.
- [ ] Retrieval returns sensible entries for manual queries.

### B5 — Support capability (1.5 h) — **CHECKPOINT**
- [ ] Header-then-answer parser (pure, zod-validated).
- [ ] Repair retry recorded as its own attempt; garbage output -> safe error, not a crash.
- [ ] Confidence computed per fixed formula; threshold starts at 0.55.
- [ ] Out-of-scope message -> refusal, `refused: true`, upstream aborted early.

### B6 — Console (1.25 h)
- [ ] Playground streams the answer and shows model, fallback badge, entries, intent, tokens, latency, cost.
- [ ] Usage view shows requests, cost, tokens, remaining quota.
- [ ] Errors (quota, auth) display readable messages.

### B7 — Eval, ship (2 h) — **CHECKPOINT**
- [ ] One command reproduces the eval report (A vs B, intent accuracy, cosine quality, p50/p95, tokens, cost per 100 requests, counts as well as percentages).
- [ ] Deployed URL works end to end.
- [ ] README, REPORT.md, CUTS.md, demo video.

## 8. Evaluation plan

- ~30 held-out cases (~25 in-scope, 5 out-of-scope).
- Config A = prompt v1 + `fast`; Config B = prompt v2 (few-shot) + `strong`. Run sequentially and throttled.
- Quality metric = embedding cosine to the reference answer. LLM-as-judge optional; if used, a different model from the generator, and the bias risk stated.
- Report refusal precision on out-of-scope cases.
- State that with 30 cases differences are noisy, and say what more time would buy.

## 9. Testing requirements

- Unit: `route()` rules, quota SQL, chunk parser, cost calculator, confidence formula.
- Integration: auth failure, quota exhaustion, DB outage (spy: no backend call), each fallback trigger, mid-stream break, client abort, 50-parallel quota test.
- One smoke script (curl) for the three seed tenants against the deployed URL.

## 10. Explicit cuts (must not be built)

Admin key and cross-tenant usage; `eval_runs`/`eval_results` and `model_catalog` tables (results are JSON + Markdown; prices in `config/models.ts`); quota reset schedule (manual script instead); circuit breaker (stretch only, only if time remains); Ollama in production (dev only); LLM-as-judge (optional); CI (optional); capability filter and budget guard rules (future work). New cuts during the build are logged in `docs/CUTS.md` at the moment they happen.

## 11. Repo layout

```
/apps/gateway   Fastify API, router, adapters, migrations, tests
/apps/console   React (Vite)
/infra          docker-compose, render.yaml
/scripts        dataset slice, embeddings, eval runner, smoke
/docs           README.md, REPORT.md, CUTS.md, eval results
```

## 12. Trade-offs the report must state

- No fallback after the first token.
- Estimated cost uses list prices.
- Small KB slice (~600 entries).
- Seeded demo keys instead of login.
- Direct provider calls: a new provider needs an adapter config entry.

## 13. Process rules for the agent (from AGENT.md §2)

1. One milestone at a time; restate the plan in five lines and list assumptions and files first.
2. Tests are written with the code; report acceptance checks as a checklist; stop at CHECKPOINTs (B2, B5, B7).
3. Never invent numbers; every figure comes from a recorded run.
4. Log each cut in `docs/CUTS.md` when it happens.
5. No secrets in the repo; keep `.env.example` current.
6. Human review is mandatory before proceeding past: auth, quota SQL, routing, fallback loop, stream handling.
