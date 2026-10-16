import { describe, expect, it } from "vitest";

import { expandMedicalSearchQuery } from "./medical-query-expansion";

describe("MeSH-backed controlled medical query expansion pilot", () => {
  it("adds one MeSH-verified alternative for aortic stenosis without changing the clinical intent", () => {
    expect(expandMedicalSearchQuery("management and treatment of aortic stenosis")).toEqual({
      query: "management and treatment of aortic stenosis aortic valve stenosis",
      expanded: true,
    });
    expect(expandMedicalSearchQuery("severe asymptomatic aortic stenosis diagnosis")).toEqual({
      query: "severe asymptomatic aortic stenosis diagnosis aortic valve stenosis",
      expanded: true,
    });
  });

  it("uses a reviewed unambiguous FMF expansion and avoids multiple aliases", () => {
    expect(expandMedicalSearchQuery("management of fmf")).toEqual({
      query: "management of fmf familial mediterranean fever",
      expanded: true,
    });
    expect(expandMedicalSearchQuery("Familial Mediterranean fever")).toEqual({
      query: "Familial Mediterranean fever",
      expanded: false,
    });
    expect(expandMedicalSearchQuery("Aortic valve stenosis")).toEqual({
      query: "Aortic valve stenosis",
      expanded: false,
    });
  });

  it("never expands a two-condition question or differential comparison", () => {
    const two = "Compare aortic stenosis and familial Mediterranean fever";
    expect(expandMedicalSearchQuery(two)).toEqual({ query: two, expanded: false });
    const differential = "Aortic stenosis vs hypertrophic cardiomyopathy";
    expect(expandMedicalSearchQuery(differential)).toEqual({
      query: differential,
      expanded: false,
    });
  });

  it("never uses ambiguous acronyms or adds a topic without an exact verified match", () => {
    for (const query of ["AS", "MI", "management", "atrial stenosis", "unknown condition"]) {
      expect(expandMedicalSearchQuery(query)).toEqual({ query, expanded: false });
    }
    const long = "severe asymptomatic aortic stenosis " + "clinical ".repeat(50);
    expect(expandMedicalSearchQuery(long)).toEqual({ query: long, expanded: false });
  });

  it("respects whole phrases, ignores punctuation and never invents TAVR or treatment claims", () => {
    const query = "What is the management of aortic stenosis?";
    const expansion = expandMedicalSearchQuery(query);
    expect(expansion.expanded).toBe(true);
    expect(expansion.query).toContain("aortic valve stenosis");
    expect(expansion.query).not.toMatch(/TAVR|SAVR|valve replacement/i);
    expect(expandMedicalSearchQuery("not-aortic stenosis")).toEqual({
      query: "not-aortic stenosis aortic valve stenosis",
      expanded: true,
    });
  });
});
