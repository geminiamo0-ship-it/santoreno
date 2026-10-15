import type { RetrievedEvidence } from "./types";

/**
 * The persisted conversation context is a PROMPT aid, not a search term.
 * Independent new topics must not query medical libraries using previous
 * questions (e.g. FMF after aortic stenosis). This does not mutate the DO.
 */
const FOLLOW_UP_MARKER = "\nFollow-up question:\n";
const CONTEXTUAL = /\b(?:it|its|this|that|these|those|them|their|previous|above|same)\b/i;
const BARE_FOLLOW_UP =
  /^(?:the )?(?:management|treatment|diagnosis|symptoms|complications|causes|prognosis|investigations|pathophysiology|prevention|therapy|العلاج|التشخيص|الأعراض|المضاعفات)(?:\s+(?:please|briefly|in brief|in detail|again))?[?.!\s]*$/iu;

export function focusedSearchQuery(input: string): string {
  const markerIndex = input.indexOf(FOLLOW_UP_MARKER);
  if (markerIndex < 0) return input;
  const question = input.slice(markerIndex + FOLLOW_UP_MARKER.length).trim();
  if (!question) return input;
  return CONTEXTUAL.test(question) || BARE_FOLLOW_UP.test(question) ? input : question;
}

/** Lexical provenance gate: score alone does not establish topic relevance. */
const GENERIC_TERMS = new Set([
  "a", "an", "and", "about", "all", "are", "be", "brief", "briefly", "can", "causes",
  "clinical", "condition", "could", "describe", "diagnosis", "do", "explain",
  "features", "for", "give", "how", "i", "in", "is", "its", "key", "learn",
  "management", "me", "medical", "of", "on", "overview", "patient", "patients",
  "please", "review", "say", "short", "show", "signs", "summary", "symptoms",
  "tell", "the", "their", "this", "to", "treatment", "what", "when", "which",
  "who", "why", "with", "would", "you", "your", "follow", "up", "question",
  "prior", "discussion", "untrusted", "context", "use", "retrieved", "evidence",
  "only", "and", "severe", "presentation", "steps",
  "عن", "من", "في", "على", "ما", "هو", "هي", "اشرح", "ملخص", "سريع",
]);

function words(text: string): string[] {
  return (text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
}

function topicAnchors(query: string): string[] {
  return [...new Set(words(query).filter((token) => token.length >= 3 && !GENERIC_TERMS.has(token)))];
}

function containsAcronymExpansion(textWords: readonly string[], acronym: string): boolean {
  if (!/^[a-z]{2,6}$/.test(acronym)) return false;
  const meaningful = textWords.filter((token) => !["and", "of", "the", "in", "for"].includes(token));
  for (let start = 0; start + acronym.length <= meaningful.length; start++) {
    const candidate = meaningful.slice(start, start + acronym.length).map((w) => w[0]).join("");
    if (candidate === acronym) return true;
  }
  return false;
}

/**
 * Keep actual evidence only when its title/section/body matches the medical
 * subject of this turn. Generic search scores (especially across indexes)
 * cannot authorize article cards or images on their own. Conservative
 * false negatives are preferable to mismatched condition diagrams.
 */
export function matchesSearchSubject(query: string, evidence: RetrievedEvidence): boolean {
  const anchors = topicAnchors(query);
  if (!anchors.length) return false;
  const sourceWords = words(
    [evidence.title, evidence.section ?? "", evidence.text].join(" "),
  );
  const sourceTerms = new Set(sourceWords);
  const hits = anchors.filter(
    (word) => sourceTerms.has(word) || containsAcronymExpansion(sourceWords, word),
  ).length;
  return hits >= Math.min(2, anchors.length);
}
