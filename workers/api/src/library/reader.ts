import type { SessionContextResponse } from "@santo/contracts";
import {
  LibraryArticleSchema,
  LibraryArticleIdSchema,
  LibraryCatalogSchema,
  LibraryListingSchema,
  LibraryArticleListResponseSchema,
  SourceArticleRequestSchema,
  SourceArticleResponseSchema,
  BatchSourceImagesRequestSchema,
  BatchSourceImagesResponseSchema,
} from "@santo/contracts/library-reader";
import type {
  LibraryArticle,
  SourceArticleResponse,
  BatchSourceImagesResponse,
} from "@santo/contracts/library-reader";
import { GroundedAiLibraryIdSchema } from "@santo/contracts/ai";
import type { R2BucketLike } from "../runtime/bindings";
import { R2VerifiedSourceStore } from "../sources/store";

export class LibraryReaderError extends Error {
  constructor(
    readonly status: 400 | 404 | 502 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = "LibraryReaderError";
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
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
  }
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
    if (
      !GroundedAiLibraryIdSchema.safeParse(libraryId).success ||
      search.length > 80 ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > 6000
    ) {
      throw new LibraryReaderError(400, "INVALID_LIBRARY_REQUEST");
    }
    const index = LibraryListingSchema.safeParse(
      await readJson(this.bucket, `medical-library-catalog/v1/${libraryId}.json`, MAX_INDEX_BYTES),
    );
    if (!index.success || index.data.libraryId !== libraryId) {
      throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    }
    const q = search.trim().toLocaleLowerCase();
    const articles = q
      ? index.data.articles.filter((a) =>
          `${a.title} ${a.category}`.toLocaleLowerCase().includes(q),
        )
      : index.data.articles;
    return LibraryArticleListResponseSchema.parse({
      libraryId,
      articles: articles.slice(cursor, cursor + 40),
      nextCursor: cursor + 40 < articles.length ? cursor + 40 : null,
    });
  }
  async article(libraryId: string, articleId: string): Promise<LibraryArticle> {
    if (
      !GroundedAiLibraryIdSchema.safeParse(libraryId).success ||
      !LibraryArticleIdSchema.safeParse(articleId).success
    ) {
      throw new LibraryReaderError(400, "INVALID_LIBRARY_REQUEST");
    }
    const raw = await readJson(
      this.bucket,
      `medical-articles/v1/${libraryId}/${articleId}.json`,
      MAX_ARTICLE_BYTES,
    );
    const parsed = LibraryArticleSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.libraryId !== libraryId ||
      parsed.data.articleId !== articleId
    ) {
      throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    }
    return parsed.data;
  }
  /**
   * Authorize one message snapshot once, then fetch up to five original articles
   * concurrently. Only image metadata is returned. No unverified source ID,
   * tenant, URL or article selector from the browser is ever trusted.
   */
  async batchImages(
    session: SessionContextResponse,
    raw: unknown,
  ): Promise<BatchSourceImagesResponse> {
    const request = BatchSourceImagesRequestSchema.safeParse(raw);
    if (!request.success) throw new LibraryReaderError(400, "INVALID_LIBRARY_REQUEST");
    const messageId = request.data.messageId;
    const sources = await this.snapshots.load({ ...session, messageId });
    const selected = request.data.sourceIds
      .map((id) => {
        const source = sources.find((item) => item.sourceId === id);
        if (!source) throw new LibraryReaderError(404, "LIBRARY_NOT_FOUND");
        const match = ITEM_KEY.exec(source.itemKey);
        if (!match || match[1] !== source.libraryId) return null;
        return { sourceId: id, libraryId: match[1]!, articleId: match[2]!, sectionId: match[3]! };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    // A single cited article may contribute multiple cited sections. Fetch it
    // only once and preserve the explicit highlighted section for each citation.
    const articles = new Map<string, Promise<LibraryArticle>>();
    const items = await Promise.all(
      selected.map(async (entry) => {
        const key = entry.libraryId + "/" + entry.articleId;
        let articlePromise = articles.get(key);
        if (!articlePromise) {
          articlePromise = this.article(entry.libraryId, entry.articleId);
          articles.set(key, articlePromise);
        }
        try {
          const article = await articlePromise;
          const cited = article.sections.find((section) => section.id === entry.sectionId);
          if (!cited) return null;
          const ordered = [cited, ...article.sections.filter((section) => section.id !== cited.id)];
          let count = 0;
          const sections: BatchSourceImagesResponse["items"][number]["sections"] = [];
          for (const section of ordered) {
            if (count >= 24 || sections.length >= 24) break;
            if (!section.images.length) continue;
            const images = section.images.slice(0, 24 - count);
            sections.push({
              heading: section.heading,
              citedSection: section.id === cited.id,
              images,
            });
            count += images.length;
          }
          return { sourceId: entry.sourceId, articleTitle: article.title, sections };
        } catch (error) {
          // Missing/unimported article objects are not fabricated; another
          // verified citation may still have useful pictures.
          if (error instanceof LibraryReaderError && error.status === 404) return null;
          throw error;
        }
      }),
    );
    return BatchSourceImagesResponseSchema.parse({
      items: items.filter((item): item is NonNullable<typeof item> => item !== null),
    });
  }

  /** Citation link is derived exclusively from the validated historical source snapshot. */
  async fromCitation(
    session: SessionContextResponse,
    raw: unknown,
  ): Promise<SourceArticleResponse> {
    const request = SourceArticleRequestSchema.safeParse(raw);
    if (!request.success) throw new LibraryReaderError(400, "INVALID_LIBRARY_REQUEST");
    const sources = await this.snapshots.load({ ...session, messageId: request.data.messageId });
    const source = sources.find((s) => s.sourceId === request.data.sourceId);
    if (!source) throw new LibraryReaderError(404, "LIBRARY_NOT_FOUND");
    // Original AnKing v12 scientific note citations open as a source-backed
    // study-note article. Never resolve/display an Anki card or CID here.
    const ankingKey = /(?:^|\/)(note_(\d{10,16}))\.json$/.exec(source.itemKey);
    if (
      source.libraryId === "anking" &&
      source.instanceId === "santo-anking-step-v12" &&
      ankingKey
    ) {
      const noteId = Number(ankingKey[2]);
      const raw = await readJson(
        this.bucket,
        `anking/v12/full/shards/shard_${String(noteId % 128).padStart(3, "0")}.json`,
        MAX_ARTICLE_BYTES,
      );
      const notes =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const record = notes?.[ankingKey[1]!];
      const note =
        record && typeof record === "object" && !Array.isArray(record)
          ? (record as Record<string, unknown>)
          : null;
      if (!note || note.note_id !== noteId || note.rights_status !== "licensed_for_santo") {
        throw new LibraryReaderError(404, "LIBRARY_ARTICLE_NOT_AVAILABLE");
      }
      const fact = typeof note.medical_fact === "string" ? note.medical_fact.slice(0, 3000) : "";
      const pearl =
        typeof note.clinical_pearl === "string" ? note.clinical_pearl.slice(0, 1000) : "";
      if (!fact.trim()) throw new LibraryReaderError(404, "LIBRARY_ARTICLE_NOT_AVAILABLE");
      const topic = typeof note.topic === "string" ? note.topic.slice(0, 250) : "Medical concept";
      const article = LibraryArticleSchema.parse({
        schemaVersion: 1,
        libraryId: "anking",
        articleId: "note-" + noteId,
        title: "AnKing v12 — " + topic,
        category: "High-Yield Medical Study Notes",
        source: "AnKing v12",
        sections: [
          { id: "medical-fact", heading: "Medical concept", text: fact, images: [] },
          ...(pearl
            ? [{ id: "clinical-pearl", heading: "Clinical Pearl", text: pearl, images: [] }]
            : []),
        ],
      });
      return SourceArticleResponseSchema.parse({
        source,
        article,
        highlightSectionId: "medical-fact",
      });
    }
    const match = ITEM_KEY.exec(source.itemKey);
    if (!match || match[1] !== source.libraryId) {
      // Old citations or un-imported fixtures remain valid for metadata, not full article browsing.
      throw new LibraryReaderError(404, "LIBRARY_ARTICLE_NOT_AVAILABLE");
    }
    const article = await this.article(match[1]!, match[2]!);
    const section = article.sections.find((s) => s.id === match[3]);
    if (!section) throw new LibraryReaderError(502, "LIBRARY_CONTENT_INVALID");
    return SourceArticleResponseSchema.parse({
      source,
      article,
      highlightSectionId: section.id,
    });
  }
}
