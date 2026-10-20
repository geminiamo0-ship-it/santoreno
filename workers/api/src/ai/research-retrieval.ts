import { GroundedAiError } from "./errors";
import { selectPmcTeachingPassages } from "./research-fulltext";
import type { RetrievalPort, RetrievalRequest, RetrievedEvidence } from "./types";

export interface ResearchProviderConfig {
  ncbiApiKey?: string;
  openAlexApiKey?: string;
  fetcher?: typeof fetch;
}

/** PubMed discovery is independent of Santo's indexed knowledge-library search. */
interface Paper {
  pmid: string;
  pmcid: string | null;
  doi: string | null;
  title: string;
  abstract: string;
  year: number | null;
  types: string[];
  citations: number | null;
  position: number;
  score: number;
}

const PUBMED = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
const OPENALEX = "https://api.openalex.org/works";
const MAX_CANDIDATES = 60; // Network bound, not a model/source citation count.
const MAX_EVIDENCE_BYTES = 22_000; // Approx. 5.5k input tokens; preserves room for prompt/history + 3k output.
const FIRST_PAPER_BYTES = 15_000;
const FOLLOWUP_PAPER_BYTES = 2_500;
const MAX_DOWNLOAD_BYTES = 1_500_000;
const TIMEOUT_MS = 4000;
/** Real NCBI/Europe PMC JATS uses pub-id-type='pmcid' with 'PMC' prefix; allow older 'pmc' too. */
function pmcArticleIdentity(xml: string): string | null {
  const found =
    /<article-id\b[^>]*\bpub-id-type=["'](?:pmcid|pmc)["'][^>]*>\s*(?:PMC)?(\d+)\s*<\/article-id>/i.exec(xml);
  return found ? "PMC" + found[1] : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity] ?? "",
    )
    .replace(/\s+/g, " ")
    .trim();
}
function tag(xml: string, name: string): string | null {
  const match = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i").exec(
    xml,
  );
  return match ? decodeXml(match[1] ?? "") : null;
}
function fieldId(xml: string, idType: string): string | null {
  const match = new RegExp(
    "<ArticleId\\s+IdType=[\"']" + idType + "[\"']>([^<]+)<\\/ArticleId>",
    "i",
  ).exec(xml);
  return match?.[1]?.trim() ?? null;
}
function xmlChunks(xml: string, name: string): string[] {
  return [
    ...xml.matchAll(new RegExp("<" + name + "(?:\\s[^>]*)?>[\\s\\S]*?<\\/" + name + ">", "gi")),
  ].map((match) => match[0]);
}
function numeric(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function normalizedDoi(value: string): string {
  return value
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim()
    .toLowerCase();
}
function extractPapers(xml: string, ids: readonly string[]): Paper[] {
  const wanted = new Set(ids);
  const found = new Map<string, Paper>();
  for (const block of xmlChunks(xml, "PubmedArticle")) {
    const pmid = tag(block, "PMID");
    if (!pmid || !/^\d+$/.test(pmid) || !wanted.has(pmid) || found.has(pmid)) continue;
    const title = tag(block, "ArticleTitle");
    if (!title) continue;
    const sections = [...block.matchAll(/<AbstractText(?:\s[^>]*)?>([\s\S]*?)<\/AbstractText>/gi)]
      .map((match) => decodeXml(match[1] ?? ""))
      .filter(Boolean);
    const types = xmlChunks(block, "PublicationType").map(decodeXml);
    const year = numeric(tag(block, "Year"));
    const doi = fieldId(block, "doi");
    const pmc = fieldId(block, "pmc");
    found.set(pmid, {
      pmid,
      pmcid: pmc && /^PMC\d+$/i.test(pmc) ? pmc.toUpperCase() : null,
      doi: doi ? normalizedDoi(doi) : null,
      title: title.slice(0, 480),
      abstract: sections.join(" ").slice(0, 8500),
      year,
      types,
      citations: null,
      position: ids.indexOf(pmid),
      score: 0,
    });
  }
  return [...found.values()];
}

function keyTerms(value: string): string[] {
  const stop = new Set([
    "about",
    "after",
    "before",
    "what",
    "which",
    "where",
    "when",
    "with",
    "from",
    "that",
    "this",
    "into",
    "for",
    "the",
    "and",
    "are",
    "how",
    "latest",
    "research",
    "evidence",
    "study",
    "studies",
  ]);
  return [
    ...new Set(
      (value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((term) => !stop.has(term)),
    ),
  ].slice(0, 40);
}
function rankPapers(papers: Paper[], query: string): Paper[] {
  const terms = keyTerms(query);
  const currentYear = new Date().getUTCFullYear();
  const maxCitations = Math.max(1, ...papers.map((p) => p.citations ?? 0));
  const positiveLog = Math.log1p(maxCitations);
  return papers
    .filter((p) => !p.types.some((type) => /retract(ed|ion)/i.test(type)))
    .map((p) => {
      const haystack = (p.title + " " + p.abstract).toLowerCase();
      const matched = terms.filter((term) => haystack.includes(term)).length;
      const relevance =
        0.65 * (terms.length ? matched / terms.length : 1) +
        0.35 * (1 - p.position / Math.max(1, MAX_CANDIDATES));
      const study = p.types.some((t) =>
        /systematic review|meta.analysis|practice guideline/i.test(t),
      )
        ? 1
        : p.types.some((t) => /randomized controlled trial/i.test(t))
          ? 0.95
          : p.types.some((t) => /clinical trial|comparative study/i.test(t))
            ? 0.75
            : 0.45;
      const age = p.year ? Math.max(0, currentYear - p.year) : 20;
      const recency = 1 / (1 + age / 5);
      const adjustedCitations = (p.citations ?? 0) / (1 + age);
      const influence =
        p.citations === null ? 0.5 : Math.min(1, Math.log1p(adjustedCitations) / positiveLog);
      return { ...p, score: 0.4 * relevance + 0.3 * study + 0.2 * recency + 0.1 * influence };
    })
    .sort((a, b) => b.score - a.score || a.position - b.position);
}

/** Fixed provider hosts and response-size bounds; no arbitrary URLs from papers or users. */
export class PubMedResearchRetrieval implements RetrievalPort {
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: ResearchProviderConfig = {}) {
    // Cloudflare's native fetch must be invoked as a global function, not
    // extracted and called as a class method (which causes Illegal invocation).
    this.fetcher = config.fetcher ?? ((input, init) => fetch(input, init));
  }

  private async get(url: URL, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<string> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        signal: combined,
        headers: { accept: "application/xml, application/json" },
      });
    } catch {
      throw new GroundedAiError(502, "SEARCH_FAILED", "Research provider unavailable");
    }
    if (!response.ok) throw new GroundedAiError(502, "SEARCH_FAILED", "Research provider failed");
    const headerLength = Number(response.headers.get("content-length") ?? "0");
    if (headerLength > MAX_DOWNLOAD_BYTES)
      throw new GroundedAiError(502, "SEARCH_FAILED", "Research response too large");
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_DOWNLOAD_BYTES) {
      throw new GroundedAiError(502, "SEARCH_FAILED", "Research response too large");
    }
    return text;
  }

  private ncbiUrl(operation: "esearch" | "efetch", params: Record<string, string>): URL {
    const url = new URL(PUBMED + operation + ".fcgi");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (this.config.ncbiApiKey?.trim())
      url.searchParams.set("api_key", this.config.ncbiApiKey.trim());
    return url;
  }

  private async enrichOpenAlex(papers: Paper[], signal?: AbortSignal): Promise<void> {
    const dois = [...new Set(papers.map((p) => p.doi).filter((doi): doi is string => !!doi))].slice(
      0,
      60,
    );
    if (!dois.length || !this.config.openAlexApiKey?.trim()) return;
    const url = new URL(OPENALEX);
    url.searchParams.set("filter", "doi:" + dois.map((doi) => "https://doi.org/" + doi).join("|"));
    url.searchParams.set("per_page", String(Math.min(100, dois.length)));
    url.searchParams.set("select", "doi,cited_by_count,publication_year");
    url.searchParams.set("api_key", this.config.openAlexApiKey.trim());
    try {
      const data: unknown = JSON.parse(await this.get(url, signal, 1200));
      if (!data || typeof data !== "object" || !("results" in data)) return;
      const results = (data as { results?: unknown }).results;
      if (!Array.isArray(results)) return;
      const counts = new Map<string, number>();
      for (const row of results) {
        if (!row || typeof row !== "object") continue;
        const x = row as { doi?: unknown; cited_by_count?: unknown };
        if (
          typeof x.doi === "string" &&
          typeof x.cited_by_count === "number" &&
          x.cited_by_count >= 0
        ) {
          counts.set(normalizedDoi(x.doi), x.cited_by_count);
        }
      }
      for (const paper of papers)
        if (paper.doi && counts.has(paper.doi)) paper.citations = counts.get(paper.doi)!;
    } catch {
      // Citation counts are an OPTIONAL rank signal, never a clinical evidence dependency.
    }
  }

  private async fallbackEuropePmc(question: string, signal?: AbortSignal): Promise<Paper[]> {
    // Europe PMC indexes PubMed (MED) records with stable PMIDs. This is an
    // independent read-only fallback when NCBI E-utilities is unavailable.
    const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
    url.searchParams.set("query", question.slice(0, 1800));
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", String(MAX_CANDIDATES));
    const payload: unknown = JSON.parse(await this.get(url, signal));
    const root =
      payload && typeof payload === "object"
        ? (payload as { resultList?: { result?: unknown } }).resultList
        : null;
    if (!Array.isArray(root?.result)) {
      throw new GroundedAiError(
        502,
        "SEARCH_FAILED",
        "Both biomedical search providers unavailable",
      );
    }
    const papers: Paper[] = [];
    const seen = new Set<string>();
    for (const item of root.result) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const pmid = record.pmid;
      const title = record.title;
      if (
        record.source !== "MED" ||
        typeof pmid !== "string" ||
        !/^\d+$/.test(pmid) ||
        typeof title !== "string" ||
        title.trim().length < 4 ||
        seen.has(pmid)
      )
        continue;
      if (record.isRetracted === true || record.isRetracted === "Y") continue;
      const abstract =
        typeof record.abstractText === "string"
          ? decodeXml(record.abstractText).slice(0, 8500)
          : "";
      if (!abstract.trim()) continue;
      const doi =
        typeof record.doi === "string" && record.doi.length < 250
          ? normalizedDoi(record.doi)
          : null;
      const pmcid =
        typeof record.pmcid === "string" && /^PMC\d+$/i.test(record.pmcid)
          ? record.pmcid.toUpperCase()
          : null;
      const yearRaw = typeof record.pubYear === "string" ? record.pubYear : "";
      const year = numeric(yearRaw);
      const citations =
        typeof record.citedByCount === "number" &&
        Number.isSafeInteger(record.citedByCount) &&
        record.citedByCount >= 0
          ? record.citedByCount
          : null;
      seen.add(pmid);
      papers.push({
        pmid,
        title: title.slice(0, 480),
        abstract,
        doi,
        pmcid,
        year,
        citations,
        position: papers.length,
        score: 0,
        types:
          typeof record.pubTypeList === "object" &&
          record.pubTypeList !== null &&
          Array.isArray((record.pubTypeList as { pubType?: unknown }).pubType)
            ? (record.pubTypeList as { pubType: unknown[] }).pubType
                .filter((x): x is string => typeof x === "string")
                .slice(0, 12)
            : [],
      });
    }
    return papers;
  }
  async retrieve(request: RetrievalRequest): Promise<RetrievedEvidence[]> {
    if (request.libraryId !== null) {
      throw new GroundedAiError(
        400,
        "INVALID_SOURCE_MODE",
        "Research cannot combine with a library filter",
      );
    }
    const signal = request.signal;
    const startedAt = Date.now();
    const cleanQuestion = request.query.includes("Follow-up question:")
      ? request.query.split("Follow-up question:").at(-1)!.trim()
      : request.query;
    let papers: Paper[];
    try {
      const search = this.ncbiUrl("esearch", {
        db: "pubmed",
        term: cleanQuestion.slice(0, 1800),
        retmax: String(MAX_CANDIDATES),
        retmode: "json",
        sort: "relevance",
      });
      const result: unknown = JSON.parse(await this.get(search, signal));
      const root =
        result && typeof result === "object"
          ? (result as { esearchresult?: { idlist?: unknown } }).esearchresult
          : null;
      const ids = Array.isArray(root?.idlist)
        ? root.idlist.filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
        : [];
      if (!ids.length) return [];
      const xml = await this.get(
        this.ncbiUrl("efetch", {
          db: "pubmed",
          id: ids.join(","),
          retmode: "xml",
        }),
        signal,
      );
      papers = extractPapers(xml, ids);
      // Malformed-but-200 provider responses must not silently mean no evidence.
      if (papers.length === 0) {
        throw new GroundedAiError(502, "SEARCH_FAILED", "PubMed returned no parseable records");
      }
    } catch (primaryError) {
      if (signal?.aborted) throw primaryError;
      try {
        papers = await this.fallbackEuropePmc(cleanQuestion, signal);
      } catch {
        throw primaryError instanceof GroundedAiError
          ? primaryError
          : new GroundedAiError(502, "SEARCH_FAILED", "Research discovery unavailable");
      }
    }
    if (!papers.length) return [];
    // Full-text is the primary evidence for a treatment question. Avoid
    // spending the short retrieval deadline on optional citation-count ranking
    // before contacting PMC. The first relevant articles get priority.
    const ranked = rankPapers(papers, cleanQuestion);
    const eligible = ranked.filter((paper) => paper.pmcid).slice(0, 4);
    const fullText = new Map<string, string>();
    let providerStatus: "not_applicable" | "ok" | "failed" = "not_applicable";
    if (eligible.length && !signal?.aborted) {
      try {
        const records = await this.get(
          this.ncbiUrl("efetch", {
            db: "pmc",
            id: eligible.map((paper) => paper.pmcid!.slice(3)).join(","),
            retmode: "xml",
          }),
          signal,
          4_500,
        );
        for (const article of xmlChunks(records, "article")) {
          const pmcid = pmcArticleIdentity(article);
          if (pmcid && eligible.some((paper) => paper.pmcid === pmcid)) {
            fullText.set(pmcid, article);
          }
        }
        providerStatus = fullText.size ? "ok" : "failed";
      } catch {
        providerStatus = "failed";
      }
    }

    // A single targeted Europe PMC fullTextXML fallback rescues the most
    // relevant original article if NCBI EFetch timed out or omitted it.
    // Never add uncited material from another paper or fabricate passages.
    const firstPmc = eligible[0]?.pmcid;
    if (firstPmc && !fullText.has(firstPmc) && !signal?.aborted) {
      try {
        const url = new URL(
          "https://www.ebi.ac.uk/europepmc/webservices/rest/" + firstPmc + "/fullTextXML",
        );
        const xml = await this.get(url, signal, 2_500);
        if (pmcArticleIdentity(xml) === firstPmc) {
          const article = xmlChunks(xml, "article")[0];
          if (article) fullText.set(firstPmc, article);
        }
      } catch {
        // The article may still be cited as ABSTRACT ONLY, explicitly labeled.
      }
    }
    // Citation counts are advisory metadata, not a reason to delay or suppress
    // the clinical sections. Enrich only with remaining time.
    if (Date.now() - startedAt < 7_500) await this.enrichOpenAlex(papers, signal);
    console.info("santo_research_pmc_evidence", {
      eligible: eligible.length,
      fulltext: fullText.size,
      abstractOnly: Math.max(0, eligible.length - fullText.size),
      status: providerStatus,
    });

    const output: RetrievedEvidence[] = [];
    let budget = MAX_EVIDENCE_BYTES;
    for (const paper of ranked) {
      if (budget < 450 || output.length >= 12) break;
      const pmc = paper.pmcid ? fullText.get(paper.pmcid) : undefined;
      const perPaper = Math.min(
        budget,
        output.length === 0 ? FIRST_PAPER_BYTES : FOLLOWUP_PAPER_BYTES,
      );
      const fullTextSelection = pmc
        ? selectPmcTeachingPassages(pmc, cleanQuestion, Math.max(0, perPaper - 1_200))
        : { text: "", sectionCount: 0 };
      const status = fullTextSelection.text
        ? "PMC full-text passages available and included (selected relevant sections, not the entire article)."
        : paper.pmcid
          ? "PMC full-text unavailable or no relevant passage extracted: ABSTRACT ONLY. Do not claim this abstract verifies specific management doses or thresholds."
          : "No indexed PMC full text: ABSTRACT ONLY.";
      const header = [
        "Publication year: " + (paper.year ?? "unknown"),
        "Study type: " + (paper.types.join(", ") || "not classified"),
        "Citations indexed by OpenAlex: " + (paper.citations ?? "unavailable"),
        "Evidence coverage: " + status,
        "PubMed abstract: " + paper.abstract.slice(0, fullTextSelection.text ? 650 : 1_900),
      ].join("\n");
      const text =
        header +
        (fullTextSelection.text
          ? "\nVerified PMC full-text excerpts by section:\n" + fullTextSelection.text
          : "");
      const selected = new TextEncoder().encode(text).length <= perPaper ? text : header; // Never silently cut medical numbers or dosing mid-sentence.
      const consumed = new TextEncoder().encode(selected).length;
      if (consumed > budget || (!paper.abstract.trim() && !fullTextSelection.text)) continue;
      budget -= consumed;
      output.push({
        sourceId: "pubmed:" + paper.pmid,
        libraryId: "pubmed",
        instanceId: "pubmed",
        itemKey: "pmid:" + paper.pmid,
        title: paper.title,
        page: null,
        section: paper.pmcid ? "PubMed / PMC " + paper.pmcid : "PubMed abstract",
        text: selected,
        score: paper.score,
      });
    }
    return output;
  }
}

/** Research and existing libraries still use the SAME model / quota / conversation pathway. */
export class SourceModeRetrieval implements RetrievalPort {
  constructor(
    private readonly libraries: RetrievalPort,
    private readonly research: RetrievalPort,
  ) {}
  retrieve(request: RetrievalRequest): Promise<RetrievedEvidence[]> {
    return (request.sourceMode === "research" ? this.research : this.libraries).retrieve(request);
  }
}
