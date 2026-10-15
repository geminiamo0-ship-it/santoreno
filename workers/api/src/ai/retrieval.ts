import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import {
  AiSearchNamespaceLibraryCatalog,
  type LibraryCatalogEntry,
  type LibraryCatalogPort,
} from "./library-catalog";
import type { RetrievalPort, RetrievalRequest, RetrievedEvidence } from "./types";
import { focusedSearchQuery, matchesSearchSubject } from "./source-relevance";

const LIBRARIES = ["amboss", "usmle", "passmedicine", "pastest", "one-examination"] as const;
const MAX_RESULTS = 5;
const PER_LIBRARY_CANDIDATES = 3;
const MATCH_THRESHOLD = 0.4;
const MAX_CHUNK_CHARS = 5000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pageFromMetadata(metadata: Record<string, unknown> | null): number | null {
  for (const key of ["page", "page_number", "pageNumber"]) {
    const value = metadata?.[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function sectionFromMetadata(metadata: Record<string, unknown> | null): string | null {
  return (
    stringField(metadata, "section") ??
    stringField(metadata, "section_title") ??
    stringField(metadata, "sectionTitle")
  );
}

function titleFromItem(item: Record<string, unknown> | null): string {
  const metadata = asRecord(item?.metadata);
  return (
    stringField(metadata, "title") ??
    stringField(metadata, "name") ??
    stringField(item, "key") ??
    "Santo medical source"
  ).slice(0, 500);
}

/**
 * There are five fixed licensed medical libraries in this rollout. A global
 * search always considers EXACTLY those libraries, independent of the score
 * distribution returned by a combined namespace query.
 */
function selectLibraries(
  catalog: readonly LibraryCatalogEntry[],
  libraryId: string | null,
): readonly LibraryCatalogEntry[] {
  const supported = new Set<string>(LIBRARIES);
  if (libraryId !== null && !supported.has(libraryId)) {
    throw new GroundedAiError(400, "INVALID_LIBRARY_FILTER", "Unknown Santo library filter");
  }
  const selected = LIBRARIES.map((id) => catalog.find((entry) => entry.id === id));
  // Reject misconfigured/incomplete namespaces rather than silently searching
  // an unrelated index. For an explicit filter, require that index only.
  const required =
    libraryId === null ? selected : [catalog.find((entry) => entry.id === libraryId)];
  if (required.some((entry) => !entry)) {
    throw new GroundedAiError(
      503,
      "SEARCH_CONFIGURATION_ERROR",
      "Required medical library index unavailable",
    );
  }
  return required as LibraryCatalogEntry[];
}

function evidenceFromSearch(
  raw: unknown,
  selectedLibraries: readonly LibraryCatalogEntry[],
): RetrievedEvidence[] {
  const root = asRecord(raw);
  const chunks = root?.chunks;
  if (!Array.isArray(chunks)) {
    throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search returned an invalid response");
  }

  const libraryByInstanceId = new Map(
    selectedLibraries.map((entry) => [entry.instanceId, entry] as const),
  );
  const fallbackLibrary = selectedLibraries.length === 1 ? selectedLibraries[0] : null;
  const evidence: RetrievedEvidence[] = [];
  const seen = new Set<string>();

  for (const rawChunk of chunks) {
    const chunk = asRecord(rawChunk);
    const chunkId = stringField(chunk, "id");
    const text = stringField(chunk, "text");
    const score = numberField(chunk, "score");
    const item = asRecord(chunk?.item);
    const itemKey = stringField(item, "key");
    const instanceId = stringField(chunk, "instance_id") ?? fallbackLibrary?.instanceId ?? null;
    const library = instanceId ? libraryByInstanceId.get(instanceId) : undefined;

    if (
      !chunkId ||
      !text ||
      score === null ||
      score < MATCH_THRESHOLD ||
      !itemKey ||
      !instanceId ||
      !library
    ) {
      continue;
    }

    const sourceId = `${instanceId}:${chunkId}`;
    if (seen.has(sourceId)) {
      continue;
    }
    seen.add(sourceId);

    const metadata = asRecord(item?.metadata);
    evidence.push({
      sourceId,
      libraryId: library.id,
      instanceId,
      itemKey,
      title: titleFromItem(item),
      page: pageFromMetadata(metadata),
      section: sectionFromMetadata(metadata),
      text: text.slice(0, MAX_CHUNK_CHARS),
      score,
    });

    if (evidence.length >= MAX_RESULTS) {
      break;
    }
  }

  return evidence;
}

export class CloudflareAiSearchRetrieval implements RetrievalPort {
  private readonly catalog: LibraryCatalogPort;

  constructor(
    private readonly namespace: AiSearchNamespaceLike | undefined,
    catalog?: LibraryCatalogPort,
  ) {
    this.catalog = catalog ?? new AiSearchNamespaceLibraryCatalog(namespace);
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievedEvidence[]> {
    if (!this.namespace) {
      throw new GroundedAiError(503, "AI_NOT_CONFIGURED", "AI Search binding is required");
    }

    try {
      const selectedLibraries = selectLibraries(await this.catalog.list(), request.libraryId);
      const currentTopicQuery = focusedSearchQuery(request.query);
      // Query each index concurrently. Asking a single global top-5 search
      // routinely hides smaller libraries, even when their evidence is relevant.
      // No Reranker or synthetic citation is involved. From each library we
      // retain at most one valid, relevant, Cloudflare-ranked source passage.
      const results = await Promise.all(
        selectedLibraries.map(async (entry) => {
          const search = await this.namespace!.search({
            query: currentTopicQuery,
            ai_search_options: {
              instance_ids: [entry.instanceId],
              retrieval: {
                retrieval_type: "hybrid",
                match_threshold: MATCH_THRESHOLD,
                max_num_results: PER_LIBRARY_CANDIDATES,
                return_on_failure: true,
              },
              query_rewrite: { enabled: false },
            },
          });
          // Do not force one result per library: a high semantic score can
          // still be for a DIFFERENT disease from a previous discussion.
          return evidenceFromSearch(search, [entry])
            .filter((candidate) => matchesSearchSubject(currentTopicQuery, candidate))
            .slice(0, 1);
        }),
      );
      return results.flat().slice(0, MAX_RESULTS);
    } catch (error) {
      if (error instanceof GroundedAiError) {
        throw error;
      }
      throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search request failed");
    }
  }
}
