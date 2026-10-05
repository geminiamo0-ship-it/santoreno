export interface RetrievedEvidence {
  sourceId: string;
  instanceId: string;
  itemKey: string;
  title: string;
  page: number | null;
  text: string;
  score: number;
}

export interface RetrievalPort {
  retrieve(query: string): Promise<RetrievedEvidence[]>;
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
