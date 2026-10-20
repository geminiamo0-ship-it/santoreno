import { describe, expect, it, vi } from "vitest";
import { PmcResearchFigureProvider, pmcidFromSavedSource } from "./research-figures";

const metadata = {
  pmcid: "PMC12345",
  version: 2,
  license_code: "cc-by",
  is_retracted: false,
  xml_url: "https://pmc-oa-opendata.s3.amazonaws.com/PMC12345.2/PMC12345.2.xml?md5=test",
  media_urls: [
    "https://pmc-oa-opendata.s3.amazonaws.com/PMC12345.2/fig-1.jpg?md5=real",
    "https://outside.example.com/bad.jpg",
  ],
};
const xml = `<article><body><fig id="F1"><caption><p>Cardiac valve anatomy in aortic stenosis</p></caption>
  <graphic xlink:href="fig-1.jpg"/></fig></body></article>`;

function mockFetch(changes: Partial<typeof metadata> = {}) {
  const request = vi.fn(async (url: RequestInfo | URL) => {
    const href = String(url);
    if (href.includes("list-type=2")) {
      return new Response(
        "<ListBucketResult><CommonPrefixes><Prefix>PMC12345.1/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>PMC12345.2/</Prefix></CommonPrefixes></ListBucketResult>",
      );
    }
    if (href.includes("/metadata/")) return Response.json({ ...metadata, ...changes });
    if (href.includes(".xml")) return new Response(xml);
    return new Response("not found", { status: 404 });
  });
  return request;
}

describe("authorized PMC research figures", () => {
  it("resolves real figure/caption pairs from official AWS metadata", async () => {
    const fetcher = mockFetch();
    const result = await new PmcResearchFigureProvider(fetcher as typeof fetch).find("PMC12345");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pmcid: "PMC12345",
      license: "cc-by",
      caption: "Cardiac valve anatomy in aortic stenosis",
    });
    expect(result[0]?.url).toContain("pmc-oa-opendata.s3.amazonaws.com/PMC12345.2/fig-1.jpg");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("omits all media for NC or unknown licenses", async () => {
    expect(
      await new PmcResearchFigureProvider(
        mockFetch({ license_code: "cc-by-nc" }) as typeof fetch,
      ).find("PMC12345"),
    ).toEqual([]);
  });

  it("omits retracted articles and rejects mismatched source identifiers", async () => {
    expect(
      await new PmcResearchFigureProvider(mockFetch({ is_retracted: true }) as typeof fetch).find(
        "PMC12345",
      ),
    ).toEqual([]);
    const finder = new PmcResearchFigureProvider(mockFetch() as typeof fetch);
    expect(await finder.find("https://evil.test")).toEqual([]);
    expect(
      pmcidFromSavedSource({
        instanceId: "pubmed",
        sourceId: "pubmed:101",
        section: "PubMed / PMC PMC12345",
      }),
    ).toBe("PMC12345");
    expect(
      pmcidFromSavedSource({
        instanceId: "amboss",
        sourceId: "pubmed:101",
        section: "PubMed / PMC PMC12345",
      }),
    ).toBeNull();
  });
});
