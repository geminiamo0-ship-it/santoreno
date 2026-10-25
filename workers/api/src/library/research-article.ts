import type { SessionContextResponse } from "@santo/contracts";
import {
  LibraryArticleSchema,
  SourceArticleRequestSchema,
  SourceArticleResponseSchema,
  type SourceArticleResponse,
} from "@santo/contracts/library-reader";
import { R2VerifiedSourceStore } from "../sources/store";
import { LibraryReaderError } from "./reader";
import { loadLicensedPmcFigures } from "../ai/pmc-figures";

const EUROPE_PMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/";
const MAX_BYTES = 1_500_000;
const MAX_FULL_TEXT = 68_000;
const REQUEST_TIMEOUT_MS = 7000;

/** Decode a strictly text-only copy; HTML is never trusted or injected from the API. */
function plainText(raw: string): string {
  return raw
    .replace(/<\/(?:p|sec|title)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:amp|lt|gt|quot|apos);/g,
      (token) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
        })[token] ?? " ",
    )
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function pubmedRecord(raw: unknown, pmid: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { resultList?: { result?: unknown } }).resultList?.result;
  if (!Array.isArray(list)) return null;
  return (
    (list.find(
      (x) =>
        x &&
        typeof x === "object" &&
        (x as Record<string, unknown>).source === "MED" &&
        (x as Record<string, unknown>).pmid === pmid,
    ) as Record<string, unknown> | undefined) ?? null
  );
}

export class PubMedArticleViewerService {
  constructor(
    private readonly snapshotStore: R2VerifiedSourceStore,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly enablePmcFigures = false,
  ) {}

  private async download(url: URL): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // Europe PMC may redirect to its canonical EBI URL.
        redirect: "follow",
        headers: { accept: "application/json, application/xml" },
      });
      if (response.redirected) {
        const finalUrl = new URL(response.url);
        if (
          finalUrl.protocol !== "https:" ||
          finalUrl.hostname !== "www.ebi.ac.uk" ||
          !finalUrl.pathname.startsWith("/europepmc/webservices/rest/")
        ) {
          throw new Error("Unexpected provider redirect");
        }
      }
      if (!response.ok) throw new Error("upstream status");
      if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES)
        throw new Error("too large");
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new Error("too large");
      return body;
    } catch {
      throw new LibraryReaderError(503, "LIBRARY_UNAVAILABLE");
    }
  }

  async fromCitation(
    session: SessionContextResponse,
    raw: unknown,
  ): Promise<SourceArticleResponse> {
    const request = SourceArticleRequestSchema.safeParse(raw);
    if (!request.success) throw new LibraryReaderError(400, "INVALID_LIBRARY_REQUEST");

    // The caller never controls PMID/PMCID or a provider URL. Resolve exclusively
    // through a tenant/user-owned verified citation in the signed conversation.
    const sources = await this.snapshotStore.load({
      ...session,
      messageId: request.data.messageId,
    });
    const source = sources.find((s) => s.sourceId === request.data.sourceId);
    if (
      !source ||
      source.instanceId !== "pubmed" ||
      source.libraryId !== "pubmed" ||
      !/^pubmed:\d{1,12}$/.test(source.sourceId)
    ) {
      throw new LibraryReaderError(404, "LIBRARY_ARTICLE_NOT_AVAILABLE");
    }
    const pmid = source.sourceId.slice(7);
    const url = new URL(EUROPE_PMC + "search");
    url.searchParams.set("query", "EXT_ID:" + pmid + " AND SRC:MED");
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", "1");

    let record: Record<string, unknown> | null;
    try {
      record = pubmedRecord(JSON.parse(await this.download(url)) as unknown, pmid);
    } catch (e) {
      if (e instanceof LibraryReaderError) throw e;
      throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    }
    if (!record) throw new LibraryReaderError(404, "LIBRARY_ARTICLE_NOT_AVAILABLE");

    const title = typeof record.title === "string" ? plainText(record.title).slice(0, 500) : "";
    const abstract =
      typeof record.abstractText === "string"
        ? plainText(record.abstractText).slice(0, 160_000)
        : "";
    const year = typeof record.pubYear === "string" ? record.pubYear : "Unknown";
    const journal = typeof record.journalTitle === "string" ? record.journalTitle : "PubMed";
    const authors =
      typeof record.authorString === "string" ? record.authorString.slice(0, 1200) : "";
    const doi = typeof record.doi === "string" ? record.doi.slice(0, 200) : "";
    const metadata = [
      "PMID: " + pmid,
      "Published: " + year,
      "Journal: " + journal,
      ...(authors ? ["Authors: " + authors] : []),
      ...(doi ? ["DOI: " + doi] : []),
    ].join("\n");

    const sections = [
      {
        id: "s-0001",
        heading: "Abstract",
        text: abstract || "Abstract is unavailable from this indexed medical record.",
        images: [],
      },
      { id: "s-0002", heading: "Publication details", text: metadata, images: [] },
    ];
    const pmcid =
      typeof record.pmcid === "string" && /^PMC\d{1,12}$/.test(record.pmcid) ? record.pmcid : null;
    // Optional structured full text is read on demand; it is not taken from R2.
    if (pmcid) {
      try {
        const full = new URL(EUROPE_PMC + encodeURIComponent(pmcid) + "/fullTextXML");
        const xml = await this.download(full);
        if (this.enablePmcFigures) {
          const figures = await loadLicensedPmcFigures(pmcid, xml, this.fetcher);
          if (figures.length) {
            sections.splice(1, 0, {
              id: "s-0004",
              heading: "Original PMC figures — open-access licensed",
              text:
                "Figures supplied by the original cited PMC article. Attribution and license: " +
                pmcid +
                ", " +
                [...new Set(figures.map((figure) => figure.license))].join(", ") +
                ". " +
                "Image descriptions are original figure captions, not independent medical conclusions.",
              images: figures.slice(0, 24).map((figure) => ({
                src: figure.src,
                alt: (figure.caption + " (" + figure.pmcid + "; " + figure.license + ")").slice(
                  0,
                  250,
                ),
              })),
            });
          }
        }
        const body = /<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i.exec(xml)?.[1];
        if (body) {
          const paragraphs = [...body.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)]
            .map((p) => plainText(p[1] ?? ""))
            .filter((x) => x.length >= 20);
          const fullText = paragraphs.join("\n\n").slice(0, MAX_FULL_TEXT);
          if (fullText)
            sections.splice(1, 0, {
              id: "s-0003",
              heading: "Full-text excerpts (PMC)",
              text: fullText,
              images: [],
            });
        }
      } catch {
        // Valid medical abstract remains browsable if PMC full text is unavailable.
      }
    }
    const article = LibraryArticleSchema.safeParse({
      schemaVersion: 1,
      libraryId: "pubmed",
      articleId: "pmid-" + pmid,
      title: title || source.title,
      category: "Published medical research",
      source: pmcid ? "PubMed / PMC" : "PubMed",
      sections,
    });
    if (!article.success) throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    return SourceArticleResponseSchema.parse({
      source,
      article: article.data,
      highlightSectionId: "s-0001",
    });
  }
}
