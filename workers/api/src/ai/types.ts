export interface RetrievedEvidence {
  sourceId: string;
  libraryId: string;
  instanceId: string;
  itemKey: string;
  title: string;
  page: number | null;
  section: string | null;
  text: string;
  score: number;
}

export interface RetrievalRequest {
  query: string;
  libraryId: string | null;
  /** Validated single-Qwen medical search query; avoids calling Qwen twice. */
  preparedQuery?: string;
  /** Optional request-scoped observer: outcome and duration only, never prompts. */
  onRouteDiagnostic?: (
    outcome: import("./medical-query-rewrite").QwenRouteOutcome,
    milliseconds: number,
  ) => void;
}

export interface GallerySearchHit {
  imageId: string;
  score: number;
}

export interface CombinedSearchResult {
  evidence: RetrievedEvidence[];
  galleryHits: GallerySearchHit[];
}

export interface RetrievalPort {
  retrieve(request: RetrievalRequest): Promise<RetrievedEvidence[]>;
  /** One Cloudflare namespace request with five evidence indexes and image index. */
  retrieveWithGallery?(request: RetrievalRequest): Promise<CombinedSearchResult>;
  /** Optional staging-only Qwen route; all other adapters remain unchanged. */
  route?(request: RetrievalRequest): Promise<import("./medical-query-rewrite").MedicalRoute>;
}

export interface GroundedModelDraft {
  answer: string;
  citationIds: string[];
  /** Staging Markdown: no inline citation is implied by related library sources. */
  sourcePresentation?: "related" | "none";
}

export interface ModelPort {
  generate(
    prompt: string,
    onProvisionalAnswer?: (text: string) => void,
    allowedCitationIds?: readonly string[],
  ): Promise<GroundedModelDraft>;
}

export interface AiTelemetryEvent {
  requestId: string;
  tenantId: string;
  externalUserId: string;
  status: "success" | "failure";
  latencyMs: number;
  errorCode: string | null;
  failureStage?: string;
  responseFormat?: "json" | "markdown";
  retrievedSourceCount?: number;
  validCitationCount?: number;
  outputChars?: number;
  sourcePresentation?: "inline" | "related";
}

export interface AiTelemetryPort {
  record(event: AiTelemetryEvent): void;
}
