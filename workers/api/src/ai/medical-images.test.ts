import { describe, expect, it } from "vitest";
import type { R2BucketLike } from "../runtime/bindings";
import type { RetrievedEvidence } from "./types";
import {
  loadMedicalImages,
  medicalImagePrompt,
  renderMedicalImageMarkers,
  selectMedicalImagesForPrompt,
} from "./medical-images";

const MEDIA = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/";
const evidence: RetrievedEvidence[] = [
  {
    sourceId: "amboss:chunk-123",
    instanceId: "amboss",
    libraryId: "amboss",
    itemKey: "medical-search/v1/amboss/aortic-stenosis/s-0001.md",
    title: "Aortic stenosis",
    section: "Diagnosis",
    page: null,
    text: "Valve obstruction",
    score: 0.93,
  },
];

function bucket(html: string, count = { reads: 0 }): R2BucketLike {
  const article = {
    schemaVersion: 1,
    libraryId: "amboss",
    articleId: "aortic-stenosis",
    title: "Aortic stenosis",
    category: "Cardiology",
    source: "AMBOSS",
    contentHtml: html,
    sections: [
      {
        id: "s-0001",
        heading: "Diagnosis",
        text: "Aortic valve disease",
        images: [{ src: MEDIA + "valve.png", alt: "Aortic valve" }],
      },
    ],
  };
  return {
    async get(key: string) {
      count.reads++;
      return key === "medical-articles/v1/amboss/aortic-stenosis.json"
        ? { text: async () => JSON.stringify(article) }
        : null;
    },
    async put() {
      return null;
    },
    async delete() {},
  };
}

describe("Luna original medical article images", () => {
  it("starts all five R2 article reads before any finishes and preserves evidence ordering", async () => {
    const ids = ["amboss", "usmle", "passmedicine", "pastest", "one-examination"];
    let started = 0;
    const articles = ids.map((id) => ({
      ...evidence[0]!,
      sourceId: id + ":unique-chunk",
      libraryId: id,
      instanceId: id,
      itemKey: "medical-search/v1/" + id + "/topic/s-0001.md",
    }));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const b: R2BucketLike = {
      async get(key) {
        started++;
        await gate;
        const lib = ids.find((id) => key === "medical-articles/v1/" + id + "/topic.json")!;
        return {
          text: async () =>
            JSON.stringify({
              schemaVersion: 1,
              libraryId: lib,
              articleId: "topic",
              title: lib,
              source: lib,
              category: "General",
              contentHtml: '<h2>Figure</h2><img src="' + MEDIA + lib + '.png">',
              sections: [{ id: "s-0001", heading: "Figure", text: "Relevant image", images: [] }],
            }),
        };
      },
      async put() {
        return null;
      },
      async delete() {},
    };
    const resultPromise = loadMedicalImages(b, articles);
    await Promise.resolve();
    expect(started).toBe(5);
    finish();
    const actual = await resultPromise;
    expect(actual.map((item) => item.sourceId)).toEqual(ids.map((id) => id + ":unique-chunk"));
    const repeat = await loadMedicalImages(
      b,
      articles.map((item) => ({
        ...item,
        sourceId: item.sourceId.replace("unique", "another"),
      })),
    );
    expect(started).toBe(5);
    expect(repeat.map((item) => item.sourceId)).toEqual(ids.map((id) => id + ":another-chunk"));
  });

  it("offers up to 30 source-verified image candidates and prioritizes clinical matches", () => {
    const candidates = Array.from({ length: 45 }, (_, index) => ({
      id: "IMG_" + String(index + 1).padStart(3, "0"),
      sourceId: index === 44 ? "usmle:unique" : "amboss:source",
      src: MEDIA + index + ".png",
      articleTitle: "Cardiology",
      section: index === 44 ? "Aortic stenosis Doppler ultrasound" : "Unrelated figure",
      alt: "Figure " + index,
      caption: "",
      originalId: null,
      before: "",
      after: "",
    }));
    const chosen = selectMedicalImagesForPrompt(candidates, "aortic stenosis", 30);
    expect(chosen).toHaveLength(30);
    expect(chosen.map((item) => item.id)).toContain("IMG_045");
    const prompt = medicalImagePrompt(candidates, "aortic stenosis");
    expect(prompt).toContain("IMG_045");
    expect(prompt).not.toContain("IMG_044");
    expect(prompt.match(/"image_id":/g)).toHaveLength(30);
    expect(prompt).not.toContain(MEDIA + "44.png"); // Original URLs stay server-side
    expect(prompt).toContain("Illustrations are a PRIORITY");
    expect(prompt).toContain("genuinely match the CURRENT question");
    expect(prompt).toContain("use none if no illustration adds reliable teaching value");
  });

  it("combines lazy HTML images with section image metadata without duplicating original figures", async () => {
    const html =
      '<h2>Diagnosis</h2><img data-src="' +
      MEDIA +
      'doppler.png" alt="Doppler study"><img src="' +
      MEDIA +
      'valve.png" alt="Valve">';
    const original = bucket(html);
    const merged: R2BucketLike = {
      ...original,
      async get(key) {
        const object = await original.get(key);
        if (!object) return null;
        const article = JSON.parse(await object.text()) as {
          sections: Array<{ images: Array<{ src: string; alt: string }> }>;
        };
        article.sections[0]!.images.push({ src: MEDIA + "doppler.png", alt: "Doppler" });
        article.sections[0]!.images.push({
          src: MEDIA + "additional.png",
          alt: "Extra section figure",
        });
        // Structured section image URLs are already schema-validated; test
        // hostile HTML separately rather than invalidating the whole article.
        return { text: async () => JSON.stringify(article) };
      },
    };
    const results = await loadMedicalImages(merged, evidence);
    expect(results.map((item) => item.src)).toEqual([
      MEDIA + "doppler.png",
      MEDIA + "valve.png",
      MEDIA + "additional.png",
    ]);
    expect(results[0]!.alt).toBe("Doppler study");
    expect(results.every((item) => item.sourceId === "amboss:chunk-123")).toBe(true);
  });

  it("hydrates HTML images with canonical R2 src, original IDs and figcaption", async () => {
    const html =
      "<h2>Diagnosis</h2><p>Valve narrowing on echocardiography.</p>" +
      '<figure><img id="fig-88" alt="Doppler" src="' +
      MEDIA +
      'valve.png">' +
      "<figcaption>Continuous-wave Doppler showing severe aortic stenosis</figcaption></figure>";
    const reads = { reads: 0 };
    const images = await loadMedicalImages(bucket(html, reads), [...evidence, evidence[0]!]);
    expect(reads.reads).toBe(1);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      id: "IMG_001",
      originalId: "fig-88",
      src: MEDIA + "valve.png",
      caption: "Continuous-wave Doppler showing severe aortic stenosis",
      section: "Diagnosis",
      sourceId: "amboss:chunk-123",
    });
    expect(medicalImagePrompt(images)).toContain("IMG_001");
    expect(medicalImagePrompt(images)).toContain("fig-88");
  });

  it("falls back to two neighboring prose blocks when the image has no caption", async () => {
    const html =
      "<h2>Pathophysiology</h2>" +
      "<p>Pressure overload develops across the narrowed aortic valve.</p>" +
      "<p>The left ventricle initially compensates with concentric hypertrophy.</p>" +
      '<img id="diagram" src="' +
      MEDIA +
      'valve.png" alt="Aortic obstruction">' +
      "<p>Myocardial oxygen demand rises as the wall thickens.</p>" +
      "<p>Progressive diastolic dysfunction can follow.</p>";
    const images = await loadMedicalImages(bucket(html), evidence);
    expect(images).toHaveLength(1);
    expect(images[0]!.before).toContain("concentric hypertrophy");
    expect(images[0]!.after).toContain("Myocardial oxygen demand");
    expect(images[0]!.section).toBe("Pathophysiology");
  });

  it("never turns Luna-invented image URLs or image IDs into content", async () => {
    const html = '<p>Actual article</p><img src="' + MEDIA + 'valve.png" alt="Valve anatomy">';
    const images = await loadMedicalImages(bucket(html), evidence);
    const rendered = renderMedicalImageMarkers(
      "## Anatomy\n\n[[IMG_001]]\n[[IMG_999]]\n![fake](https://evil.example/img.png)\n[[IMG_001]]",
      images,
    );
    expect(rendered.sourceIds).toEqual(["amboss:chunk-123"]);
    expect(rendered.answer.match(/!\[/g)).toHaveLength(1);
    expect(rendered.answer).toContain(MEDIA + "valve.png");
    expect(rendered.answer).toContain("Source: Aortic stenosis");
    expect(rendered.answer).not.toContain("evil.example");
    expect(rendered.answer).not.toContain("IMG_999");
  });

  it("does not expose images from forged indexes or foreign R2 origins", async () => {
    const article = await loadMedicalImages(
      bucket('<img src="https://evil.example/x.png">'),
      evidence,
    );
    // An unsafe HTML URL is rejected; safe section metadata from the same
    // schema-validated source can still be used as a legitimate fallback.
    expect(article.map((image) => image.src)).toEqual([MEDIA + "valve.png"]);
    expect(article.every((image) => !image.src.includes("evil.example"))).toBe(true);
    const forged: RetrievedEvidence[] = [{ ...evidence[0]!, itemKey: "../../outside" }];
    const reads = { reads: 0 };
    expect(await loadMedicalImages(bucket("", reads), forged)).toEqual([]);
    expect(reads.reads).toBe(0);
  });
});
