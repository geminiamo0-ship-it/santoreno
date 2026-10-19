import { describe, expect, it, vi } from "vitest";

import type { R2BucketLike } from "../runtime/bindings";
import { AmbossAdjacentRetrieval, expandAmbossAdjacentEvidence } from "./amboss-adjacent";
import { buildGroundedPrompt } from "./prompt";
import type { RetrievalPort, RetrievedEvidence } from "./types";

const folder = "medical-search/v1/amboss/unnamed-2746/";
const anchor: RetrievedEvidence = {
  sourceId: "amboss:search-chunk-0015",
  libraryId: "amboss",
  instanceId: "amboss",
  itemKey: folder + "s-0015.md",
  title: "Aortic valve stenosis",
  page: null,
  section: "Treatment",
  text: "# Aortic valve stenosis\nLibrary: AMBOSS\nSection: Treatment\nAVR is definitive.",
  score: 0.93,
};
const usmle: RetrievedEvidence = {
  ...anchor,
  libraryId: "usmle",
  instanceId: "usmle",
  itemKey: "medical-search/v1/usmle/valve/s-0001.md",
  sourceId: "usmle:search-1",
};

function section(n: number, name: string) {
  return (
    "# Aortic valve stenosis\n\nLibrary: AMBOSS\nCategory: Clinical correlations\nSection: " +
    name +
    "\n\nClinical teaching text " +
    n +
    " about aortic stenosis."
  );
}

function fakeBucket(keys: Record<string, string>) {
  const reads: string[] = [];
  const bucket: Pick<R2BucketLike, "get"> = {
    get: vi.fn(async (key: string) => {
      reads.push(key);
      const text = keys[key];
      return text === undefined ? null : { text: async () => text };
    }),
  };
  return { bucket, reads };
}

function files() {
  const names = [
    "Approach",
    "Echocardiographic monitoring",
    "SAVR and TAVR",
    "Follow-up",
    "Antithrombotic therapy",
    "Complications",
    "Special populations",
    "Concomitant disease",
    "Follow-up after intervention",
    "Treatment summary",
  ];
  return Object.fromEntries(
    names.map((name, index) => [
      folder + "s-" + String(index + 16).padStart(4, "0") + ".md",
      section(index + 16, name),
    ]),
  );
}

describe("AMBOSS-only adjacent R2 evidence expansion", () => {
  it("adds exactly ten following AMBOSS sections with distinct server-derived citations", async () => {
    const { bucket, reads } = fakeBucket(files());
    const result = await expandAmbossAdjacentEvidence([anchor, usmle], bucket);
    expect(result).toHaveLength(12);
    expect(result.map((item) => item.itemKey)).toEqual([
      anchor.itemKey,
      ...Array.from(
        { length: 10 },
        (_, index) => folder + "s-" + String(index + 16).padStart(4, "0") + ".md",
      ),
      usmle.itemKey,
    ]);
    expect(reads).toEqual(result.slice(1, 11).map((item) => item.itemKey));
    expect(result[1]).toMatchObject({
      section: "Approach",
      libraryId: "amboss",
      instanceId: "amboss",
      page: null,
      score: 0,
    });
    expect(result[1]?.sourceId).toMatch(/^amboss:r2-[0-9a-f]{32}$/);
    expect(new Set(result.map((item) => item.sourceId)).size).toBe(12);
    const output = buildGroundedPrompt("Management of aortic stenosis", result);
    expect(output).toContain("Echocardiographic monitoring");
    expect(output).toContain(result[3]!.sourceId);
  });

  it("starts all ten R2 reads before awaiting any individual object and preserves neighbor ordering", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const bucket: Pick<R2BucketLike, "get"> = {
      get: vi.fn(async (key: string) => {
        calls.push(key);
        await waiting;
        return { text: async () => files()[key] ?? "" };
      }),
    };
    const pending = expandAmbossAdjacentEvidence([anchor, usmle], bucket);
    await Promise.resolve();
    expect(calls).toHaveLength(10);
    expect(calls[0]).toBe(folder + "s-0016.md");
    expect(calls[9]).toBe(folder + "s-0025.md");
    release();
    const result = await pending;
    expect(result.map((x) => x.itemKey)).toEqual([anchor.itemKey, ...calls, usmle.itemKey]);
  });

  it("keeps the five original results and caps the total at fifteen", async () => {
    const original = [
      anchor,
      usmle,
      { ...usmle, libraryId: "pastest", sourceId: "pastest:1", itemKey: "pastest/1.md" },
      {
        ...usmle,
        libraryId: "passmedicine",
        sourceId: "passmedicine:1",
        itemKey: "passmedicine/1.md",
      },
      {
        ...usmle,
        libraryId: "one-examination",
        sourceId: "one-examination:1",
        itemKey: "one-examination/1.md",
      },
    ];
    const result = await expandAmbossAdjacentEvidence(original, fakeBucket(files()).bucket);
    expect(result).toHaveLength(15);
    expect(result.filter((x) => x.libraryId === "amboss")).toHaveLength(11);
    expect(result.filter((x) => x.libraryId !== "amboss")).toHaveLength(4);
    expect(buildGroundedPrompt("Treatment of AS", result)).toContain("SAVR and TAVR");
  });

  it("rejects other libraries, unsafe R2 keys, and the section-number boundary", async () => {
    const { bucket, reads } = fakeBucket(files());
    for (const evidence of [
      [usmle],
      [{ ...anchor, itemKey: "medical-search/v1/amboss/../usmle/s-0015.md" }],
      [{ ...anchor, itemKey: folder + "s-9999.md" }],
      [{ ...anchor, itemKey: "medical-search/v1/amboss/foo/s-0015.md/../../x" }],
    ]) {
      expect(await expandAmbossAdjacentEvidence(evidence, bucket)).toEqual(evidence);
    }
    expect(reads).toHaveLength(0);
  });

  it("stops at a missing or invalid section and never changes an existing hit", async () => {
    const missing = fakeBucket({ [folder + "s-0016.md"]: section(16, "Approach") });
    const partial = await expandAmbossAdjacentEvidence([anchor], missing.bucket);
    expect(partial).toHaveLength(2);
    expect(missing.reads).toHaveLength(10); // Prefetched concurrently; only the valid consecutive prefix is trusted.
    const invalid = fakeBucket({
      [folder + "s-0016.md"]: section(16, "Approach").replace("AMBOSS", "USMLE"),
    });
    expect(await expandAmbossAdjacentEvidence([anchor], invalid.bucket)).toEqual([anchor]);
    const wrongArticle = fakeBucket({
      [folder + "s-0016.md"]: section(16, "Approach").replace(
        "# Aortic valve stenosis",
        "# Coarctation",
      ),
    });
    expect(await expandAmbossAdjacentEvidence([anchor], wrongArticle.bucket)).toEqual([anchor]);
  });

  it("deduplicates already-retrieved sections without another R2 read", async () => {
    const { bucket, reads } = fakeBucket(files());
    const originalSecond = {
      ...anchor,
      itemKey: folder + "s-0016.md",
      sourceId: "amboss:real-search-0016",
    };
    const result = await expandAmbossAdjacentEvidence([anchor, usmle, originalSecond], bucket);
    expect(result).toHaveLength(12);
    expect(result[1]?.sourceId).toBe(originalSecond.sourceId);
    expect(result.filter((r) => r.itemKey === originalSecond.itemKey)).toHaveLength(1);
    expect(reads).not.toContain(originalSecond.itemKey);
  });

  it("gracefully retains search evidence on R2 failure", async () => {
    const bucket: Pick<R2BucketLike, "get"> = {
      get: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
    };
    expect(await expandAmbossAdjacentEvidence([anchor, usmle], bucket)).toEqual([anchor, usmle]);
  });

  it("preserves a single search, routing, and gallery results via the decorator", async () => {
    const search = vi.fn(async () => [anchor, usmle]);
    const gallery = vi.fn(async () => ({
      evidence: [anchor, usmle],
      galleryHits: [{ imageId: "img_000014", score: 0.9 }],
    }));
    const route = vi.fn(async () => ({
      intent: "medical" as const,
      searchQuery: "aortic stenosis",
    }));
    const source: RetrievalPort = { retrieve: search, retrieveWithGallery: gallery, route };
    const decorated = new AmbossAdjacentRetrieval(source, fakeBucket(files()).bucket);
    const request = { query: "management", libraryId: null };
    const result = await decorated.retrieve(request);
    expect(result).toHaveLength(12);
    expect(search).toHaveBeenCalledTimes(1);
    const withGallery = await decorated.retrieveWithGallery!(request);
    expect(withGallery.galleryHits).toEqual([{ imageId: "img_000014", score: 0.9 }]);
    expect(withGallery.evidence).toHaveLength(12);
    expect(gallery).toHaveBeenCalledTimes(1);
    expect(await decorated.route!(request)).toEqual({
      intent: "medical",
      searchQuery: "aortic stenosis",
    });
    expect(route).toHaveBeenCalledTimes(1);
  });
});
