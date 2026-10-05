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
}

export interface RetrievalPort {
  retrieve(request: RetrievalRequest): Promise<RetrievedEvidence[]>;
}

export interface GroundedModelDraft {
  answer: string;
  citationIds: string[];
}

export interface ModelPort {
  generate(prompt: string): Promise<GroundedModelDraft>;
}

export interface AiTelemetryEvent {
  requestId: string;
  tenantId: string;
  externalUserId: string;
  status: "success" | "failure";
  latencyMs: number;
  errorCode: string | null;
}

export interface AiTelemetryPort {
  record(event: AiTelemetryEvent): void;
}
