import type { GroundedAiSuggestedFlashcard } from "@santo/contracts/ai";
import type { R2BucketLike } from "../runtime/bindings";
import type { AnkingSearchHit } from "./types";

/**
 * AnKing is an optional, explicitly licensed exam-memory supplement.
 * It is NEVER a sixth clinical evidence/citation source.
 * Only R2-owned, rights-cleared and expert-approved records are eligible.
 */
export interface AnkingSupplement {
  cards: GroundedAiSuggestedFlashcard[];
  promptContext: string;
}

export interface AnkingSupplementRetriever {
  hydrate(hits: readonly AnkingSearchHit[], query: string): Promise<AnkingSupplement>;
}

interface CardRecord {
  card_id?: unknown;
  cloze_number?: unknown;
  target_concepts?: unknown;
  preview?: unknown;
  anki_query?: unknown;
}

interface NoteRecord {
  note_id?: unknown;
  primary_system?: unknown;
  topic?: unknown;
  medical_fact?: unknown;
  clinical_pearl?: unknown;
  rights_status?: unknown;
  review_status?: unknown;
  cards?: unknown;
}

const MAX_NOTES = 7;
const MAX_CARDS = 5;
const SHARD_PREFIX = "anking/v12/full/shards/";
const SHARD_COUNT = 128;
const SHARD_CACHE_MS = 5 * 60_000;
type Shard = Record<string, NoteRecord>;
const shardCache = new WeakMap<R2BucketLike, Map<number, { until: number; data: Shard }>>();
const shardFlights = new WeakMap<R2BucketLike, Map<number, Promise<Shard>>>();

async function loadShard(bucket: R2BucketLike, shard: number): Promise<Shard> {
  let cache = shardCache.get(bucket);
  if (!cache) {
    cache = new Map();
    shardCache.set(bucket, cache);
  }
  const stored = cache.get(shard);
  if (stored && stored.until > Date.now()) return stored.data;
  let flights = shardFlights.get(bucket);
  if (!flights) {
    flights = new Map();
    shardFlights.set(bucket, flights);
  }
  const existing = flights.get(shard);
  if (existing) return existing;
  const loading = (async (): Promise<Shard> => {
    const object = await bucket.get(`${SHARD_PREFIX}shard_${String(shard).padStart(3, "0")}.json`);
    if (!object) return {};
    const parsed = record(JSON.parse(await object.text()) as unknown);
    if (!parsed) return {};
    const checked: Shard = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (/^note_\d{10,16}$/.test(key)) {
        const row = record(value);
        if (row) checked[key] = row as NoteRecord;
      }
    }
    cache!.set(shard, { until: Date.now() + SHARD_CACHE_MS, data: checked });
    return checked;
  })();
  flights.set(shard, loading);
  try {
    return await loading;
  } finally {
    flights.delete(shard);
  }
}

const EMPTY: AnkingSupplement = { cards: [], promptContext: "" };
const IGNORE = new Set([
  "about",
  "from",
  "with",
  "have",
  "what",
  "which",
  "this",
  "that",
  "and",
  "the",
  "are",
  "for",
  "how",
  "does",
  "into",
  "when",
  "will",
  "their",
  "than",
  "give",
  "explain",
  "tell",
  "difference",
  "between",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !IGNORE.has(w)));
}

function overlap(query: Set<string>, text: string): number {
  const candidate = words(text);
  let count = 0;
  for (const term of query) if (candidate.has(term)) count++;
  return count;
}

function parseCard(raw: unknown): GroundedAiSuggestedFlashcard | null {
  const c = record(raw);
  if (!c) return null;
  const id = c.card_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (c.anki_query !== `cid:${id}`) return null;
  if (typeof c.preview !== "string" || !c.preview.trim()) return null;
  if (!Array.isArray(c.target_concepts)) return null;
  const targets = c.target_concepts.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (targets.length === 0) return null;
  return {
    cardId: id,
    ankiQuery: `cid:${id}`,
    focus: targets.join(", ").slice(0, 180),
    preview: c.preview.slice(0, 500),
  };
}

export class R2AnkingSupplementRetriever implements AnkingSupplementRetriever {
  constructor(private readonly bucket: R2BucketLike) {}

  async hydrate(hits: readonly AnkingSearchHit[], query: string): Promise<AnkingSupplement> {
    if (!hits.length) return EMPTY;
    const unique = [...new Set(hits.map((hit) => hit.noteId))]
      .filter((id) => /^note_\d{10,16}$/.test(id))
      .slice(0, MAX_NOTES);
    const notes = await Promise.all(
      unique.map(async (id) => {
        try {
          const number = Number(id.slice(5));
          return (await loadShard(this.bucket, number % SHARD_COUNT))[id] ?? null;
        } catch {
          return null;
        }
      }),
    );
    const queryTerms = words(query);
    const selected: GroundedAiSuggestedFlashcard[] = [];
    const facts: string[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < unique.length; i++) {
      const note = notes[i] as NoteRecord | null;
      if (!note || note.note_id !== Number(unique[i]!.slice(5))) continue;
      // Owner-cleared original Anki IDs may be suggested as flashcard navigation.
      // Unreviewed facts must NEVER enter Luna's clinical explanation prompt.
      if (note.rights_status !== "licensed_for_santo") continue;
      const medicalFact =
        typeof note.medical_fact === "string" ? note.medical_fact.slice(0, 420) : "";
      const pearl =
        typeof note.clinical_pearl === "string" ? note.clinical_pearl.slice(0, 220) : "";
      const topic = typeof note.topic === "string" ? note.topic.slice(0, 120) : "AnKing high-yield";
      if (!medicalFact || overlap(queryTerms, `${topic} ${medicalFact}`) === 0) continue;
      if (note.review_status === "approved") {
        facts.push(`- ${topic}: ${medicalFact}${pearl ? "; " + pearl : ""}`);
      }
      if (!Array.isArray(note.cards)) continue;
      for (const item of note.cards as unknown[]) {
        const card = parseCard(item);
        if (!card || seen.has(card.cardId)) continue;
        // Do not expose every card in the note. Prefer the exact cloze's topic/focus.
        if (overlap(queryTerms, `${topic} ${card.preview} ${card.focus}`) === 0) continue;
        seen.add(card.cardId);
        selected.push(card);
        if (selected.length >= MAX_CARDS) break;
      }
      if (selected.length >= MAX_CARDS) break;
    }
    if (!selected.length) return EMPTY;
    // Never tell Luna the raw card IDs; the backend adds them after generation.
    return {
      cards: selected,
      promptContext: facts.length
        ? "\nEXAM_MEMORY_ADJUNCTS (not independent medical citations):\n" +
          facts.slice(0, MAX_NOTES).join("\n").slice(0, 1800) +
          "\nUse these only as exam-recall context when consistent with the five cited clinical libraries; current diagnosis and treatment guidance comes from those verified sources. Do not cite these adjuncts or invent Anki IDs.\n"
        : "",
    };
  }
}
