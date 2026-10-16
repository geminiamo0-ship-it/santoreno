import { describe, expect, it } from "vitest";
import type { RetrievedEvidence } from "./types";
import { rankMedicalCandidates, type RankedCandidate } from "./medical-ranking";

function candidate(
  id: string,
  title: string,
  section: string,
  text: string,
  position: number,
  article = id,
  instanceId = "amboss",
): RankedCandidate {
  const evidence: RetrievedEvidence = {
    sourceId: instanceId + ":" + id,
    libraryId: instanceId,
    instanceId,
    itemKey: article + ".html",
    title,
    section,
    text,
    page: null,
    score: 0.95,
  };
  return { evidence, position };
}

describe("Medical Retrieval v2 cross-library ranking", () => {
  it("preserves Cloudflare reranker priority without lexical overrides", () => {
    const candidates = [
      candidate(
        "unrelated-heart-failure",
        "Aortic stenosis",
        "Clinical complications",
        "Aortic stenosis can cause cardiogenic shock and heart failure.",
        0,
      ),
      candidate(
        "mechanism",
        "Aortic stenosis",
        "Pathophysiology",
        "Aortic stenosis: the stenotic valve increases left ventricular pressure overload.",
        8,
      ),
    ];
    expect(rankMedicalCandidates("Aortic stenosis mechanism", candidates)[0]?.sourceId).toBe(
      "amboss:unrelated-heart-failure",
    );
  });

  it("does not apply a disease-word hard gate after native reranking", () => {
    const candidates = [
      candidate("valve", "Aortic stenosis", "TAVR", "Aortic stenosis diagnosis", 0),
      candidate(
        "fmf",
        "Familial Mediterranean fever",
        "Mechanism",
        "Familial Mediterranean fever, an autoinflammatory disorder caused by MEFV variants.",
        9,
      ),
    ];
    expect(rankMedicalCandidates("FMF", candidates).map((x) => x.sourceId)).toEqual(["amboss:valve", "amboss:fmf"]);
  });

  it("caps repeated chunks from one article and never manufactures identifiers", () => {
    const candidates = Array.from({ length: 5 }, (_, position) =>
      candidate(
        "chunk-" + position,
        "Aortic stenosis",
        position === 0 ? "Mechanism" : "Pathophysiology",
        "Aortic stenosis causes ventricular pressure overload.",
        position,
        "same-article",
      ),
    );
    const ranked = rankMedicalCandidates("Aortic stenosis mechanism", candidates);
    expect(ranked).toHaveLength(1);
    expect(ranked.every((x) => candidates.some((a) => a.evidence.sourceId === x.sourceId))).toBe(
      true,
    );
  });

  it("does not compare raw similarity scores between separate libraries", () => {
    const a = candidate(
      "a",
      "Familial Mediterranean fever",
      "Pathophysiology",
      "Familial Mediterranean fever is an autoinflammatory syndrome.",
      0,
    );
    a.evidence.score = 0.41;
    const b = candidate(
      "b",
      "Familial Mediterranean fever",
      "Pathophysiology",
      "Familial Mediterranean fever is an autoinflammatory syndrome.",
      7,
      "b",
      "usmle",
    );
    b.evidence.score = 0.99;
    expect(rankMedicalCandidates("Familial Mediterranean fever", [b, a])[0]?.sourceId).toBe(
      "amboss:a",
    );
  });
});
