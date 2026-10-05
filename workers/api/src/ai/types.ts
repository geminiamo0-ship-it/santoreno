export interface LibraryCatalogEntry {
  libraryId: string;
  name: string;
  instanceId: string;
}

export interface LibraryCatalogPort {
  select(libraryId?: string): Promise<LibraryCatalogEntry[]>;
}

export interface RetrievalQuery {
  query: string;
  libraryId?: string;
}

export interface RetrievedEvidence {
  sourceId: string;
  libraryId: string;
  libraryName: string;
  instanceId: string;
  itemKey: string;
  title: string;
  page: number | null;
  section: string | null;
  text: string;
  score: number;
}

export interface RetrievalPort {
  retrieve(input: RetrievalQuery): Promise<RetrievedEvidence[]>;
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
