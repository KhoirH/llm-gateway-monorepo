import { AppError } from "./errors.js";
import { AdapterError } from "./adapters/types.js";

export const MAX_CONSECUTIVE_RETRIES = 3;

export interface MappedError {
  status: number;
  code: string;
  message: string;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

export function mapAdapterError(err: unknown): MappedError {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err instanceof AdapterError) {
    if (err.kind === "timeout") {
      return { status: 504, code: "timeout", message: "Upstream timed out" };
    }
    if (err.kind === "http") {
      if (err.status !== undefined && err.status < 500 && err.status !== 429) {
        return { status: 400, code: "invalid_request", message: err.message };
      }
      return { status: 502, code: "all_backends_failed", message: "Backend request failed" };
    }
    return { status: 502, code: "all_backends_failed", message: "Backend connection failed" };
  }
  return { status: 500, code: "internal", message: "Internal error" };
}

export function is4xxFailure(err: unknown): boolean {
  return err instanceof AdapterError && err.kind === "http" && err.status !== undefined && err.status >= 400 && err.status < 500;
}

export function isRetryableError(err: unknown): boolean {
  return !(err instanceof AppError);
}

export function shouldRetry(err: unknown, consecutiveFailures: number): boolean {
  return isRetryableError(err) && consecutiveFailures < MAX_CONSECUTIVE_RETRIES;
}
