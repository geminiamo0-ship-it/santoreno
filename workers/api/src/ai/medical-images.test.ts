import { describe, expect, it } from "vitest";
import type { R2BucketLike } from "../runtime/bindings";
import type { RetrievedEvidence } from "./types";
import { loadMedicalImages, medicalImagePrompt, renderMedicalImageMarkers } from "./medical-images";

const MEDIA = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/";
const evidence: RetrievedEvidence[] = [{
  sourceId: "amboss:chunk-123", instanceId: "amboss", libraryId: "amboss",
  itemKey: "medical-search/v1/amboss/aortic-stenosis/s-0001.md",
  title: "Aortic stenosis", section: "Diagnosis", page: null,
  text: "Valve obstruction", score: 0.93,
}];

function bucket(html: string, count = { reads: 0 }): R2BucketLike {
  const article = {
    schemaVersion: 1, libraryId: "amboss", articleId: "aortic-stenosis",
    title: "Aortic stenosis", category: "Cardiology", source: "AMBOSS",
    contentHtml: html,
    sections: [{ id: "s-0001", heading: "Diagnosis", text: "Aortic valve disease",
      images: [{ src: MEDIA + "valve.png", alt: "Aortic valve" }] }],
  };
  return {
    async get(key: string) {
      count.reads++;
      return key === "medical-articles/v1/amboss/aortic-stenosis.json"
        ? { text: async () => JSON.stringify(article) }
        : null;
    },
    async put() { return null; },
    async delete() {},
  };
}

describe("Luna original medical article images", () => {
  it("hydrates HTML images with canonical R2 src, original IDs and figcaption", async () => {
    const html = '<h2>Diagnosis</h2><p>Valve narrowing on echocardiography.</p>' +
      '<figure><img id="fig-88" alt="Doppler" src="' + MEDIA + 'valve.png">' +
      '<figcaption>Continuous-wave Doppler showing severe aortic stenosis</figcaption></figure>';
    const reads = { reads: 0 };
    const images = await loadMedicalImages(bucket(html, reads), [...evidence, evidence[0]!]);
    expect(reads.reads).toBe(1);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      id: "IMG_001", originalId: "fig-88",
      src: MEDIA + "valve.png", caption: "Continuous-wave Doppler showing severe aortic stenosis",
      section: "Diagnosis", sourceId: "amboss:chunk-123",
    });
    expect(medicalImagePrompt(images)).toContain("IMG_001");
    expect(medicalImagePrompt(images)).toContain("fig-88");
  });

  it("falls back to two neighboring prose blocks when the image has no caption", async () => {
    const html = "<h2>Pathophysiology</h2>" +
      "<p>Pressure overload develops across the narrowed aortic valve.</p>" +
      "<p>The left ventricle initially compensates with concentric hypertrophy.</p>" +
      '<img id="diagram" src="' + MEDIA + 'valve.png" alt="Aortic obstruction">' +
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
    const article = await loadMedicalImages(bucket('<img src="https://evil.example/x.png">'), evidence);
    expect(article).toEqual([]);
    const forged: RetrievedEvidence[] = [{ ...evidence[0]!, itemKey: "../../outside" }];
    const reads = { reads: 0 };
    expect(await loadMedicalImages(bucket("", reads), forged)).toEqual([]);
    expect(reads.reads).toBe(0);
  });
});
