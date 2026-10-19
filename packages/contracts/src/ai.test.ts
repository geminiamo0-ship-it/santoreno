import { describe, expect, it } from "vitest";

import { GroundedAiQueryRequestSchema, GroundedAiQueryResponseSchema } from "./ai";

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
  it("accepts fifteen verified cited sources and rejects sixteen", () => {
    const citations = Array.from({ length: 15 }, (_, i) => ({
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
