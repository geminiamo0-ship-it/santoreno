import { GroundedAiError } from "./errors";
import { buildGroundedPrompt } from "./prompt";
import type { RetrievedEvidence } from "./types";

/**
 * Research conversation budget. Counts are estimated for the configured model:
 * exact tokenization requires the model provider's own tokenizer/usage data.
 * The reservation includes the complete structured output, not just answer prose.
 */
export const RESEARCH_TOKEN_POLICY = {
  total: 10_000,
  maximumOutput: 3_000,
  maximumInput: 7_000,
  overhead: 320,
  minimumExcerptChars: 120,
} as const;

/** Conservative preflight approximation for mixed Arabic/English medical evidence. */
export function estimateResearchInputTokens(content: string): number {
  const bytes = new TextEncoder().encode(content).byteLength;
  return Math.ceil(bytes / 2) + RESEARCH_TOKEN_POLICY.overhead;
}

/** Trim candidate passages adaptively; do not discard relevant evidence at an arbitrary paper count. */
export function buildBudgetedResearchPrompt(
  question: string,
  retrieved: readonly RetrievedEvidence[],
): string {
  const selected = retrieved.map((item) => ({ ...item }));
  if (!selected.length)
    throw new GroundedAiError(422, "INSUFFICIENT_EVIDENCE", "No research evidence");

  for (let i = 0; i < 150; i += 1) {
    const prompt = buildGroundedPrompt(question, selected);
    if (estimateResearchInputTokens(prompt) <= RESEARCH_TOKEN_POLICY.maximumInput) {
      return prompt;
    }
    let longest = -1;
    let longestLength = RESEARCH_TOKEN_POLICY.minimumExcerptChars;
    for (let index = 0; index < selected.length; index += 1) {
      const length = selected[index]?.text.length ?? 0;
      if (length > longestLength) {
        longestLength = length;
        longest = index;
      }
    }
    if (longest >= 0) {
      const item = selected[longest]!;
      // Keep the beginning of each previously ranked evidence item.
      const newLength = Math.max(
        RESEARCH_TOKEN_POLICY.minimumExcerptChars,
        Math.floor(item.text.length * 0.8),
      );
      selected[longest] = { ...item, text: item.text.slice(0, newLength) };
      continue;
    }
    // Metadata/system/user prompt alone is too large. Remove the last ranked item
    // rather than passing a model prompt that exceeds our estimated budget.
    if (selected.length > 1) {
      selected.pop();
      continue;
    }
    break;
  }
  throw new GroundedAiError(
    422,
    "INSUFFICIENT_EVIDENCE",
    "Research question and source metadata exceed the token budget",
  );
}
