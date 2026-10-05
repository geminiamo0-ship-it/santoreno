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
