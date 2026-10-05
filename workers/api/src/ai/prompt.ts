import type { RetrievedEvidence } from "./types";

const MAX_EVIDENCE_CHARS = 3500;

export function buildGroundedPrompt(query: string, evidence: readonly RetrievedEvidence[]): string {
  const context = evidence
    .map((item, index) => {
      const page = item.page === null ? "unknown" : String(item.page);
      return [
        `SOURCE ${index + 1}`,
        `source_id: ${item.sourceId}`,
        `title: ${item.title}`,
        `page: ${page}`,
        `text: ${item.text.slice(0, MAX_EVIDENCE_CHARS)}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "You are Santo, a medical knowledge assistant.",
    "Answer the user's question using ONLY the evidence supplied below.",
    "Do not use unstated medical facts and do not invent sources.",
    "Every citation_id must exactly match one source_id from the evidence.",
    "Return JSON only with this exact shape:",
    '{"answer":"concise grounded answer","citation_ids":["source_id"]}',
    "Use at least one citation_id for a successful answer.",
    'If the evidence is insufficient, return {"answer":"INSUFFICIENT_EVIDENCE","citation_ids":[]}.',
    "",
    `USER QUESTION:\n${query}`,
    "",
    `EVIDENCE:\n${context}`,
  ].join("\n");
}
