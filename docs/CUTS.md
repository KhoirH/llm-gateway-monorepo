# CUTS — scope cuts and deviations, logged as they happened

Scope cuts declared up front (AGENT.md) and honoured:

- **Admin key and cross-tenant usage** — `GET /v1/usage` and traces are strictly per-tenant.
- **`eval_runs` / `eval_results` / `model_catalog` tables** — eval results are committed JSON + Markdown files; prices live in `config/models.ts` as list prices.
- **Quota reset schedule** — manual `npm run db:reset` script instead.
- **Circuit breaker** — stretch goal, not built (fallback + TTFT/total timeouts cover the graded behaviour).
- **Ollama** — not used at all (decision during B4: no self-hosted models; z.ai provides no embedding model, so embeddings went to Gemini).
- **LLM-as-judge** — not used; answer quality is embedding cosine only.
- **CI** — not set up; tests run locally via `npm run gateway:test` (85 tests).
- **Capability filter and budget guard routing rules** — future work (listed in AGENT.md as such).
- **Console chat playground** — the console playground uses the support capability only; the chat endpoint is exercised via tests/Postman. Cut during B6 to keep the console at assessment scope.

Deviations from AGENT.md made during the build (each approved by Hilmi in-session):

1. **Generic `FAST_*` / `STRONG_*` env** instead of `GROQ_*` / `GEMINI_*` naming — the adapter is provider-agnostic; GLM via z.ai ended up serving both tiers.
2. **Chat `stream` body param, default `false`** — AGENT.md pinned SSE; default-off JSON mode was requested and is more OpenAI-compatible.
3. **`reasoning_content` passthrough** — GLM thinking models stream reasoning separately; forwarded as its own delta field (streaming) / `message.reasoning_content` (JSON), counted in usage.
4. **Embedding model `gemini-embedding-001`** — AGENT.md named `text-embedding-004`, which Google no longer serves for embedContent (verified 404 in-session).
5. **Dataset/embedding-store tooling in Python inside Docker** (dataset splitter via parquet + duckdb; KB build; retrieval checks; eval runner) — replaces the Node equivalents at Hilmi's request; runtime retrieval stays TypeScript (request path).
6. **`SUPPORT_PROMPT_VERSION` + `SUPPORT_MODEL_OVERRIDE` env** — added in B7 so Config A/B run as two gateway instances instead of prompt hacks.
7. **Error code `internal` (500)** — not in the AGENT.md code list; used only for unexpected errors so the single error shape still holds.
8. **Local Node 24** instead of 20 (`engines: >=20`).
