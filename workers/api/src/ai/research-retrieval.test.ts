import { describe, expect, it, vi } from "vitest";

import { PubMedResearchRetrieval, SourceModeRetrieval } from "./research-retrieval";
import type { RetrievalPort } from "./types";

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

function mockedFetch(config: { empty?: boolean; pmcFails?: boolean; alexFails?: boolean } = {}) {
  const calls: string[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/esearch.fcgi")) {
      return Response.json({ esearchresult: { idlist: config.empty ? [] : ["100", "200"] } });
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
