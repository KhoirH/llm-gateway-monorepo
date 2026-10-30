import { describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const app = buildApp({
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: 3000,
      DATABASE_URL: "postgres://gateway:gateway@localhost:5432/gateway",
      LOG_LEVEL: "fatal",
      FAST_API_KEY: "",
      FAST_BASE_URL: "https://api.groq.com/openai/v1",
      FAST_MODEL: "llama-3.1-8b-instant",
      STRONG_API_KEY: "",
      STRONG_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      STRONG_MODEL: "gemini-2.0-flash",
    });

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
