import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import { CloudflareAiSearchLibraryCatalog } from "./library-catalog";
import type {
  LibraryCatalogEntry,
  LibraryCatalogPort,
  RetrievalPort,
  RetrievalQuery,
  RetrievedEvidence,
} from "./types";

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

function titleFromItem(item: Record<string, unknown> | null): string {
  const metadata = asRecord(item?.metadata);
  return (
    stringField(metadata, "title") ??
    stringField(metadata, "name") ??
    stringField(item, "key") ??
    "Santo medical source"
  ).slice(0, 500);
}

function sectionFromMetadata(metadata: Record<string, unknown> | null): string | null {
  return stringField(metadata, "section")?.slice(0, 500) ?? null;
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

  const selectedByInstance = new Map(
    selectedLibraries.map((library) => [library.instanceId, library] as const),
  );
  const evidence: RetrievedEvidence[] = [];
  const seen = new Set<string>();

  for (const rawChunk of chunks) {
    const chunk = asRecord(rawChunk);
    const chunkId = stringField(chunk, "id");
    const text = stringField(chunk, "text");
    const score = numberField(chunk, "score");
    const item = asRecord(chunk?.item);
    const itemKey = stringField(item, "key");
    const instanceId =
      stringField(chunk, "instance_id") ??
      (selectedLibraries.length === 1 ? selectedLibraries[0]?.instanceId ?? null : null);

    if (!chunkId || !text || score === null || !itemKey || !instanceId) {
      continue;
    }

    const library = selectedByInstance.get(instanceId);
    if (!library) {
      throw new GroundedAiError(
        502,
        "SEARCH_SCOPE_VIOLATION",
        "AI Search returned evidence outside the selected library scope",
      );
    }

    const sourceId = `${instanceId}:${chunkId}`;
    if (seen.has(sourceId)) {
      continue;
    }
    seen.add(sourceId);

    const metadata = asRecord(item?.metadata);
    evidence.push({
      sourceId,
      libraryId: library.libraryId,
      libraryName: library.name,
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
  constructor(
    private readonly namespace: AiSearchNamespaceLike | undefined,
    private readonly catalog?: LibraryCatalogPort,
  ) {}

  async retrieve(input: RetrievalQuery): Promise<RetrievedEvidence[]> {
    if (!this.namespace) {
      throw new GroundedAiError(503, "AI_NOT_CONFIGURED", "AI Search binding is required");
    }

    try {
      const catalog = this.catalog ?? new CloudflareAiSearchLibraryCatalog(this.namespace);
      const selectedLibraries = await catalog.select(input.libraryId);
      if (selectedLibraries.length === 0) {
        return [];
      }

      const result = await this.namespace.search({
        query: input.query,
        ai_search_options: {
          instance_ids: selectedLibraries.map((library) => library.instanceId),
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
