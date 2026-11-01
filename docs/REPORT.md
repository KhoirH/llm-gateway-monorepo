# Technical Report — Mini Inference Router

Author: Hilmi Khoirulloh. All numbers below come from recorded runs of this repository (see `docs/eval-results/`); none are estimated by hand.


## 1. What was built

One Fastify (TypeScript) gateway owns the full request path: zod validation → bearer-key auth (sha256-hashed keys, redacted logs) → atomic per-tenant token quota (fail closed) → per-capability handling → backend attempts through a `BackendAdapter` interface → metering row + routing attempts written in `finally`. PostgreSQL + pgvector stores tenants, keys, metering, traces and the knowledge base. A React console offers two playground sub-tabs — **Chat Completions** (`POST /v1/chat/completions`, streaming with stop/abort, per-turn model/fallback badges, usage, decision trail) and **Support (KB)** — plus a Usage view (`GET /v1/usage`) with a quota bar.

Backends: one generic `OpenAICompatAdapter` (OpenAI SDK) configured purely by env (`FAST_*` / `STRONG_*`: base URL, key, model) serves both tiers — in the current deployment via `api.anoman.io` (`fast` = `gemini-3.1-flash-lite`, `strong` = `gemini-3.5-flash-lite`), plus a deterministic `MockAdapter` (seedable RNG, latency/TTFT/failure controls, `cancelled` flag) used by tests and the `chaos` tenant. Embeddings run through the same adapter interface against Gemini `gemini-embedding-001` (768 dims) for both KB build and query time.

**Architecture diagrams** — `docs/architecture.drawio`, three pages:

1. **AI Flow** — the numbered support pipeline (1 console → 2 Vite proxy → 3 auth → 4 quota reserve → 5 embed query → 6 retrieve top-4 → 7 `route()` tier selection → 8 attempt loop → 9 chunk parser → 10 confidence gate → 11 SSE delivery → 12 metering), with branch paths: early-exit guardrails (401/429/503), fallback (8b), repair retry (9b), refusal (10b), plus endpoint list, seed tenants and routing hard rules.
2. **Data Flow** — what lives where: offline Python tooling in Docker (dataset splitter, KB builder with cache, eval runner) → committed `data/` files → Postgres stores (`tenants` + `api_keys`, `requests` with `route_steps` JSONB, `routing_attempts`, `kb_entries vector(768)`) → runtime gateway reads/writes.
3. **Topology** — ports, processes, protocols: browser (5173) → Vite proxy → gateway (3000) → Postgres 16 + pgvector (5432, `infra-db-1`); Python tooling profile; eval gateways A/B; external APIs (OpenAI-compatible chat `FAST_*`/`STRONG_*`, Gemini embeddings); Render production (web service + managed Postgres with pgvector).

## 2. Request-path decisions worth grading

- **Quota is atomic and fails closed.** Reserve is a single conditional `UPDATE ... WHERE tokens_used + n <= daily_token_quota RETURNING`; zero rows → 429, DB error → 503 before any backend call (test includes a spy proving no model call happens). Reconcile uses `GREATEST(0, tokens_used + actual - reserved)`; full refund when nothing succeeded. A 50-parallel-reserve test admits exactly `floor(quota/estimate)` requests.
- **Fallback only before the first token.** Triggers: any backend error — 4xx (incl. 429), 5xx, connection error — plus TTFT timeout (3000 ms default) and total timeout (20 s). At most `MAX_CONSECUTIVE_RETRIES` = 3 consecutive failed attempts, cycling the fallback chain (fast → strong → fast …), then the chat is closed with the mapped error; policy lives only in `src/retry.ts`. `writeHead` is delayed until the first token so `x-model-used` / `x-fallback-fired` are always correct — including on the support endpoint, where `meta`/`retrieval` events are buffered until then. Mid-stream breaks stream an `error` event and store `partial_failure`; client aborts cancel the upstream call (verified through the mock's `cancelled` flag, and now demonstrable from the console's chat playground Stop button).
- **Support output contract.** The model must answer with a JSON header line (`intent`, `confidence`), a `---` separator, then the answer. A pure, unit-tested chunk parser validates the header with zod before anything is streamed; one repair retry is recorded as its own routing attempt; persistent failure → safe `bad_output` error. Confidence is fixed-weight: `0.4 × top-1 similarity + 0.3 × intent agreement + 0.3 × self-reported`; below 0.55 the upstream is aborted as soon as the header is known and a fixed refusal is returned with no generated answer.
- **Observability.** Every attempt lands in `routing_attempts` (backend, reason: primary/repair/fallback, outcome, latency, error) and every request keeps its `route()` steps (tenant policy, tier selection, chaos routing, model override) as JSON on the metering row. `GET /v1/requests/:id` returns the whole trail, scoped to the caller's tenant.

## 3. Evaluation (recorded run 2026-11-01, current provider env)

30 held-out Bitext cases per configuration (25 in-scope stratified across 27 intents + 5 out-of-scope), zero overlap with the 600-entry KB (asserted by test). Config A = prompt v1 + `fast` (`gemini-3.1-flash-lite`); Config B = prompt v2 (few-shot) + `strong` (`gemini-3.5-flash-lite`). Throttled 1.5 s/request, run sequentially; answer quality = embedding cosine to the reference answer.

| Metric | A (v1 + fast) | B (v2 few-shot + strong) |
|---|---|---|
| Intent accuracy | 25/25 = 100% | 25/25 = 100% |
| Refusal precision (out-of-scope) | 5/5 = 100% | 5/5 = 100% |
| Answer quality (cosine mean) | 0.8752 | 0.8604 |
| Latency p50 / p95 | 2869 / 4530 ms | 2925 / 4326 ms |
| Tokens total (in / out) | 17942 / 3499 | 20467 / 2756 |
| Fallback fired | 0× | 0× |
| Errored cases | 0 | 0 |
| Cost per 100 requests (list prices) | $0.0039 | $0.0105 |

Honest reading (for the recorded run):

- With 25 in-scope cases, intent accuracy and refusal precision differences are **noise** — both configs hit the ceiling on both metrics because the task (paraphrase → KB intent) is easy for the model family and the retrieval surface is small. Counts are shown next to percentages deliberately.
- The only separating metrics are **answer quality** (A +0.015 cosine over B) and **cost** (A ~2.7× cheaper per 100 requests), with latency statistically tied (p50 within 2%, p95 in B's favour by a hair). At this sample size the quality gap is directional, not significant.
- The few-shot prompt in B did not pay for itself: more tokens per request (20467 vs 17942 input) for slightly lower cosine quality and higher cost. On this task, prompt v1 + the fast tier is the better default.
- What more time would buy: more held-out cases per intent, an LLM-as-judge (different model from the generator, bias stated), repeated runs for variance, and a hard out-of-scope classifier.

## 4. Trade-offs (deliberate, stated)

- No fallback after the first streamed token — restarting silently would show inconsistent text; partial text + explicit error instead.
- Estimated cost uses **list prices** from `config/models.ts` even though the providers used are free-tier (`usage_estimated` flags estimated token counts).
- Small KB slice (600 entries) — enough to be real, small enough to embed in one command.
- Demo console uses **seeded keys** instead of login; keys are printed once at seed time.
- Direct provider calls: adding a provider is one adapter config entry (new env = new `FAST_*`/`STRONG_*` values, as happened in this env switch), but there is no provider abstraction beyond the OpenAI-compatible shape.
- Embedding tooling is Python-in-Docker by choice; the runtime retrieval path is TypeScript inside the request path.

## 5. Deliverables

- Repo with README, this report, `CUTS.md`, console guide (`docs/console-guide.md`) and Postman collection.
- 85 tests (unit + integration) covering quota atomicity, every fallback trigger, parser, refusal, retrieval, auth and log redaction.
- Eval reproducible with one command (`docs/eval-howto.md`); results committed under `docs/eval-results/` (latest recorded, current env: `eval-salvaged-20261101-074509`; chart + email version included).
- Architecture diagrams: `docs/architecture.drawio` (AI flow, data flow, topology).
- Console playground in two modes (Chat Completions / Support KB) with streaming, stop, per-turn usage and decision trail; Usage view with quota bar.
- Demo video: recorded separately (architecture, playground with trace, globex quota exhaustion, chaos fallback, refusal, eval table).
