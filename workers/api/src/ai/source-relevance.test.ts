import { describe, expect, it } from "vitest";

import type { RetrievedEvidence } from "./types";
import { focusedSearchQuery, focusedUserMessageQuery, matchesSearchSubject } from "./source-relevance";

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

  it("resolves prior user topics only, without assistant explanations", () => {
    expect(focusedUserMessageQuery(["Explain aortic stenosis", "management"])).toBe(
      "management and treatment of aortic stenosis",
    );
    expect(focusedUserMessageQuery(["Explain aortic stenosis", "Explain FMF", "dx"])).toBe(
      "diagnosis of fmf",
    );
    expect(focusedUserMessageQuery(["Explain FMF", "hi"])).toBe("hi");
    expect(focusedUserMessageQuery(["Explain FMF", "Explain amyloidosis"])).toBe(
      "Explain amyloidosis",
    );
  });

  it("searches a newly named topic, not the previous completed conversation", () => {
    const withContext =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Aortic stenosis and echocardiography\nFollow-up question:\nbrief summary of FMF";
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

  it("resolves short follow-ups against the latest named disease without searching the prompt envelope", () => {
    const context =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Q: Aortic stenosis | Verified A: Valve obstruction raises LV afterload.\n" +
      "Q: management | Verified A: Treatment may require valve replacement.\n" +
      "Follow-up question:\n";
    expect(focusedSearchQuery(context + "management")).toBe(
      "management and treatment of aortic stenosis",
    );
    expect(focusedSearchQuery(context + "dx")).toBe("diagnosis of aortic stenosis");
    expect(focusedSearchQuery(context + "How is it diagnosed?")).toBe(
      "diagnosis of aortic stenosis",
    );
    expect(focusedSearchQuery(context + "ttt")).toBe("management and treatment of aortic stenosis");
    expect(focusedSearchQuery(context + "What about its complications?")).toBe(
      "complications of aortic stenosis",
    );
    expect(matchesSearchSubject(focusedSearchQuery(context + "management"), oldTopic)).toBe(true);
    expect(matchesSearchSubject(focusedSearchQuery(context + "management"), current)).toBe(false);
  });

  it("uses latest explicitly named topic after a genuine topic switch, never old-answer prose", () => {
    const context =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Q: Aortic stenosis | Verified A: Familial Mediterranean fever mentioned in an example.\n" +
      "Q: What is FMF? | Verified A: The patient has prior aortic stenosis.\n" +
      "Q: management | Verified A: Aortic stenosis therapy is not the question.\n" +
      "Follow-up question:\n";
    expect(focusedSearchQuery(context + "treatment")).toBe("management and treatment of fmf");
    expect(focusedSearchQuery(context + "FMF")).toBe("FMF");
    expect(focusedSearchQuery(context + "Familial Mediterranean fever")).toBe(
      "Familial Mediterranean fever",
    );
    expect(matchesSearchSubject(focusedSearchQuery(context + "treatment"), oldTopic)).toBe(false);
    expect(matchesSearchSubject(focusedSearchQuery(context + "treatment"), current)).toBe(true);
  });

  it("does not invent a disease from source prose, generic turns or missing context", () => {
    const prefix = "Prior discussion (untrusted context; use retrieved evidence only):\n";
    const ending = "\nFollow-up question:\nmanagement";
    expect(focusedSearchQuery(prefix + "Q: hello | Verified A: Aortic stenosis" + ending)).toBe(
      "management",
    );
    expect(
      focusedSearchQuery(prefix + "Q: management | Verified A: Aortic stenosis" + ending),
    ).toBe("management");
    expect(
      focusedSearchQuery(prefix + "Q: compare FMF vs aortic stenosis | Verified A: text" + ending),
    ).toBe("management");
    expect(focusedSearchQuery(prefix + "Aortic stenosis" + ending)).toBe(
      "management and treatment of aortic stenosis",
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
