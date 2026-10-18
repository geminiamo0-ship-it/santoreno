import { describe, expect, it, vi } from "vitest";
import { findMoreAnkingCards } from "./anking-topic-finder";
import type { R2BucketLike } from "../runtime/bindings";

const n1 = 1471558916902;
const n2 = 1471558916903;
const cid1 = 1752612845008;
const cid2 = 1752612845009;

function testBucket(rights = "licensed_for_santo"): R2BucketLike {
  const index = {
    version: 1, notes: 4151, cards: 5156,
    topics: { aortic: [n1, n2], stenosis: [n1], mitral: [n2] },
    facts: { murmur: [n1, n2], systolic: [n1] },
  };
  const notes = [n1, n2].map((note_id, i) => ({
    note_id,
    medical_fact: i ? "Mitral regurgitation creates a murmur" : "Aortic stenosis creates a systolic murmur",
    clinical_pearl: i ? "Radiates to the axilla" : "Radiates to the carotids",
    rights_status: rights,
    review_status: "pending_expert_review",
    cards: [{
      card_id: i ? cid2 : cid1,
      cloze_number: 1,
      target_concepts: [i ? "mitral" : "aortic"],
      preview: i ? "Mitral [...] murmur" : "Aortic [...] murmur",
      anki_query: `cid:${i ? cid2 : cid1}`,
    }],
  }));
  return {
    get: vi.fn(async (key) => {
      if (key === "anking/v3/cardiology/topic-index-v1.json") {
        return { text: async () => JSON.stringify(index) };
      }
      const shard = /^anking\/v3\/cardiology\/shards\/shard_(\d{2})\.json$/.exec(key);
      if (shard) {
        return { text: async () => JSON.stringify(
          Object.fromEntries(notes.filter(n => n.note_id % 32 === Number(shard[1])).map(n => [`note_${n.note_id}`, n])),
        ) };
      }
      return null;
    }),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe("AnKing Find More from private R2 topic index", () => {
  it("ranks the exact topic, uses original CID, and includes Clinical Pearls only", async () => {
    const source = testBucket();
    const data = await findMoreAnkingCards(source, "aortic stenosis", 0, []);
    expect(data.cards.length).toBeGreaterThan(0);
    expect(data.cards[0]).toMatchObject({
      cardId: cid1, ankiQuery: `cid:${cid1}`, backText: "Aortic stenosis creates a systolic murmur",
      noteFields: [{ label: "Clinical Pearls", value: "Radiates to the carotids" }],
    });
    expect(data.nextCursor).toBeNull();
    expect(source.put).not.toHaveBeenCalled();
    expect(source.get).toHaveBeenCalledWith("anking/v3/cardiology/topic-index-v1.json");
  });

  it("excludes cards already suggested in the original Luna reply", async () => {
    const result = await findMoreAnkingCards(testBucket(), "aortic stenosis", 0, [cid1]);
    expect(result.cards.some(c => c.cardId === cid1)).toBe(false);
  });

  it("never exposes CID from rights-locked notes", async () => {
    const result = await findMoreAnkingCards(testBucket("unverified_rights_locked"), "aortic stenosis", 0, []);
    expect(result.cards).toEqual([]);
  });

  it("returns no cards for an unmatched topic", async () => {
    expect((await findMoreAnkingCards(testBucket(), "pneumothorax", 0, [])).cards).toEqual([]);
  });
});
