import { useEffect, useRef, useState } from "react";
import { ApiError, getTrace, streamSupport, type FinalEvent, type MetaEvent, type RetrievedEntry, type Trace } from "../api";

interface Stats {
  intent: string | null;
  confidence: number;
  refused: boolean;
  refusalMessage?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  usageEstimated: boolean | null;
  estimatedCost: number | null;
  latencyMs: number | null;
}

interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  status: "pending" | "streaming" | "done" | "refused" | "error";
  meta?: MetaEvent;
  stats?: Stats;
  entries?: RetrievedEntry[];
  trace?: Trace;
  error?: string;
}

export function SupportPlayground({ apiKey }: { apiKey: string }) {
  const [message, setMessage] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

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

  const send = async () => {
    const text = message.trim();
    if (!apiKey || !text || streaming) return;
    setMessage("");
    const userTurn: Turn = { id: nextId.current++, role: "user", text, status: "done" };
    const botId = nextId.current++;
    setTurns((t) => [...t, userTurn, { id: botId, role: "assistant", text: "", status: "pending" }]);
    setStreaming(true);
    let answerBuf = "";
    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((ts) => ts.map((turn) => (turn.id === botId ? fn(turn) : turn)));
    try {
      await streamSupport(
        apiKey,
        text,
        (e) => {
          if (e.event === "meta") {
            patch((turn) => ({ ...turn, meta: e.data as unknown as MetaEvent, status: "streaming" }));
          } else if (e.event === "retrieval") {
            patch((turn) => ({ ...turn, entries: (e.data as unknown as { entries: RetrievedEntry[] }).entries }));
          } else if (e.event === "delta") {
            answerBuf += (e.data as unknown as { content: string }).content;
            patch((turn) => ({ ...turn, text: answerBuf, status: "streaming" }));
          } else if (e.event === "final") {
            const f = e.data as unknown as FinalEvent;
            patch((turn) => ({
              ...turn,
              text: f.answer || turn.text,
              status: f.refused ? "refused" : "done",
              stats: {
                intent: f.intent,
                confidence: f.confidence,
                refused: f.refused,
                refusalMessage: f.refusal_message,
                inputTokens: f.usage?.input_tokens ?? null,
                outputTokens: f.usage?.output_tokens ?? null,
                usageEstimated: f.usage?.usage_estimated ?? null,
                estimatedCost: f.usage?.estimated_cost ?? null,
                latencyMs: f.latency_ms,
              },
            }));
          } else if (e.event === "error") {
            const errData = e.data as { code: string; message: string };
            patch((turn) => ({
              ...turn,
              status: "error",
              error: friendlyError(new ApiError(errData.code, errData.message)),
            }));
          }
        },
        (requestId) => {
          getTrace(apiKey, requestId)
            .then((trace) => patch((turn) => ({ ...turn, trace })))
            .catch(() => {});
        },
      );
    } catch (err) {
      patch((turn) => ({ ...turn, status: "error", error: friendlyError(err) }));
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <span className="chat-hint">
          {turns.filter((t) => t.role === "user").length} request(s) this session — every turn keeps its own badges,
          stats and trail
        </span>
        <button className="chat-clear" onClick={() => setTurns([])} disabled={streaming || turns.length === 0}>
          Clear
        </button>
      </div>
      <div className="transcript" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="chat-empty">
            Ask a customer support question to start a conversation. Each turn keeps its model badge, fallback state,
            retrieval entries, tokens/latency/cost and decision trail — scroll back anytime.
          </div>
        )}
        {turns.map((turn) =>
          turn.role === "user" ? (
            <div key={turn.id} className="msg user">
              <p>{turn.text}</p>
            </div>
          ) : (
            <div key={turn.id} className="msg assistant">
              {turn.meta && (
                <div className="badges">
                  <span className="badge model">model: {turn.meta.model}</span>
                  <span className={`badge ${turn.meta.fallback_fired ? "fallback-on" : "fallback-off"}`}>
                    fallback: {turn.meta.fallback_fired ? "fired" : "not fired"}
                  </span>
                </div>
              )}
              {turn.status === "refused" && (
                <div className="refusal">
                  <strong>Refused</strong> — {turn.stats?.refusalMessage}
                </div>
              )}
              {turn.error && <div className="error">{turn.error}</div>}
              {turn.text ? (
                <div className="answer inline">{turn.text}</div>
              ) : (
                turn.status === "pending" && <div className="answer inline pending">Retrieving & thinking...</div>
              )}
              {turn.stats && (
                <div className="stats">
                  {turn.stats.intent && (
                    <div className="stat">
                      <label>intent</label>
                      <span>
                        {turn.stats.intent} ({(turn.stats.confidence * 100).toFixed(1)}% confidence)
                      </span>
                    </div>
                  )}
                  {turn.stats.inputTokens !== null && (
                    <div className="stat">
                      <label>tokens</label>
                      <span>
                        in {turn.stats.inputTokens} / out {turn.stats.outputTokens}
                        {turn.stats.usageEstimated ? " (estimated)" : ""}
                      </span>
                    </div>
                  )}
                  {turn.stats.latencyMs !== null && (
                    <div className="stat">
                      <label>latency</label>
                      <span>{turn.stats.latencyMs} ms</span>
                    </div>
                  )}
                  {turn.stats.estimatedCost !== null && (
                    <div className="stat">
                      <label>est. cost</label>
                      <span>${turn.stats.estimatedCost.toFixed(6)}</span>
                    </div>
                  )}
                </div>
              )}
              {turn.entries && turn.entries.length > 0 && (
                <details className="turn-details">
                  <summary>Retrieved entries (top {turn.entries.length})</summary>
                  {turn.entries.map((e, i) => (
                    <div key={i} className="entry">
                      <span className="entry-intent">{e.intent}</span>
                      <span className="entry-sim">sim {e.similarity.toFixed(3)}</span>
                      <p>{e.question}</p>
                    </div>
                  ))}
                </details>
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
          ),
        )}
      </div>
      <div className="composer">
        <textarea
          placeholder={
            apiKey ? "Ask a customer support question... (Enter to send, Shift+Enter for newline)" : "Paste a demo key first (npm run db:seed)"
          }
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          disabled={streaming || !apiKey}
        />
        <button onClick={send} disabled={streaming || !apiKey || !message.trim()}>
          {streaming ? "Streaming..." : "Send"}
        </button>
      </div>
    </div>
  );
}
