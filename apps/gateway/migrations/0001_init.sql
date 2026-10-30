CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  allowed_models TEXT[] NOT NULL DEFAULT '{}',
  daily_token_quota BIGINT NOT NULL,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  capability TEXT NOT NULL,
  model_used TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  usage_estimated BOOLEAN NOT NULL DEFAULT false,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  estimated_cost NUMERIC(12,6) NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  fallback_fired BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requests_tenant_created_idx ON requests (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS routing_attempts (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  backend TEXT NOT NULL,
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL,
  latency_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routing_attempts_request_idx ON routing_attempts (request_id, attempt);
