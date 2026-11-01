# How to run the A/B evaluation — verified walkthrough

Every command below was executed successfully on 2026-11-01 against the current provider env. Follow the steps in order; do not continue past a failing verification step.

## 0. What is being compared

| | Config A | Config B |
|---|---|---|
| Prompt | `v1` | `v2` (few-shot) |
| Tier | `fast` | `strong` |
| Model (current env) | `gemini-3.1-flash-lite` via `api.anoman.io` | `llama-3-1-8b-instruct` via `api.anoman.io` |
| Wiring | `gateway-a`: `SUPPORT_PROMPT_VERSION=v1` + `SUPPORT_MODEL_OVERRIDE=fast` | `gateway-b`: `v2` + `strong` |

Both gateways serve the same held-out set from `data/heldout.json` (25 in-scope + 5 out-of-scope, zero overlap with the 600-entry KB, asserted by test). Harness: `scripts/run_eval.py` (Docker image `eval`), throttled 1.5 s/request, sequential A then B.

## 1. Verify providers first — stop if this fails

```powershell
npm run verify:providers
```
Must print all four lines `PASS ...` and `RESULT: all providers verified`.

Known gotchas:
- `FAST_BASE_URL` / `STRONG_BASE_URL` must end at `/v1` — the OpenAI SDK appends `/chat/completions` itself; a URL that already contains `/chat/completions` yields 404.
- 429 right after heavy use → wait ~30 s and re-probe before concluding the model is down.
- If a model cannot be verified, do not continue to the eval — fix `.env` first.

## 2. One-time DB + KB preparation

```powershell
npm run db:up          # Postgres 16 + pgvector (Docker)
npm run db:migrate     # 0001..0003
npm run db:seed        # prints demo keys (acme / globex / chaos)
npm run kb:build       # embeds 600 KB entries (cache = instant on re-run)
docker exec infra-db-1 psql -U gateway -d gateway -c "SELECT count(*) FROM kb_entries;"   # expect 600
```

If the count is ~4, the test suite wiped the KB — run `npm run kb:build` again (all cache hits).

## 3. Fresh eval key (seed rotates keys every run)

Copy the **acme** key printed by `db:seed` into `.env`:
```
GATEWAY_API_KEY=sk-gw-...
```
- Eval requests run as tenant `acme` (quota 200 000 tokens; a full run burns ~55 000).
- 401 everywhere during the eval means the key rotated → redo this step.
- Quota exhausted → `npm run db:reset`, then re-copy the freshly printed acme key.

## 4. Run the evaluation (~10–12 min)

```powershell
docker compose -f infra/docker-compose.yml --profile tools build gateway-a gateway-b eval
docker compose -f infra/docker-compose.yml --profile tools up -d gateway-a gateway-b
docker compose -f infra/docker-compose.yml --profile tools run --rm eval
```
- Rebuild matters: the Python harness and gateway code are baked into the images; editing sources without rebuilding changes nothing.
- Progress prints one line per case (`[A] question -> intent`). The run is sequential; interrupting it leaves no output — just rerun.

## 5. Outputs

| File | Content |
|---|---|
| `docs/eval-results/eval-<stamp>.json` | Full per-case records: question, predicted intent, confidence, refusal, answer text, tokens, latency, cost, error |
| `docs/eval-results/eval-report-<stamp>.md` | A/B comparison table |

Metrics: **intent accuracy** = correct intents over answered in-scope cases; **refusal precision** = out-of-scope questions refused / 5; **answer quality** = embedding cosine between generated and reference answer; **latency p50/p95**; **cost per 100 requests** at list prices from `config/models.ts`; **fallback count**; **errored cases**.

## 6. Salvage a completed run with broken aggregates

If the run completed all 30 cases per config but the aggregates look wrong (e.g. every case marked as an error by a harness bug), the per-case records may still be intact. Recompute without re-answering anything:

```powershell
node --env-file=.env scripts/salvage-eval.mjs docs/eval-results/eval-<stamp>.json
```
This rewrites aggregates, computes the missing quality metric from the recorded answers, and writes `eval-salvaged-<stamp>.json` + `eval-report-salvaged-<stamp>.md`. It never calls the chat providers — only the embedding endpoint.

## 7. Chart for reporting / email

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-eval-chart.ps1 -JsonPath docs/eval-results/eval-salvaged-<stamp>.json
```
Writes `docs/eval-results/eval-chart-salvaged-<stamp>.png` (1400×560): accuracy bars (intent / refusal / quality), latency p50, cost per 100 requests.

## 8. Troubleshooting (all observed in this repo)

| Symptom | Cause → Fix |
|---|---|
| `http_401` on every case | Seed rotated keys → redo step 3 |
| `HTTPError 502` crashes the run / `all_backends_failed` | TTFT budget too tight for the provider → `.env` currently `TTFT_TIMEOUT_MS=8000`, `TOTAL_TIMEOUT_MS=30000`; raise further if p95 exceeds it |
| Edit to `run_eval.py` has no effect | Python is baked into the image → rebuild `eval` (step 4, first command) |
| Aborted mid-run | No output written → rerun step 4 |
| 404 on all provider probes | Base URL contains `/chat/completions` → strip to `/v1` |
| Refused on nearly everything | KB wiped by tests (~4 rows) → `npm run kb:build`, verify count = 600 |
