import { describe, expect, it, vi } from "vitest";

import { PubMedResearchRetrieval, SourceModeRetrieval } from "./research-retrieval";
import type { RetrievalPort } from "./types";
import type { WorkersAiLike } from "../runtime/bindings";

const pubmedXml = `
<PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID>100</PMID><Article>
<ArticleTitle>New randomized trial in severe aortic stenosis</ArticleTitle>
<Abstract><AbstractText>Patients with severe aortic stenosis were compared in a randomized treatment trial with clinically important results.</AbstractText></Abstract>
<Journal><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal>
<PublicationTypeList><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList>
</Article></MedlineCitation><PubmedData><ArticleIdList>
<ArticleId IdType="doi">10.1000/new</ArticleId><ArticleId IdType="pmc">PMC789</ArticleId>
</ArticleIdList></PubmedData></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID>200</PMID><Article>
<ArticleTitle>Old aortic stenosis retrospective review</ArticleTitle>
<Abstract><AbstractText>Old aortic stenosis records were examined in a small retrospective analysis.</AbstractText></Abstract>
<Journal><JournalIssue><PubDate><Year>2010</Year></PubDate></JournalIssue></Journal>
<PublicationTypeList><PublicationType>Observational Study</PublicationType></PublicationTypeList>
</Article></MedlineCitation><PubmedData><ArticleIdList>
<ArticleId IdType="doi">10.1000/old</ArticleId>
</ArticleIdList></PubmedData></PubmedArticle>
</PubmedArticleSet>`;

function mockedFetch(
  config: {
    empty?: boolean;
    pmcFails?: boolean;
    alexFails?: boolean;
    pubmedFails?: boolean;
    europeFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/esearch.fcgi")) {
      if (config.pubmedFails) return new Response("temporarily blocked", { status: 503 });
      return Response.json({ esearchresult: { idlist: config.empty ? [] : ["100", "200"] } });
    }
    if (url.includes("ebi.ac.uk/europepmc/webservices/rest/search")) {
      if (config.europeFails) return new Response("unavailable", { status: 503 });
      return Response.json({
        resultList: {
          result: [
            {
              source: "MED",
              pmid: "100",
              title: "New randomized trial in severe aortic stenosis",
              abstractText:
                "Patients with severe aortic stenosis were compared in a randomized treatment trial.",
              pmcid: "PMC789",
              doi: "10.1000/new",
              pubYear: "2026",
              citedByCount: 2,
              pubTypeList: { pubType: ["Randomized Controlled Trial"] },
            },
            {
              source: "MED",
              pmid: "200",
              title: "Old aortic stenosis retrospective review",
              abstractText: "Old aortic stenosis records were examined in retrospective analysis.",
              pubYear: "2010",
              citedByCount: 1200,
            },
            {
              source: "PPR",
              pmid: "900",
              title: "Unverified preprint not PubMed",
              abstractText: "Not in PubMed.",
            },
          ],
        },
      });
    }
    if (url.includes("/efetch.fcgi") && url.includes("db=pubmed")) {
      return new Response(pubmedXml, { status: 200 });
    }
    if (url.includes("api.openalex.org")) {
      if (config.alexFails) return new Response("unavailable", { status: 503 });
      return Response.json({
        results: [
          { doi: "https://doi.org/10.1000/new", cited_by_count: 2 },
          { doi: "https://doi.org/10.1000/old", cited_by_count: 1200 },
        ],
      });
    }
    if (url.includes("/efetch.fcgi") && url.includes("db=pmc")) {
      if (config.pmcFails) return new Response("unavailable", { status: 503 });
      return new Response(`<pmc-articleset><article>
        <article-id pub-id-type="pmc">789</article-id>
        <sec><p>Severe aortic stenosis outcomes were compared in a contemporary randomized trial.</p></sec>
        <fig><caption><p>Severe aortic stenosis treatment figure illustrates the trial design and outcomes.</p></caption></fig>
      </article></pmc-articleset>`);
    }
    return new Response("not found", { status: 404 });
  });
  return { fake: fake as unknown as typeof fetch, calls };
}

describe("PubMed Research Mode adapter", () => {
  it("discovers studies, enriches citations, ranks evidence and includes PMC content", async () => {
    const { fake, calls } = mockedFetch();
    const adapter = new PubMedResearchRetrieval({
      fetcher: fake,
      ncbiApiKey: "test-ncbi",
      openAlexApiKey: "test-openalex",
    });
    const evidence = await adapter.retrieve({
      query: "Severe aortic stenosis randomized treatment",
      libraryId: null,
      sourceMode: "research",
    });
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.sourceId).toBe("pubmed:100");
    expect(evidence[0]?.text).toContain("Figure caption");
    expect(evidence[0]?.text).toContain("PubMed abstract");
    expect(evidence[0]?.instanceId).toBe("pubmed");
    expect(calls.some((url) => url.includes("api.openalex.org") && url.includes("filter="))).toBe(
      true,
    );
    expect(calls.some((url) => url.includes("db=pmc"))).toBe(true);
  });

  it("uses one contextual Qwen route and two deduplicated PubMed discovery queries", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () => ({
        response: JSON.stringify({
          intent: "MEDICAL",
          search_query: "aortic stenosis management treatment",
          search_queries: [
            "aortic stenosis management treatment",
            "aortic stenosis transcatheter valve replacement outcomes",
          ],
        }),
      })),
    };
    const { fake, calls } = mockedFetch();
    const adapter = new PubMedResearchRetrieval({
      fetcher: fake,
      qwenAi: ai,
      enableQwenRouting: true,
    });
    const route = await adapter.route!({
      query: "management",
      libraryId: null,
      sourceMode: "research",
      recentUserMessages: ["aortic stenosis", "management"],
    });
    expect(route.intent).toBe("medical");
    if (route.intent !== "medical") throw new Error("Expected contextual medical route");
    expect(route.searchQuery.toLowerCase()).toContain("aortic stenosis");
    const found = await adapter.retrieve({
      query: "management",
      libraryId: null,
      sourceMode: "research",
      preparedQuery: route.searchQuery,
      preparedQueries: route.searchQueries,
    });
    expect(found.map((paper) => paper.sourceId)).toEqual(["pubmed:100", "pubmed:200"]);
    expect(vi.mocked(ai.run)).toHaveBeenCalledTimes(1);
    expect(calls.filter((url) => url.includes("esearch.fcgi"))).toHaveLength(2);
    const searches = calls.filter((url) => url.includes("esearch.fcgi"));
    expect(new URL(searches[1]!).searchParams.get("term")).toContain("Practice Guideline[pt]");
    expect(new URL(searches[1]!).searchParams.get("term")).toContain("aortic stenosis");
    const fetched = calls.filter((url) => url.includes("efetch.fcgi") && url.includes("db=pubmed"));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("id=100%2C200");
  });

  it("rescues older disease-specific Practice Guidelines that are absent from broad PubMed hits", async () => {
    const calls: string[] = [];
    const fake = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("esearch.fcgi")) {
        const isGuidelines = new URL(url).searchParams
          .get("term")
          ?.includes("Practice Guideline[pt]");
        return Response.json({ esearchresult: { idlist: isGuidelines ? ["200"] : ["100"] } });
      }
      if (url.includes("efetch.fcgi") && url.includes("db=pubmed")) {
        return new Response(
          "<PubmedArticleSet>" +
            "<PubmedArticle><MedlineCitation><PMID>100</PMID><Article>" +
            "<ArticleTitle>Polygenic risk score in aortic stenosis</ArticleTitle>" +
            "<Abstract><AbstractText>Genetic prediction of aortic stenosis.</AbstractText></Abstract>" +
            "<Journal><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal>" +
            "<PublicationTypeList><PublicationType>Journal Article</PublicationType></PublicationTypeList>" +
            "</Article></MedlineCitation></PubmedArticle>" +
            "<PubmedArticle><MedlineCitation><PMID>200</PMID><Article>" +
            "<ArticleTitle>Clinical practice guidelines for aortic stenosis diagnosis and management</ArticleTitle>" +
            "<Abstract><AbstractText>Aortic stenosis severity, diagnosis and treatment recommendations.</AbstractText></Abstract>" +
            "<Journal><JournalIssue><PubDate><Year>2021</Year></PubDate></JournalIssue></Journal>" +
            "<PublicationTypeList><PublicationType>Practice Guideline</PublicationType></PublicationTypeList>" +
            "</Article></MedlineCitation></PubmedArticle>" +
            "</PubmedArticleSet>",
        );
      }
      return new Response("optional provider unavailable", { status: 503 });
    });
    const adapter = new PubMedResearchRetrieval({
      fetcher: fake as typeof fetch,
      enableQwenRouting: true,
    });
    const results = await adapter.retrieve({
      query: "aortic stenosis",
      libraryId: null,
      sourceMode: "research",
      preparedQuery: "aortic stenosis management",
    });
    expect(results[0]?.sourceId).toBe("pubmed:200");
    expect(results[0]?.text).toContain("Study type: Practice Guideline");
    expect(results).toHaveLength(2);
    expect(calls.filter((url) => url.includes("esearch.fcgi"))).toHaveLength(2);
  });

  it("allocates PubMed abstracts across many distinct original PMIDs", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(i + 1000));
    const xml =
      "<PubmedArticleSet>" +
      ids
        .map(
          (id) =>
            "<PubmedArticle><MedlineCitation><PMID>" +
            id +
            "</PMID><Article><ArticleTitle>Aortic stenosis trial " +
            id +
            "</ArticleTitle><Abstract><AbstractText>" +
            "Severe aortic stenosis treatment was studied across multiple cohorts. ".repeat(3) +
            "</AbstractText></Abstract><Journal><JournalIssue><PubDate><Year>2026</Year>" +
            "</PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle>",
        )
        .join("") +
      "</PubmedArticleSet>";
    const fake = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) return Response.json({ esearchresult: { idlist: ids } });
      if (url.includes("efetch.fcgi") && url.includes("db=pubmed")) return new Response(xml);
      return new Response("unavailable", { status: 503 });
    });
    const found = await new PubMedResearchRetrieval({ fetcher: fake as typeof fetch }).retrieve({
      query: "aortic stenosis management",
      libraryId: null,
      sourceMode: "research",
    });
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(new Set(found.map((paper) => paper.sourceId)).size).toBe(found.length);
    expect(found.every((paper) => paper.text.includes("PubMed abstract:"))).toBe(true);
  });

  it("handles PubMed no-results without fabricated citations", async () => {
    const { fake } = mockedFetch({ empty: true });
    const evidence = await new PubMedResearchRetrieval({ fetcher: fake }).retrieve({
      query: "unknown query",
      libraryId: null,
    });
    expect(evidence).toEqual([]);
  });

  it("continues from abstracts when optional enrichment providers fail", async () => {
    const { fake } = mockedFetch({ pmcFails: true, alexFails: true });
    const evidence = await new PubMedResearchRetrieval({
      fetcher: fake,
      openAlexApiKey: "test-openalex",
    }).retrieve({ query: "aortic stenosis", libraryId: null });
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.sourceId).toBe("pubmed:100");
  });

  it("falls back to Europe PMC when NCBI ESearch is unavailable and retains original PMIDs", async () => {
    const { fake, calls } = mockedFetch({ pubmedFails: true });
    const evidence = await new PubMedResearchRetrieval({ fetcher: fake }).retrieve({
      query: "aortic stenosis",
      libraryId: null,
      sourceMode: "research",
    });
    expect(evidence).toHaveLength(2);
    expect(evidence.map((item) => item.sourceId).sort()).toEqual(["pubmed:100", "pubmed:200"]);
    expect(calls.some((url) => url.includes("ebi.ac.uk/europepmc/webservices/rest/search"))).toBe(
      true,
    );
    expect(evidence.every((item) => item.text.includes("PubMed abstract:"))).toBe(true);
  });

  it("fails closed when both independent biomedical search providers are unavailable", async () => {
    const { fake } = mockedFetch({ pubmedFails: true, europeFails: true });
    await expect(
      new PubMedResearchRetrieval({ fetcher: fake }).retrieve({
        query: "aortic stenosis",
        libraryId: null,
        sourceMode: "research",
      }),
    ).rejects.toMatchObject({ code: "SEARCH_FAILED" });
  });

  it("keeps Research and Library modes on distinct retrieval adapters", async () => {
    const libraries: RetrievalPort = {
      retrieve: vi.fn(async () => []),
    };
    const research: RetrievalPort = {
      retrieve: vi.fn(async () => []),
    };
    const router = new SourceModeRetrieval(libraries, research);
    await router.retrieve({ query: "test", libraryId: null });
    await router.retrieve({ query: "test", libraryId: null, sourceMode: "research" });
    expect(libraries.retrieve).toHaveBeenCalledTimes(1);
    expect(research.retrieve).toHaveBeenCalledTimes(1);
  });

  it("rejects mixing research with an indexed library filter", async () => {
    const adapter = new PubMedResearchRetrieval({ fetcher: mockedFetch().fake });
    await expect(adapter.retrieve({ query: "test", libraryId: "amboss" })).rejects.toMatchObject({
      code: "INVALID_SOURCE_MODE",
    });
  });
});
