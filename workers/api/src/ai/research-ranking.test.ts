import { describe, expect, it } from "vitest";

import {
  guidelineSearchQuery,
  mergePubMedCandidateIds,
  rankResearchPapers,
  researchTopicWords,
  type ResearchPaper,
} from "./research-ranking";

const paper = (
  pmid: string,
  title: string,
  abstract: string,
  types: string[],
  year = 2025,
  position = 0,
): ResearchPaper => ({
  pmid,
  pmcid: null,
  doi: null,
  title,
  abstract,
  types,
  year,
  position,
  score: 0,
  citations: null,
});

describe("PubMed clinical-guideline-first research ranking", () => {
  it("builds one PubMed publication-type guideline search with the resolved topic", () => {
    const query = guidelineSearchQuery("severe aortic stenosis diagnosis and management");
    expect(query).toContain("(aortic stenosis)");
    expect(query).toContain("Practice Guideline[pt]");
    expect(query).toContain("Guideline[pt]");
    expect(query).toContain("guideline[ti]");
    expect(query).not.toContain("management)");
    expect(researchTopicWords("aortic stenosis management treatment")).toEqual([
      "aortic",
      "stenosis",
    ]);
  });

  it("reserves actual guideline PMIDs even if the broad primary call filled 60 hits", () => {
    const primary = Array.from({ length: 60 }, (_, index) => String(1000 + index));
    const guidelines = [
      primary[3]!,
      ...Array.from({ length: 28 }, (_, index) => String(4000 + index)),
    ];
    const merged = mergePubMedCandidateIds(primary, guidelines);
    expect(merged).toHaveLength(60);
    expect(new Set(merged).size).toBe(60);
    expect(merged).toContain("4000");
    expect(merged).toContain("4019");
    expect(merged).toContain("1000");
  });

  it("promotes a relevant clinical guideline over a new polygenic risk study", () => {
    const ranked = rankResearchPapers(
      [
        paper(
          "10",
          "Novel Polygenic Risk Score for Aortic Stenosis",
          "Aortic stenosis prediction by genetic risk profile.",
          ["Randomized Controlled Trial"],
          2026,
          0,
        ),
        paper(
          "20",
          "Clinical practice guideline on diagnosis and management of aortic stenosis",
          "Evidence based recommendations for diagnosis, severity and treatment of aortic stenosis.",
          ["Practice Guideline"],
          2021,
          20,
        ),
        paper(
          "30",
          "Aortic stenosis: clinical diagnosis and treatment overview",
          "Diagnosis and treatment of aortic stenosis are reviewed.",
          ["Review"],
          2024,
          2,
        ),
      ],
      "aortic stenosis management",
    );
    expect(ranked[0]?.pmid).toBe("20");
    expect(ranked[1]?.pmid).toBe("30");
    expect(ranked.at(-1)?.pmid).toBe("10");
  });

  it("excludes wrong-disease aortic regurgitation without hiding relevant comparative evidence", () => {
    const ranked = rankResearchPapers(
      [
        paper(
          "1",
          "Transcatheter implantation for aortic regurgitation",
          "Isolated aortic regurgitation was treated with a dedicated prosthesis.",
          ["Clinical Trial"],
          2026,
        ),
        paper(
          "2",
          "Comparing aortic stenosis and aortic regurgitation interventions",
          "Aortic stenosis and regurgitation have distinct management pathways.",
          ["Review"],
          2023,
        ),
        paper(
          "3",
          "Diagnosis and management of aortic stenosis",
          "Aortic stenosis is classified by echocardiography.",
          ["Guideline"],
          2025,
        ),
      ],
      "aortic stenosis",
    );
    expect(ranked.map((item) => item.pmid)).not.toContain("1");
    expect(ranked.map((item) => item.pmid)).toEqual(expect.arrayContaining(["2", "3"]));
  });

  it("prefers diagnosis and management coverage to repetitive niche risk papers", () => {
    const clinical = [
      paper(
        "g",
        "Aortic stenosis management guidelines",
        "Aortic stenosis treatment",
        ["Guideline"],
        2021,
      ),
      paper(
        "d",
        "Aortic stenosis echocardiography and severity assessment",
        "Aortic stenosis diagnosis",
        ["Review"],
        2023,
      ),
      paper(
        "t",
        "Aortic stenosis valve replacement and intervention",
        "Aortic stenosis treatment",
        ["Clinical Trial"],
        2024,
      ),
    ];
    const narrow = Array.from({ length: 8 }, (_, i) =>
      paper(
        "r" + i,
        "Polygenic risk prediction in aortic stenosis cohort " + i,
        "Genetic factors in aortic stenosis risk prediction",
        ["Journal Article"],
        2026,
        i,
      ),
    );
    const ranked = rankResearchPapers([...narrow, ...clinical], "aortic stenosis");
    expect(ranked.slice(0, 5).map((item) => item.pmid)).toEqual(
      expect.arrayContaining(["g", "d", "t"]),
    );
    expect(
      ranked.slice(0, 5).filter((item) => item.pmid.startsWith("r")).length,
    ).toBeLessThanOrEqual(2);
  });

  it("does not mislabel article titles about guidelines as PubMed Practice Guideline types", () => {
    const ranked = rankResearchPapers(
      [
        paper(
          "a",
          "Commentary on aortic stenosis guidelines",
          "Discussion of the aortic stenosis guidelines",
          ["Journal Article"],
          2026,
        ),
        paper(
          "b",
          "Aortic stenosis clinical practice recommendations",
          "Clinical guidance for aortic stenosis",
          ["Practice Guideline"],
          2024,
        ),
      ],
      "aortic stenosis",
    );
    expect(ranked[0]?.pmid).toBe("b");
    expect(ranked[0]?.types).toEqual(["Practice Guideline"]);
  });

  it("finds disease-matched official valve guidelines via PubMed keywords without an abstract", () => {
    const guideline = paper(
      "40878295",
      "2025 ESC/EACTS Guidelines for the management of valvular heart disease",
      "",
      ["Practice Guideline"],
      2025,
      14,
    );
    guideline.subjectTerms = ["Aortic stenosis", "TAVI", "valvular heart disease"];
    const ranked = rankResearchPapers(
      [
        paper(
          "10",
          "Aortic stenosis polygenic risk score",
          "Genetic risk in aortic stenosis.",
          ["Journal Article"],
          2026,
        ),
        guideline,
      ],
      "aortic stenosis",
    );
    expect(ranked[0]?.pmid).toBe("40878295");
  });

  it("fails closed on unrelated topics or retracted records", () => {
    expect(
      rankResearchPapers(
        [
          paper(
            "1",
            "Pulmonary arterial hypertension clinical guidelines",
            "Pulmonary hypertension management",
            ["Guideline"],
            2026,
          ),
          paper(
            "2",
            "Retracted guideline for aortic stenosis",
            "Aortic stenosis management",
            ["Guideline", "Retraction of Publication"],
            2025,
          ),
        ],
        "aortic stenosis",
      ),
    ).toEqual([]);
  });
});
