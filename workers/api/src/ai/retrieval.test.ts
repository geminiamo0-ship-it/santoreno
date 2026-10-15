import { describe, expect, it } from "vitest";

import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { AiSearchNamespaceLibraryCatalog } from "./library-catalog";
import { CloudflareAiSearchRetrieval } from "./retrieval";

const expectedIds = ["amboss", "usmle", "passmedicine", "pastest", "one-examination"];
const instanceFor = (id: string) => (id === "one-examination" ? "one-examination-isolated" : id);
const catalogItems = expectedIds.map((id) => ({
  id: instanceFor(id),
  metadata: { library_id: id, title: id },
}));

function chunk(id: string, index = 1, score = 0.91) {
  return {
    id: "chunk-" + id + "-" + index,
    text: id + " evidence " + index,
    score,
    instance_id: instanceFor(id),
    item: {
      key: "medical-search/v1/" + id + "/article/s-0001.md",
      metadata: { title: id + " article", page_number: "12", section: "Mechanism" },
    },
  };
}

class FakeAiSearchNamespace implements AiSearchNamespaceLike {
  readonly searchInputs: unknown[] = [];
  constructor(
    readonly catalog: unknown = { result: catalogItems },
    readonly results: Readonly<Record<string, unknown>> = {},
  ) {}
  list(): Promise<unknown> {
    return Promise.resolve(this.catalog);
  }
  search(input: unknown): Promise<unknown> {
    this.searchInputs.push(input);
    const value = input as { ai_search_options: { instance_ids: string[] } };
    const id = value.ai_search_options.instance_ids[0]!;
    return Promise.resolve(this.results[id] ?? { chunks: [] });
  }
}

describe("Santo five licensed library retrieval", () => {
  it("searches all 5 approved libraries in parallel, selecting 1 valid passage from each", async () => {
    const aiSearch = new FakeAiSearchNamespace(
      { result: [...catalogItems, { id: "foreign-project" }] },
      Object.fromEntries(
        expectedIds.map((id) => [
          instanceFor(id),
          {
            chunks: [chunk(id, 1), chunk(id, 2, 0.87), chunk(id, 3, 0.8)],
          },
        ]),
      ),
    );
    const result = await new CloudflareAiSearchRetrieval(aiSearch).retrieve({
      query: "aortic stenosis",
      libraryId: null,
    });
    expect(aiSearch.searchInputs).toHaveLength(5);
    expect(
      aiSearch.searchInputs.map(
        (input) =>
          (input as { ai_search_options: { instance_ids: string[] } }).ai_search_options
            .instance_ids[0],
      ),
    ).toEqual(expectedIds.map(instanceFor));
    for (const input of aiSearch.searchInputs) {
      expect(input).toMatchObject({
        query: "aortic stenosis",
        ai_search_options: {
          retrieval: { max_num_results: 3, match_threshold: 0.4, retrieval_type: "hybrid" },
          query_rewrite: { enabled: false },
        },
      });
    }
    expect(result.map((x) => x.libraryId)).toEqual(expectedIds);
    expect(result).toHaveLength(5);
    expect(result[0]).toMatchObject({
      sourceId: "amboss:chunk-amboss-1",
      title: "amboss article",
      page: 12,
      section: "Mechanism",
    });
    expect(result[4]).toMatchObject({
      libraryId: "one-examination",
      instanceId: "one-examination-isolated",
    });
  });

  it("never manufactures a missing fifth citation or returns a low-score passage", async () => {
    const aiSearch = new FakeAiSearchNamespace(undefined, {
      amboss: { chunks: [chunk("amboss", 1, 0.35)] },
      usmle: { chunks: [chunk("usmle")] },
      passmedicine: { chunks: [chunk("passmedicine")] },
      pastest: { chunks: [chunk("pastest")] },
    });
    const evidence = await new CloudflareAiSearchRetrieval(aiSearch).retrieve({
      query: "ECG",
      libraryId: null,
    });
    expect(evidence.map((x) => x.libraryId)).toEqual(["usmle", "passmedicine", "pastest"]);
  });

  it("keeps explicit library selection to one authorized index", async () => {
    const aiSearch = new FakeAiSearchNamespace(undefined, {
      "one-examination-isolated": { chunks: [chunk("one-examination")] },
    });
    const retrieval = new CloudflareAiSearchRetrieval(aiSearch);
    const evidence = await retrieval.retrieve({ query: "sodium", libraryId: "one-examination" });
    expect(evidence.map((x) => x.libraryId)).toEqual(["one-examination"]);
    expect(aiSearch.searchInputs).toHaveLength(1);
    expect(aiSearch.searchInputs[0]).toMatchObject({
      ai_search_options: { instance_ids: ["one-examination-isolated"] },
    });
  });

  it("disallows unknown or removed library IDs and never broadens to foreign projects", async () => {
    const aiSearch = new FakeAiSearchNamespace();
    const retrieval = new CloudflareAiSearchRetrieval(aiSearch);
    await expect(retrieval.retrieve({ query: "sample", libraryId: "other" })).rejects.toMatchObject(
      {
        status: 400,
        code: "INVALID_LIBRARY_FILTER",
      },
    );
    expect(aiSearch.searchInputs).toHaveLength(0);
  });

  it("fails closed if any of five index mappings is missing", async () => {
    const aiSearch = new FakeAiSearchNamespace({
      result: catalogItems.filter((x) => x.id !== "amboss"),
    });
    const retrieval = new CloudflareAiSearchRetrieval(aiSearch);
    await expect(retrieval.retrieve({ query: "ECG", libraryId: null })).rejects.toMatchObject({
      status: 503,
      code: "SEARCH_CONFIGURATION_ERROR",
    });
    expect(aiSearch.searchInputs).toHaveLength(0);
  });

  it("uses the deployment allowlist, and refuses to query a disallowed index", async () => {
    const aiSearch = new FakeAiSearchNamespace();
    const catalog = new AiSearchNamespaceLibraryCatalog(aiSearch, new Set(["usmle"]));
    const retrieval = new CloudflareAiSearchRetrieval(aiSearch, catalog);
    await expect(retrieval.retrieve({ query: "sodium", libraryId: null })).rejects.toMatchObject({
      status: 503,
      code: "SEARCH_CONFIGURATION_ERROR",
    });
    expect(await retrieval.retrieve({ query: "sodium", libraryId: "usmle" })).toEqual([]);
    expect(aiSearch.searchInputs).toHaveLength(1);
  });

  it("does not silently downgrade to fewer indexes when one parallel query fails", async () => {
    const invalid = new FakeAiSearchNamespace(undefined, { amboss: { broken: true } });
    await expect(
      new CloudflareAiSearchRetrieval(invalid).retrieve({
        query: "aortic stenosis",
        libraryId: null,
      }),
    ).rejects.toMatchObject({ status: 502, code: "SEARCH_FAILED" });
    const failed = new FakeAiSearchNamespace();
    failed.search = async (input: unknown) => {
      if (
        (input as { ai_search_options: { instance_ids: string[] } }).ai_search_options
          .instance_ids[0] === "amboss"
      )
        throw new Error("Search temporarily unavailable");
      return { chunks: [] };
    };
    await expect(
      new CloudflareAiSearchRetrieval(failed).retrieve({
        query: "aortic stenosis",
        libraryId: null,
      }),
    ).rejects.toMatchObject({ status: 502, code: "SEARCH_FAILED" });
  });
});
