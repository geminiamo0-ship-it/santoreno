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
const MAX_IMAGES = 80;
const MAX_ARTICLES = 5;

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
    const src = approvedUrl(attr(tag, "src"));
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

/** Fetch original R2 articles before generation, de-duplicating repeated chunks
 * and resolving only the five server-allowlisted retrieval citations. */
export async function loadMedicalImages(
  bucket: R2BucketLike,
  evidence: readonly RetrievedEvidence[],
  diagnostics?: ImageHydrationDiagnostics,
): Promise<MedicalImageCandidate[]> {
  const articles = new Set<string>();
  const found: Omit<MedicalImageCandidate, "id">[] = [];
  const seenUrls = new Set<string>();
  for (const item of evidence) {
    const parsed = SEARCH_KEY.exec(item.itemKey);
    if (!parsed || parsed[1] !== item.libraryId) continue;
    if (diagnostics) diagnostics.recognizedSourcePaths++;
    const key = "medical-articles/v1/" + parsed[1] + "/" + parsed[2] + ".json";
    if (articles.has(key) || articles.size >= MAX_ARTICLES) continue;
    articles.add(key);
    if (diagnostics) diagnostics.articleReads++;
    try {
      const object = await bucket.get(key);
      if (!object) continue;
      if (diagnostics) diagnostics.articleObjectsFound++;
      const raw: unknown = JSON.parse(await object.text());
      const validated = LibraryArticleSchema.safeParse(raw);
      if (
        !validated.success ||
        validated.data.libraryId !== item.libraryId ||
        validated.data.articleId !== parsed[2]
      )
        continue;
      if (diagnostics) diagnostics.validArticles++;
      const article = await originalHtml(validated.data);
      const candidates = article.contentHtml
        ? extractHtmlImages(article, item.sourceId)
        : extractSectionImages(article, item.sourceId);
      if (diagnostics && candidates.length > 0) diagnostics.articlesWithImages++;
      for (const image of candidates) {
        if (seenUrls.has(image.src)) continue;
        seenUrls.add(image.src);
        found.push(image);
        if (found.length >= MAX_IMAGES) break;
      }
    } catch {
      if (diagnostics) diagnostics.unreadableArticles++;
      // Image hydration is optional: a failure must not erase the medical answer.
    }
    if (found.length >= MAX_IMAGES) break;
  }
  if (diagnostics) diagnostics.imageCandidates = found.length;
  return found.map((image, index) => ({
    ...image,
    id: "IMG_" + String(index + 1).padStart(3, "0"),
  }));
}

export function medicalImagePrompt(images: readonly MedicalImageCandidate[]): string {
  if (!images.length) return "";
  return (
    "\nAVAILABLE_ORIGINAL_ARTICLE_IMAGES:\n" +
    JSON.stringify(
      images.map((image) => ({
        image_id: image.id,
        source_id: image.sourceId,
        original_html_id: image.originalId,
        src: image.src,
        article: image.articleTitle,
        section: image.section,
        alt: image.alt,
        caption: image.caption || null,
        ...(image.caption ? {} : { context_before: image.before, context_after: image.after }),
      })),
    ) +
    "\nUse as many clinically relevant figures as improve the teaching, placed inline beside their corresponding explanations. " +
    "To request a figure, write ONLY its exact [[IMG_001]]-style image_id on a standalone line. " +
    "Never invent image IDs or URLs, never cite an image as evidence for an unsupported clinical claim, " +
    "and exclude unrelated, decorative and duplicate pictures. Each image must correspond to the question " +
    "and the actual passage; cite its source when discussing the figure. Original URLs are rendered by Santo, not you."
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
      usedSources.add(image.sourceId);
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
