import { useState } from "react";
import { ChatPlayground } from "./playground/ChatPlayground";
import { SupportPlayground } from "./playground/SupportPlayground";

export function Playground({ apiKey }: { apiKey: string }) {
  const [mode, setMode] = useState<"chat" | "support">("chat");

  return (
    <div className="playground">
      <div className="subtabs">
        <button className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")}>
          Chat Completions
        </button>
        <button className={mode === "support" ? "active" : ""} onClick={() => setMode("support")}>
          Support (KB)
        </button>
      </div>
      {mode === "chat" ? <ChatPlayground apiKey={apiKey} /> : <SupportPlayground apiKey={apiKey} />}
    </div>
  );
}
