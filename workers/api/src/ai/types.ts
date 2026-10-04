import type {
  GroundedAiCitation,
  GroundedAiModelOutput,
  GroundedAiQueryResponse,
  SessionContextResponse,
} from "@santo/contracts";

export interface RetrievedEvidence {
  sourceId: string;
  instanceId: string;
  title: string;
  page: number | null;
  score: number;
  text: string;
  key: string;
}

export interface GroundedRetrieval {
  retrieve(question: string): Promise<RetrievedEvidence[]>;
}

export interface GroundedModelInput {
  question: string;
  evidence: readonly RetrievedEvidence[];
}

export interface GroundedModel {
  generate(input: GroundedModelInput): Promise<GroundedAiModelOutput>;
}

export interface GroundedAiQueryInput {
  session: SessionContextResponse;
  question: string;
  idempotencyKey: string;
}

export interface GroundedAiResult extends GroundedAiQueryResponse {
  citations: GroundedAiCitation[];
}
