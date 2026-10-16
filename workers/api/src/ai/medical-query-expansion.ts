/**
 * Small, explicitly reviewed MeSH term pilot — NOT a full MeSH or UMLS import.
 *
 * Source: NLM MeSH 2026
 * D001024: https://meshb.nlm.nih.gov/record/ui?ui=D001024
 * D010505: https://meshb.nlm.nih.gov/record/ui?ui=D010505
 *
 * Entry terms are retrieval aliases, NOT treatment recommendations. Never
 * invent clinical modifiers (severity, pregnancy, patient age, modalities).
 * No model call, remote vocabulary fetch, index mutation or source citation.
 */

interface MeshPilotConcept {
  meshId: string;
  aliases: readonly string[];
  /** One extra label, known to represent the same indexed concept. */
  alternative: string;
}

const MESH_PILOT: readonly MeshPilotConcept[] = [
  {
    meshId: "D001024",
    aliases: ["aortic valve stenosis", "aortic stenosis"],
    alternative: "aortic valve stenosis",
  },
  {
    meshId: "D010505",
    // 'FMF' is a locally reviewed clinical abbreviation, not a MeSH entry term.
    aliases: ["familial mediterranean fever", "fmf", "recurrent polyserositis"],
    alternative: "familial mediterranean fever",
  },
];

export interface MedicalSearchQueryPlan {
  query: string;
  expanded: boolean;
}

function includesPhrase(text: string, phrase: string): boolean {
  const normalized = " " + text.toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ") + " ";
  return normalized.includes(" " + phrase + " ");
}

/**
 * Conservative controlled expansion, always anchored to ONE known condition.
 * In long or multi-condition clinical queries prefer the original untouched.
 */
export function expandMedicalSearchQuery(focusedQuery: string): MedicalSearchQueryPlan {
  const query = focusedQuery.trim();
  if (
    query.length < 3 ||
    query.length > 320 ||
    /\\b(?:vs|versus|compare|comparison|differentiate|differential)\\b/i.test(query)
  ) {
    return { query: focusedQuery, expanded: false };
  }

  const matches = MESH_PILOT.filter((concept) =>
    concept.aliases.some((name) => includesPhrase(query, name)),
  );
  if (matches.length !== 1) return { query: focusedQuery, expanded: false };

  const [match] = matches;
  if (!match || includesPhrase(query, match.alternative)) {
    // A MeSH-preferred term already in the question is sufficient for now.
    return { query: focusedQuery, expanded: false };
  }

  // No synonym pile-up: at most ONE strictly curated additional phrase.
  return { query: `${query} ${match.alternative}`, expanded: true };
}
