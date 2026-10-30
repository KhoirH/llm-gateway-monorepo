export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  invalidRequest: (message = "Invalid request") => new AppError(400, "invalid_request", message),
  invalidApiKey: (message = "Missing or invalid API key") => new AppError(401, "invalid_api_key", message),
  modelNotAllowed: (message = "Model not allowed for this tenant") => new AppError(403, "model_not_allowed", message),
  quotaExhausted: (message = "Daily token quota exhausted") => new AppError(429, "quota_exhausted", message),
  allBackendsFailed: (message = "All backends failed") => new AppError(502, "all_backends_failed", message),
  badOutput: (message = "Model produced unusable output") => new AppError(502, "bad_output", message),
  quotaUnavailable: (message = "Quota store unavailable") => new AppError(503, "quota_unavailable", message),
  timeout: (message = "Request timed out") => new AppError(504, "timeout", message),
  internal: (message = "Internal error") => new AppError(500, "internal", message),
};
