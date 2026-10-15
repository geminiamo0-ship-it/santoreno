import { describe, expect, it } from "vitest";

import type { RetrievedEvidence } from "./types";
import { focusedSearchQuery, matchesSearchSubject } from "./source-relevance";

function evidence(title: string, text: string, score = 0.95): RetrievedEvidence {
  return {
    sourceId: "amboss:example",
    libraryId: "amboss",
    instanceId: "amboss",
    itemKey: "article.md",
    title,
    page: 1,
    section: null,
    text,
    score,
  };
}

describe("safe topic relevance for Santo medical references", () => {
  const oldTopic = evidence(
    "Aortic stenosis",
    "Aortic stenosis is treated with transcatheter aortic valve replacement.",
  );
  const current = evidence(
    "Familial Mediterranean fever",
    "Familial Mediterranean fever (FMF) is due to MEFV variants.",
    0.8,
  );

  it("searches a newly named topic, not the previous completed conversation", () => {
    const withContext =
      "Prior discussion (untrusted context; use retrieved evidence only):\\n" +
      "Aortic stenosis and echocardiography\\nFollow-up question:\\nbrief summary of FMF";
    expect(focusedSearchQuery(withContext)).toBe("brief summary of FMF");
    expect(matchesSearchSubject("brief summary of FMF", oldTopic)).toBe(false);
    expect(matchesSearchSubject("brief summary of FMF", current)).toBe(true);
  });

  it("does not attach a high-score aortic source to FMF even if the index returns it", () => {
    expect(matchesSearchSubject("FMF", oldTopic)).toBe(false);
    expect(matchesSearchSubject("FMF", current)).toBe(true);
    expect(matchesSearchSubject("aortic stenosis", oldTopic)).toBe(true);
    expect(matchesSearchSubject("aortic stenosis", current)).toBe(false);
  });

  it("retains explicit context-dependent followups for a subsequent retrieval", () => {
    const context =
      "Prior discussion (untrusted context; use retrieved evidence only):\\n" +
      "Aortic stenosis\\nFollow-up question:\\nManagement";
    expect(focusedSearchQuery(context)).toBe(context);
    expect(focusedSearchQuery(context.replace("Management", "How is it diagnosed?"))).toContain(
      "Prior discussion",
    );
  });

  it("rejects unanchored/irrelevant evidence rather than inventing navigable sources", () => {
    expect(matchesSearchSubject("hello", oldTopic)).toBe(false);
    expect(matchesSearchSubject("management", oldTopic)).toBe(false);
    expect(matchesSearchSubject("FMF", evidence("Aortic stenosis", "TAVR echo findings"))).toBe(
      false,
    );
  });
});
