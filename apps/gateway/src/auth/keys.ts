import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): string {
  return `sk-gw-${randomBytes(24).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function keyPrefix(key: string): string {
  return key.slice(0, 12);
}
