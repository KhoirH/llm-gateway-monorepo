# Technical Report — Mini Inference Router (Approach B)

Author: Hilmi Khoirulloh. All numbers below come from recorded runs of this repository (see `docs/eval-results/`); none are estimated by hand.

## 1. What was built

One Fastify (TypeScript) gateway owns the full request path: zod validation → bearer-key auth (sha256-hashed keys, redacted logs) → atomic per-tenant token quota (fail closed) → per-capability handling → backend attempts through a `BackendAdapter` interface → metering row + routing attempts written in `finally`. PostgreSQL + pgvector stores tenants, keys, metering, traces and the knowledge base. A React console streams from the support capability and renders the decision trail.

Backends: one generic `OpenAICompatAdapter` (OpenAI SDK) configured by base URL/key/model serves `fast` and `strong` (both GLM via z.ai in this deployment), plus a deterministic `MockAdapter` (seedable RNG, latency/TTFT/failure controls, `cancelled` flag) used by tests and the `chaos` tenant. Embeddings run through the same interface against Gemini `gemini-embedding-001` (768 dims).

## 2. Request-path decisions worth grading

- **Quota is atomic and fails closed.** Reserve is a single conditional `UPDATE ... WHERE tokens_used + n <= daily_token_quota RETURNING`; zero rows → 429, DB error → 503 before any backend call (test includes a spy proving no model call happens). Reconcile uses `GREATEST(0, tokens_used + actual - reserved)`; full refund when nothing succeeded. A 50-parallel-reserve test admits exactly `floor(quota/estimate)` requests.
- **Fallback only before the first token.** Triggers: 5xx, 429, connection error, TTFT timeout (3000 ms default), total timeout (20 s). Provider 4xx (non-429) fails fast. `writeHead` is delayed until the first token so `x-model-used` / `x-fallback-fired` are always correct — including on the support endpoint, where `meta`/`retrieval` events are buffered until then. Mid-stream breaks stream an `error` event and store `partial_failure`; client aborts cancel the upstream call (verified through the mock's `cancelled` flag).
- **Support output contract.** The model must answer with a JSON header line (`intent`, `confidence`), a `---` separator, then the answer. A pure, unit-tested chunk parser validates the header with zod before anything is streamed; one repair retry is recorded as its own routing attempt; persistent failure → safe `bad_output` error. Confidence is fixed-weight: `0.4 × top-1 similarity + 0.3 × intent agreement + 0.3 × self-reported`; below 0.55 the upstream is aborted as soon as the header is known and a fixed refusal is returned with no generated answer.
- **Observability.** Every attempt lands in `routing_attempts` (backend, reason: primary/repair/fallback, outcome, latency, error) and every request keeps its `route()` steps (tenant policy, tier selection, chaos routing, model override) as JSON on the metering row. `GET /v1/requests/:id` returns the whole trail, scoped to the caller's tenant.

## 3. Evaluation (recorded run 2026-10-31)

30 held-out Bitext cases per configuration (25 in-scope stratified across 27 intents + 5 out-of-scope), zero overlap with the 600-entry KB (asserted by test). Config A = prompt v1 + `fast`; Config B = prompt v2 (few-shot) + `strong`. Throttled 1.5 s/request; run sequentially; answer quality = embedding cosine to the reference answer.

| Metric | A (v1 + fast) | B (v2 few-shot + strong) |
|---|---|---|
| Intent accuracy | 25/25 = 100% | 25/25 = 100% |
| Refusal precision (out-of-scope) | 3/5 = 60% | 2/5 = 40% |
| Answer quality (cosine mean) | 0.8859 | 0.8816 |
| Latency p50 / p95 | 4610 / — ms | 5612 / — ms |
| Cost per 100 requests (list prices) | $0.0051 | $0.0190 |

Honest reading:

- With 25 in-scope cases, intent accuracy differences are **noise** — both hit the ceiling because the task (paraphrase → KB intent) is easy for the model family and the retrieval surface is small. Counts are shown next to percentages deliberately.
- The meaningful gap is **refusal precision**: 2–3 of 5 out-of-scope messages slipped through as confident answers (some even broke the format into `bad_output`). Out-of-scope refusal is the real weak point; more work would go into the threshold, an "intent not in list" escape hatch, or an explicit out-of-scope check.
- Config A dominates on cost (~3.7× cheaper per 100 requests) and latency at equal quality — the few-shot prompt did not pay for itself here.
- What more time would buy: more held-out cases per intent, an LLM-as-judge (different model from the generator, bias stated), repeated runs for variance, and a hard out-of-scope classifier.

## 4. Trade-offs (deliberate, stated)

- No fallback after the first streamed token — restarting silently would show inconsistent text; partial text + explicit error instead.
- Estimated cost uses **list prices** from `config/models.ts` even though free tiers were used (`usage_estimated` flags estimated token counts).
- Small KB slice (600 entries) — enough to be real, small enough to embed in one command.
- Demo console uses **seeded keys** instead of login; keys are printed once at seed time.
- Direct provider calls: adding a provider is one adapter config entry, but there is no provider abstraction beyond the OpenAI-compatible shape.
- Embedding tooling is Python-in-Docker by choice; the runtime retrieval path is TypeScript inside the request path.

## 5. Deliverables

- Repo with README, this report, `CUTS.md`, Postman collection.
- 85 tests (unit + integration) covering quota atomicity, every fallback trigger, parser, refusal, retrieval, auth and log redaction.
- Eval reproducible with one command; results committed under `docs/eval-results/`.
- Demo video: recorded separately (architecture, playground with trace, globex quota exhaustion, chaos fallback, refusal, eval table).
