import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import {
  AiSearchNamespaceLibraryCatalog,
  type LibraryCatalogEntry,
  type LibraryCatalogPort,
} from "./library-catalog";
import type { RetrievalPort, RetrievalRequest, RetrievedEvidence } from "./types";

const MAX_SEARCH_INSTANCES = 10;
const MAX_RESULTS = 5;
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

function selectLibraries(
  catalog: readonly LibraryCatalogEntry[],
  libraryId: string | null,
): readonly LibraryCatalogEntry[] {
  if (libraryId === null) {
    return catalog;
  }

  const selected = catalog.find((entry) => entry.id === libraryId);
  if (!selected) {
    throw new GroundedAiError(400, "INVALID_LIBRARY_FILTER", "Unknown Santo library filter");
  }

  return [selected];
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

    if (!chunkId || !text || score === null || !itemKey || !instanceId || !library) {
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
      if (selectedLibraries.length === 0) {
        return [];
      }
      if (selectedLibraries.length > MAX_SEARCH_INSTANCES) {
        throw new GroundedAiError(
          503,
          "SEARCH_CONFIGURATION_ERROR",
          `All Libraries currently supports at most ${MAX_SEARCH_INSTANCES} AI Search instances`,
        );
      }

      const result = await this.namespace.search({
        query: request.query,
        ai_search_options: {
          instance_ids: selectedLibraries.map((entry) => entry.instanceId),
          retrieval: {
            retrieval_type: "hybrid",
            match_threshold: MATCH_THRESHOLD,
            max_num_results: MAX_RESULTS,
            return_on_failure: true,
          },
          query_rewrite: {
            enabled: false,
          },
        },
      });

      return evidenceFromSearch(result, selectedLibraries);
    } catch (error) {
      if (error instanceof GroundedAiError) {
        throw error;
      }
      throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search request failed");
    }
  }
}
