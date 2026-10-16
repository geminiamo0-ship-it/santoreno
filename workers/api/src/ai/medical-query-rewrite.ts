import type { WorkersAiLike } from "../runtime/bindings";

const GRANITE_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";
const FOLLOW_UP_MARKER = "\nFollow-up question:\n";
const MAX_FOCUSED_CHARS = 850;
const REWRITE_TIMEOUT_MS = 3500;
const PROMPT =
  "Rewrite the latest medical question into ONE concise English library search query using the resolved topic for follow-ups; preserve diagnosis, intent, negation and clinical qualifiers, never add unrelated diseases or treatments, and output ONLY the query.";

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

const IGNORED = new Set([
  "a", "an", "the", "and", "of", "or", "in", "on", "for", "to", "with", "at",
  "is", "are", "was", "were", "what", "how", "why", "please", "explain", "describe",
  "tell", "me", "about", "can", "you", "its", "it", "this", "that", "management",
  "treatment", "diagnosis", "symptoms", "causes", "pathophysiology", "complications",
  "overview", "summary", "of", "therapy", "question", "clinical", "patient",
]);

const MUST_KEEP = new Set([
  "not", "without", "exclude", "severe", "mild", "moderate", "acute", "chronic",
  "asymptomatic", "symptomatic", "pregnant", "pregnancy", "adult", "pediatric",
  "paediatric", "neonatal", "child", "children", "elderly", "unstable",
]);

export function acceptMedicalRewrite(focused: string, output: unknown): string | null {
  if (typeof output !== "string") return null;
  const candidate = output.trim();
  if (
    candidate.length < 3 ||
    candidate.length > 220 ||
    /[\n\r{}<>]/.test(candidate) ||
    /^(?:here|sure|query:|search query:|i |please |note:)/i.test(candidate)
  ) return null;
  const inputWords = words(focused);
  const candidateWords = new Set(words(candidate));
  const anchors = [...new Set(inputWords.filter((word) => word.length >= 3 && !IGNORED.has(word)))];
  if (anchors.length === 0) return null;
  // Reject dropped disease terms (short queries), silent negation/severity loss,
  // stale-topic contamination and overcreative unrelated expansions conservatively.
  const requiredHits = Math.min(2, anchors.length);
  if (anchors.filter((word) => candidateWords.has(word)).length < requiredHits) return null;
  if (inputWords.some((word) => MUST_KEEP.has(word) && !candidateWords.has(word))) return null;
  return candidate;
}

/**
 * One *small*, isolated Workers AI inference before Cloudflare's unchanged
 * 5/10 operations. Never uses Verified A text; never feeds this model's
 * output to citations or Luna as evidence. Timeout/invalid/unconfigured ->
 * deterministic focused query. No retry, no second paid rewrite.
 */
export async function rewriteMedicalSearchQuery(
  ai: WorkersAiLike | undefined,
  originalRequest: string,
  focusedQuery: string,
): Promise<string> {
  if (!ai || focusedQuery.length > MAX_FOCUSED_CHARS || focusedQuery.length < 3) {
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
      ai.run(GRANITE_MODEL, {
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: input },
        ],
        max_tokens: 64,
        temperature: 0,
        stream: false,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("QUERY_REWRITE_TIMEOUT")), REWRITE_TIMEOUT_MS);
      }),
    ]);
    const data = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
    return acceptMedicalRewrite(focusedQuery, data?.response) ?? focusedQuery;
  } catch {
    return focusedQuery;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
