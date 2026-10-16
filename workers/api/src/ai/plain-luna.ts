import { GroundedAiError } from "./errors";
import { LUNA_MAX_GENERATED_CHARS } from "./luna-event-stream";
import type { GroundedModelDraft } from "./types";

/**
 * Staging-only alternative to streaming one giant JSON string.
 * AI supplies Markdown and numbered [[N]] citations; authoritative source
 * identities are *never* supplied by the AI and remain server validated.
 */
export const LUNA_PLAIN_TEXT_INSTRUCTIONS =
  "You are Santo Medical Education Copilot, a knowledgeable medical professor. " +
  "Respond in readable Markdown, never JSON. Explain mechanisms, diagnosis, and management clearly, " +
  "adapting depth to the question without filler or invented patient data. " +
  "Use retrieved evidence honestly; the EVIDENCE_JSON source_id SANTO_REF_1 maps to [[1]], " +
  "SANTO_REF_2 maps to [[2]], and so on. After supported clinical claims, insert compact " +
  "citation markers [[1]] through [[5]] for the corresponding real excerpt, not for unrelated " +
  "background knowledge. When evidence is supplied include at least one supported citation. " +
  "When no evidence is supplied, use none. Never output technical labels SANTO_REF_*, " +
  "source hashes, invented citations, JSON wrappers, or code fences. Finish the answer in complete sentences.";

function scrubMachineIds(text: string, ids: readonly string[]): string {
  let safe = text;
  for (const id of [...new Set(ids)].sort((a, b) => b.length - a.length)) {
    if (!id) continue;
    safe = safe.split("cite" + id).join("");
    safe = safe.split(id).join("");
  }
  // Do not expose a model's own private alias if it disobeyed the instruction.
  return safe.replace(/\b(?:cite)?SANTO_REF_[1-9]\d?\b/g, "");
}

/** Drafts are explicitly unverified. Suppress partial citations while streaming. */
export function previewPlainLuna(text: string, sourceIds: readonly string[]): string {
  // Streaming drafts cannot display arbitrary model-authored image URLs.
  const withoutModelUrls = text.replace(/!\[[^\]\n]{0,250}\]\([^\)\n]{1,900}\)/g, "");
  const withoutFullCitations = withoutModelUrls.replace(/\[\[(?:\d{1,2}|IMG_\d{0,3})\]\]/g, "");
  const withoutPartial = withoutFullCitations.replace(/\[\[(?:\d{0,2})?$/g, "");
  return scrubMachineIds(withoutPartial, sourceIds).replace(
    /\[?SANTO_(?:R(?:E(?:F(?:_\d*)?)?)?)?$/g,
    "",
  );
}

/** A short social/clarifying Luna answer must not inherit unrelated RAG sources. */
function isNonClinicalReply(answer: string): boolean {
  const normalized = answer.trim().replace(/\s+/g, " ");
  if (normalized.length > 420) return false;
  if (/^(?:what|which) (?:condition|disease|medical condition|topic)\b/i.test(normalized)) {
    return true;
  }
  if (/^(?:could you|can you|please) (?:clarify|specify|name)\b/i.test(normalized)) {
    return true;
  }
  if (
    /^(?:hi|hello|hey|good morning|good evening|good afternoon|thanks|thank you|you(?:'re| are) welcome)[!.,\s؟]*$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  // Luna's real greeting is often two sentences, not just the literal "Hi!".
  if (
    /^(?:hi|hello|hey|good morning|good evening)[!.,\s؟]+(?:what would you like to learn about today\?|how can i help you(?: today)?\?|what can i help you with(?: today)?\?)$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return /^(?:تقصد (?:أي|اي) (?:مرض|حالة)|(?:ما|ايه) (?:المرض|الحالة) المقصود)/u.test(normalized);
}

/**
 * Luna chooses inline citations using [[N]], while Santo alone owns the source
 * identifiers. Unknown/malformed markers are stripped, never relinked.
 * Complete uncited teaching may be accompanied by real, separately labeled
 * related-library sources (not claimed sentence-level provenance).
 * A response.completed provider frame is still mandatory upstream.
 */
export function parsePlainLunaAnswer(
  text: string,
  sourceIds: readonly string[] | undefined,
): GroundedModelDraft {
  const allowed = sourceIds ?? [];
  const used: string[] = [];
  const found = new Set<string>();
  let answer = text.replace(/\[\[([^\]\n]{0,24})\]\]/g, (_whole, token: string) => {
    if (/^IMG_\d{3}$/.test(token)) return _whole;
    if (!/^[1-9]\d?$/.test(token)) return "";
    const source = allowed[Number(token) - 1];
    if (!source) return "";
    if (!found.has(source)) {
      found.add(source);
      used.push(source);
    }
    return "\u0000" + source + "\u0000";
  });
  answer = answer.replace(/\[\[[^\]\n]{0,24}(?=\n|$)/g, "");
  for (let i = 0; i < used.length; i++) {
    answer = answer.split("\u0000" + used[i] + "\u0000").join("[" + (i + 1) + "]");
  }
  answer = scrubMachineIds(answer.trim(), allowed);
  if (!answer || answer.length > LUNA_MAX_GENERATED_CHARS) {
    throw new GroundedAiError(
      502,
      "MODEL_RESPONSE_INVALID",
      "Model returned unusable teaching text",
    );
  }
  if (allowed.length > 0 && used.length === 0) {
    return {
      answer,
      citationIds: [],
      sourcePresentation: isNonClinicalReply(answer) ? "none" : "related",
    };
  }
  return { answer, citationIds: used };
}
