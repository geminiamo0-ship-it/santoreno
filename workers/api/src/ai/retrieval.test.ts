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
    text: id + " evidence " + index + " about aortic stenosis, ECG and sodium.",
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

  it("does not carry over aortic stenosis articles when user switches to FMF", async () => {
    const previousTopic = chunk("amboss", 1, 0.99);
    const newTopic = {
      ...chunk("amboss", 2, 0.86),
      text: "Familial Mediterranean fever is associated with mutations in MEFV and recurrent fever.",
      item: {
        key: "medical-search/v1/amboss/article/fmf.md",
        metadata: { title: "Familial Mediterranean fever", section: "Pathophysiology" },
      },
    };
    const staleTopic = {
      ...chunk("usmle", 1, 0.97),
      text: "Aortic stenosis: calcification of the aortic valve.",
    };
    const ns = new FakeAiSearchNamespace(undefined, {
      amboss: { chunks: [previousTopic, newTopic] },
      usmle: { chunks: [staleTopic] },
    });
    const query =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Aortic stenosis and transcatheter valve replacement.\n" +
      "Follow-up question:\nbrief summary of FMF";
    const evidence = await new CloudflareAiSearchRetrieval(ns).retrieve({
      query,
      libraryId: null,
    });
    expect(ns.searchInputs).toHaveLength(5);
    for (const input of ns.searchInputs) {
      expect(input).toMatchObject({ query: "brief summary of FMF" });
    }
    expect(evidence.map((x) => x.title)).toEqual(["Familial Mediterranean fever"]);
    expect(evidence[0]?.text).toContain("MEFV");
  });

  it("V2 searches cited management passages using the actual disease, not raw conversation text", async () => {
    const asManagement = {
      ...chunk("amboss", 1),
      text: "Management of aortic stenosis includes evaluation for aortic valve replacement.",
      item: {
        key: "aortic-stenosis-management.html",
        metadata: { title: "Aortic stenosis", section: "Management" },
      },
    };
    const unrelated = {
      ...chunk("usmle", 1, 0.99),
      text: "Familial Mediterranean fever management uses anti-inflammatory prophylaxis.",
      item: {
        key: "fmf.html",
        metadata: { title: "Familial Mediterranean fever", section: "Management" },
      },
    };
    const namespace = new FakeAiSearchNamespace(undefined, {
      amboss: { chunks: [asManagement] },
      usmle: { chunks: [unrelated] },
    });
    const query =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Q: Aortic stenosis | Verified A: Valve narrowing causes pressure overload.\n" +
      "Q: pathophysiology | Verified A: Left ventricular hypertrophy.\n" +
      "Follow-up question:\nmanagement";
    const matches = await new CloudflareAiSearchRetrieval(namespace, undefined, true).retrieve({
      query,
      libraryId: null,
    });
    expect(namespace.searchInputs).toHaveLength(10);
    for (const search of namespace.searchInputs) {
      expect(search).toMatchObject({ query: "management and treatment of aortic stenosis" });
    }
    expect(matches).toHaveLength(1);
    expect(matches[0]?.itemKey).toBe("aortic-stenosis-management.html");
    expect(matches[0]?.sourceId).toBe("amboss:chunk-amboss-1");
  });

  it("V2 searches 24 candidates per index with Cloudflare native reranking", async () => {
    const ns = new FakeAiSearchNamespace(
      undefined,
      Object.fromEntries(
        expectedIds.map((id) => [
          instanceFor(id),
          { chunks: Array.from({ length: 15 }, (_, index) => chunk(id, index + 1)) },
        ]),
      ),
    );
    const retrieval = new CloudflareAiSearchRetrieval(ns, undefined, true);
    const selected = await retrieval.retrieve({ query: "aortic stenosis", libraryId: null });
    expect(ns.searchInputs).toHaveLength(5);
    for (const input of ns.searchInputs) {
      expect(input).toMatchObject({
        ai_search_options: {
          retrieval: { retrieval_type: "hybrid", max_num_results: 24 },
          reranking: { enabled: true, model: "@cf/baai/bge-reranker-base" },
        },
      });
    }
    expect(selected).toHaveLength(5);
    expect(new Set(selected.map((source) => source.sourceId)).size).toBe(5);
  });

  it("V2 can find a disease deep in the list without returning old-topic articles", async () => {
    const incorrect = Array.from({ length: 11 }, (_, i) => ({
      ...chunk("amboss", i + 1, 0.98),
      text: "Aortic stenosis and heart failure; pressure overload of aortic valve.",
      item: { key: "old-topic.html", metadata: { title: "Aortic stenosis" } },
    }));
    const fmf = {
      ...chunk("amboss", 12, 0.68),
      text: "Familial Mediterranean fever (FMF) is an autosomal recessive autoinflammatory disorder.",
      item: {
        key: "fmf.html",
        metadata: { title: "Familial Mediterranean fever", section: "Pathogenesis" },
      },
    };
    const ns = new FakeAiSearchNamespace(undefined, { amboss: { chunks: [...incorrect, fmf] } });
    const selection = await new CloudflareAiSearchRetrieval(ns, undefined, true).retrieve({
      query:
        "Prior discussion (untrusted context; use retrieved evidence only):\nAortic stenosis\n" +
        "Follow-up question:\nbrief summary of FMF",
      libraryId: null,
    });
    expect(selection.map((item) => item.itemKey)).toEqual(["fmf.html"]);
    expect(ns.searchInputs).toHaveLength(10);
    expect(
      ns.searchInputs.every((x) => (x as { query: string }).query === "brief summary of FMF"),
    ).toBe(true);
    expect(
      ns.searchInputs
        .slice(5)
        .every(
          (x) =>
            (x as { ai_search_options: { retrieval: { max_num_results: number } } })
              .ai_search_options.retrieval.max_num_results === 40,
        ),
    ).toBe(true);
  });

  it("V2 filters to an explicitly authorized library and never searches other indexes", async () => {
    const ns = new FakeAiSearchNamespace(undefined, {
      "one-examination-isolated": { chunks: [chunk("one-examination")] },
    });
    const found = await new CloudflareAiSearchRetrieval(ns, undefined, true).retrieve({
      query: "aortic stenosis",
      libraryId: "one-examination",
    });
    expect(found).toHaveLength(1);
    expect(ns.searchInputs).toHaveLength(1);
    expect(ns.searchInputs[0]).toMatchObject({
      ai_search_options: { instance_ids: ["one-examination-isolated"] },
    });
  });

  it("V2 preserves infrastructure errors instead of treating them as absent medical evidence", async () => {
    const ns = new FakeAiSearchNamespace();
    ns.search = async () => {
      throw new Error("AI Search reranking unavailable");
    };
    await expect(
      new CloudflareAiSearchRetrieval(ns, undefined, true).retrieve({
        query: "aortic stenosis",
        libraryId: null,
      }),
    ).rejects.toMatchObject({ status: 502, code: "SEARCH_FAILED" });
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
