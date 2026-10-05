import { describe, expect, it, vi } from "vitest";

import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { CloudflareAiSearchRetrieval } from "./retrieval";

function namespaceWithLibraries(): AiSearchNamespaceLike & {
  list: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} {
  return {
    list: vi.fn(async () => ({
      result: [
        { id: "usmle", name: "USMLE" },
        { id: "mrcp", name: "MRCP" },
      ],
    })),
    search: vi.fn(async () => ({
      chunks: [
        {
          id: "chunk-1",
          instance_id: "mrcp",
          text: "Normal serum sodium is generally 135 to 145 mmol/L.",
          score: 0.91,
          item: {
            key: "electrolytes.md",
            metadata: {
              title: "Electrolytes",
              page: "12",
              section: "Sodium",
            },
          },
        },
      ],
    })),
  };
}

describe("CloudflareAiSearchRetrieval", () => {
  it("keeps All Libraries as the default and normalizes library/source metadata", async () => {
    const namespace = namespaceWithLibraries();
    const retrieval = new CloudflareAiSearchRetrieval(namespace);

    const evidence = await retrieval.retrieve({ query: "normal sodium" });

    expect(namespace.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "normal sodium",
        ai_search_options: expect.objectContaining({
          instance_ids: ["mrcp", "usmle"],
        }),
      }),
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        sourceId: "mrcp:chunk-1",
        libraryId: "mrcp",
        libraryName: "MRCP",
        instanceId: "mrcp",
        itemKey: "electrolytes.md",
        title: "Electrolytes",
        page: 12,
        section: "Sodium",
      }),
    ]);
  });

  it("restricts AI Search to one validated library", async () => {
    const namespace = namespaceWithLibraries();
    namespace.search.mockResolvedValueOnce({
      chunks: [
        {
          id: "chunk-2",
          instance_id: "usmle",
          text: "USMLE evidence",
          score: 0.9,
          item: { key: "usmle.md", metadata: { title: "USMLE Source" } },
        },
      ],
    });
    const retrieval = new CloudflareAiSearchRetrieval(namespace);

    const evidence = await retrieval.retrieve({ query: "renal physiology", libraryId: "usmle" });

    expect(namespace.search).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_search_options: expect.objectContaining({
          instance_ids: ["usmle"],
        }),
      }),
    );
    expect(evidence[0]).toMatchObject({ libraryId: "usmle", libraryName: "USMLE" });
  });

  it("fails closed for an unknown library instead of broadening search", async () => {
    const namespace = namespaceWithLibraries();
    const retrieval = new CloudflareAiSearchRetrieval(namespace);

    await expect(
      retrieval.retrieve({ query: "renal physiology", libraryId: "unknown-library" }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_LIBRARY" });
    expect(namespace.search).not.toHaveBeenCalled();
  });

  it("rejects evidence returned outside the selected library scope", async () => {
    const namespace = namespaceWithLibraries();
    const retrieval = new CloudflareAiSearchRetrieval(namespace);

    await expect(
      retrieval.retrieve({ query: "normal sodium", libraryId: "usmle" }),
    ).rejects.toMatchObject({ status: 502, code: "SEARCH_SCOPE_VIOLATION" });
  });
});
