import type { GroundedModelInput } from "./types";

export function buildGroundedPrompt(input: GroundedModelInput): string {
  const evidence = input.evidence
    .map(
      (item) =>
        `[${item.sourceId}]\nTitle: ${item.title}\nSource: ${item.key}\nEvidence:\n${item.text}`,
    )
    .join("\n\n---\n\n");

  return [
    "Answer the medical question using only the evidence below.",
    "Do not use outside knowledge to fill gaps.",
    "If the evidence does not support a medically useful answer, state that the evidence is insufficient.",
    "Return citation_ids containing only source IDs shown in square brackets below.",
    "Every factual medical claim in the answer must be supported by at least one returned source ID.",
    "",
    `Question: ${input.question}`,
    "",
    "Evidence:",
    evidence,
  ].join("\n");
}
