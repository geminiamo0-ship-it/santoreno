import type { GroundedAiSuggestedFlashcard } from "@santo/contracts/ai";
import type { R2BucketLike, WorkersAiLike } from "../runtime/bindings";
import { loadShard, parseCard, studyNoteFields, type NoteRecord } from "./anking-flashcards";
import { rewriteMedicalSearchQuery } from "./medical-query-rewrite";

/** A topic->original-note-ID lookup stored as ONE private R2 object, not a new AI Search. */
const INDEX_KEY = "anking/v3/cardiology/topic-index-v1.json";
const MAX_CANDIDATES = 130;
const PAGE_SIZE = 10;
const INDEX_TTL_MS = 5 * 60_000;
const STOP = new Set(
  "a an and are be by can causes clinical common diagnosis disease does explain for from have how in is it its more most of on or please present presentation signs symptoms the their these this to treatment what when which why with about all associated features following finding facts classic medicine topic cards card flashcards show give me plus".split(
    " ",
  ),
);
interface TopicIndex {
  version: number;
  notes: number;
  cards: number;
  topics: Record<string, number[]>;
  facts: Record<string, number[]>;
}
const cache = new WeakMap<R2BucketLike, { expires: number; index: TopicIndex }>();
const flights = new WeakMap<R2BucketLike, Promise<TopicIndex>>();

async function topicIndex(bucket: R2BucketLike): Promise<TopicIndex> {
  const cached = cache.get(bucket);
  if (cached && cached.expires > Date.now()) return cached.index;
  const pending = flights.get(bucket);
  if (pending) return pending;
  const promise = (async () => {
    const object = await bucket.get(INDEX_KEY);
    if (!object) throw new Error("ANKING_TOPIC_INDEX_NOT_READY");
    const parsed: unknown = JSON.parse(await object.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("INVALID_ANKING_TOPIC_INDEX");
    const raw = parsed as Partial<TopicIndex>;
    if (
      raw.version !== 1 ||
      raw.notes !== 4151 ||
      raw.cards !== 5156 ||
      !raw.topics ||
      !raw.facts ||
      typeof raw.topics !== "object" ||
      typeof raw.facts !== "object"
    )
      throw new Error("INVALID_ANKING_TOPIC_INDEX");
    const index = raw as TopicIndex;
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
  ].slice(0, 16);
}

function rankedNotes(index: TopicIndex, query: string): number[] {
  const tokens = terms(query);
  const score = new Map<number, number>();
  for (const token of tokens) {
    for (const [map, weight] of [
      [index.topics, 5],
      [index.facts, 1],
    ] as const) {
      const ids = map[token];
      if (!Array.isArray(ids)) continue;
      // An unhelpfully broad tag must not swamp disease-specific matches.
      if (ids.length > 2500) continue;
      for (const id of ids) {
        if (Number.isSafeInteger(id) && id > 0) score.set(id, (score.get(id) ?? 0) + weight);
      }
    }
  }
  return [...score]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_CANDIDATES)
    .map(([id]) => id);
}

export interface FindMoreCardsResult {
  cards: GroundedAiSuggestedFlashcard[];
  nextCursor: number | null;
  normalizedTopic: string;
}

export async function findMoreAnkingCards(
  bucket: R2BucketLike,
  topic: string,
  cursor: number,
  excluded: readonly number[],
  ai?: WorkersAiLike,
): Promise<FindMoreCardsResult> {
  // Qwen, when available, only translates Arabic on the FIRST Find More click.
  // Following pages reuse normalizedTopic; no second model invocation.
  const normalizedTopic =
    cursor === 0 && /[\u0600-\u06ff]/u.test(topic)
      ? await rewriteMedicalSearchQuery(ai, topic, topic)
      : topic;
  const index = await topicIndex(bucket);
  const ranked = rankedNotes(index, normalizedTopic);
  if (!ranked.length) return { cards: [], nextCursor: null, normalizedTopic };
  const noteIds = ranked.map((id) => `note_${id}`);
  // Only existing private R2 shards; IDs must have come from our source-verified index.
  const shardIds = [...new Set(ranked.map((id) => id % 32))];
  const shards = new Map(
    await Promise.all(shardIds.map(async (id) => [id, await loadShard(bucket, id)] as const)),
  );
  const ignore = new Set(excluded);
  const cards: GroundedAiSuggestedFlashcard[] = [];
  const seen = new Set<number>();
  for (let n = 0; n < ranked.length; n++) {
    const note = shards.get(ranked[n]! % 32)?.[noteIds[n]!] as NoteRecord | undefined;
    if (!note || note.note_id !== ranked[n] || note.rights_status !== "licensed_for_santo")
      continue;
    const backText = typeof note.medical_fact === "string" ? note.medical_fact.slice(0, 2500) : "";
    if (!backText) continue;
    if (!Array.isArray(note.cards)) continue;
    for (const raw of note.cards) {
      const card = parseCard(raw);
      if (!card || ignore.has(card.cardId) || seen.has(card.cardId)) continue;
      seen.add(card.cardId);
      cards.push({
        ...card,
        backText,
        noteFields: studyNoteFields(note),
      });
    }
  }
  const page = cards.slice(cursor, cursor + PAGE_SIZE);
  return {
    cards: page,
    nextCursor: cursor + PAGE_SIZE < cards.length ? cursor + PAGE_SIZE : null,
    normalizedTopic,
  };
}
