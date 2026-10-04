import type { GroundedAiCitation, GroundedAiModelOutput } from "@santo/contracts";

import type { RetrievedEvidence } from "./types";

export class CitationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CitationError";
  }
}

export function validateCitations(
  output: GroundedAiModelOutput,
  evidence: readonly RetrievedEvidence[],
): GroundedAiCitation[] {
  const evidenceById = new Map(evidence.map((item) => [item.sourceId, item]));
  const uniqueIds = [...new Set(output.citation_ids)];

  if (uniqueIds.length === 0) {
    throw new CitationError("CITATION_INVALID", "Grounded answer must cite retrieved evidence");
  }

  return uniqueIds.map((sourceId) => {
    const source = evidenceById.get(sourceId);
    if (!source) {
      throw new CitationError(
        "CITATION_INVALID",
        `Model cited a source that was not retrieved: ${sourceId}`,
      );
    }

    return {
      sourceId: source.sourceId,
      instanceId: source.instanceId,
      title: source.title,
      page: source.page,
      score: source.score,
    };
  });
}
