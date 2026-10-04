import type { AiSearchNamespaceLike } from "../runtime/bindings";
import type { GroundedRetrieval, RetrievedEvidence } from "./types";

const MAX_INSTANCES = 10;
const MAX_RESULTS = 5;

export class RetrievalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RetrievalError";
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function configuredInstanceIds(value?: string): string[] | null {
  if (!value?.trim()) {
    return null;
  }

  const ids = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0 || ids.length > MAX_INSTANCES) {
    throw new RetrievalError(
      "SEARCH_INSTANCE_CONFIGURATION_INVALID",
      `AI Search must configure between 1 and ${MAX_INSTANCES} instance IDs`,
    );
  }

  return ids;
}

function pageFromMetadata(metadata: UnknownRecord | null): number | null {
  if (!metadata) {
    return null;
  }

  for (const key of ["page", "page_number", "pageNumber"]) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

function titleFromItem(key: string, metadata: UnknownRecord | null): string {
  const title = metadata?.title;
  return typeof title === "string" && title.trim() ? title.trim().slice(0, 500) : key.slice(0, 500);
}

function normalizeChunk(value: unknown, index: number): RetrievedEvidence {
  const chunk = asRecord(value);
  const item = asRecord(chunk?.item);
  const metadata = asRecord(item?.metadata);
  const id = chunk?.id;
  const instanceId = chunk?.instance_id;
  const score = chunk?.score;
  const text = chunk?.text;
  const key = item?.key;

  if (
    typeof id !== "string" ||
    typeof instanceId !== "string" ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1 ||
    typeof text !== "string" ||
    !text.trim() ||
    typeof key !== "string" ||
    !key.trim()
  ) {
    throw new RetrievalError("SEARCH_INVALID_RESPONSE", "AI Search returned a malformed chunk");
  }

  return {
    sourceId: `src_${index + 1}`,
    instanceId,
    title: titleFromItem(key, metadata),
    page: pageFromMetadata(metadata),
    score,
    text: text.trim(),
    key,
  };
}

export class CloudflareAiSearchRetrieval implements GroundedRetrieval {
  constructor(
    private readonly namespace: AiSearchNamespaceLike,
    private readonly configuredIds?: string,
  ) {}

  private async resolveInstanceIds(): Promise<string[]> {
    const configured = configuredInstanceIds(this.configuredIds);
    if (configured) {
      return configured;
    }

    const response = asRecord(await this.namespace.list({ page: 1, per_page: 100 }));
    const result = response?.result;
    if (!Array.isArray(result)) {
      throw new RetrievalError("SEARCH_INVALID_RESPONSE", "AI Search instance list is malformed");
    }

    const ids = result
      .map(asRecord)
      .filter((instance): instance is UnknownRecord => Boolean(instance))
      .filter((instance) => instance.paused !== true)
      .map((instance) => instance.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      throw new RetrievalError(
        "SEARCH_NOT_CONFIGURED",
        "No active AI Search instances are available",
      );
    }
    if (uniqueIds.length > MAX_INSTANCES) {
      throw new RetrievalError(
        "SEARCH_INSTANCE_LIMIT_EXCEEDED",
        `All Libraries currently supports at most ${MAX_INSTANCES} AI Search instances per request`,
      );
    }

    return uniqueIds;
  }

  async retrieve(question: string): Promise<RetrievedEvidence[]> {
    const instanceIds = await this.resolveInstanceIds();
    let raw: unknown;
    try {
      raw = await this.namespace.search({
        messages: [{ role: "user", content: question }],
        ai_search_options: {
          instance_ids: instanceIds,
          retrieval: {
            retrieval_type: "hybrid",
            max_num_results: MAX_RESULTS,
            return_on_failure: false,
          },
        },
      });
    } catch (error) {
      throw new RetrievalError(
        "SEARCH_FAILED",
        error instanceof Error ? error.message : "AI Search request failed",
      );
    }

    const response = asRecord(raw);
    const errors = response?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new RetrievalError("SEARCH_FAILED", "One or more AI Search instances failed");
    }

    const chunks = response?.chunks;
    if (!Array.isArray(chunks)) {
      throw new RetrievalError("SEARCH_INVALID_RESPONSE", "AI Search response is malformed");
    }

    return chunks.slice(0, MAX_RESULTS).map(normalizeChunk);
  }
}
