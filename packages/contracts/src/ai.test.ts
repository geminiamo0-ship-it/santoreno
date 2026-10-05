import { describe, expect, it } from "vitest";

import { GroundedAiQueryRequestSchema } from "./ai";

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
