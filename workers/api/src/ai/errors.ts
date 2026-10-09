export type GroundedAiErrorCode =
  | "AI_NOT_CONFIGURED"
  | "INVALID_LIBRARY_FILTER"
  | "SEARCH_FAILED"
  | "SEARCH_TIMEOUT"
  | "SEARCH_CONFIGURATION_ERROR"
  | "INSUFFICIENT_EVIDENCE"
  | "MODEL_FAILED"
  | "MODEL_TIMEOUT"
  | "REQUEST_CANCELLED"
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
    readonly status: 400 | 403 | 422 | 429 | 499 | 502 | 503 | 504,
    readonly code: GroundedAiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GroundedAiError";
  }
}
