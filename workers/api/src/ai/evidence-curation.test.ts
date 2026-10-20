import { describe, expect, it, vi } from "vitest";

import { CuratedEvidenceRetrieval, curateRetrievedEvidence } from "./evidence-curation";
import type { RetrievalPort, RetrievedEvidence } from "./types";

function source(
  sourceId: string,
  text: string,
  libraryId = "amboss",
  title = "Aortic stenosis",
): RetrievedEvidence {
  return {
    sourceId,
    text,
    libraryId,
    title,
    instanceId: libraryId,
    itemKey: `medical-search/v1/${libraryId}/book/${sourceId}.md`,
    section: null,
    page: null,
    score: 0.9,
  };
}

describe("Staging forward-all evidence curation", () => {
  it("dedupes literal imports but keeps excerpts with extra facts", () => {
    const pastestText =
      "# Aortic Stenosis\nLibrary: Pastest\nCategory: Cardiology\nSection: Clinical Presentation\n\n" +
      "Initially asymptomatic, aortic stenosis may cause exertional syncope and dyspnoea.";
    const common = "Clinical features of aortic stenosis: syncope, angina and dyspnoea.";
    const sources = [
      source("pastest:46", pastestText, "pastest"),
      source(
        "passmedicine:34",
        "# Aortic stenosis\nLibrary: PassMedicine\n" + common,
        "passmedicine",
      ),
      source("pastest:47", pastestText.replace(/\n/g, "\r\n"), "pastest"),
      source(
        "passmedicine:36",
        "# Aortic stenosis\nLibrary: PassMedicine\n" +
          common +
          "\nAdditional information about echo Doppler gradients.",
        "passmedicine",
      ),
    ];
    const kept = curateRetrievedEvidence("aortic stenosis in detail", sources);
    expect(kept.map((item) => item.sourceId)).toEqual([
      "pastest:46",
      "passmedicine:34",
      "passmedicine:36",
    ]);
    expect(kept[0]).toBe(sources[0]); // The original trusted source ID survives.
  });

  it("filters off-topic diseases but keeps relevant causes and AnKing", () => {
    const returned = [
      source(
        "amboss:1",
        "# Aortic stenosis\nLibrary: AMBOSS\nThe valve narrows and produces a systolic murmur.",
      ),
      source(
        "usmle:renal",
        "# Renal artery stenosis\nRenal artery narrowing causes resistant hypertension.",
        "usmle",
        "Renal artery stenosis",
      ),
      source(
        "amboss:dissection",
        "# Aortic dissection\nAcute aortic dissection may cause tearing chest pain.",
        "amboss",
        "Aortic dissection",
      ),
      source(
        "amboss:rheumatic",
        "# Acute rheumatic fever\nRheumatic heart disease can cause late aortic stenosis.",
        "amboss",
        "Acute rheumatic fever",
      ),
      source(
        "santo-anking-step-v12:note",
        "AnKing notes: aortic stenosis produces pulsus parvus et tardus.",
        "anking",
        "AnKing cardiovascular notes",
      ),
      source(
        "amboss:regurgitation",
        "# Aortic regurgitation\nIncomplete valve closure allows diastolic reflux.",
        "amboss",
        "Aortic regurgitation",
      ),
    ];
    const kept = curateRetrievedEvidence("Aortic stenosis in detail", returned);
    expect(kept.map((item) => item.sourceId)).toEqual([
      "amboss:1",
      "amboss:rheumatic",
      "santo-anking-step-v12:note",
    ]);
  });

  it("keeps 60 distinct relevant passages without a new top-k", () => {
    const sixty = Array.from({ length: 60 }, (_, index) =>
      source(
        `amboss:real-${index}`,
        `# Aortic stenosis\nSection: Clinical feature\nAortic stenosis evidence for independently verified finding ${index}.`,
      ),
    );
    const kept = curateRetrievedEvidence("aortic stenosis", sixty);
    expect(kept).toHaveLength(60);
    expect(kept.map((item) => item.sourceId)).toEqual(sixty.map((item) => item.sourceId));
  });

  it("does not guess the topic from an ambiguous acronym or generic prompt", () => {
    const result = [
      source("amboss:1", "# Aortic stenosis\nAortic stenosis."),
      source("usmle:1", "# Renal artery stenosis\nRenal artery stenosis.", "usmle"),
    ];
    expect(curateRetrievedEvidence("AS", result)).toEqual(result);
    expect(curateRetrievedEvidence("tell me", result)).toEqual(result);
  });

  it("uses current follow-up subject instead of the previous disease", () => {
    const old = source("amboss:old", "# Aortic stenosis\nAortic stenosis is obstructive.");
    const next = source("amboss:new", "# Familial Mediterranean fever\nFMF causes episodic fever.");
    const prompt =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Q: Aortic stenosis | Verified A: Obstructive valve disease.\n" +
      "Follow-up question:\nsummary of familial Mediterranean fever";
    expect(curateRetrievedEvidence(prompt, [old, next]).map((item) => item.sourceId)).toEqual([
      "amboss:new",
    ]);
  });

  it("preserves one search, optional route and gallery images", async () => {
    const data = [
      source("amboss:a", "# Aortic stenosis\nAortic stenosis causes obstruction."),
      source("usmle:bad", "# Renal artery stenosis\nRenal narrowing.", "usmle"),
    ];
    const retrieve = vi.fn(async () => data);
    const retrieveWithGallery = vi.fn(async () => ({
      evidence: data,
      galleryHits: [{ imageId: "img_000001", score: 0.91 }],
    }));
    const route = vi.fn(async () => ({
      intent: "medical" as const,
      searchQuery: "aortic stenosis",
    }));
    const original: RetrievalPort = { retrieve, retrieveWithGallery, route };
    const curated = new CuratedEvidenceRetrieval(original);
    const request = { query: "aortic stenosis", libraryId: null };
    expect((await curated.retrieve(request)).map((item) => item.sourceId)).toEqual(["amboss:a"]);
    expect(retrieve).toHaveBeenCalledTimes(1);
    const withGallery = await curated.retrieveWithGallery!(request);
    expect(withGallery.evidence.map((item) => item.sourceId)).toEqual(["amboss:a"]);
    expect(withGallery.galleryHits).toEqual([{ imageId: "img_000001", score: 0.91 }]);
    expect(retrieveWithGallery).toHaveBeenCalledTimes(1);
    expect(await curated.route!(request)).toEqual({
      intent: "medical",
      searchQuery: "aortic stenosis",
    });
    expect(route).toHaveBeenCalledTimes(1);
  });
});
