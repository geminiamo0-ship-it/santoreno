import { approvedPmcFigureImageUrl } from "@santo/contracts/ai";

/** Figures are educational illustrations, not verified clinical claim citations.
 * No arbitrary links, HTML, or provider media are trusted without PMC's
 * versioned 2026 AWS metadata and explicit commercially reusable license.
 */
export interface PmcFigure {
  src: string;
  pmcid: string;
  figureId: string;
  caption: string;
  license: string;
}

const ROOT = "https://pmc-oa-opendata.s3.amazonaws.com/";
const MAX_METADATA_BYTES = 250_000;
const MAX_FIGURES_PER_ARTICLE = 24;
const COMMERCIAL_CC = new Set(["CC0", "CC BY", "CC BY-SA"]);
const FILE = /^[A-Za-z0-9_.-]{1,170}\.(?:jpg|jpeg|png|webp|gif)$/i;
const GRAPHIC =
  /<(?:graphic|inline-graphic)\b[^>]*\b(?:xlink:href|href)\s*=\s*["']([^"']{1,200})["'][^>]*\/?>/i;

/** Strict extraction: a figure must identify its OWN media through xlink,
 * never borrow a neighbor's figure, article title, or unverified URL. */
export function extractPmcFigureCaptions(xml: string): Array<{
  id: string;
  name: string;
  caption: string;
}> {
  if (xml.length > 1_500_000) return [];
  const figures: Array<{ id: string; name: string; caption: string }> = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<fig(?:\s[^>]*)?>[\s\S]*?<\/fig>/gi)) {
    const block = match[0];
    const graphic = GRAPHIC.exec(block)?.[1];
    if (!graphic || graphic.includes("/") || graphic.includes("\\") || graphic.includes(".."))
      continue;
    const name = graphic.split("?")[0]!;
    if (!/^[A-Za-z0-9_.-]{1,170}$/.test(name)) continue;
    const figId = /\bid\s*=\s*["']([A-Za-z0-9_.:-]{1,70})["']/i.exec(block.slice(0, 300))?.[1];
    const captionBlock = /<caption(?:\s[^>]*)?>([\s\S]*?)<\/caption>/i.exec(block)?.[1];
    if (!captionBlock) continue;
    const caption = captionBlock
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&#([0-9]{1,7});/g, (_, n: string) => String.fromCodePoint(parseInt(n, 10)))
      .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => {
        const map: Record<string, string> = {
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        };
        return map[entity.toLowerCase()] ?? " ";
      })
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    if (
      caption.length < 12 ||
      /©|reproduced with permission|permission of|all rights reserved/i.test(caption)
    )
      continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    figures.push({ id: figId ?? "figure-" + (figures.length + 1), name, caption });
    if (figures.length >= MAX_FIGURES_PER_ARTICLE) break;
  }
  return figures;
}

interface CloudMetadata {
  pmcid?: unknown;
  version?: unknown;
  media_urls?: unknown;
  is_pmc_openaccess?: unknown;
  is_retracted?: unknown;
  license_code?: unknown;
}

/** Only an exact S3 metadata-declared URL, from the same PMCID + version,
 * can authorize a figure image. The S3 API object is public, not a secret. */
export function approvedPmcMedia(
  raw: unknown,
  pmcid: string,
  figure: { name: string },
): { src: string; license: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as CloudMetadata;
  if (data.pmcid !== pmcid || !Number.isInteger(data.version)) return null;
  const version = Number(data.version);
  if (version < 1 || version > 999) return null;
  if (data.is_pmc_openaccess !== true || data.is_retracted === true) return null;
  const license =
    typeof data.license_code === "string" ? data.license_code.trim().toUpperCase() : "";
  if (!COMMERCIAL_CC.has(license) || !Array.isArray(data.media_urls)) return null;
  if (data.media_urls.length > 500) return null;
  const versionPrefix = pmcid + "." + version + "/";
  for (const item of data.media_urls) {
    if (typeof item !== "string" || item.length > 1000 || !item.startsWith("s3://pmc-oa-opendata/"))
      continue;
    // Compare by EXACT base filename; JATS may omit '.jpg' in xlink:href.
    const tail = item.slice("s3://pmc-oa-opendata/".length);
    const [key, query] = tail.split("?");
    if (!key?.startsWith(versionPrefix) || !/^md5=[0-9a-f]{32}$/i.test(query ?? "")) continue;
    const file = key.slice(versionPrefix.length);
    if (!FILE.test(file) || file.includes("/")) continue;
    if (
      file.toLowerCase() !== figure.name.toLowerCase() &&
      file.replace(/\.[^.]+$/, "").toLowerCase() !== figure.name.toLowerCase()
    )
      continue;
    const src = ROOT + key + "?" + query;
    if (approvedPmcFigureImageUrl(src)) return { src, license };
  }
  return null;
}

/** Bounded optional enrichment: never delay/reject PubMed text answers on a
 * missing metadata object, broken media, or unsupported license. The
 * figure/caption association comes from the SAME retrieved JATS full text. */
export async function loadLicensedPmcFigures(
  pmcid: string,
  xml: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<PmcFigure[]> {
  if (!/^PMC[1-9]\d{0,11}$/.test(pmcid)) return [];
  const figures = extractPmcFigureCaptions(xml);
  if (!figures.length) return [];
  const versions = [1, 2, 3]; // No blind object/list traversal. Missing later versions fail gracefully.
  const metadata = await Promise.all(
    versions.map(async (version) => {
      const url = ROOT + "metadata/" + pmcid + "." + version + ".json";
      try {
        const timeout = AbortSignal.timeout(2_200);
        const response = await fetcher(url, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { accept: "application/json" },
          redirect: "error",
        });
        if (
          !response.ok ||
          Number(response.headers.get("content-length") ?? "0") > MAX_METADATA_BYTES
        )
          return null;
        const body = await response.text();
        if (body.length > MAX_METADATA_BYTES) return null;
        const parsed: unknown = JSON.parse(body);
        return parsed;
      } catch {
        return null;
      }
    }),
  );
  // Prefer newer metadata when available, but never invent a matching file.
  const results: PmcFigure[] = [];
  const used = new Set<string>();
  for (const figure of figures) {
    for (const candidate of [...metadata].reverse()) {
      const media = approvedPmcMedia(candidate, pmcid, figure);
      if (!media || used.has(media.src)) continue;
      used.add(media.src);
      results.push({
        src: media.src,
        pmcid,
        figureId: figure.id,
        caption: figure.caption,
        license: media.license,
      });
      break;
    }
  }
  return results;
}
