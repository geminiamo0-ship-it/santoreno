import { describe, expect, it } from "vitest";
import { CloudflareGalleryImageRetrieval } from "./image-gallery";
import type { AiSearchNamespaceLike, R2BucketLike } from "../runtime/bindings";

const DOMAIN = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/";

function setup(
  options: { url?: string; score?: number; chunks?: unknown[]; broken?: boolean } = {},
) {
  const searched: unknown[] = [];
  const namespace: AiSearchNamespaceLike = {
    async list() {
      return [];
    },
    async search(input) {
      searched.push(input);
      if (options.broken) throw new Error("not available");
      return {
        chunks: options.chunks ?? [
          {
            id: "abc",
            instance_id: "santo-medical-images",
            score: options.score ?? 0.88,
            item: { key: "img_000001.json" },
          },
        ],
      };
    },
  };
  const bucket: R2BucketLike = {
    async get(key) {
      if (key !== "gallery/v1/santo_image_manifest.json") return null;
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
  return { retriever: new CloudflareGalleryImageRetrieval(namespace, bucket), searched };
}

describe("medical gallery sixth instance", () => {
  it("searches exactly the image instance with existing rewritten query", async () => {
    const { retriever, searched } = setup();
    const images = await retriever.retrieve("hyperkalemia ECG changes");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      id: "IMG_081",
      sourceId: "",
      caption: "Tall peaked T waves",
      src: DOMAIN + "ecg.webp",
    });
    expect(searched[0]).toMatchObject({
      query: "hyperkalemia ECG changes",
      ai_search_options: { instance_ids: ["santo-medical-images"] },
    });
  });

  it("rejects low confidence scores and fabricated image keys", async () => {
    expect(await setup({ score: 0.2 }).retriever.retrieve("test")).toEqual([]);
    expect(
      await setup({
        chunks: [
          {
            id: "abc",
            instance_id: "santo-medical-images",
            score: 0.9,
            item: { key: "medical-search/v1/amboss/abc.md" },
          },
        ],
      }).retriever.retrieve("test"),
    ).toEqual([]);
  });

  it("rejects external or unexpected image URLs", async () => {
    for (const url of [
      "https://evil.example/offline_media/abc.webp",
      DOMAIN.replace("/offline_media/", "/other/") + "abc.webp",
      "javascript:alert(1)",
    ]) {
      const { retriever } = setup({ url });
      expect(await retriever.retrieve("ECG")).toEqual([]);
    }
  });

  it("propagates search outage to bounded caller fallback", async () => {
    await expect(setup({ broken: true }).retriever.retrieve("test")).rejects.toThrow(
      "not available",
    );
  });
});
