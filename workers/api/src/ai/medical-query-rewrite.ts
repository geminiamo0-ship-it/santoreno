import type { WorkersAiLike } from "../runtime/bindings";

const QUERY_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const QUERY_MAX_TOKENS = 512;
const FOLLOW_UP_MARKER = "\nFollow-up question:\n";
const MAX_FOCUSED_CHARS = 850;
// Keep medical rewriting bounded; routing uses a faster 4s timeout.
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
    const normalized =
      typeof rewritten === "string"
        ? rewritten.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim()
        : rewritten;
    return acceptMedicalRewrite(focusedQuery, normalized) ?? focusedQuery;
  } catch {
    return focusedQuery;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** One Qwen inference classifies a student turn and normalizes medical search.
 * The generated CHAT answer is only accepted for short, unambiguous social
 * turns. All questionable output fails closed to medical retrieval. */
export type MedicalRoute =
  { intent: "medical"; searchQuery: string } | { intent: "chat"; answer: string };

const ROUTE_PROMPT =
  "You are the medical education assistant Santo's request router. Use the latest student question and its clinical topic context. " +
  "Classify CHAT only for genuinely nonclinical small-talk (greetings, thanks, who are you, short casual conversation). " +
  "If the student asks any medical question, follow-up, symptoms, diagnosis, drugs, treatment, medical education, " +
  "or you are uncertain, classify MEDICAL. For MEDICAL, produce one precise English medical search query " +
  "preserving severity, negation, timing and the resolved disease topic. Translate Arabic, fix typos and expand clear abbreviations. " +
  "For CHAT, answer as Santo warmly and briefly in the user's language without medical claims, citations or source links. " +
  'Output STRICT one-line JSON: {"intent":"MEDICAL","search_query":"..."} OR {"intent":"CHAT","answer":"..."}. ' +
  "No explanations, no Markdown fences, no extra keys. /no_think";

function modelOutput(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const response = raw as Record<string, unknown>;
  if (typeof response.response === "string") return response.response;
  const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  const record = choice && typeof choice === "object" ? (choice as Record<string, unknown>) : null;
  const message =
    record?.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : null;
  return typeof message?.content === "string" ? message.content : null;
}

function latestStudentMessage(original: string): string {
  const marker = original.lastIndexOf(FOLLOW_UP_MARKER);
  return (marker >= 0 ? original.slice(marker + FOLLOW_UP_MARKER.length) : original).trim();
}

function clearlyNonClinical(input: string): boolean {
  if (!input || input.length > 180) return false;
  // Permit only explicitly social turns, never the broad inverse of a disease
  // dictionary (which could miss clinical terms or another language).
  const socialEnglish = /^(?:(?:hi|hello|hey|good (?:morning|evening|afternoon)|thanks(?: a lot)?|thank you|bye|goodbye|how are you|who are you|what(?:'s| is) your name|what can you do|can you help me|tell me a joke|cheer me up|give me study motivation)[!.?\\s]*)$/i;
  const socialArabic = /^(?:(?:اهلا|أهلا|اهلين|سلام|السلام عليكم|صباح الخير|مساء الخير|شكرا|شكرًا|متشكر|ازيك|إزيك|عامل ايه|عامل إيه|انت مين|أنت مين)[!؟.\\s]*)$/u;
  return socialEnglish.test(input.trim()) || socialArabic.test(input.trim());
}

export async function routeMedicalRequest(
  ai: WorkersAiLike | undefined,
  originalRequest: string,
  focusedQuery: string,
): Promise<MedicalRoute> {
  const fallback: MedicalRoute = { intent: "medical", searchQuery: focusedQuery };
  if (!ai || focusedQuery.length > MAX_FOCUSED_CHARS || !focusedQuery.trim()) return fallback;
  const latest = latestStudentMessage(originalRequest);
  const input = [
    "Latest student question: " + latest.slice(0, 600),
    "Resolved medical topic and intent: " + focusedQuery.slice(0, MAX_FOCUSED_CHARS),
    "Prior medical context exists: " + originalRequest.includes(FOLLOW_UP_MARKER),
  ].join("\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      ai.run(QUERY_MODEL, {
        messages: [
          { role: "system", content: ROUTE_PROMPT },
          { role: "user", content: input },
        ],
        max_tokens: QUERY_MAX_TOKENS,
        temperature: 0,
        top_p: 0.8,
        stream: false,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ROUTER_TIMEOUT")), 4000);
      }),
    ]);
    const output = modelOutput(raw)
      ?.replace(/^<think>[\s\S]*?<\/think>\s*/i, "")
      .trim();
    if (!output || output.length > 850) return fallback;
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const result = parsed as Record<string, unknown>;
    if (result.intent === "MEDICAL")
      return {
        intent: "medical",
        searchQuery: acceptMedicalRewrite(focusedQuery, result.search_query) ?? focusedQuery,
      };
    if (
      result.intent === "CHAT" &&
      typeof result.answer === "string" &&
      result.answer.trim().length > 0 &&
      result.answer.length <= 350 &&
      clearlyNonClinical(latest) &&
      !originalRequest.includes(FOLLOW_UP_MARKER) &&
      !/https?:|\[\[|SANTO_REF_|(?:source|citation|guideline):/i.test(result.answer)
    )
      return { intent: "chat", answer: result.answer.trim() };
    return fallback;
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
