import { describe, expect, it, vi } from "vitest";
import { R2AnkingSupplementRetriever } from "./anking-flashcards";
import type { R2BucketLike } from "../runtime/bindings";

const noteId = 1471558916902;
const cardId = 1752612845008;
const hits = [{ noteId: `note_${noteId}`, score: 0.91 }];
const valid = {
  note_id: noteId,
  topic: "Aortic stenosis",
  medical_fact: "Aortic stenosis causes a crescendo-decrescendo systolic murmur",
  clinical_pearl: "Radiates toward the carotids",
  rights_status: "licensed_for_santo",
  review_status: "approved",
  cards: [
    {
      card_id: cardId,
      cloze_number: 1,
      target_concepts: ["stenosis"],
      preview: "Aortic [...] causes a systolic murmur",
      anki_query: `cid:${cardId}`,
    },
  ],
};

function source(data: unknown): R2BucketLike {
  return {
    get: vi.fn(async () => ({ text: async () => JSON.stringify({ [`note_${noteId}`]: data }) })),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe("rights-locked AnKing suggestions", () => {
  it("does not expose V3 unlicensed content even when search returns matching hits", async () => {
    const bucket = source({ ...valid, rights_status: "unverified_rights_locked" });
    const result = await new R2AnkingSupplementRetriever(bucket).hydrate(hits, "aortic stenosis");
    expect(result).toEqual({ cards: [], promptContext: "" });
  });

  it("does not expose content until medical review is approved", async () => {
    const result = await new R2AnkingSupplementRetriever(
      source({ ...valid, review_status: "pending_expert_review" }),
    ).hydrate(hits, "aortic stenosis");
    expect(result.cards).toEqual([]);
  });

  it("only returns a canonical original CID from the approved R2 record", async () => {
    const bucket = source(valid);
    const result = await new R2AnkingSupplementRetriever(bucket).hydrate(hits, "aortic stenosis");
    expect(result.cards).toEqual([
      {
        cardId,
        ankiQuery: `cid:${cardId}`,
        focus: "stenosis",
        preview: "Aortic [...] causes a systolic murmur",
      },
    ]);
    expect(result.promptContext).toContain("EXAM_MEMORY_ADJUNCTS");
    expect(result.promptContext).not.toContain(String(cardId));
    expect(bucket.get).toHaveBeenCalledWith(`anking/v3/cardiology/notes/note_${noteId}.json`);
  });

  it("rejects fabricated or mismatched IDs rather than repairing them", async () => {
    const result = await new R2AnkingSupplementRetriever(
      source({
        ...valid,
        cards: [
          { ...valid.cards[0], anki_query: "cid:1234567891011" },
          { ...valid.cards[0], card_id: Number.MAX_SAFE_INTEGER + 1 },
        ],
      }),
    ).hydrate(hits, "aortic stenosis");
    expect(result.cards).toEqual([]);
  });

  it("does not return a non-matching cloze or content for irrelevant hits", async () => {
    const result = await new R2AnkingSupplementRetriever(source(valid)).hydrate(
      hits,
      "unrelated pneumonia pathogen",
    );
    expect(result.cards).toEqual([]);
    expect(result.promptContext).toBe("");
  });

  it("returns empty on missing records, malformed data and invalid note key", async () => {
    const bucket: R2BucketLike = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    expect(
      await new R2AnkingSupplementRetriever(bucket).hydrate(
        [...hits, { noteId: "note_../../secret", score: 1 }],
        "aortic stenosis",
      ),
    ).toEqual({ cards: [], promptContext: "" });
  });
});
