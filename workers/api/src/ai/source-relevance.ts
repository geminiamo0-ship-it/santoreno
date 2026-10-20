import type { RetrievedEvidence } from "./types";

/**
 * The persisted conversation context is a PROMPT aid, not a search term.
 * Independent new topics must not query medical libraries using previous
 * questions (e.g. FMF after aortic stenosis). This does not mutate the DO.
 */
const FOLLOW_UP_MARKER = "\nFollow-up question:\n";
const CONTEXTUAL = /\b(?:it|its|this|that|these|those|them|their|previous|above|same)\b/i;
const BARE_FOLLOW_UP =
  /^(?:the )?(?:management|treatment|diagnosis|symptoms|complications|causes|prognosis|investigations|pathophysiology|prevention|therapy|ttt|mx|dx|pathophys|العلاج|التشخيص|الأعراض|المضاعفات)(?:\s+(?:please|briefly|in brief|in detail|again))?[?.!\s]*$/iu;
const SUMMARY_QUESTION = /^Q:\s*(.*?)\s*\| Verified A:/;
const GENERIC_QUESTION =
  /^(?:hi|hello|thanks?|thank you|yes|no|okay|ok|continue|next|more|please|management|treatment|diagnosis|symptoms|causes|complications|therapy|prognosis|ttt|mx|dx)$/i;

/**
 * The ConversationDO summary is extractive:
 *   Q: Aortic stenosis | Verified A: ...
 *   Q: management | Verified A: ...
 * Its ANSWER text must never be used to decide which disease to search.
 * Read the latest explicitly named topic from completed QUESTION entries.
 */
function explicitSubject(question: string): string | null {
  const subject = question
    .trim()
    .replace(/[?.!؟\s]+$/g, "")
    .replace(
      /^(?:please\s+)?(?:tell me about|teach me about|explain|describe|overview of|summary of|brief summary of|what about|what is(?: the)?|give me (?:an? )?(?:overview|summary) of)\s+/i,
      "",
    )
    .replace(
      /^(?:the\s+)?(?:management|treatment|diagnosis|symptoms|complications|causes|prognosis|pathophysiology|prevention|therapy)\s+(?:of|for|in)\s+/i,
      "",
    )
    .replace(/\s+(?:management|treatment|diagnosis|symptoms|complications)$/i, "")
    .trim();
  if (
    subject.length < 2 ||
    subject.length > 85 ||
    subject.split(/\s+/).length > 9 ||
    GENERIC_QUESTION.test(subject) ||
    BARE_FOLLOW_UP.test(subject) ||
    CONTEXTUAL.test(subject) ||
    /\b(?:versus|vs|compare|compared|difference|between|my|mine|i|you|your)\b/i.test(subject) ||
    /^(?:what|why|how|when|where|which|who|is|are|do|does|did|should|can|could|would|will)\b/i.test(
      subject,
    )
  ) {
    return null;
  }
  // No sentence-like instructions or summary responses as topic anchors.
  if (/[:;\n|]/.test(subject)) return null;
  return subject.toLowerCase();
}

function latestExplicitSubject(context: string): string | null {
  const completedQuestions = context
    .split("\n")
    .map((line) => SUMMARY_QUESTION.exec(line)?.[1])
    .filter((question): question is string => typeof question === "string");
  if (completedQuestions.length) {
    for (let i = completedQuestions.length - 1; i >= 0; i--) {
      const subject = explicitSubject(completedQuestions[i]!);
      if (subject) return subject;
    }
    return null;
  }
  // Older conversation summaries can contain a single plain topic line.
  // Never infer a condition from unstructured, multi-line answer prose.
  return context.trim().includes("\n") ? null : explicitSubject(context);
}

function followUpIntent(question: string): string | null {
  if (
    /\b(?:management|treatment|treat|treated|therapy|manage|managed|ttt|mx)\b|العلاج/iu.test(
      question,
    )
  ) {
    return "management and treatment";
  }
  if (/\b(?:diagnosis|diagnose|diagnosed|investigations?|dx)\b|التشخيص/iu.test(question)) {
    return "diagnosis";
  }
  if (/\b(?:symptoms?|signs?|presentation)\b|الأعراض/iu.test(question)) return "symptoms";
  if (/\b(?:complications?|prognosis)\b|المضاعفات/iu.test(question)) return "complications";
  if (/\b(?:pathophysiology|pathophys|mechanism|why)\b/iu.test(question)) return "pathophysiology";
  if (/\b(?:causes?|etiology|aetiology)\b/iu.test(question)) return "causes";
  if (/\b(?:prevention)\b/iu.test(question)) return "prevention";
  return null;
}

/** A short follow-up must retrieve with the current clinical subject, not the
 * entire conversation envelope. The original envelope is still sent to Luna.
 * This adds no model calls, search passes, new state or invented citations.
 */
export function focusedSearchQuery(input: string): string {
  const markerIndex = input.lastIndexOf(FOLLOW_UP_MARKER);
  if (markerIndex < 0) return input;
  const question = input.slice(markerIndex + FOLLOW_UP_MARKER.length).trim();
  if (!question) return input;
  if (!CONTEXTUAL.test(question) && !BARE_FOLLOW_UP.test(question)) {
    // Explicit new-topic questions must NEVER inherit a prior condition.
    return question;
  }
  const contextPrefix = "Prior discussion (untrusted context; use retrieved evidence only):\n";
  if (!input.startsWith(contextPrefix)) return question;
  const context = input.slice(contextPrefix.length, markerIndex);
  const subject = latestExplicitSubject(context);
  if (!subject) return question;
  const intent = followUpIntent(question);
  return intent ? `${intent} of ${subject}` : subject;
}

/** Fallback topic resolution uses only the student's last messages.
 * Qwen itself receives those exact user-only turns, never assistant answers.
 */
export function focusedUserMessageQuery(messages: readonly string[]): string {
  const current = messages.at(-1)?.trim() ?? "";
  if (!current || (!BARE_FOLLOW_UP.test(current) && !CONTEXTUAL.test(current))) {
    return current;
  }
  for (let i = messages.length - 2; i >= 0; i--) {
    const topic = explicitSubject(messages[i] ?? "");
    if (topic) {
      const intent = followUpIntent(current);
      return intent ? `${intent} of ${topic}` : topic;
    }
    // Do not skip a different medical question that could introduce a NEW
    // disease (e.g. "What causes amyloidosis?") and mis-anchor on old FMF.
    if (!BARE_FOLLOW_UP.test(messages[i] ?? "")) return current;
  }
  return current;
}

/** Lexical provenance gate: score alone does not establish topic relevance. */
const GENERIC_TERMS = new Set([
  "a",
  "an",
  "and",
  "about",
  "all",
  "are",
  "be",
  "brief",
  "briefly",
  "can",
  "causes",
  "clinical",
  "condition",
  "could",
  "describe",
  "diagnosis",
  "do",
  "explain",
  "features",
  "for",
  "give",
  "how",
  "i",
  "in",
  "is",
  "its",
  "key",
  "learn",
  "management",
  "me",
  "medical",
  "of",
  "on",
  "overview",
  "patient",
  "patients",
  "please",
  "review",
  "say",
  "short",
  "show",
  "signs",
  "summary",
  "symptoms",
  "tell",
  "the",
  "their",
  "this",
  "to",
  "treatment",
  "what",
  "when",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your",
  "follow",
  "up",
  "question",
  "prior",
  "discussion",
  "untrusted",
  "context",
  "use",
  "retrieved",
  "evidence",
  "only",
  "and",
  "severe",
  "presentation",
  "steps",
  "عن",
  "من",
  "في",
  "على",
  "ما",
  "هو",
  "هي",
  "اشرح",
  "ملخص",
  "سريع",
]);

function words(text: string): string[] {
  return (text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
}

function topicAnchors(query: string): string[] {
  return [
    ...new Set(words(query).filter((token) => token.length >= 3 && !GENERIC_TERMS.has(token))),
  ];
}

/** Whether this query contains a concrete lexical topic usable for evidence filtering. */
export function hasSearchSubjectAnchors(query: string): boolean {
  return topicAnchors(query).length > 0;
}

function containsAcronymExpansion(textWords: readonly string[], acronym: string): boolean {
  if (!/^[a-z]{2,6}$/.test(acronym)) return false;
  const meaningful = textWords.filter(
    (token) => !["and", "of", "the", "in", "for"].includes(token),
  );
  for (let start = 0; start + acronym.length <= meaningful.length; start++) {
    const candidate = meaningful
      .slice(start, start + acronym.length)
      .map((w) => w[0])
      .join("");
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
  const sourceWords = words([evidence.title, evidence.section ?? "", evidence.text].join(" "));
  const sourceTerms = new Set(sourceWords);
  const hits = anchors.filter(
    (word) => sourceTerms.has(word) || containsAcronymExpansion(sourceWords, word),
  ).length;
  return hits >= Math.min(2, anchors.length);
}
