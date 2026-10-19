import type { R2BucketLike } from "../runtime/bindings";

/** Completely independent copy-to-Anki CID search. Never calls AI Search,
 * Qwen, Luna, model tokens, chat quota, or reads/writes medical citations.
 * v12 index is built only from licensed original CID R2 shards.
 */
const INDEX_KEY = "anking/v12/full/topic-index-v1.json";
const PAGE_SIZE = 20;
const MAX_CURSOR = 40_000;
const INDEX_TTL_MS = 5 * 60_000;
const STOP = new Set(
  "a an and are be by can causes clinical common diagnosis disease does explain for from have how in is it its more most of on or please present presentation signs symptoms the their these this to what when which why with about all associated features following finding facts classic medicine topic cards card flashcards show give me plus".split(
    " ",
  ),
);

interface TopicIndex {
  version: number;
  notes: number;
  cards: number;
  topics: Record<string, number[]>;
  facts: Record<string, number[]>;
  card_ids: Record<string, number[]>;
}

const cache = new WeakMap<R2BucketLike, { expires: number; index: TopicIndex }>();
const flights = new WeakMap<R2BucketLike, Promise<TopicIndex>>();

async function topicIndex(bucket: R2BucketLike): Promise<TopicIndex> {
  const stored = cache.get(bucket);
  if (stored && stored.expires > Date.now()) return stored.index;
  const pending = flights.get(bucket);
  if (pending) return pending;
  const promise = (async () => {
    const file = await bucket.get(INDEX_KEY);
    if (!file) throw new Error("ANKING_V12_TOPIC_INDEX_NOT_READY");
    const raw: unknown = JSON.parse(await file.text());
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("INVALID_ANKING_TOPIC_INDEX");
    const data = raw as Partial<TopicIndex>;
    if (
      data.version !== 2 ||
      data.notes !== 30_477 ||
      data.cards !== 36_896 ||
      !data.topics ||
      !data.facts ||
      !data.card_ids ||
      typeof data.topics !== "object" ||
      typeof data.facts !== "object" ||
      typeof data.card_ids !== "object"
    )
      throw new Error("INVALID_ANKING_TOPIC_INDEX");
    const index = data as TopicIndex;
    cache.set(bucket, { expires: Date.now() + INDEX_TTL_MS, index });
    return index;
  })();
  flights.set(bucket, promise);
  try {
    return await promise;
  } finally {
    flights.delete(bucket);
  }
}

function terms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((word) => !STOP.has(word)),
    ),
  ].slice(0, 20);
}

function matchedNotes(index: TopicIndex, query: string): number[] {
  const tokens = terms(query);
  if (!tokens.length) return [];
  const score = new Map<number, number>();
  const matches = new Map<number, number>();
  for (const token of tokens) {
    const covered = new Set<number>();
    for (const [postings, weight] of [
      [index.topics, 8],
      [index.facts, 1],
    ] as const) {
      const ids = postings[token];
      // Prevent generic terms from swamping more specific disease concepts.
      if (!Array.isArray(ids) || ids.length > 20_000) continue;
      for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        score.set(id, (score.get(id) ?? 0) + weight);
        covered.add(id);
      }
    }
    for (const id of covered) matches.set(id, (matches.get(id) ?? 0) + 1);
  }
  // Prefer all disease terms: e.g. 'aortic stenosis' before single-token matches.
  const maxMatch = Math.max(0, ...matches.values());
  const minMatch = tokens.length > 1 ? Math.min(2, maxMatch) : 1;
  return [...score.entries()]
    .filter(([id]) => (matches.get(id) ?? 0) >= minMatch)
    .sort((a, b) => matches.get(b[0])! - matches.get(a[0])! || b[1] - a[1] || a[0] - b[0])
    .map(([id]) => id);
}

export interface FindMoreCardsResult {
  cardIds: number[];
  ankiQuery: string;
  nextCursor: number | null;
  total: number;
  normalizedTopic: string;
}

export async function findMoreAnkingCards(
  bucket: R2BucketLike,
  topic: string,
  cursor: number,
): Promise<FindMoreCardsResult> {
  // No translation model or query rewrite: a click must cost zero AI tokens.
  const normalizedTopic = topic.trim().slice(0, 250);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > MAX_CURSOR) {
    throw new Error("INVALID_ANKI_CURSOR");
  }
  const index = await topicIndex(bucket);
  const ranked = matchedNotes(index, normalizedTopic);
  const allIds: number[] = [];
  const seen = new Set<number>();
  for (const noteId of ranked) {
    const ids = index.card_ids[String(noteId)] ?? [];
    for (const cid of ids) {
      if (!Number.isSafeInteger(cid) || cid <= 0 || seen.has(cid)) continue;
      seen.add(cid);
      allIds.push(cid);
    }
  }
  const cardIds = allIds.slice(cursor, cursor + PAGE_SIZE);
  return {
    cardIds,
    ankiQuery: cardIds.map((id) => `cid:${id}`).join(" OR "),
    nextCursor: cursor + PAGE_SIZE < allIds.length ? cursor + PAGE_SIZE : null,
    total: allIds.length,
    normalizedTopic,
  };
}
