import { describe, expect, it } from "vitest";
import type { R2BucketLike, R2ObjectBodyLike } from "../runtime/bindings";
import { R2VerifiedSourceStore } from "../sources/store";
import { LibraryReaderService } from "./reader";

const tenantId = "11111111-1111-4111-8111-111111111111";
const externalUserId = "student";
const messageId = "22222222-2222-4222-8222-222222222222";
const itemKey = "medical-search/v1/passmedicine/passmed-5683/s-0002.md";
const source = {
  sourceId: "pass-instance:chunk-01",
  libraryId: "passmedicine",
  instanceId: "pass-instance",
  itemKey,
  title: "ACE inhibitors",
  page: null,
  section: "Mechanism",
};
const article = {
  schemaVersion: 1,
  libraryId: "passmedicine",
  articleId: "passmed-5683",
  title: "ACE inhibitors",
  category: "Cardiology",
  source: "passmedicine",
  sections: [
    { id: "s-0001", heading: "Overview", text: "Overview", images: [] },
    { id: "s-0002", heading: "Mechanism", text: "An evidence-backed teaching section", images: [] },
  ],
};
const session = {
  tenantId,
  externalUserId,
  sessionId: "33333333-3333-4333-8333-333333333333",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
};
class FakeR2 implements R2BucketLike {
  readonly data = new Map<string, string>();
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown> {
    if (typeof value !== "string") throw new Error("unexpected bytes");
    this.data.set(key, value);
    return Promise.resolve();
  }
  get(key: string): Promise<R2ObjectBodyLike | null> {
    const value = this.data.get(key);
    return Promise.resolve(value === undefined ? null : { text: async () => value });
  }
  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}
const articleKey = "medical-articles/v1/passmedicine/passmed-5683.json";
async function setup() {
  const bucket = new FakeR2();
  bucket.data.set(articleKey, JSON.stringify(article));
  bucket.data.set(
    "medical-library-catalog/v1/catalog.json",
    JSON.stringify({
      schemaVersion: 1,
      libraries: [{ id: "passmedicine", title: "PassMedicine", count: 1 }],
    }),
  );
  bucket.data.set(
    "medical-library-catalog/v1/passmedicine.json",
    JSON.stringify({
      schemaVersion: 1,
      libraryId: "passmedicine",
      title: "PassMedicine",
      articles: [{ id: "passmed-5683", title: "ACE inhibitors", category: "Cardiology" }],
    }),
  );
  const snapshots = new R2VerifiedSourceStore(bucket);
  await snapshots.save({ tenantId, externalUserId, messageId }, [source]);
  return { bucket, service: new LibraryReaderService(bucket) };
}
describe("verified source explorer and private article browser", () => {
  it("retrieves only server-known article ID and exact verified section", async () => {
    const { service } = await setup();
    const result = await service.fromCitation(session, { messageId, sourceId: source.sourceId });
    expect(result.source).toEqual(source);
    expect(result.article).toEqual(article);
    expect(result.highlightSectionId).toBe("s-0002");
    expect(JSON.stringify(result)).not.toContain("medical-articles/v1");
  });
  it("rejects cross-user snapshots, forged ids and browser-controlled selectors", async () => {
    const { service } = await setup();
    await expect(
      service.fromCitation(
        { ...session, externalUserId: "other" },
        { messageId, sourceId: source.sourceId },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.fromCitation(session, { messageId, sourceId: "pass-instance:forged" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.fromCitation(session, { messageId, sourceId: source.sourceId, tenantId }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.article("passmedicine", "../../secret")).rejects.toMatchObject({
      status: 400,
    });
  });
  it("searches only bounded catalog titles and paginates safely", async () => {
    const { service } = await setup();
    expect((await service.catalog()).libraries[0]?.count).toBe(1);
    expect((await service.list("passmedicine", "ACE", 0)).articles).toHaveLength(1);
    expect((await service.list("passmedicine", "unknown", 0)).articles).toHaveLength(0);
    expect((await service.list("passmedicine", "", 0)).nextCursor).toBeNull();
    await expect(service.list("passmedicine", "", 7000)).rejects.toMatchObject({ status: 400 });
  });
  it("accepts optional backward-compatible rich-HTML article payload while keeping original sections", async () => {
    const { service, bucket } = await setup();
    const richer = {
      ...article,
      contentHtml: '<h2 id="cardiology">ACE inhibitors</h2><table><tr><td>ACE</td></tr></table>',
    };
    bucket.data.set(articleKey, JSON.stringify(richer));
    expect((await service.article("passmedicine", "passmed-5683")).contentHtml).toContain(
      "<table>",
    );
    expect((await service.article("passmedicine", "passmed-5683")).sections).toEqual(
      article.sections,
    );
    bucket.data.set(articleKey, JSON.stringify({ ...article, contentHtml: "x".repeat(1_500_001) }));
    await expect(service.article("passmedicine", "passmed-5683")).rejects.toMatchObject({
      status: 502,
    });
  });
  it("rejects malformed, executable or oversized content, without falling back to HTML", async () => {
    const { service, bucket } = await setup();
    bucket.data.set(
      articleKey,
      JSON.stringify({
        ...article,
        sections: [
          {
            ...article.sections[0],
            images: [{ alt: "Bad", src: "javascript:alert(1)" }],
          },
        ],
      }),
    );
    await expect(service.article("passmedicine", "passmed-5683")).rejects.toMatchObject({
      status: 502,
    });
    bucket.data.set(articleKey, "<html><script>evil()</script></html>");
    await expect(service.article("passmedicine", "passmed-5683")).rejects.toMatchObject({
      status: 502,
    });
    bucket.data.set(articleKey, "x".repeat(2_000_001));
    await expect(service.article("passmedicine", "passmed-5683")).rejects.toMatchObject({
      status: 502,
    });
  });
  it("fails closed when citations refer to old unimported AI Search object keys", async () => {
    const { service, bucket } = await setup();
    await new R2VerifiedSourceStore(bucket).save(
      { tenantId, externalUserId, messageId: "44444444-4444-4444-8444-444444444444" },
      [{ ...source, itemKey: "old-fixture.md" }],
    );
    await expect(
      service.fromCitation(session, {
        messageId: "44444444-4444-4444-8444-444444444444",
        sourceId: source.sourceId,
      }),
    ).rejects.toMatchObject({ code: "LIBRARY_ARTICLE_NOT_AVAILABLE" });
  });
});
