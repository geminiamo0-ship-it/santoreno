import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";

export interface LibraryCatalogEntry {
  id: string;
  instanceId: string;
  title: string;
}

export interface LibraryCatalogPort {
  list(): Promise<readonly LibraryCatalogEntry[]>;
  resolve(libraryId: string): Promise<LibraryCatalogEntry | null>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class AiSearchNamespaceLibraryCatalog implements LibraryCatalogPort {
  constructor(private readonly namespace: AiSearchNamespaceLike | undefined) {}

  async list(): Promise<readonly LibraryCatalogEntry[]> {
    if (!this.namespace) {
      throw new GroundedAiError(503, "AI_NOT_CONFIGURED", "AI Search binding is required");
    }

    let raw: unknown;
    try {
      raw = await this.namespace.list();
    } catch {
      throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search library catalog request failed");
    }

    const root = asRecord(raw);
    const result = root?.result;
    if (!Array.isArray(result)) {
      throw new GroundedAiError(
        502,
        "SEARCH_FAILED",
        "AI Search namespace returned an invalid library catalog",
      );
    }

    const entries: LibraryCatalogEntry[] = [];
    const seenLibraryIds = new Set<string>();

    for (const rawEntry of result) {
      const entry = asRecord(rawEntry);
      const instanceId = stringField(entry, "id");
      if (!instanceId) {
        continue;
      }

      const metadata = asRecord(entry?.metadata);
      const libraryId = stringField(metadata, "library_id") ?? instanceId;
      if (seenLibraryIds.has(libraryId)) {
        throw new GroundedAiError(
          503,
          "SEARCH_CONFIGURATION_ERROR",
          `Duplicate library identifier: ${libraryId}`,
        );
      }
      seenLibraryIds.add(libraryId);

      entries.push({
        id: libraryId,
        instanceId,
        title: stringField(metadata, "title") ?? stringField(entry, "name") ?? libraryId,
      });
    }

    return entries.sort((left, right) => left.id.localeCompare(right.id));
  }

  async resolve(libraryId: string): Promise<LibraryCatalogEntry | null> {
    const entries = await this.list();
    return entries.find((entry) => entry.id === libraryId) ?? null;
  }
}
