import { z } from "zod";
import { GroundedAiLibraryIdSchema } from "./ai";
import { TrustedSourceIdSchema, TrustedSourceMetadataSchema } from "./source";

export const LibraryArticleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,90}$/);
export const LibrarySectionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,100}$/);
const ImageUrlSchema = z.string().url().max(900).refine((url) => {
  const value = new URL(url);
  return value.protocol === "https:" &&
    value.hostname === "pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev" &&
    /^\/offline_media\/[A-Za-z0-9_%+.-]+\.(?:png|jpg|jpeg|webp|gif)$/i.test(value.pathname) &&
    !value.search && !value.hash;
}, "Media URL must use the approved public R2 image prefix");
export const LibraryArticleSectionSchema = z.object({
  id: LibrarySectionIdSchema,
  heading: z.string().min(1).max(300),
  text: z.string().max(180000),
  images: z.array(z.object({ src: ImageUrlSchema, alt: z.string().max(250) }).strict()).max(40),
}).strict();
export const LibraryArticleSchema = z.object({
  schemaVersion: z.literal(1),
  libraryId: GroundedAiLibraryIdSchema,
  articleId: LibraryArticleIdSchema,
  title: z.string().min(1).max(500),
  category: z.string().max(300),
  source: z.string().max(120),
  sections: z.array(LibraryArticleSectionSchema).min(1).max(300),
}).strict().superRefine((article, context) => {
  if (new Set(article.sections.map((s) => s.id)).size !== article.sections.length) {
    context.addIssue({ code: "custom", message: "Duplicate section IDs", path: ["sections"] });
  }
});
export type LibraryArticle = z.infer<typeof LibraryArticleSchema>;
export const LibraryListingSchema = z.object({
  schemaVersion: z.literal(1),
  libraryId: GroundedAiLibraryIdSchema,
  title: z.string().min(1).max(120),
  articles: z.array(z.object({
    id: LibraryArticleIdSchema,
    title: z.string().min(1).max(500),
    category: z.string().max(300),
  }).strict()).max(6000),
}).strict();
export const LibraryCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  libraries: z.array(z.object({ id: GroundedAiLibraryIdSchema, title: z.string().min(1).max(120), count: z.number().int().nonnegative() }).strict()).max(10),
}).strict();
export const LibraryArticleListResponseSchema = z.object({
  libraryId: GroundedAiLibraryIdSchema,
  articles: LibraryListingSchema.shape.articles.max(40),
  nextCursor: z.number().int().nonnegative().nullable(),
}).strict();
export const SourceArticleRequestSchema = z.object({
  messageId: z.string().uuid(),
  sourceId: TrustedSourceIdSchema,
}).strict();
export const SourceArticleResponseSchema = z.object({
  source: TrustedSourceMetadataSchema,
  article: LibraryArticleSchema,
  highlightSectionId: LibrarySectionIdSchema.nullable(),
}).strict();
export type SourceArticleResponse = z.infer<typeof SourceArticleResponseSchema>;
export type LibraryCatalog = z.infer<typeof LibraryCatalogSchema>;
export type LibraryArticleListResponse = z.infer<typeof LibraryArticleListResponseSchema>;
