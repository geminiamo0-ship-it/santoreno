import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import type { LibraryCatalogEntry, LibraryCatalogPort } from "./types";

const MAX_SEARCH_INSTANCES = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function entriesFromList(raw: unknown): LibraryCatalogEntry[] {
  const root = asRecord(raw);
  const result = root?.result;
  if (!Array.isArray(result)) {
    throw new GroundedAiError(
      502,
      "SEARCH_FAILED",
      "AI Search namespace returned an invalid library catalog",
    );
  }

  const byId = new Map<string, LibraryCatalogEntry>();
  for (const rawEntry of result) {
    const entry = asRecord(rawEntry);
    const instanceId = stringField(entry, "id");
    if (!instanceId || byId.has(instanceId)) {
      continue;
    }

    byId.set(instanceId, {
      libraryId: instanceId,
      instanceId,
      name: (stringField(entry, "name") ?? stringField(entry, "title") ?? instanceId).slice(0, 200),
    });
  }

  const entries = [...byId.values()].sort((a, b) => a.libraryId.localeCompare(b.libraryId));
  if (entries.length > MAX_SEARCH_INSTANCES) {
    throw new GroundedAiError(
      503,
      "SEARCH_CONFIGURATION_ERROR",
      `All Libraries currently supports at most ${MAX_SEARCH_INSTANCES} AI Search instances`,
    );
  }

  return entries;
}

export class CloudflareAiSearchLibraryCatalog implements LibraryCatalogPort {
  constructor(private readonly namespace: AiSearchNamespaceLike) {}

  async select(libraryId?: string): Promise<LibraryCatalogEntry[]> {
    let entries: LibraryCatalogEntry[];
    try {
      entries = entriesFromList(await this.namespace.list());
    } catch (error) {
      if (error instanceof GroundedAiError) {
        throw error;
      }
      throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search library catalog request failed");
    }

    if (libraryId === undefined) {
      return entries;
    }

    const selected = entries.find((entry) => entry.libraryId === libraryId);
    if (!selected) {
      throw new GroundedAiError(400, "UNKNOWN_LIBRARY", "Requested Santo library is not available");
    }

    return [selected];
  }
}
