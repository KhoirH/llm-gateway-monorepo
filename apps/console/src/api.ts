export interface SseEvent<T = Record<string, unknown>> {
  event: string;
  data: T;
}

export interface RetrievedEntry {
  question: string;
  answer: string;
  intent: string;
  similarity: number;
}

export interface MetaEvent {
  request_id: string;
  model: string;
  fallback_fired: boolean;
}

export interface FinalEvent {
  answer: string;
  intent: string | null;
  confidence: number;
  confidence_components: { topSimilarity: number; intentAgreement: number; selfReported: number } | null;
  entries: RetrievedEntry[];
  refused: boolean;
  refusal_message?: string;
  usage: { input_tokens: number; output_tokens: number; usage_estimated: boolean; estimated_cost: number } | null;
  latency_ms: number;
}

export interface RoutingAttempt {
  attempt: number;
  backend: string;
  reason: string;
  outcome: string;
  latency_ms: number | null;
  error: string | null;
}

export interface RouteStep {
  rule: string;
  detail: string;
}

export interface Trace {
  request: Record<string, unknown> & { outcome: string; model_used: string | null; route_steps: RouteStep[] };
  routing_attempts: RoutingAttempt[];
}

export interface Usage {
  tenant_id: string;
  tenant_name: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  quota: { daily_token_quota: number; tokens_used: number; remaining: number };
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(body.error?.code ?? `http_${res.status}`, body.error?.message ?? `HTTP ${res.status}`);
  } catch {
    return new ApiError(`http_${res.status}`, `HTTP ${res.status}`);
  }
}

export async function streamSupport(
  apiKey: string,
  message: string,
  onEvent: (e: SseEvent) => void,
  onRequestMeta: (requestId: string, model: string, fallbackFired: boolean) => void,
): Promise<void> {
  const res = await fetch("/v1/capabilities/support/answer", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ message }),
  });
  const requestId = res.headers.get("x-request-id");
  const modelUsed = res.headers.get("x-model-used");
  const fallbackFired = res.headers.get("x-fallback-fired") === "true";
  if (!res.ok || !res.body) {
    throw await errorFrom(res);
  }
  if (requestId) onRequestMeta(requestId, modelUsed ?? "?", fallbackFired);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        onEvent({ event, data: JSON.parse(data) });
      } catch {}
    }
  }
}

export async function getUsage(apiKey: string): Promise<Usage> {
  const res = await fetch("/v1/usage", { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as Usage;
}

export async function getTrace(apiKey: string, requestId: string): Promise<Trace> {
  const res = await fetch(`/v1/requests/${requestId}`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as Trace;
}
