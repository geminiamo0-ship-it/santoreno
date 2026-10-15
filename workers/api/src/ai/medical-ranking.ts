import type { RetrievedEvidence } from "./types";
import { matchesSearchSubject } from "./source-relevance";

export interface RankedCandidate {
  evidence: RetrievedEvidence;
  /** Position after Cloudflare native per-index reranking, starting at zero. */
  position: number;
}

const CLINICAL_SECTIONS: ReadonlyArray<{ intent: RegExp; section: RegExp }> = [
  {
    intent: /\b(?:mechanism|pathophysiology|physiology|pathogenesis|why|hemodynamic)\b/i,
    section:
      /\b(?:mechanism|pathophysiology|physiology|pathogenesis|hemodynamic|pressure.overload)\b/i,
  },
  {
    intent: /\b(?:symptoms?|signs?|presentation|manifestations?|clinical features?)\b/i,
    section: /\b(?:symptoms?|signs?|presentation|manifestations?|clinical features?)\b/i,
  },
  {
    intent: /\b(?:diagnos\w*|investigat\w*|evaluation|test|ecg|echo|imaging)\b/i,
    section: /\b(?:diagnos\w*|investigat\w*|evaluation|test|ecg|echo|imaging)\b/i,
  },
  {
    intent: /\b(?:treatment|management|therapy|ttt|intervention|drug|surgery)\b/i,
    section: /\b(?:treatment|management|therapy|therapeutic|intervention|drug|surgery)\b/i,
  },
];

const COMMON = new Set([
  "about",
  "and",
  "brief",
  "can",
  "clinical",
  "describe",
  "explain",
  "for",
  "from",
  "how",
  "its",
  "medical",
  "more",
  "of",
  "overview",
  "please",
  "question",
  "summary",
  "tell",
  "the",
  "this",
  "what",
  "when",
  "which",
  "with",
  "you",
]);

function words(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => word.length > 2 && !COMMON.has(word),
  );
}

function overlap(query: readonly string[], candidate: string): number {
  if (!query.length) return 0;
  const available = new Set(words(candidate));
  return query.filter((word) => available.has(word)).length / query.length;
}

/**
 * Cross-library ranking. Cloudflare's raw similarity scores are NOT compared
 * between different index instances. Use the native per-index rerank position
 * plus explicit article-title, section and content relevance instead.
 *
 * This never invents a missing source; all results retain their original IDs.
 */
export function rankMedicalCandidates(
  query: string,
  candidates: readonly RankedCandidate[],
  limit = 5,
): RetrievedEvidence[] {
  const queryWords = [...new Set(words(query))];
  const sectionIntents = CLINICAL_SECTIONS.filter((entry) => entry.intent.test(query));
  const scored = candidates
    .filter(({ evidence }) => matchesSearchSubject(query, evidence))
    .map(({ evidence, position }) => {
      const heading = [evidence.section ?? "", evidence.title].join(" ");
      const titleMatch = overlap(queryWords, evidence.title);
      const sectionMatch = overlap(queryWords, heading);
      const bodyMatch = overlap(queryWords, evidence.text);
      const sectionBonus = sectionIntents.some((entry) =>
        entry.section.test(evidence.section ?? ""),
      )
        ? 2.8
        : sectionIntents.some((entry) => entry.section.test(evidence.text.slice(0, 800)))
          ? 0.25
          : 0;
      return {
        evidence,
        quality: titleMatch * 4 + sectionMatch * 2 + bodyMatch + sectionBonus + 2 / (1 + position),
      };
    })
    .sort(
      (a, b) => b.quality - a.quality || a.evidence.sourceId.localeCompare(b.evidence.sourceId),
    );

  const seenIds = new Set<string>();
  const articleCount = new Map<string, number>();
  const result: RetrievedEvidence[] = [];
  for (const item of scored) {
    const source = item.evidence;
    const article = source.instanceId + ":" + source.itemKey;
    if (seenIds.has(source.sourceId) || (articleCount.get(article) ?? 0) >= 2) continue;
    seenIds.add(source.sourceId);
    articleCount.set(article, (articleCount.get(article) ?? 0) + 1);
    result.push(source);
    if (result.length >= limit) break;
  }
  return result;
}
