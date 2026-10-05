import type { GroundedAiCitation } from "@santo/contracts/ai";

import { GroundedAiError } from "./errors";
import type { GroundedModelDraft, RetrievedEvidence } from "./types";

export function validateGroundedCitations(
  draft: GroundedModelDraft,
  evidence: readonly RetrievedEvidence[],
): GroundedAiCitation[] {
  const byId = new Map(evidence.map((item) => [item.sourceId, item]));
  const uniqueCitationIds = [...new Set(draft.citationIds)];

  if (uniqueCitationIds.length === 0) {
    throw new GroundedAiError(
      502,
      "CITATION_INVALID",
      "A grounded answer must cite at least one retrieved source",
    );
  }

  const citations = uniqueCitationIds.map((sourceId) => {
    const source = byId.get(sourceId);
    if (!source) {
      throw new GroundedAiError(
        502,
        "CITATION_INVALID",
        "Model returned a citation that was not retrieved",
      );
    }

    return {
      sourceId: source.sourceId,
      title: source.title,
      page: source.page,
    } satisfies GroundedAiCitation;
  });

  if (citations.length > 5) {
    throw new GroundedAiError(502, "CITATION_INVALID", "Model returned too many citations");
  }

  return citations;
}
