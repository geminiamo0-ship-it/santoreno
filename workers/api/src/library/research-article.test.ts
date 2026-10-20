import { describe, expect, it, vi } from "vitest";
import type { R2BucketLike, R2ObjectBodyLike } from "../runtime/bindings";
import { R2VerifiedSourceStore } from "../sources/store";
import { PubMedArticleViewerService } from "./research-article";

const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "medical-student",
  sessionId: "22222222-2222-4222-8222-222222222222",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const messageId = "33333333-3333-4333-8333-333333333333";
const source = {
  sourceId: "pubmed:12345678",
  libraryId: "pubmed",
  instanceId: "pubmed",
  itemKey: "pmid:12345678",
  title: "Aortic Stenosis: a randomized clinical trial",
  page: null,
  section: "PubMed / PMC PMC98765",
};

class Bucket implements R2BucketLike {
  private readonly data = new Map<string, string>();
  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const value = this.data.get(key);
    return value === undefined ? null : { text: async () => value };
  }
  async put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown> {
    if (typeof value === "string") this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

async function fixture() {
  const bucket = new Bucket();
  const snapshots = new R2VerifiedSourceStore(bucket);
  await snapshots.save({ ...session, messageId }, [source]);
  const external = vi.fn(async (raw: RequestInfo | URL) => {
    const url = String(raw);
    if (url.includes("/search?")) {
      return Response.json({
        resultList: {
          result: [
            {
              source: "MED",
              pmid: "12345678",
              title: "Aortic Stenosis: a randomized clinical trial",
              abstractText:
                "<h4>Background</h4><p>Trials compare two interventions for severe aortic stenosis.</p>",
              pubYear: "2026",
              journalTitle: "Example Medical Journal",
              authorString: "Doctor A; Doctor B",
              doi: "10.1000/test",
              pmcid: "PMC98765",
            },
          ],
        },
      });
    }
    if (url.endsWith("/PMC98765/fullTextXML")) {
      return new Response(
        "<article><body><sec><p>Full-text results included survival, symptoms and clinically important outcomes.</p></sec></body></article>",
      );
    }
    return new Response("Not found", { status: 404 });
  });
  return { service: new PubMedArticleViewerService(snapshots, external as typeof fetch), external };
}

describe("verified internal PubMed article viewer", () => {
  it("renders the abstract, DOI/publication metadata, and available PMC full text", async () => {
    const { service, external } = await fixture();
    const result = await service.fromCitation(session, { messageId, sourceId: "pubmed:12345678" });
    expect(result.article.libraryId).toBe("pubmed");
    expect(result.article.sections[0]?.heading).toBe("Abstract");
    expect(result.article.sections[0]?.text).toContain("Trials compare two interventions");
    expect(result.article.sections.some((s) => s.text.includes("Full-text results"))).toBe(true);
    expect(result.article.sections.some((s) => s.text.includes("10.1000/test"))).toBe(true);
    expect(result.highlightSectionId).toBe("s-0001");
    expect(external).toHaveBeenCalledTimes(2);
  });

  it("rejects forged citations and other account's saved snapshots before any provider fetch", async () => {
    const { service, external } = await fixture();
    await expect(
      service.fromCitation(
        { ...session, externalUserId: "another-student" },
        { messageId, sourceId: "pubmed:12345678" },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.fromCitation(session, { messageId, sourceId: "pubmed:999" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(external).not.toHaveBeenCalled();
  });

  it("rejects browser-supplied extra fields and never accepts arbitrary provider URLs", async () => {
    const { service, external } = await fixture();
    await expect(
      service.fromCitation(session, {
        messageId,
        sourceId: "pubmed:12345678",
        url: "https://example.test/private",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(external).not.toHaveBeenCalled();
  });

  it("does not fabricate article content on provider outage", async () => {
    const { service, external } = await fixture();
    external.mockImplementation(async () => new Response("Unavailable", { status: 503 }));
    await expect(
      service.fromCitation(session, { messageId, sourceId: "pubmed:12345678" }),
    ).rejects.toMatchObject({ status: 503, code: "LIBRARY_UNAVAILABLE" });
  });
});
