import { GroundedAiError } from "./errors";
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
  const withoutFullCitations = text.replace(/\[\[\d{1,2}\]\]/g, "");
  const withoutPartial = withoutFullCitations.replace(/\[\[(?:\d{0,2})?$/g, "");
  return scrubMachineIds(withoutPartial, sourceIds).replace(
    /\[?SANTO_(?:R(?:E(?:F(?:_\d*)?)?)?)?$/g,
    "",
  );
}

/** An explicit [[N]] must map to the Nth actual retrieved source.
 * Never manufacture a citation or cite a source not selected by the model.
 * The ordinary GroundedAiService still validates source identity and snapshots.
 */
export function parsePlainLunaAnswer(
  text: string,
  sourceIds: readonly string[] | undefined,
): GroundedModelDraft {
  const allowed = sourceIds ?? [];
  const used: string[] = [];
  const found = new Set<string>();
  let invalidCitation = false;
  let answer = text.replace(/\[\[([^\]\n]{1,24})\]\]/g, (whole, token: string) => {
    if (!/^[1-9]\d?$/.test(token)) {
      invalidCitation = true;
      return whole;
    }
    const source = allowed[Number(token) - 1];
    if (!source) {
      invalidCitation = true;
      return whole;
    }
    if (!found.has(source)) {
      found.add(source);
      used.push(source);
    }
    // Placeholder is transient inside Santo and never sent to the client.
    return "\u0000" + source + "\u0000";
  });
  if (invalidCitation || (allowed.length > 0 && used.length === 0)) {
    throw new GroundedAiError(
      502,
      "CITATION_INVALID",
      "Model did not cite trusted source excerpts",
    );
  }
  if (/\[\[\d{0,2}$/.test(answer) || /\bSANTO_REF_?\d*$/.test(answer)) {
    throw new GroundedAiError(502, "MODEL_RESPONSE_INVALID", "Unfinished model citation");
  }
  for (let i = 0; i < used.length; i++) {
    answer = answer.split("\u0000" + used[i] + "\u0000").join("[" + (i + 1) + "]");
  }
  answer = scrubMachineIds(answer.trim(), allowed);
  if (!answer || answer.length > 64000) {
    throw new GroundedAiError(
      502,
      "MODEL_RESPONSE_INVALID",
      "Model returned unusable teaching text",
    );
  }
  return { answer, citationIds: used };
}
