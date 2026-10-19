import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
    get: vi.fn(async (key: string) =>
      key === "anking/v12/full/topic-index-v1.json"
        ? { text: async () => JSON.stringify(index) }
        : null,
    ),
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
      cardIds: [],
      ankiQuery: "",
      total: 0,
      nextCursor: null,
    });
  });

  it("rejects unsupported cursor positions rather than reading arbitrary R2 keys", async () => {
    await expect(findMoreAnkingCards(bucket(), "aortic stenosis", 40001)).rejects.toThrow();
  });
});

/** Optional post-ingest smoke against the ACTUAL private full-v12 R2 topic index.
 * CI supplies SANTO_ANKING_TOPIC_INDEX_FILE after read-only R2 download.
 * No model/AI Search/API tokens, cards rendering, tenant session or quota.
 */
describe("full v12 real R2 topic results (CI opt-in)", () => {
  const file = process.env.SANTO_ANKING_TOPIC_INDEX_FILE;
  it.skipIf(!file)(
    "resolves real disease + management topics into original Anki CIDs",
    async () => {
      const raw = readFileSync(file!, "utf8");
      const store: R2BucketLike = {
        get: vi.fn(async (key: string) =>
          key === "anking/v12/full/topic-index-v1.json" ? { text: async () => raw } : null,
        ),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      };
      const samples = ["aortic stenosis", "treatment of aortic stenosis", "sarcoidosis"];
      const baseTopic = await findMoreAnkingCards(store, "aortic stenosis", 0);
      const treatmentTopic = await findMoreAnkingCards(store, "treatment of aortic stenosis", 0);
      expect(treatmentTopic.total).toBeLessThanOrEqual(baseTopic.total);
      for (const topic of samples) {
        const first = await findMoreAnkingCards(store, topic, 0);
        expect(first.total, topic).toBeGreaterThan(0);
        expect(first.cardIds.length, topic).toBeGreaterThan(0);
        expect(first.cardIds.length, topic).toBeLessThanOrEqual(20);
        expect(first.ankiQuery).toBe(first.cardIds.map((id) => `cid:${id}`).join(" OR "));
        const second =
          first.nextCursor !== null
            ? await findMoreAnkingCards(store, topic, first.nextCursor)
            : { cardIds: [] };
        expect(new Set([...first.cardIds, ...second.cardIds]).size).toBe(
          first.cardIds.length + second.cardIds.length,
        );
        console.info("REAL_ANKING_FIND_THE_CARD_TOPIC_PASSED", topic, "total=", first.total);
      }
      expect(store.put).not.toHaveBeenCalled();
    },
  );
});
