import type { WorkersAiLike } from "../runtime/bindings";

const QUERY_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const QUERY_MAX_TOKENS = 512;
const FOLLOW_UP_MARKER = "\nFollow-up question:\n";
const MAX_FOCUSED_CHARS = 850;
// Bounded by the outer 15s retrieval deadline; leave time for AI Search.
const REWRITE_TIMEOUT_MS = 8000;
const PROMPT =
  "You are a medical-search query normalizer. Translate Arabic medical questions into precise English; repair spelling, expand clear abbreviations, and keep the latest disease, management/diagnosis intent, negation, severity, population and timing. For follow-ups use ONLY the supplied resolved topic. Never introduce unrelated diagnoses or treatments. Output ONE compact English search query (prefer under 25 words), no explanation, list, tags, or JSON. /no_think";

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

const IGNORED = new Set([
  "a",
  "an",
  "the",
  "and",
  "of",
  "or",
  "in",
  "on",
  "for",
  "to",
  "with",
  "at",
  "is",
  "are",
  "was",
  "were",
  "what",
  "how",
  "why",
  "please",
  "explain",
  "describe",
  "tell",
  "me",
  "about",
  "can",
  "you",
  "its",
  "it",
  "this",
  "that",
  "management",
  "treatment",
  "diagnosis",
  "symptoms",
  "causes",
  "pathophysiology",
  "complications",
  "overview",
  "summary",
  "of",
  "therapy",
  "question",
  "clinical",
  "patient",
]);

export function acceptMedicalRewrite(_focused: string, output: unknown): string | null {
  if (typeof output !== "string") return null;
  const candidate = output.trim();
  if (
    candidate.length < 3 ||
    candidate.length > 220 ||
    /[\n\r{}<>]/.test(candidate) ||
    /^(?:here|sure|query:|search query:|i |please |note:)/i.test(candidate)
  )
    return null;
  // Translation and typo correction change surface tokens by design.
  // Reject malformed/non-English output, not medically correct paraphrases.
  if (/[\u0600-\u06ff]/u.test(candidate)) return null;
  return candidate;
}

/**
 * One isolated multilingual Workers AI inference before Cloudflare's unchanged
 * 5/10 operations. Never uses Verified A text; never feeds this model's
 * output to citations or Luna as evidence. Timeout/invalid/unconfigured ->
 * deterministic focused query. No retry, no second paid rewrite.
 */
export async function rewriteMedicalSearchQuery(
  ai: WorkersAiLike | undefined,
  originalRequest: string,
  focusedQuery: string,
): Promise<string> {
  if (
    !ai ||
    focusedQuery.length > MAX_FOCUSED_CHARS ||
    focusedQuery.length < 3 ||
    !words(focusedQuery).some((word) => word.length >= 3 && !IGNORED.has(word))
  ) {
    return focusedQuery;
  }
  const marker = originalRequest.lastIndexOf(FOLLOW_UP_MARKER);
  const studentMessage =
    marker >= 0 ? originalRequest.slice(marker + FOLLOW_UP_MARKER.length).trim() : originalRequest;
  const input = [
    "Latest student question: " + studentMessage.slice(0, 600),
    "Resolved medical topic and clinical intent: " + focusedQuery.slice(0, MAX_FOCUSED_CHARS),
  ].join("\n");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ai.run(QUERY_MODEL, {
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: input },
        ],
        max_tokens: QUERY_MAX_TOKENS,
        temperature: 0.4,
        top_p: 0.8,
        stream: false,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("QUERY_REWRITE_TIMEOUT")), REWRITE_TIMEOUT_MS);
      }),
    ]);
    const data = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
    const choices = Array.isArray(data?.choices) ? data.choices : [];
    const first = choices[0];
    const message =
      first && typeof first === "object" ? (first as Record<string, unknown>).message : null;
    const content =
      message && typeof message === "object" ? (message as Record<string, unknown>).content : null;
    const rewritten = typeof data?.response === "string" ? data.response : content;
    // Qwen3 may wrap a no-thinking response in an empty <think> block.
    const normalized = typeof rewritten === "string"
      ? rewritten.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim()
      : rewritten;
    return acceptMedicalRewrite(focusedQuery, normalized) ?? focusedQuery;
  } catch {
    return focusedQuery;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
