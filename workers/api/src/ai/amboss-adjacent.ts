import type { R2BucketLike } from "../runtime/bindings";
import type {
  CombinedSearchResult,
  RetrievalPort,
  RetrievalRequest,
  RetrievedEvidence,
} from "./types";

// A search section is one independent R2 object, not a neighboring chunk in
// the same AI Search item. Only approved AMBOSS keys may be expanded.
const AMBOSS_SECTION_KEY = /^medical-search\/v1\/amboss\/[a-zA-Z0-9_-]+\/s-(\d{4})\.md$/;
const ADJACENT_FILES = 10;
const MAX_TOTAL_EVIDENCE = 60;
const LEGACY_MAX_TOTAL_EVIDENCE = 15;
const MAX_SECTION_CHARS = 3500;
const MAX_R2_SECTION_CHARS = 100_000;

function sectionMetadata(text: string): { title: string; section: string } | null {
  const title = /^# ([^\r\n]{1,500})\r?$/m.exec(text)?.[1]?.trim();
  const library = /^Library:\s*AMBOSS\s*$/m.test(text);
  const section = /^Section:\s*(.{1,500})\r?$/m.exec(text)?.[1]?.trim();
  return title && library && section ? { title, section } : null;
}

async function sourceIdForObject(instanceId: string, key: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
  const id = Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("");
  // Server-verified private-R2 identity. No model-generated ID or public URL.
  return instanceId + ":r2-" + id.slice(0, 32);
}

/** Preserve all five original search results; add at most ten neighboring AMBOSS sections. */
export async function expandAmbossAdjacentEvidence(
  original: readonly RetrievedEvidence[],
  bucket: Pick<R2BucketLike, "get">,
): Promise<RetrievedEvidence[]> {
  const anchor = original.find(
    (item) => item.libraryId === "amboss" && AMBOSS_SECTION_KEY.test(item.itemKey),
  );
  // Original short retrieval keeps its 15-source behavior. In the all-hits
  // staging trial, never truncate a 16–50-hit search response.
  const evidenceCap =
    original.length > LEGACY_MAX_TOTAL_EVIDENCE ? MAX_TOTAL_EVIDENCE : LEGACY_MAX_TOTAL_EVIDENCE;
  if (!anchor || original.length >= evidenceCap) {
    return [...original];
  }
  const match = AMBOSS_SECTION_KEY.exec(anchor.itemKey);
  if (!match) return [...original];
  const firstNumber = Number(match[1]);
  if (!Number.isSafeInteger(firstNumber) || firstNumber < 1 || firstNumber > 9989) {
    return [...original];
  }

  const folder = anchor.itemKey.slice(0, anchor.itemKey.lastIndexOf("/") + 1);
  const initialTitle = /^# ([^\r\n]+)\r?$/m.exec(anchor.text)?.[1]?.trim();
  const existing = new Map(original.map((item) => [item.itemKey, item]));
  const additional: RetrievedEvidence[] = [];

  // Ten sequential awaited R2 gets added network round trips before Luna
  // could emit its first token. Prefetch the same ten SAME-ARTICLE keys
  // concurrently, then consume IN ORDER and stop at the first missing,
  // invalid or mismatched section. Do not widen retrieval or change citations.
  const neighbors = await Promise.all(
    Array.from(
      { length: Math.min(ADJACENT_FILES, evidenceCap - original.length) },
      async (_, index) => {
        const key = folder + "s-" + String(firstNumber + index + 1).padStart(4, "0") + ".md";
        const alreadyRetrieved = existing.get(key);
        if (alreadyRetrieved) return { key, alreadyRetrieved, raw: null as string | null };
        try {
          const object = await bucket.get(key);
          return { key, alreadyRetrieved: undefined, raw: object ? await object.text() : null };
        } catch {
          return { key, alreadyRetrieved: undefined, raw: null };
        }
      },
    ),
  );
  for (const { key, alreadyRetrieved, raw } of neighbors) {
    if (alreadyRetrieved) {
      additional.push(alreadyRetrieved);
      continue;
    }
    if (!raw || raw.length > MAX_R2_SECTION_CHARS) break;
    const metadata = sectionMetadata(raw);
    if (!metadata || (initialTitle && initialTitle !== metadata.title)) break;
    additional.push({
      sourceId: await sourceIdForObject(anchor.instanceId, key),
      libraryId: "amboss",
      instanceId: anchor.instanceId,
      itemKey: key,
      title: metadata.title,
      page: null,
      section: metadata.section,
      text: raw.slice(0, MAX_SECTION_CHARS),
      score: 0,
    });
  }

  const added = new Set<string>();
  const result: RetrievedEvidence[] = [];
  for (const item of original) {
    if (added.has(item.itemKey)) continue;
    result.push(item);
    added.add(item.itemKey);
    if (item === anchor) {
      for (const adjacent of additional) {
        if (added.has(adjacent.itemKey)) continue;
        result.push(adjacent);
        added.add(adjacent.itemKey);
      }
    }
  }
  return result.slice(0, evidenceCap);
}

/** Preserve existing query routing and gallery retrieval; no extra AI Search calls. */
export class AmbossAdjacentRetrieval implements RetrievalPort {
  readonly route?: RetrievalPort["route"];
  readonly retrieveWithGallery?: RetrievalPort["retrieveWithGallery"];

  constructor(
    private readonly original: RetrievalPort,
    private readonly bucket: Pick<R2BucketLike, "get">,
  ) {
    this.route = original.route ? (request) => original.route!(request) : undefined;
    this.retrieveWithGallery = original.retrieveWithGallery
      ? async (request): Promise<CombinedSearchResult> => {
          const result = await original.retrieveWithGallery!(request);
          return {
            ...result,
            evidence: await expandAmbossAdjacentEvidence(result.evidence, this.bucket),
          };
        }
      : undefined;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievedEvidence[]> {
    const evidence = await this.original.retrieve(request);
    return expandAmbossAdjacentEvidence(evidence, this.bucket);
  }
}
