import { describe, expect, it } from "vitest";

import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { CloudflareAiSearchRetrieval } from "./retrieval";

class FakeAiSearchNamespace implements AiSearchNamespaceLike {
  readonly searchInputs: unknown[] = [];

  constructor(
    private readonly listResult: unknown,
    private readonly searchResult: unknown,
  ) {}

  list(): Promise<unknown> {
    return Promise.resolve(this.listResult);
  }

  search(input: unknown): Promise<unknown> {
    this.searchInputs.push(input);
    return Promise.resolve(this.searchResult);
  }
}

function namespace(): FakeAiSearchNamespace {
  return new FakeAiSearchNamespace(
    {
      result: [
        {
          id: "instance-usmle",
          metadata: { library_id: "usmle", title: "USMLE" },
        },
        {
          id: "instance-mrcp",
          metadata: { library_id: "mrcp", title: "MRCP" },
        },
      ],
    },
    {
      chunks: [
        {
          id: "chunk-1",
          text: "Normal serum sodium is generally 135 to 145 mmol/L.",
          score: 0.91,
          instance_id: "instance-mrcp",
          item: {
            key: "electrolytes.md",
            metadata: {
              title: "Electrolytes",
              page_number: "12",
              section: "Sodium disorders",
            },
          },
        },
      ],
    },
  );
}

describe("CloudflareAiSearchRetrieval", () => {
  it("keeps All Libraries as the default and normalizes retrieval metadata", async () => {
    const aiSearch = namespace();
    const retrieval = new CloudflareAiSearchRetrieval(aiSearch);

    const evidence = await retrieval.retrieve({ query: "normal sodium", libraryId: null });

    expect(aiSearch.searchInputs).toHaveLength(1);
    expect(aiSearch.searchInputs[0]).toMatchObject({
      query: "normal sodium",
      ai_search_options: {
        instance_ids: ["instance-mrcp", "instance-usmle"],
      },
    });
    expect(evidence).toEqual([
      {
        sourceId: "instance-mrcp:chunk-1",
        libraryId: "mrcp",
        instanceId: "instance-mrcp",
        itemKey: "electrolytes.md",
        title: "Electrolytes",
        page: 12,
        section: "Sodium disorders",
        text: "Normal serum sodium is generally 135 to 145 mmol/L.",
        score: 0.91,
      },
    ]);
  });

  it("allows only explicitly approved Santo instances and excludes other project data", async () => {
    const aiSearch = namespace();
    const { AiSearchNamespaceLibraryCatalog } = await import("./library-catalog");
    const retrieval = new CloudflareAiSearchRetrieval(
      aiSearch,
      new AiSearchNamespaceLibraryCatalog(aiSearch, new Set(["instance-usmle"])),
    );
    const evidence = await retrieval.retrieve({ query: "normal sodium", libraryId: null });
    expect(aiSearch.searchInputs).toHaveLength(1);
    expect(aiSearch.searchInputs[0]).toMatchObject({
      ai_search_options: { instance_ids: ["instance-usmle"] },
    });
    expect(evidence).toEqual([]);
    await expect(retrieval.retrieve({ query: "sodium", libraryId: "mrcp" })).rejects.toMatchObject({
      code: "INVALID_LIBRARY_FILTER",
      status: 400,
    });
  });

  it("keeps the One Examination library ID stable on an isolated AI Search source", async () => {
    const aiSearch = new FakeAiSearchNamespace(
      { result: [{ id: "one-examination-isolated" }, { id: "one-examination" }] },
      { chunks: [{
        id: "chunk-x",
        score: 0.93,
        instance_id: "one-examination-isolated",
        text: "One Examination source text",
        item: { key: "medical-search/v1/one-examination/topic/s-0001.md" },
      }] },
    );
    const { AiSearchNamespaceLibraryCatalog } = await import("./library-catalog");
    const catalog = new AiSearchNamespaceLibraryCatalog(
      aiSearch, new Set(["one-examination-isolated"]),
    );
    const retrieval = new CloudflareAiSearchRetrieval(aiSearch, catalog);
    const evidence = await retrieval.retrieve({
      query: "Sample question", libraryId: "one-examination",
    });
    expect(evidence[0]).toMatchObject({
      libraryId: "one-examination", instanceId: "one-examination-isolated",
    });
    expect(aiSearch.searchInputs[0]).toMatchObject({
      ai_search_options: { instance_ids: ["one-examination-isolated"] },
    });
  });

  it("fails closed when the Santo allowlist is empty", async () => {
    const aiSearch = namespace();
    const { AiSearchNamespaceLibraryCatalog } = await import("./library-catalog");
    const retrieval = new CloudflareAiSearchRetrieval(
      aiSearch,
      new AiSearchNamespaceLibraryCatalog(aiSearch, new Set()),
    );
    expect(await retrieval.retrieve({ query: "sodium", libraryId: null })).toEqual([]);
    expect(aiSearch.searchInputs).toHaveLength(0);
  });

  it("narrows AI Search to the selected library", async () => {
    const aiSearch = namespace();
    const retrieval = new CloudflareAiSearchRetrieval(aiSearch);

    await retrieval.retrieve({ query: "normal sodium", libraryId: "mrcp" });

    expect(aiSearch.searchInputs).toHaveLength(1);
    expect(aiSearch.searchInputs[0]).toMatchObject({
      ai_search_options: {
        instance_ids: ["instance-mrcp"],
      },
    });
  });

  it("rejects an unknown library without silently broadening retrieval", async () => {
    const aiSearch = namespace();
    const retrieval = new CloudflareAiSearchRetrieval(aiSearch);

    await expect(
      retrieval.retrieve({ query: "normal sodium", libraryId: "unknown" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_LIBRARY_FILTER",
    });
    expect(aiSearch.searchInputs).toHaveLength(0);
  });
});
