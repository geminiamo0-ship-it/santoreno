export type GroundedAiErrorCode =
  | "AI_NOT_CONFIGURED"
  | "UNKNOWN_LIBRARY"
  | "SEARCH_FAILED"
  | "SEARCH_CONFIGURATION_ERROR"
  | "SEARCH_SCOPE_VIOLATION"
  | "INSUFFICIENT_EVIDENCE"
  | "MODEL_FAILED"
  | "MODEL_RESPONSE_INVALID"
  | "CITATION_INVALID"
  | "TENANT_SUSPENDED"
  | "USER_SUSPENDED"
  | "QUOTA_EXPIRED"
  | "TENANT_QUOTA_EXHAUSTED"
  | "USER_QUOTA_EXHAUSTED"
  | "QUOTA_UNAVAILABLE"
  | "QUOTA_RELEASE_FAILED"
  | "QUOTA_FINALIZE_FAILED";

export class GroundedAiError extends Error {
  constructor(
    readonly status: 400 | 403 | 422 | 429 | 502 | 503,
    readonly code: GroundedAiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GroundedAiError";
  }
}
