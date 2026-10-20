import { describe, expect, it } from "vitest";
import {
  buildBudgetedResearchPrompt,
  estimateResearchInputTokens,
  RESEARCH_TOKEN_POLICY,
} from "./research-budget";
import type { RetrievedEvidence } from "./types";

function item(index: number, chars = 3000): RetrievedEvidence {
  return {
    sourceId: "pubmed:" + (10000 + index),
    libraryId: "pubmed",
    instanceId: "pubmed",
    itemKey: "pmid:" + (10000 + index),
    title: "Published aortic stenosis trial " + index,
    page: null,
    section: "PubMed / PMC PMC" + (12345 + index),
    text: "Evidence from this study about aortic stenosis. ".repeat(Math.ceil(chars / 48)),
    score: 1 - index / 50,
  };
}

describe("Research token preflight", () => {
  it("keeps a useful short prompt and identifiable citations", () => {
    const result = buildBudgetedResearchPrompt("Aortic stenosis therapy", [item(1, 400)]);
    expect(result).toContain("pubmed:10001");
    expect(result).toContain("Aortic stenosis therapy");
    expect(estimateResearchInputTokens(result)).toBeLessThanOrEqual(7000);
  });
  it("adapts long evidence to 10k total including 3k output reserved", () => {
    const articles = Array.from({ length: 12 }, (_, i) => item(i, 3000));
    const prompt = buildBudgetedResearchPrompt(
      "Compare interventions for severe aortic stenosis",
      articles,
    );
    expect(estimateResearchInputTokens(prompt)).toBeLessThanOrEqual(
      RESEARCH_TOKEN_POLICY.maximumInput,
    );
    expect(prompt).toContain("pubmed:10000");
    expect(prompt).toContain("USER_QUESTION_JSON");
    expect(prompt).not.toContain("undefined");
  });
  it("fails closed on excessive required user/query/context bytes", () => {
    expect(() => buildBudgetedResearchPrompt("س".repeat(4000), [item(0, 400)])).toThrowError(
      "Research question and source metadata exceed the token budget",
    );
  });
});
