import type {
  CombinedSearchResult,
  RetrievalPort,
  RetrievalRequest,
  RetrievedEvidence,
} from "./types";
import {
  focusedSearchQuery,
  hasSearchSubjectAnchors,
  matchesSearchSubject,
} from "./source-relevance";

/**
 * The one-call, forward-all staging path needs source-quality cleanup, not a
 * new top-k limit or a second search/model call.
 *
 * Preserve ranked order and original verified IDs. Discard only passages
 * outside the question's subject and verbatim-equivalent passage bodies.
 * Different excerpts from the same article remain independent evidence.
 */
export function curateRetrievedEvidence(
  query: string,
  evidence: readonly RetrievedEvidence[],
): RetrievedEvidence[] {
  const focused = focusedSearchQuery(query);
  // For non-specific/abbreviated prompts ("AS", "ECG", etc.), there is no
  // reliable lexical subject gate. Do not erase the search result set.
  const canCheckSubject = hasSearchSubjectAnchors(focused);
  const seenSources = new Set<string>();
  const seenContent = new Set<string>();
  const retained: RetrievedEvidence[] = [];
  let unrelated = 0;
  let duplicates = 0;

  for (const item of evidence) {
    if (canCheckSubject && !matchesSearchSubject(focused, item)) {
      unrelated++;
      continue;
    }
    if (seenSources.has(item.sourceId)) {
      duplicates++;
      continue;
    }

    // Article filenames differ across book imports. A stable article heading
    // plus normalized BODY identifies literal copies without equating two
    // passages that merely discuss the same disease.
    const lines = item.text.replace(/\r\n?/g, "\n").split("\n");
    const heading = lines.find((line) => /^#\s+\S/.test(line.trim()))?.trim() ?? "";
    const body = lines
      .filter(
        (line) => !/^\s*#\s+\S/.test(line) && !/^\s*(?:Library|Category|Section):\s*/i.test(line),
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("en");
    const normalizedHeading = heading.replace(/^#\s+/, "").trim().toLocaleLowerCase("en");
    // Empty/generic header-only chunks are not safe to merge across items.
    const contentKey = body.length > 0 ? normalizedHeading + "\n" + body : null;
    if (contentKey && seenContent.has(contentKey)) {
      duplicates++;
      continue;
    }
    seenSources.add(item.sourceId);
    if (contentKey) seenContent.add(contentKey);
    retained.push(item);
  }

  console.info("santo_evidence_curation", {
    retrieved: evidence.length,
    retained: retained.length,
    duplicates,
    unrelated,
  });
  return retained;
}

/** Staging-only decorator after optional AMBOSS R2 expansion.
 * All search and gallery operations are delegated unchanged.
 */
export class CuratedEvidenceRetrieval implements RetrievalPort {
  readonly route?: RetrievalPort["route"];
  readonly retrieveWithGallery?: RetrievalPort["retrieveWithGallery"];

  constructor(private readonly original: RetrievalPort) {
    this.route = original.route ? (request) => original.route!(request) : undefined;
    this.retrieveWithGallery = original.retrieveWithGallery
      ? async (request): Promise<CombinedSearchResult> => {
          const result = await original.retrieveWithGallery!(request);
          return {
            ...result,
            evidence: curateRetrievedEvidence(request.preparedQuery ?? request.query, result.evidence),
          };
        }
      : undefined;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievedEvidence[]> {
    return curateRetrievedEvidence(
      request.preparedQuery ?? request.query,
      await this.original.retrieve(request),
    );
  }
}
