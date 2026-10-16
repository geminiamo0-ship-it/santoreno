import type { RetrievedEvidence } from "./types";

export interface RankedCandidate {
  evidence: RetrievedEvidence;
  /** Cloudflare native per-library reranker position, starting at zero. */
  position: number;
}

/** Native Cloudflare ranking owns relevance. No token-overlap or subject
 * matching gate may discard translated, misspelled or synonymous articles.
 * Preserve genuine source IDs and prefer diversity across original articles.
 */
export function rankMedicalCandidates(
  _query: string,
  candidates: readonly RankedCandidate[],
  limit = 5,
): RetrievedEvidence[] {
  const usedIds = new Set<string>();
  const usedArticles = new Set<string>();
  return [...candidates]
    .sort((a, b) => a.position - b.position ||
      a.evidence.instanceId.localeCompare(b.evidence.instanceId) ||
      a.evidence.sourceId.localeCompare(b.evidence.sourceId))
    .filter(({ evidence }) => {
      const article = evidence.instanceId + ":" + evidence.itemKey;
      if (usedIds.has(evidence.sourceId) || usedArticles.has(article)) return false;
      usedIds.add(evidence.sourceId);
      usedArticles.add(article);
      return true;
    })
    .slice(0, limit)
    .map(({ evidence }) => evidence);
}
