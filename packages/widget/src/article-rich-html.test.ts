import { describe, expect, it } from "vitest";
import type { SourceArticleResponse } from "@santo/contracts/library-reader";
import {
  approvedMedicalImageUrl,
  decodeArticlePopover,
  referencedHeadingText,
  sanitizeArticleForReader,
} from "./article-rich-html";
import { citedMedicalImages } from "./cited-chat-images";

const ORIGIN = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev";
const image = ORIGIN + "/offline_media/L70427jpg.jpg";
const message = "22222222-2222-4222-8222-222222222222";
const citation = "amboss-instance:chunk-2";

function sourceResponse(): SourceArticleResponse {
  return {
    source: {
      sourceId: citation,
      libraryId: "amboss",
      instanceId: "amboss-instance",
      itemKey: "medical-search/v1/amboss/a-1/s-0002.md",
      title: "Atrial flutter",
      page: null,
      section: "ECG",
    },
    article: {
      schemaVersion: 1,
      libraryId: "amboss",
      articleId: "a-1",
      title: "Atrial flutter",
      category: "Cardiology",
      source: "amboss",
      contentHtml: '<h2>ECG</h2><img src="' + image + '">',
      sections: [
        {
          id: "s-0001",
          heading: "Introduction",
          text: "Other section",
          images: [{ src: ORIGIN + "/offline_media/other.jpg", alt: "Uncited" }],
        },
        {
          id: "s-0002",
          heading: "ECG",
          text: "Sawtooth",
          images: [
            { src: image, alt: "Typical flutter ECG" },
            { src: image, alt: "Duplicate" },
            { src: "https://evil.example/other.png", alt: "Unsafe" },
          ],
        },
      ],
    },
    highlightSectionId: "s-0002",
  };
}

describe("Santo original article and chat medical image security", () => {
  it("accepts only approved offline_media R2 URL without query or path tricks", () => {
    expect(approvedMedicalImageUrl(image)).toBe(image);
    for (const bad of [
      "https://evil.example/offline_media/L70427jpg.jpg",
      "http://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/a.jpg",
      image + "?x=1",
      image + "#fragment",
      ORIGIN + "/offline_media/%2e%2e.jpg",
      ORIGIN + "/offline_media/%2F.jpg",
      ORIGIN + "/other/a.jpg",
      "javascript:alert(1)",
    ]) {
      expect(approvedMedicalImageUrl(bad)).toBeNull();
    }
  });

  it("only displays media from exact source-verified cited section", () => {
    const source = sourceResponse();
    expect(citedMedicalImages(source, message, citation)).toEqual([
      {
        src: image,
        alt: "Typical flutter ECG",
        messageId: message,
        sourceId: citation,
        sectionTitle: "ECG",
      },
    ]);
    expect(citedMedicalImages({ ...source, highlightSectionId: null }, message, citation)).toEqual(
      [],
    );
    expect(citedMedicalImages(source, message, "forged:chunk")).toEqual([]);
    expect(
      citedMedicalImages(
        { ...source, source: { ...source.source, libraryId: "pastest" } },
        message,
        citation,
      ),
    ).toEqual([]);
    expect(
      citedMedicalImages({ ...source, highlightSectionId: "s-0001" }, message, citation)[0]?.alt,
    ).toBe("Uncited");
  });

  it("does not silently inject raw HTML without an actual browser DOMParser", () => {
    expect(sanitizeArticleForReader("<img src=x onerror=evil()>")).toBe("");
    expect(referencedHeadingText("ECG (part 3)")).toBe("ecg");
    expect(decodeArticlePopover("VGVzdA==")).toBe("Test");
  });
});
