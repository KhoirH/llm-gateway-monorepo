import type { RetrievedEntry } from "../retrieval.js";

export type PromptVersion = "v1" | "v2";

function kbBlock(entries: RetrievedEntry[]): string {
  return entries.map((e, i) => `${i + 1}. [${e.intent}] Q: ${e.question}\n   A: ${e.answer}`).join("\n");
}

function intentList(entries: RetrievedEntry[]): string {
  return [...new Set(entries.map((e) => e.intent))].join(", ");
}

export function buildPromptV1(message: string, entries: RetrievedEntry[]): string {
  return (
    "You are a customer support assistant. Answer the customer using the knowledge base entries.\n\n" +
    `Knowledge base entries:\n${kbBlock(entries)}\n\n` +
    `Customer message: ${message}\n\n` +
    "Respond in EXACTLY this format (first line JSON, then a line containing only ---, then the answer):\n" +
    '{"intent": "<intent>", "confidence": <number between 0.0 and 1.0>}\n' +
    "---\n" +
    "<answer>\n" +
    `Valid intents: ${intentList(entries)}`
  );
}

export function buildPromptV2(message: string, entries: RetrievedEntry[]): string {
  return (
    "You are a customer support assistant. Answer the customer using the knowledge base entries.\n\n" +
    "Here are two examples of the EXACT response format you must follow:\n\n" +
    "Example 1:\n" +
    '{"intent": "cancel_order", "confidence": 0.92}\n' +
    "---\n" +
    "I can help you cancel order #12345. Open the Orders page, select the order, and press Cancel within 24 hours of purchase.\n\n" +
    "Example 2:\n" +
    '{"intent": "get_refund", "confidence": 0.88}\n' +
    "---\n" +
    "Refunds are issued to the original payment method within 5 business days after we receive the returned item.\n\n" +
    "Now respond to the customer below in EXACTLY the same format (first line JSON with intent and confidence, then a line containing only ---, then the answer):\n\n" +
    `Knowledge base entries:\n${kbBlock(entries)}\n\n` +
    `Customer message: ${message}\n\n` +
    `Valid intents: ${intentList(entries)}`
  );
}

export function buildPrompt(message: string, entries: RetrievedEntry[], version: PromptVersion): string {
  return version === "v2" ? buildPromptV2(message, entries) : buildPromptV1(message, entries);
}

export function buildRepairSuffix(): string {
  return (
    "\n\nYour previous response did not follow the required format. Respond again in EXACTLY the required format, starting with the JSON header line."
  );
}
