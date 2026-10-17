import type { SourceArticleResponse } from "@santo/contracts/library-reader";
import { approvedMedicalImageUrl } from "./article-rich-html";

export interface VerifiedChatImage {
  src: string;
  alt: string;
  messageId: string;
  sourceId: string;
  sectionTitle: string;
}

/**
 * Select images only from the exact server-resolved cited section.
 * Never accept model Markdown image URLs or unsourced neighboring sections.
 */
export function citedMedicalImages(
  source: SourceArticleResponse,
  messageId: string,
  sourceId: string,
): VerifiedChatImage[] {
  if (
    source.source.sourceId !== sourceId ||
    !source.highlightSectionId ||
    source.source.libraryId !== source.article.libraryId
  )
    return [];
  const section = source.article.sections.find((item) => item.id === source.highlightSectionId);
  if (!section) return [];
  const seen = new Set<string>();
  const images: VerifiedChatImage[] = [];
  for (const image of section.images) {
    const src = approvedMedicalImageUrl(image.src);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    images.push({
      src,
      alt: image.alt?.slice(0, 250) || section.heading,
      messageId,
      sourceId,
      sectionTitle: section.heading,
    });
    if (images.length === 2) break;
  }
  return images;
}
