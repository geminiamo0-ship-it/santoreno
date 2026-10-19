import { describe, expect, it, vi } from "vitest";
import { findMoreAnkingCards } from "./anking-topic-finder";
import type { R2BucketLike } from "../runtime/bindings";

const base = 1471558916902;
const cid = 1752612845008;

function bucket(matches = 25): R2BucketLike {
  const noteIds = Array.from({ length: matches }, (_, i) => base + i);
  const index = {
    version: 2,
    notes: 30477,
    cards: 36896,
    topics: { aortic: noteIds, stenosis: noteIds, sarcoidosis: [] },
    facts: { treatment: [base + 1], diagnosis: [base + 2] },
    card_ids: Object.fromEntries(noteIds.map((id, i) => [String(id), [cid + i]])),
  };
  return {
    get: vi.fn(async (key: string) => key === "anking/v12/full/topic-index-v1.json"
      ? { text: async () => JSON.stringify(index) } : null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe("fully isolated original CID Find the Card search", () => {
  it("returns exact Anki Browser search queries, no generated flashcard text", async () => {
    const r2 = bucket(3);
    const result = await findMoreAnkingCards(r2, "aortic stenosis", 0);
    expect(result.cardIds).toEqual([cid, cid + 1, cid + 2]);
    expect(result.ankiQuery).toBe(`cid:${cid} OR cid:${cid + 1} OR cid:${cid + 2}`);
    expect(result.total).toBe(3);
    expect(result.nextCursor).toBeNull();
    expect(r2.get).toHaveBeenCalledTimes(1);
    expect(r2.get).toHaveBeenCalledWith("anking/v12/full/topic-index-v1.json");
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("paginates all CIDs with stable ordering, and no 5-card limit", async () => {
    const r2 = bucket(25);
    const first = await findMoreAnkingCards(r2, "aortic stenosis", 0);
    expect(first.cardIds).toHaveLength(20);
    expect(first.nextCursor).toBe(20);
    expect(first.total).toBe(25);
    const next = await findMoreAnkingCards(r2, "aortic stenosis", first.nextCursor!);
    expect(next.cardIds).toHaveLength(5);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.cardIds, ...next.cardIds]).size).toBe(25);
  });

  it("prioritizes the treatment subtopic and allows broader fallback", async () => {
    const preferred = await findMoreAnkingCards(bucket(3), "treatment of aortic stenosis", 0);
    expect(preferred.cardIds[0]).toBe(cid + 1);
    expect(preferred.total).toBe(3);
  });

  it("returns empty for unrelated topics without an AI query rewrite", async () => {
    expect(await findMoreAnkingCards(bucket(3), "sarcoidosis", 0)).toMatchObject({
      cardIds: [], ankiQuery: "", total: 0, nextCursor: null,
    });
  });

  it("rejects unsupported cursor positions rather than reading arbitrary R2 keys", async () => {
    await expect(findMoreAnkingCards(bucket(), "aortic stenosis", 40001)).rejects.toThrow();
  });
});
