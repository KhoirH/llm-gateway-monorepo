# Console Guide — how to run, use, and troubleshoot

The console is a small React app (`apps/console`) that drives the gateway's support assistant: streaming playground, retrieval panel, decision trail (trace), and usage/quota view.

## 1. Prerequisites (once)

```powershell
# .env must contain real keys:
#   FAST_API_KEY / STRONG_API_KEY   -> z.ai (GLM)   https://api.z.ai/api/paas/v4
#   EMBED_API_KEY / EMBED_BASE_URL  -> Gemini embeddings (768-dim)
npm run db:up            # Postgres 16 + pgvector in Docker
npm run db:migrate       # 0001..0003 (includes kb_entries + HNSW index)
npm run db:seed          # prints demo keys (acme/globex/chaos) — copy acme!
npm run kb:build         # embeds 600 KB entries into kb_entries (cache = instant on re-run)
```

> **Check KB is alive:** `docker exec infra-db-1 psql -U gateway -d gateway -c "SELECT count(*) FROM kb_entries;"` → expect **600**. If it shows ~4, the test suite wiped it — run `npm run kb:build` again (all cache hits, 0 API calls).

## 2. Start the stack (two terminals)

```powershell
npm run dev -w apps/gateway     # gateway on http://127.0.0.1:3000
npm run dev -w apps/console     # console on http://localhost:5173 (proxies /v1 -> gateway)
```

Open **http://localhost:5173**. In Settings: paste the demo key printed by `db:seed`
(saved in localStorage, so only once per browser). Gateway URL stays `http://127.0.0.1:3000`
(only relevant if you run the console `vite build` standalone — in dev the Vite proxy handles it).

## 3. Playground — what you see per request

| Panel | Source | Meaning |
|---|---|---|
| **Answer stream** | SSE `delta` events | Tokens as they arrive from GLM |
| **Model badge** | SSE `meta.model` | Tier actually served (`fast`/`strong`), correct even after fallback |
| **Fallback badge** | SSE `meta.fallback_fired` | `true` = primary failed before first token and a backup served |
| **Retrieval panel** | SSE `retrieval.entries` | Top-4 KB rows with intent + similarity |
| **Intent + confidence** | SSE `final` | Parsed intent, confidence `0.4×top1 + 0.3×agreement + 0.3×self-reported`, threshold 0.55 |
| **Refused banner** | `final.refused` | Confidence too low → upstream aborted, no answer billed |
| **Tokens / latency / cost** | SSE `final` usage + `estimated_cost` | Real provider usage when available (estimated flag otherwise) |
| **Decision trail** | `GET /v1/requests/:id` | Route steps (tenant policy, tier selection) + every attempt with outcome |

## 4. Usage tab

`GET /v1/usage` for your tenant: request count, tokens in/out, estimated cost, remaining quota with a bar (red past 90%). Press Refresh after requests.

## 5. Demo scenarios for the video

1. **Happy path**: "How do I reset my password?" → streams, intent `recover_password`, trace shows `tier_selection`.
2. **Quota**: use the **globex** key (seeded with a tiny budget) → 429 `quota_exhausted` friendly message.
3. **Fallback chaos**: set `MOCK_FAILURE_RATE=1` + `MOCK_FAIL_MODE=error5xx` in `.env`, restart gateway, use the **chaos** key (routes mock first) → mock fails 500 → GLM serves, badge "fallback fired". Reset to `0` afterwards.
4. **Refusal**: ask something outside the KB domain ("What is the capital of France?") → refused banner, no deltas, metering outcome `refused`.

## 6. Troubleshooting — "why doesn't it answer what I need?"

Symptom → cause → fix (all observed in this project, in rough hit order):

| Symptom | Cause | Fix |
|---|---|---|
| `401 invalid_api_key` | `db:seed` rotates keys every run; browser may hold a stale key | Re-run `npm run db:seed`, paste the fresh `acme` key in Settings. If Postman was used, update its variables too |
| **Refused banner** + very low top-1 similarity (~0.02) | KB wiped by the test suite (only 4 synthetic rows left) | `npm run kb:build` (cache → instant). Verify count = 600 |
| Refused but retrieval looks sensible | Confidence < 0.55 (by design — sim/KB/intent/self all low) | Rephrase inside the KB domain (accounts, orders, payments, refunds, delivery, subscriptions). Check the retrieval panel's similarity |
| `502 Retrieval failed: Backend connection failed` | Embedding provider (googleapis) unreachable — flaky network/VPN | Retry; the gateway fails closed on purpose. If persistent, check `EMBED_API_KEY` with `npm run verify:providers` |
| `502 all_backends_failed` | Both chat providers down or keys wrong | Check `FAST_API_KEY`/`STRONG_API_KEY`, run `npm run verify:providers` |
| Empty answer, but tokens were burned | GLM thinking model spent the whole budget on reasoning (`max_tokens` too low) | Send a clearer/shorter question; internally usage is still metered honestly |
| Gateway answers with **old env** (e.g. you just fixed `.env`) | `tsx watch` reloads code, **not** `.env`; orphaned processes may hold port 3000 | Kill orphans (`netstat -ano | findstr :3000` → `taskkill /PID <pid> /F`), restart `npm run dev -w apps/gateway` |
| Console shows nothing at all | Gateway not running, or Vite proxy target wrong | Start gateway first; in dev the proxy defaults to `http://127.0.0.1:3000` (override with `GATEWAY_ORIGIN` when starting Vite) |
| `429 quota_exhausted` on acme | Tenant burned its budget (metering is real) | `npm run db:reset` re-seeds quotas (rotates keys again!) |

Golden rule: **after any `.env` change → restart the gateway; after any test-suite run → check/restore the KB; after any seed → re-copy the key.**

## 7. Diagrams

`docs/architecture.drawio` (3 pages, opens in draw.io / diagrams.net / VS Code drawio extension):

1. **AI flow** — the numbered support-request pipeline through the gateway (auth → quota → embed → retrieve → route → attempt loop → parse → confidence → SSE → metering), including refusal/repair/fallback branches.
2. **Data flow** — what lives where: Postgres tables (`tenants`, `api_keys`, `requests` + `route_steps`, `routing_attempts`, `kb_entries vector(768)`), `data/kb.json` / `data/heldout.json`, embedding cache, provider APIs.
3. **Topology** — browser (5173) → Vite proxy → gateway (3000) → Postgres (5432) + z.ai GLM + Gemini embeddings, plus the Python-in-Docker tooling (dataset, kb-build, retrieval-try, eval A/B).
