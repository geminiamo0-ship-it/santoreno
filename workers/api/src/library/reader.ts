import type { SessionContextResponse } from "@santo/contracts";
import { LibraryArticleSchema, LibraryArticleIdSchema, LibraryCatalogSchema, LibraryListingSchema, LibraryArticleListResponseSchema, SourceArticleRequestSchema, SourceArticleResponseSchema } from "@santo/contracts/library-reader";
import type { LibraryArticle, SourceArticleResponse } from "@santo/contracts/library-reader";
import { GroundedAiLibraryIdSchema } from "@santo/contracts/ai";
import type { R2BucketLike } from "../runtime/bindings";
import { R2VerifiedSourceStore } from "../sources/store";

export class LibraryReaderError extends Error {
  constructor(readonly status: 400 | 404 | 502 | 503, readonly code: string) {
    super(code); this.name = "LibraryReaderError";
  }
}
const ITEM_KEY = /^medical-search\/v1\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)\.md$/;
const MAX_ARTICLE_BYTES = 2_000_000;
const MAX_INDEX_BYTES = 1_500_000;

async function readJson(bucket: R2BucketLike, key: string, maxBytes: number): Promise<unknown> {
  let text: string;
  try {
    const object = await bucket.get(key);
    if (!object) throw new LibraryReaderError(404, "LIBRARY_NOT_FOUND");
    text = await object.text();
  } catch (error) {
    if (error instanceof LibraryReaderError) throw error;
    throw new LibraryReaderError(503, "LIBRARY_UNAVAILABLE");
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID"); }
}

export class LibraryReaderService {
  private readonly snapshots: R2VerifiedSourceStore;
  constructor(private readonly bucket: R2BucketLike) {
    this.snapshots = new R2VerifiedSourceStore(bucket);
  }
  async catalog() {
    const parsed = LibraryCatalogSchema.safeParse(
      await readJson(this.bucket, "medical-library-catalog/v1/catalog.json", MAX_INDEX_BYTES),
    );
    if (!parsed.success) throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    return parsed.data;
  }
  async list(libraryId: string, search: string, cursor: number) {
    if (!GroundedAiLibraryIdSchema.safeParse(libraryId).success || search.length > 80 ||
        !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 6000) {
      throw new LibraryReaderError(400, "INVALID_LIBRARY_REQUEST");
    }
    const index = LibraryListingSchema.safeParse(
      await readJson(this.bucket, `medical-library-catalog/v1/${libraryId}.json`, MAX_INDEX_BYTES),
    );
    if (!index.success || index.data.libraryId !== libraryId) {
      throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    }
    const q = search.trim().toLocaleLowerCase();
    const articles = q ? index.data.articles.filter((a) =>
      `${a.title} ${a.category}`.toLocaleLowerCase().includes(q)) : index.data.articles;
    return LibraryArticleListResponseSchema.parse({
      libraryId, articles: articles.slice(cursor, cursor + 40),
      nextCursor: cursor + 40 < articles.length ? cursor + 40 : null,
    });
  }
  async article(libraryId: string, articleId: string): Promise<LibraryArticle> {
    if (!GroundedAiLibraryIdSchema.safeParse(libraryId).success ||
        !LibraryArticleIdSchema.safeParse(articleId).success) {
      throw new LibraryReaderError(400, "INVALID_LIBRARY_REQUEST");
    }
    const raw = await readJson(
      this.bucket, `medical-articles/v1/${libraryId}/${articleId}.json`, MAX_ARTICLE_BYTES,
    );
    const parsed = LibraryArticleSchema.safeParse(raw);
    if (!parsed.success || parsed.data.libraryId !== libraryId || parsed.data.articleId !== articleId) {
      throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    }
    return parsed.data;
  }
  /** Citation link is derived exclusively from the validated historical source snapshot. */
  async fromCitation(session: SessionContextResponse, raw: unknown): Promise<SourceArticleResponse> {
    const request = SourceArticleRequestSchema.safeParse(raw);
    if (!request.success) throw new LibraryReaderError(400, "INVALID_LIBRARY_REQUEST");
    const sources = await this.snapshots.load({ ...session, messageId: request.data.messageId });
    const source = sources.find((s) => s.sourceId === request.data.sourceId);
    if (!source) throw new LibraryReaderError(404, "LIBRARY_NOT_FOUND");
    const match = ITEM_KEY.exec(source.itemKey);
    if (!match || match[1] !== source.libraryId) {
      // Old citations or un-imported fixtures remain valid for metadata, not full article browsing.
      throw new LibraryReaderError(404, "LIBRARY_ARTICLE_NOT_AVAILABLE");
    }
    const article = await this.article(match[1]!, match[2]!);
    const section = article.sections.find((s) => s.id === match[3]);
    if (!section) throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    return SourceArticleResponseSchema.parse({
      source, article, highlightSectionId: section.id,
    });
  }
}
