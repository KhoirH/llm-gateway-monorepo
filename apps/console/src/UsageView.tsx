import { useCallback, useEffect, useState } from "react";
import { ApiError, getUsage, type Usage } from "./api";

export function UsageView({ apiKey }: { apiKey: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    setError(null);
    try {
      setUsage(await getUsage(apiKey));
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_api_key") {
        setError("Invalid or missing API key. Paste a demo key from `npm run db:seed`.");
      } else {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
      setUsage(null);
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const quotaPct = usage ? Math.min(100, Math.round((usage.quota.tokens_used / usage.quota.daily_token_quota) * 100)) : 0;

  return (
    <div className="usage">
      <div className="usage-header">
        <h2>Usage{usage ? ` — ${usage.tenant_name} (${usage.tenant_id})` : ""}</h2>
        <button onClick={() => void refresh()} disabled={loading || !apiKey}>
          Refresh
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {!apiKey && <div className="error">Set an API key in the header first.</div>}
      {usage && (
        <>
          <div className="cards">
            <div className="card">
              <label>requests</label>
              <strong>{usage.requests}</strong>
            </div>
            <div className="card">
              <label>tokens (in / out)</label>
              <strong>
                {usage.input_tokens} / {usage.output_tokens}
              </strong>
            </div>
            <div className="card">
              <label>estimated cost</label>
              <strong>${usage.estimated_cost.toFixed(6)}</strong>
            </div>
            <div className="card">
              <label>remaining quota</label>
              <strong>{usage.quota.remaining.toLocaleString()}</strong>
            </div>
          </div>
          <div className="quota">
            <label>
              daily quota — {usage.quota.tokens_used.toLocaleString()} / {usage.quota.daily_token_quota.toLocaleString()} ({quotaPct}%)
            </label>
            <div className="quota-bar">
              <div className={`quota-fill ${quotaPct > 90 ? "danger" : ""}`} style={{ width: `${quotaPct}%` }} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
