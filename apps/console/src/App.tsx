import { useState } from "react";
import { Playground } from "./Playground";
import { UsageView } from "./UsageView";

export interface Settings {
  apiKey: string;
}

const STORAGE_KEY = "llm-gateway-console-settings";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Settings;
  } catch {}
  return { apiKey: "" };
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tab, setTab] = useState<"playground" | "usage">("playground");

  const save = (apiKey: string) => {
    const next = { apiKey };
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  return (
    <div className="app">
      <header className="header">
        <h1>LLM Gateway Console</h1>
        <div className="settings">
          <input
            type="password"
            placeholder="Demo API key (sk-gw-...)"
            value={settings.apiKey}
            onChange={(e) => save(e.target.value)}
            spellCheck={false}
          />
          <span className={`key-state ${settings.apiKey ? "ok" : "missing"}`}>
            {settings.apiKey ? "key set" : "no key"}
          </span>
        </div>
      </header>
      <nav className="tabs">
        <button className={tab === "playground" ? "active" : ""} onClick={() => setTab("playground")}>
          Playground
        </button>
        <button className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>
          Usage
        </button>
      </nav>
      {tab === "playground" ? <Playground apiKey={settings.apiKey} /> : <UsageView apiKey={settings.apiKey} />}
    </div>
  );
}
