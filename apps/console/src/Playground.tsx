import { useRef, useState } from "react";
import { ApiError, getTrace, streamSupport, type FinalEvent, type MetaEvent, type RetrievedEntry, type Trace } from "./api";

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

export function Playground({ apiKey }: { apiKey: string }) {
  const [message, setMessage] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [answer, setAnswer] = useState("");
  const [meta, setMeta] = useState<MetaEvent | null>(null);
  const [entries, setEntries] = useState<RetrievedEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef(answer);
  answerRef.current = answer;

  const friendlyError = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === "invalid_api_key") return "Invalid or missing API key. Paste a demo key from `npm run db:seed`.";
      if (err.code === "quota_exhausted") return "Daily token quota exhausted for this tenant. Run `npm run db:reset` or wait for reset.";
      if (err.code === "quota_unavailable") return "Quota store (database) unreachable. The gateway failed closed.";
      if (err.code === "all_backends_failed") return "All model backends failed. See the trace panel for details.";
      if (err.code === "bad_output") return "The model produced unusable output (even after one repair retry).";
      if (err.code === "timeout") return "The request timed out.";
      return err.message;
    }
    return err instanceof Error ? err.message : "Unknown error";
  };

  const send = async () => {
    if (!apiKey || !message.trim() || streaming) return;
    setStreaming(true);
    setError(null);
    setAnswer("");
    setMeta(null);
    setEntries([]);
    setStats(null);
    setTrace(null);
    let answerBuf = "";
    try {
      await streamSupport(
        apiKey,
        message.trim(),
        (e) => {
          if (e.event === "meta") {
            setMeta(e.data as unknown as MetaEvent);
          } else if (e.event === "retrieval") {
            setEntries((e.data as unknown as { entries: RetrievedEntry[] }).entries);
          } else if (e.event === "delta") {
            answerBuf += (e.data as unknown as { content: string }).content;
            setAnswer(answerBuf);
          } else if (e.event === "final") {
            const f = e.data as unknown as FinalEvent;
            setAnswer(f.answer);
            setStats({
              intent: f.intent,
              confidence: f.confidence,
              refused: f.refused,
              refusalMessage: f.refusal_message,
              inputTokens: f.usage?.input_tokens ?? null,
              outputTokens: f.usage?.output_tokens ?? null,
              usageEstimated: f.usage?.usage_estimated ?? null,
              estimatedCost: f.usage?.estimated_cost ?? null,
              latencyMs: f.latency_ms,
            });
          } else if (e.event === "error") {
            const errData = e.data as { code: string; message: string };
            setError(friendlyError(new ApiError(errData.code, errData.message)));
          }
        },
        (requestId) => {
          getTrace(apiKey, requestId)
            .then(setTrace)
            .catch(() => setTrace(null));
        },
      );
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="playground">
      <div className="composer">
        <textarea
          placeholder="Ask a customer support question..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          disabled={streaming || !apiKey}
        />
        <button onClick={send} disabled={streaming || !apiKey || !message.trim()}>
          {streaming ? "Streaming..." : "Send"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {meta && (
        <div className="badges">
          <span className="badge model">model: {meta.model}</span>
          <span className={`badge ${meta.fallback_fired ? "fallback-on" : "fallback-off"}`}>
            fallback: {meta.fallback_fired ? "fired" : "not fired"}
          </span>
        </div>
      )}
      {stats?.refused && (
        <div className="refusal">
          <strong>Refused</strong> — {stats.refusalMessage}
        </div>
      )}
      <div className="answer">
        {answer || (streaming ? "..." : "Answer appears here")}
      </div>
      {stats && (
        <div className="stats">
          {stats.intent && (
            <div className="stat">
              <label>intent</label>
              <span>
                {stats.intent} ({(stats.confidence * 100).toFixed(1)}% confidence)
              </span>
            </div>
          )}
          {stats.inputTokens !== null && (
            <div className="stat">
              <label>tokens</label>
              <span>
                in {stats.inputTokens} / out {stats.outputTokens}
                {stats.usageEstimated ? " (estimated)" : ""}
              </span>
            </div>
          )}
          {stats.latencyMs !== null && (
            <div className="stat">
              <label>latency</label>
              <span>{stats.latencyMs} ms</span>
            </div>
          )}
          {stats.estimatedCost !== null && (
            <div className="stat">
              <label>est. cost</label>
              <span>${stats.estimatedCost.toFixed(6)}</span>
            </div>
          )}
        </div>
      )}
      {entries.length > 0 && (
        <div className="entries">
          <h3>Retrieved entries (top {entries.length})</h3>
          {entries.map((e, i) => (
            <div key={i} className="entry">
              <span className="entry-intent">{e.intent}</span>
              <span className="entry-sim">sim {e.similarity.toFixed(3)}</span>
              <p>{e.question}</p>
            </div>
          ))}
        </div>
      )}
      {trace && (
        <div className="trace">
          <h3>Decision trail</h3>
          <div className="steps">
            {trace.request.route_steps.map((s, i) => (
              <div key={i} className="step">
                <strong>{s.rule}</strong> — {s.detail}
              </div>
            ))}
          </div>
          <h4>Attempts</h4>
          {trace.routing_attempts.map((a, i) => (
            <div key={i} className="attempt">
              #{a.attempt} {a.backend} [{a.reason}] → <span className={`outcome-${a.outcome}`}>{a.outcome}</span>
              {a.error ? ` (${a.error})` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
