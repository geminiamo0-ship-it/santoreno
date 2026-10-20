/**
 * Resolve PMC figures only from an AUTHORIZED, saved PubMed citation.
 * Every remote URL is constrained to the official anonymous PMC dataset.
 * No arbitrary publisher URLs, HTML scraping, or unlicensed binary mirroring.
 */
export interface ResearchFigure {
  url: string;
  caption: string;
  altText: string;
  license: string;
  pmcid: string;
}

export interface ResearchFigureProvider {
  find(pmcid: string): Promise<ResearchFigure[]>;
}

const BASE = "https://pmc-oa-opendata.s3.amazonaws.com";
const MAX_METADATA_BYTES = 90_000;
const MAX_JATS_BYTES = 1_500_000;
const MAX_FIGURES = 12;
const NETWORK_TIMEOUT_MS = 6_000;

// A generous default for clear, reusable media; others can be enabled
// only after the owner supplies evidence of permission.
const REDISTRIBUTABLE = new Set(["cc0", "cc-by", "cc-by-sa"]);
const CAPTION_TAG = /<caption(?:\s[^>]*)?>([\s\S]*?)<\/caption>/i;
const FIG_TAG = /<fig(?:\s[^>]*)?>([\s\S]*?)<\/fig>/gi;
const GRAPHIC_TAG = /<(?:graphic|inline-graphic)\b[^>]*?\bxlink:href=["']([^"']+)["'][^>]*\/?\s*>/i;
const HEX = /^PMC[0-9]{1,12}$/;

function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([a-f0-9]+);/gi, (_, value: string) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_, value: string) => String.fromCodePoint(parseInt(value, 10)))
    .replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_, key: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[key] ?? "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function validArticleUrl(raw: string, version: string, extensions: RegExp): string | null {
  try {
    // Official metadata may expose S3 URIs; map only this fixed public bucket.\n    const httpUrl = raw.startsWith("s3://pmc-oa-opendata/")\n      ? BASE + raw.slice("s3://pmc-oa-opendata".length)\n      : raw;\n    const url = new URL(httpUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "pmc-oa-opendata.s3.amazonaws.com" ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    if (!url.pathname.startsWith("/" + version + "/") || !extensions.test(url.pathname))
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface DatasetMetadata {
  pmcid?: unknown;
  license_code?: unknown;
  is_retracted?: unknown;
  xml_url?: unknown;
  media_urls?: unknown;
}

export class PmcResearchFigureProvider implements ResearchFigureProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async fetchText(url: URL, maxBytes: number): Promise<string | null> {
    try {
      const response = await this.fetcher(url.toString(), {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > maxBytes)
        return null;
      const text = await response.text();
      return new TextEncoder().encode(text).byteLength <= maxBytes ? text : null;
    } catch {
      return null;
    }
  }

  async find(pmcid: string): Promise<ResearchFigure[]> {
    if (!HEX.test(pmcid)) return [];
    // S3 ListObjectsV2 with a PMCID-only prefix: retrieve the most recent article version.
    const listing = new URL(BASE + "/");
    listing.searchParams.set("list-type", "2");
    listing.searchParams.set("prefix", pmcid + ".");
    listing.searchParams.set("delimiter", "/");
    const prefixes = await this.fetchText(listing, 250_000);
    if (!prefixes) return [];
    const versions = [...prefixes.matchAll(/<Prefix>(PMC\d+\.(\d+)\/) <\/Prefix>/g)];
    // Also support the actual compact S3 XML with no whitespace before closing tag.
    const matches = versions.length
      ? versions
      : [...prefixes.matchAll(/<Prefix>(PMC\d+\.(\d+)\/)<\/Prefix>/g)];
    const candidates = matches
      .filter((match) => match[1]?.startsWith(pmcid + "."))
      .sort((a, b) => Number(b[2]) - Number(a[2]));
    if (!candidates.length) return [];
    const version = candidates[0]![1]!.replace(/\/$/, "");
    if (!new RegExp("^" + pmcid + "\\.\\d+$").test(version)) return [];

    const metadataUrl = new URL(BASE + "/metadata/" + version + ".json");
    const raw = await this.fetchText(metadataUrl, MAX_METADATA_BYTES);
    if (!raw) return [];
    let data: DatasetMetadata;
    try {
      data = JSON.parse(raw) as DatasetMetadata;
    } catch {
      return [];
    }
    if (data.pmcid !== pmcid || data.is_retracted === true) return [];
    const license =
      typeof data.license_code === "string"
        ? data.license_code.toLowerCase().replace(/_/g, "-")
        : "";
    if (!REDISTRIBUTABLE.has(license)) return [];
    if (typeof data.xml_url !== "string" || !Array.isArray(data.media_urls)) return [];
    const xmlUrl = validArticleUrl(data.xml_url, version, /\.xml$/i);
    if (!xmlUrl) return [];
    const media = new Map<string, string>();
    for (const rawUrl of data.media_urls.slice(0, 250)) {
      if (typeof rawUrl !== "string") continue;
      const checked = validArticleUrl(rawUrl, version, /\.(?:jpe?g|png|webp)$/i);
      if (!checked) continue;
      const name = decodeURIComponent(
        new URL(checked).pathname.split("/").at(-1) ?? "",
      ).toLowerCase();
      if (name) media.set(name, checked);
    }
    if (media.size === 0) return [];
    const xml = await this.fetchText(new URL(xmlUrl), MAX_JATS_BYTES);
    if (!xml) return [];
    const figures: ResearchFigure[] = [];
    const seen = new Set<string>();
    for (const match of xml.matchAll(FIG_TAG)) {
      const block = match[1] ?? "";
      const graphic = GRAPHIC_TAG.exec(block)?.[1]?.trim();
      if (!graphic || graphic.includes("/") || graphic.includes("\\") || graphic.includes(".."))
        continue;
      const url = media.get(graphic.toLowerCase());
      const caption = cleanText(CAPTION_TAG.exec(block)?.[1] ?? "").slice(0, 1000);
      if (!url || !caption || seen.has(url)) continue;
      seen.add(url);
      figures.push({ url, altText: caption.slice(0, 300), caption, license, pmcid });
      if (figures.length >= MAX_FIGURES) break;
    }
    return figures;
  }
}

/** Restrict the lookup to the PubMed source and PMCID recorded at generation time. */
export function pmcidFromSavedSource(source: {
  instanceId: string;
  sourceId: string;
  section: string | null;
}): string | null {
  if (source.instanceId !== "pubmed" || !/^pubmed:\d+$/.test(source.sourceId)) return null;
  const match = /^PubMed \/ PMC (PMC\d+)$/.exec(source.section ?? "");
  return match?.[1] ?? null;
}
