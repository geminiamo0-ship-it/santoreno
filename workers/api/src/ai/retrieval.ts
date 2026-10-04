import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import type { RetrievalPort, RetrievedEvidence } from "./types";

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

function titleFromItem(item: Record<string, unknown> | null): string {
  const metadata = asRecord(item?.metadata);
  return (
    stringField(metadata, "title") ??
    stringField(metadata, "name") ??
    stringField(item, "key") ??
    "Santo medical source"
  ).slice(0, 500);
}

function instanceIdsFromList(raw: unknown): string[] {
  const root = asRecord(raw);
  const result = root?.result;
  if (!Array.isArray(result)) {
    throw new GroundedAiError(
      502,
      "SEARCH_FAILED",
      "AI Search namespace returned an invalid instance list",
    );
  }

  const ids = result
    .map((entry) => stringField(asRecord(entry), "id"))
    .filter((value): value is string => value !== null)
    .sort();

  if (ids.length > MAX_SEARCH_INSTANCES) {
    throw new GroundedAiError(
      503,
      "SEARCH_CONFIGURATION_ERROR",
      `All Libraries currently supports at most ${MAX_SEARCH_INSTANCES} AI Search instances`,
    );
  }

  return ids;
}

function evidenceFromSearch(raw: unknown, selectedInstanceIds: readonly string[]): RetrievedEvidence[] {
  const root = asRecord(raw);
  const chunks = root?.chunks;
  if (!Array.isArray(chunks)) {
    throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search returned an invalid response");
  }

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
      (selectedInstanceIds.length === 1 ? selectedInstanceIds[0] : null);

    if (!chunkId || !text || score === null || !itemKey || !instanceId) {
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
      instanceId,
      itemKey,
      title: titleFromItem(item),
      page: pageFromMetadata(metadata),
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
  constructor(private readonly namespace: AiSearchNamespaceLike | undefined) {}

  async retrieve(query: string): Promise<RetrievedEvidence[]> {
    if (!this.namespace) {
      throw new GroundedAiError(503, "AI_NOT_CONFIGURED", "AI Search binding is required");
    }

    try {
      const instanceIds = instanceIdsFromList(await this.namespace.list());
      if (instanceIds.length === 0) {
        return [];
      }

      const result = await this.namespace.search({
        query,
        ai_search_options: {
          instance_ids: instanceIds,
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

      return evidenceFromSearch(result, instanceIds);
    } catch (error) {
      if (error instanceof GroundedAiError) {
        throw error;
      }
      throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search request failed");
    }
  }
}
