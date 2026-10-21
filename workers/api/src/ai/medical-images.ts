import { LibraryArticleSchema, type LibraryArticle } from "@santo/contracts/library-reader";
import type { R2BucketLike } from "../runtime/bindings";
import type { RetrievedEvidence } from "./types";

/** Images are advisory teaching material, NEVER sources invented by Luna. */
export interface MedicalImageCandidate {
  id: string;
  sourceId: string;
  src: string;
  articleTitle: string;
  section: string;
  originalId: string | null;
  alt: string;
  caption: string;
  before: string;
  after: string;
}

const SEARCH_KEY = /^medical-search\/v1\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)\.md$/;
const MEDIA_HOST = "pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev";
const MAX_IMAGES = 160;
const MAX_ARTICLES = 12;

/** Privacy-safe staging diagnostics: counters only, no article text, image URLs,
 * student prompts or private article identifiers are ever logged. */
export interface ImageHydrationDiagnostics {
  evidenceCount: number;
  recognizedSourcePaths: number;
  articleReads: number;
  articleObjectsFound: number;
  validArticles: number;
  articlesWithImages: number;
  unreadableArticles: number;
  imageCandidates: number;
}

export function emptyImageHydrationDiagnostics(evidenceCount: number): ImageHydrationDiagnostics {
  return {
    evidenceCount,
    recognizedSourcePaths: 0,
    articleReads: 0,
    articleObjectsFound: 0,
    validArticles: 0,
    articlesWithImages: 0,
    unreadableArticles: 0,
    imageCandidates: 0,
  };
}

function approvedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== MEDIA_HOST ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/offline_media\/[A-Za-z0-9_%+.-]+\.(?:png|jpg|jpeg|webp|gif)$/i.test(url.pathname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function entities(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#(\d+)|#x([0-9a-f]+));/gi,
    (full, dec, hex) => {
      if (dec || hex) {
        const n = parseInt(dec || hex, hex ? 16 : 10);
        return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
      }
      return (
        (
          {
            "&amp;": "&",
            "&lt;": "<",
            "&gt;": ">",
            "&quot;": '"',
            "&apos;": "'",
            "&nbsp;": " ",
          } as Record<string, string>
        )[full.toLowerCase()] ?? full
      );
    },
  );
}

function plain(html: string): string {
  return entities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function attr(tag: string, name: string): string {
  const regex = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1", "i");
  return entities(regex.exec(tag)?.[2] ?? "").trim();
}

/** Extract two surrounding prose blocks in their original HTML order. */
function nearby(html: string, direction: "before" | "after"): string {
  const blocks = html
    .split(/<\/(?:p|div|li|figcaption|h[1-6]|tr)>|<br\s*\/?>/i)
    .map(plain)
    .filter((text) => text.length > 8);
  return (direction === "before" ? blocks.slice(-2) : blocks.slice(0, 2)).join(" ").slice(0, 340);
}

function nearbyHeading(htmlBefore: string, fallback: string): string {
  const headings = [...htmlBefore.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
  return plain(headings.at(-1)?.[1] ?? "").slice(0, 160) || fallback;
}

function extractHtmlImages(
  article: LibraryArticle,
  sourceId: string,
): Omit<MedicalImageCandidate, "id">[] {
  const html = article.contentHtml ?? "";
  if (!html) return [];
  const matches = [...html.matchAll(/<img\b[^>]*>/gi)];
  const output: Omit<MedicalImageCandidate, "id">[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const tag = match[0];
    const src = approvedUrl(attr(tag, "src")) ?? approvedUrl(attr(tag, "data-src"));
    if (!src || seen.has(src)) continue;
    seen.add(src);
    const at = match.index ?? 0;
    const beforeHtml = html.slice(Math.max(0, at - 2500), at);
    const afterHtml = html.slice(at + tag.length, at + tag.length + 2500);
    // Only a caption inside the same original figure may describe this image.
    const figureStart = beforeHtml.lastIndexOf("<figure");
    const figureEnd = afterHtml.indexOf("</figure>");
    const insideFigure =
      figureStart >= 0 && figureEnd >= 0 && beforeHtml.lastIndexOf("</figure>") < figureStart;
    const captionHtml = insideFigure
      ? (/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(
          beforeHtml.slice(figureStart) + tag + afterHtml.slice(0, figureEnd),
        )?.[1] ?? "")
      : "";
    const alt = attr(tag, "alt").slice(0, 250);
    const caption = (plain(captionHtml) || attr(tag, "title")).slice(0, 300);
    output.push({
      sourceId,
      src,
      articleTitle: article.title,
      section: nearbyHeading(beforeHtml, article.title),
      originalId: (attr(tag, "id") || attr(tag, "data-image-id") || null)?.slice(0, 100) ?? null,
      alt,
      caption,
      before: caption ? "" : nearby(beforeHtml, "before"),
      after: caption ? "" : nearby(afterHtml, "after"),
    });
  }
  return output;
}

function extractSectionImages(
  article: LibraryArticle,
  sourceId: string,
): Omit<MedicalImageCandidate, "id">[] {
  const images: Omit<MedicalImageCandidate, "id">[] = [];
  const seen = new Set<string>();
  for (const section of article.sections) {
    for (const image of section.images) {
      const src = approvedUrl(image.src);
      if (!src || seen.has(src)) continue;
      seen.add(src);
      images.push({
        sourceId,
        src,
        articleTitle: article.title,
        section: section.heading,
        originalId: null,
        alt: image.alt,
        caption: "",
        before: section.text.slice(0, 340),
        after: "",
      });
    }
  }
  return images;
}

async function originalHtml(article: LibraryArticle): Promise<LibraryArticle> {
  if (article.contentHtml || !article.contentHtmlGzipBase64) return article;
  try {
    const compressed = Uint8Array.from(atob(article.contentHtmlGzipBase64), (c) => c.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const html = await new Response(stream).text();
    if (html.length > 5_000_000 || html.length !== article.contentHtmlDecodedLength) return article;
    return { ...article, contentHtml: html };
  } catch {
    return article;
  }
}

/** Worker-isolate cache of small, already-validated image metadata, scoped by R2
 * binding identity. No persistent writes, no changes to the existing indexes.
 * Cache success only (never missing/corrupt articles), with a short TTL. */
type CachedImages = Omit<MedicalImageCandidate, "id" | "sourceId">[];
type CachedArticle = { images: CachedImages; expiresAt: number };
const IMAGE_CACHE_TTL_MS = 300_000;
const IMAGE_CACHE_MAX_ENTRIES = 128;
const imageCache = new WeakMap<R2BucketLike, Map<string, CachedArticle>>();
const inFlightImages = new WeakMap<R2BucketLike, Map<string, Promise<CachedImages | null>>>();

async function articleImages(
  bucket: R2BucketLike,
  key: string,
  libraryId: string,
  articleId: string,
  diagnostics?: ImageHydrationDiagnostics,
): Promise<CachedImages | null> {
  const cached = imageCache.get(bucket)?.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.images;
  let pending = inFlightImages.get(bucket);
  if (!pending) {
    pending = new Map();
    inFlightImages.set(bucket, pending);
  }
  const prior = pending.get(key);
  if (prior) return prior;
  const task = (async (): Promise<CachedImages | null> => {
    if (diagnostics) diagnostics.articleReads++;
    try {
      const object = await bucket.get(key);
      if (!object) return null;
      if (diagnostics) diagnostics.articleObjectsFound++;
      const raw: unknown = JSON.parse(await object.text());
      const validated = LibraryArticleSchema.safeParse(raw);
      if (
        !validated.success ||
        validated.data.libraryId !== libraryId ||
        validated.data.articleId !== articleId
      )
        return null;
      if (diagnostics) diagnostics.validArticles++;
      const article = await originalHtml(validated.data);
      // Original HTML and section.images can contain complementary figures.
      // Keep HTML figure captions/IDs where both mention the same src.
      const bySrc = new Map<string, Omit<MedicalImageCandidate, "id">>();
      for (const figure of [
        ...extractHtmlImages(article, ""),
        ...extractSectionImages(article, ""),
      ]) {
        if (!bySrc.has(figure.src)) bySrc.set(figure.src, figure);
      }
      const images = [...bySrc.values()].map(({ sourceId: _sourceId, ...rest }) => rest);
      let entries = imageCache.get(bucket);
      if (!entries) {
        entries = new Map();
        imageCache.set(bucket, entries);
      }
      if (entries.size >= IMAGE_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { images, expiresAt: Date.now() + IMAGE_CACHE_TTL_MS });
      return images;
    } catch {
      if (diagnostics) diagnostics.unreadableArticles++;
      return null;
    }
  })();
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

/** Fetch at most five allowlisted R2 articles in parallel. Restore original
 * evidence order when merging; a slower first article must not lose its images.
 * Cached entries are global licensed metadata only, not user/tenant content. */
export async function loadMedicalImages(
  bucket: R2BucketLike,
  evidence: readonly RetrievedEvidence[],
  diagnostics?: ImageHydrationDiagnostics,
): Promise<MedicalImageCandidate[]> {
  const articles = new Set<string>();
  const chosen: Array<{ key: string; libraryId: string; articleId: string; sourceId: string }> = [];
  for (const item of evidence) {
    const parsed = SEARCH_KEY.exec(item.itemKey);
    if (!parsed || parsed[1] !== item.libraryId) continue;
    if (diagnostics) diagnostics.recognizedSourcePaths++;
    const libraryId = parsed[1]!;
    const articleId = parsed[2]!;
    const key = "medical-articles/v1/" + libraryId + "/" + articleId + ".json";
    if (articles.has(key) || articles.size >= MAX_ARTICLES) continue;
    articles.add(key);
    chosen.push({ key, libraryId, articleId, sourceId: item.sourceId });
  }
  const results = await Promise.all(
    chosen.map(async ({ key, libraryId, articleId }) =>
      articleImages(bucket, key, libraryId, articleId, diagnostics),
    ),
  );
  const found: Omit<MedicalImageCandidate, "id">[] = [];
  const seenUrls = new Set<string>();
  results.forEach((images, position) => {
    if (!images?.length) return;
    if (diagnostics) diagnostics.articlesWithImages++;
    const sourceId = chosen[position]!.sourceId;
    for (const image of images) {
      if (seenUrls.has(image.src) || found.length >= MAX_IMAGES) continue;
      seenUrls.add(image.src);
      found.push({ ...image, sourceId });
    }
  });
  if (diagnostics) diagnostics.imageCandidates = found.length;
  return found.map((image, index) => ({
    ...image,
    id: "IMG_" + String(index + 1).padStart(3, "0"),
  }));
}

/** Keep prompt image context small; preserve at least one figure from each
 * article/source before filling the remainder with query-relevant candidates. */
export function selectMedicalImagesForPrompt(
  images: readonly MedicalImageCandidate[],
  query: string,
  limit = 48,
): MedicalImageCandidate[] {
  if (images.length <= limit) return [...images];
  const words = new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
      (word) => !["what", "about", "explain", "please", "study"].includes(word),
    ),
  );
  const scores = images.map((image, index) => ({
    image,
    index,
    score: [...words].filter((word) =>
      [image.caption, image.alt, image.section, image.articleTitle]
        .join(" ")
        .toLowerCase()
        .includes(word),
    ).length,
  }));
  scores.sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = new Set<string>();
  const chosen: typeof scores = [];
  for (const candidate of scores) {
    if (picked.has(candidate.image.sourceId)) continue;
    chosen.push(candidate);
    picked.add(candidate.image.sourceId);
    if (chosen.length >= limit) break;
  }
  for (const candidate of scores) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }
  return chosen.sort((a, b) => a.index - b.index).map(({ image }) => image);
}

export function medicalImagePrompt(
  images: readonly MedicalImageCandidate[],
  query = "",
  dataOnly = false,
): string {
  if (!images.length) return "";
  const selected = selectMedicalImagesForPrompt(images, query);
  const payload =
    "\nAVAILABLE_ORIGINAL_ARTICLE_IMAGES:\n" +
    JSON.stringify(
      selected.map((image) => ({
        image_id: image.id,
        source_id: image.sourceId,
        original_html_id: image.originalId,
        // Backend expands verified original URLs from image_id; sending URLs
        // to Luna wastes context and encourages it to print raw image links.
        article: image.articleTitle,
        section: image.section,
        alt: image.alt.slice(0, 120),
        caption: image.caption.slice(0, 160) || null,
        ...(image.caption
          ? {}
          : {
              context_before: image.before.slice(0, 130),
              context_after: image.after.slice(0, 130),
            }),
      })),
    );
  if (dataOnly) return payload;
  return (
    payload +
    "\nIllustrations are a PRIORITY teaching resource only when they genuinely match the CURRENT question, its source section and the explanation. Prefer exact anatomy, mechanism or diagnostic figures over broad generic images; use none if no illustration adds reliable teaching value. " +
    "Position each relevant figure beside the matching clinical explanation; use multiple figures only when they convey distinct anatomy, mechanism, findings or management rather than repeating the same idea. " +
    "To request a figure, write ONLY its exact [[IMG_001]]-style image_id on a standalone line. " +
    "Never invent image IDs or URLs, never cite an image as evidence for an unsupported clinical claim, " +
    "and exclude unrelated, decorative and duplicate pictures. Each image must correspond to the question " +
    "and the actual passage. Cite verified medical LIBRARY passages for clinical claims; gallery attribution is NOT a clinical citation. Original URLs are rendered by Santo, not you."
  );
}

function markdownLabel(value: string): string {
  return value
    .replace(/[\[\]()\r\n<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 230);
}

/** Only server-fetched image identities become Markdown. Model-authored URLs
 * are removed. An image used in the output is an actual source usage, not an
 * automatically added "related source" from retrieval. */
export function renderMedicalImageMarkers(
  answer: string,
  candidates: readonly MedicalImageCandidate[],
): { answer: string; sourceIds: string[] } {
  const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const usedImages = new Set<string>();
  const usedSources = new Set<string>();
  const safe = answer.replace(/!\[[^\]\n]{0,250}\]\([^\)\n]{1,900}\)/g, "");
  return {
    answer: safe.replace(/\[\[(IMG_\d{3})\]\]/g, (_match, id: string) => {
      const image = allowed.get(id);
      if (!image || usedImages.has(id)) return "";
      usedImages.add(id);
      if (image.sourceId) usedSources.add(image.sourceId);
      const caption = markdownLabel(
        image.caption || image.alt || image.section || "Medical figure",
      );
      return (
        "\n\n![" +
        caption +
        "](" +
        image.src +
        ")\n\n" +
        "*Source: " +
        markdownLabel(image.articleTitle) +
        " — " +
        markdownLabel(image.section) +
        "*\n\n"
      );
    }),
    sourceIds: [...usedSources],
  };
}
