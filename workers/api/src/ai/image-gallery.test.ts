import { describe, expect, it } from "vitest";
import { CloudflareGalleryImageRetrieval } from "./image-gallery";
import type { R2BucketLike } from "../runtime/bindings";

const DOMAIN = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/";

function setup(options: { url?: string; missing?: boolean } = {}) {
  const reads: string[] = [];
  const bucket: R2BucketLike = {
    async get(key) {
      reads.push(key);
      if (key !== "gallery/v1/santo_image_manifest.json" || options.missing) return null;
      return {
        async text() {
          return JSON.stringify({
            img_000001: {
              image_url: options.url ?? DOMAIN + "ecg.webp",
              title: "Peaked T wave ECG",
              visual_caption: "Tall peaked T waves",
              primary_system: "Cardiology",
              source_name: "Wikimedia Commons",
            },
          });
        },
      };
    },
    async put() {
      return null;
    },
    async delete() {},
  };
  return { retriever: new CloudflareGalleryImageRetrieval(bucket), reads };
}

describe("gallery hydration from a shared six-index search", () => {
  const hits = [{ imageId: "img_000001", score: 0.88 }];

  it("uses only verified R2 manifest IDs and performs no AI Search", async () => {
    const { retriever, reads } = setup();
    const images = await retriever.hydrate(hits);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      id: "IMG_081",
      sourceId: "",
      caption: "Tall peaked T waves",
      src: DOMAIN + "ecg.webp",
    });
    expect(reads).toEqual(["gallery/v1/santo_image_manifest.json"]);
  });

  it("rejects invalid, low-score and duplicate image hits", async () => {
    const { retriever } = setup();
    const images = await retriever.hydrate([
      { imageId: "img_000001", score: 0.2 },
      { imageId: "invalid", score: 0.99 },
      { imageId: "img_000001", score: 0.92 },
      { imageId: "img_000001", score: 0.8 },
      { imageId: "img_000002", score: 0.89 },
    ]);
    expect(images).toHaveLength(1);
  });

  it("rejects external and malicious image URLs", async () => {
    for (const url of [
      "https://evil.example/offline_media/abc.webp",
      DOMAIN.replace("/offline_media/", "/another/") + "abc.webp",
      "javascript:alert(1)",
    ]) {
      expect(await setup({ url }).retriever.hydrate(hits)).toEqual([]);
    }
  });

  it("returns empty without loading metadata if there are no image hits", async () => {
    const { retriever, reads } = setup();
    expect(await retriever.hydrate([])).toEqual([]);
    expect(reads).toHaveLength(0);
  });

  it("signals missing R2 manifest to the caller for safe optional fallback", async () => {
    await expect(setup({ missing: true }).retriever.hydrate(hits)).rejects.toThrow(
      "Gallery image manifest missing",
    );
  });
});
