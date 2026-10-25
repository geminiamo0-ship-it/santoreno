import { describe, expect, it } from "vitest";

import { GroundedAiQueryRequestSchema, GroundedAiQueryResponseSchema, approvedPmcFigureImageUrl } from "./ai";

describe("GroundedAiQueryRequestSchema", () => {
  it("keeps All Libraries as the default when library_id is omitted", () => {
    const parsed = GroundedAiQueryRequestSchema.parse({
      query: "What is hyponatraemia?",
      idempotency_key: "req-1",
    });

    expect(parsed.library_id).toBeUndefined();
  });

  it("accepts a stable lower-case library identifier", () => {
    const parsed = GroundedAiQueryRequestSchema.parse({
      query: "What is hyponatraemia?",
      idempotency_key: "req-2",
      library_id: "mrcp_part_1",
    });

    expect(parsed.library_id).toBe("mrcp_part_1");
  });

  it("rejects malformed library identifiers", () => {
    const parsed = GroundedAiQueryRequestSchema.safeParse({
      query: "What is hyponatraemia?",
      idempotency_key: "req-3",
      library_id: "../MRCP",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("Santo grounded-versus-general response contract", () => {
  const base = {
    requestId: "7fc8c6e6-b0c1-4a6d-9c9c-6f7a0e4f0d3a",
    messageId: "6b2ae3d3-dac3-49cb-a4e3-55fa3fdc0adb",
    answer: "A clear medical educational answer.",
    usage: { unitsCharged: 1, remaining: 9 },
  };
  it("accepts sixty verified cited sources and rejects sixty-one", () => {
    const citations = Array.from({ length: 60 }, (_, i) => ({
      sourceId: "amboss:r2-" + i,
      title: "Aortic valve stenosis",
      page: null,
    }));
    expect(
      GroundedAiQueryResponseSchema.safeParse({
        ...base,
        groundingMode: "santo",
        citations,
      }).success,
    ).toBe(true);
    expect(
      GroundedAiQueryResponseSchema.safeParse({
        ...base,
        groundingMode: "santo",
        citations: [...citations, { sourceId: "amboss:extra", title: "Extra", page: null }],
      }).success,
    ).toBe(false);
  });

  it("accepts 30 real unused-gallery images and still rejects more than the 50-result ceiling", () => {
    const relatedPics = Array.from({ length: 30 }, (_, n) => ({
      src: "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/image" + n + ".webp",
      alt: "Medical educational image " + n,
      caption: "Image from original gallery",
      sourceName: "Medical image gallery",
    }));
    expect(
      GroundedAiQueryResponseSchema.safeParse({
        ...base,
        citations: [{ sourceId: "amboss:original-1", title: "AMBOSS", page: null }],
        relatedPics,
      }),
    ).toMatchObject({ success: true });
    expect(
      GroundedAiQueryResponseSchema.safeParse({
        ...base,
        citations: [{ sourceId: "amboss:original-1", title: "AMBOSS", page: null }],
        relatedPics: [...relatedPics, ...relatedPics],
      }).success,
    ).toBe(false);
  });

  it("accepts a clearly labeled general answer with no citations", () => {
    expect(
      GroundedAiQueryResponseSchema.safeParse({
        ...base,
        groundingMode: "general",
        citations: [],
      }).success,
    ).toBe(true);
  });
  it("rejects general answer with fabricated Santo citations", () => {
    expect(
      GroundedAiQueryResponseSchema.safeParse({
        ...base,
        groundingMode: "general",
        citations: [{ sourceId: "fake", title: "Fake book", page: null }],
      }).success,
    ).toBe(false);
  });
  it("rejects missing citations from unlabeled or Santo-grounded answers", () => {
    expect(GroundedAiQueryResponseSchema.safeParse({ ...base, citations: [] }).success).toBe(false);
    expect(
      GroundedAiQueryResponseSchema.safeParse({
        ...base,
        groundingMode: "santo",
        citations: [],
      }).success,
    ).toBe(false);
  });
});
