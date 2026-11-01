import { useEffect, useRef, useState } from "react";
import { ApiError, getTrace, streamChat, type ChatMessage, type Trace } from "../api";

interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  usageEstimated: boolean;
}

interface ChatTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  status: "pending" | "streaming" | "done" | "stopped" | "error";
  model?: string;
  fallbackFired?: boolean;
  requestId?: string;
  usage: ChatUsage | null;
  clientTtftMs: number | null;
  clientLatencyMs: number | null;
  trace: Trace | null;
  error?: string;
}

const friendlyError = (err: unknown): string => {
  if (err instanceof ApiError) {
    if (err.code === "invalid_api_key") return "Invalid or missing API key. Paste a demo key from `npm run db:seed`.";
    if (err.code === "quota_exhausted") return "Daily token quota exhausted for this tenant. Run `npm run db:reset` or wait for reset.";
    if (err.code === "quota_unavailable") return "Quota store (database) unreachable. The gateway failed closed.";
    if (err.code === "all_backends_failed") return "All model backends failed. See the decision trail of this turn for details.";
    if (err.code === "bad_output") return "The model produced unusable output (even after one repair retry).";
    if (err.code === "timeout") return "The request timed out.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Unknown error";
};

async function fetchTraceWithRetry(apiKey: string, requestId: string): Promise<Trace | null> {
  for (let i = 0; i < 5; i++) {
    try {
      return await getTrace(apiKey, requestId);
    } catch (err) {
      if (err instanceof ApiError && err.code === "not_found") {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      return null;
    }
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export function ChatPlayground({ apiKey }: { apiKey: string }) {
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const buildMessages = (list: ChatTurn[]): ChatMessage[] => {
    const msgs: ChatMessage[] = [];
    if (systemPrompt.trim()) msgs.push({ role: "system", content: systemPrompt.trim() });
    for (const t of list) {
      if (t.role === "user") msgs.push({ role: "user", content: t.text });
      else if (t.status === "done" && t.text) msgs.push({ role: "assistant", content: t.text });
    }
    return msgs;
  };

  const send = async () => {
    const text = input.trim();
    if (!apiKey || !text || streaming) return;
    const history = turns;
    const messages = [...buildMessages(history), { role: "user", content: text }];
    const userTurn: ChatTurn = {
      id: nextId.current++,
      role: "user",
      text,
      reasoning: "",
      status: "done",
      usage: null,
      clientTtftMs: null,
      clientLatencyMs: null,
      trace: null,
    };
    const botId = nextId.current++;
    setTurns((ts) => [
      ...ts,
      userTurn,
      { id: botId, role: "assistant", text: "", reasoning: "", status: "pending", usage: null, clientTtftMs: null, clientLatencyMs: null, trace: null },
    ]);
    setInput("");
    setStreaming(true);
    const patch = (fn: (turn: ChatTurn) => ChatTurn) =>
      setTurns((ts) => ts.map((t) => (t.id === botId ? fn(t) : t)));
    const controller = new AbortController();
    abortRef.current = controller;
    const started = performance.now();
    let firstTokenAt: number | null = null;
    let requestId = "";
    let answerBuf = "";
    try {
      await streamChat(apiKey, messages, {
        onDelta: (chunk) => {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          answerBuf += chunk;
          patch((t) => ({ ...t, text: answerBuf, status: "streaming", clientTtftMs: Math.round((firstTokenAt as number) - started) }));
        },
        onReasoning: (chunk) => {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          patch((t) => ({
            ...t,
            reasoning: t.reasoning + chunk,
            status: "streaming",
            clientTtftMs: Math.round((firstTokenAt as number) - started),
          }));
        },
        onUsage: (u) => patch((t) => ({ ...t, usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, usageEstimated: u.usage_estimated } })),
        onRequestMeta: (rid, model, fallbackFired) => {
          requestId = rid;
          patch((t) => ({ ...t, requestId: rid, model, fallbackFired }));
        },
      }, controller.signal);
      patch((t) => ({ ...t, status: "done", clientLatencyMs: Math.round(performance.now() - started) }));
    } catch (err) {
      if (isAbortError(err)) {
        patch((t) => ({ ...t, status: "stopped", clientLatencyMs: Math.round(performance.now() - started) }));
      } else {
        patch((t) => ({
          ...t,
          status: "error",
          error: friendlyError(err),
          clientLatencyMs: Math.round(performance.now() - started),
        }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
    if (requestId) {
      const trace = await fetchTraceWithRetry(apiKey, requestId);
      if (trace) patch((t) => ({ ...t, trace }));
    }
  };

  const stop = () => abortRef.current?.abort();

  const traceStats = (turn: ChatTurn) => {
    const r = turn.trace?.request;
    const serverLatency = r?.latency_ms ?? null;
    const serverTtft = r?.ttft_ms ?? null;
    const rawCost = r?.estimated_cost;
    return {
      outcome: r?.outcome ?? null,
      ttft: serverTtft ?? turn.clientTtftMs,
      latency: serverLatency ?? turn.clientLatencyMs,
      cost: rawCost != null ? Number(rawCost) : null,
      latencyIsServer: serverLatency !== null,
    };
  };

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <span className="chat-hint">
          POST /v1/chat/completions (stream) — multi-turn: the session history is replayed per request; each turn keeps
          its model/fallback badges, usage and decision trail
        </span>
        <button className="chat-clear" onClick={() => setTurns([])} disabled={streaming || turns.length === 0}>
          Clear
        </button>
      </div>
      <div className="transcript" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="chat-empty">
            Send a message to test <code>POST /v1/chat/completions</code> with SSE streaming. Optionally set a system
            prompt below; tokens, TTFT, latency, estimated cost and the routing decision trail appear under every turn.
          </div>
        )}
        {turns.map((turn) => {
          const stats = turn.role === "assistant" ? traceStats(turn) : null;
          return turn.role === "user" ? (
            <div key={turn.id} className="msg user">
              <p>{turn.text}</p>
            </div>
          ) : (
            <div key={turn.id} className="msg assistant">
              {(turn.model || turn.fallbackFired !== undefined) && (
                <div className="badges">
                  {turn.model && <span className="badge model">model: {turn.model}</span>}
                  <span className={`badge ${turn.fallbackFired ? "fallback-on" : "fallback-off"}`}>
                    fallback: {turn.fallbackFired ? "fired" : "not fired"}
                  </span>
                </div>
              )}
              {turn.error && <div className="error">{turn.error}</div>}
              {turn.status === "stopped" && (
                <div className="stopped">
                  Stopped — the upstream call was aborted (client abort cancels the provider request).
                </div>
              )}
              {turn.reasoning && (
                <details className="turn-details">
                  <summary>Reasoning (thinking tokens)</summary>
                  <div className="reasoning">{turn.reasoning}</div>
                </details>
              )}
              {turn.text ? (
                <div className="answer inline">{turn.text}</div>
              ) : (
                turn.status === "pending" && <div className="answer inline pending">Waiting for first token...</div>
              )}
              {(turn.usage || turn.clientTtftMs !== null || stats?.ttft) && (
                <div className="stats">
                  {turn.usage && (
                    <div className="stat">
                      <label>tokens</label>
                      <span>
                        in {turn.usage.inputTokens} / out {turn.usage.outputTokens}
                        {turn.usage.usageEstimated ? " (estimated)" : ""}
                      </span>
                    </div>
                  )}
                  {stats?.ttft != null && (
                    <div className="stat">
                      <label>ttft</label>
                      <span>{stats.ttft} ms</span>
                    </div>
                  )}
                  {stats?.latency != null && (
                    <div className="stat">
                      <label>latency</label>
                      <span>
                        {stats.latency} ms{stats.latencyIsServer ? "" : " (client-measured)"}
                      </span>
                    </div>
                  )}
                  {stats?.cost != null && (
                    <div className="stat">
                      <label>est. cost</label>
                      <span>${(stats.cost as number).toFixed(6)}</span>
                    </div>
                  )}
                  {stats?.outcome && stats.outcome !== "ok" && (
                    <div className="stat">
                      <label>outcome</label>
                      <span className={`outcome-${stats.outcome}`}>{stats.outcome}</span>
                    </div>
                  )}
                </div>
              )}
              {turn.trace && (
                <details className="turn-details">
                  <summary>Decision trail</summary>
                  <div className="steps">
                    {(turn.trace.request.route_steps ?? []).map((s, i) => (
                      <div key={i} className="step">
                        <strong>{s.rule}</strong> — {s.detail}
                      </div>
                    ))}
                  </div>
                  <h4>Attempts</h4>
                  {(turn.trace.routing_attempts ?? []).map((a, i) => (
                    <div key={i} className="attempt">
                      #{a.attempt} {a.backend} [{a.reason}] → <span className={`outcome-${a.outcome}`}>{a.outcome}</span>
                      {a.error ? ` (${a.error})` : ""}
                    </div>
                  ))}
                </details>
              )}
            </div>
          );
        })}
      </div>
      <details className="system-prompt">
        <summary>System prompt{systemPrompt.trim() ? " (set)" : ""}</summary>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={2}
          placeholder="Optional system message prepended to every request in this session..."
          spellCheck={false}
        />
      </details>
      <div className="composer">
        <textarea
          placeholder={
            apiKey
              ? "Say something... (Enter to send, Shift+Enter for newline)"
              : "Paste a demo key first (npm run db:seed)"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          disabled={streaming || !apiKey}
        />
        {streaming ? (
          <button className="stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button onClick={send} disabled={!apiKey || !input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
