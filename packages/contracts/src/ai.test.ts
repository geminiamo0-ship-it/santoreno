import { describe, expect, it } from "vitest";

import { GroundedAiQueryRequestSchema, SantoLibraryIdSchema } from "./ai";

describe("Santo AI contracts", () => {
  it("keeps All Libraries as the default when library_id is omitted", () => {
    expect(
      GroundedAiQueryRequestSchema.parse({
        query: "What is the normal serum sodium range?",
        idempotency_key: "query-1",
      }),
    ).toEqual({
      query: "What is the normal serum sodium range?",
      idempotency_key: "query-1",
    });
  });

  it("accepts a validated optional library_id", () => {
    expect(
      GroundedAiQueryRequestSchema.parse({
        query: "What is the normal serum sodium range?",
        idempotency_key: "query-2",
        library_id: "mrcp-part-1",
      }).library_id,
    ).toBe("mrcp-part-1");
  });

  it("rejects malformed library identifiers", () => {
    expect(SantoLibraryIdSchema.safeParse("mrcp/../../other").success).toBe(false);
    expect(SantoLibraryIdSchema.safeParse("mrcp part 1").success).toBe(false);
    expect(SantoLibraryIdSchema.safeParse("").success).toBe(false);
  });
});
