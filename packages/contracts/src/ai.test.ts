import { describe, expect, it } from "vitest";

import { GroundedAiQueryRequestSchema, GroundedAiStreamEventSchema } from "./ai";

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
  it("accepts explicit stream opt-in while keeping JSON as the default", () => {
    const plain = GroundedAiQueryRequestSchema.parse({
      query: "Sodium?",
      idempotency_key: "sse-1",
    });
    const streamed = GroundedAiQueryRequestSchema.parse({
      query: "Sodium?",
      idempotency_key: "sse-1",
      stream: true,
    });

    expect(plain.stream).toBeUndefined();
    expect(streamed.stream).toBe(true);
    expect(
      GroundedAiQueryRequestSchema.safeParse({
        query: "Sodium?",
        idempotency_key: "sse-1",
        stream: "true",
      }).success,
    ).toBe(false);
  });

  it("validates the streaming event union and rejects invented payload fields", () => {
    expect(
      GroundedAiStreamEventSchema.parse({ type: "delta", text: "validated answer" }),
    ).toEqual({ type: "delta", text: "validated answer" });
    expect(GroundedAiStreamEventSchema.safeParse({ type: "delta", text: "" }).success).toBe(
      false,
    );
    expect(
      GroundedAiStreamEventSchema.safeParse({
        type: "delta",
        text: "answer",
        citation_ids: ["invented"],
      }).success,
    ).toBe(false);
    expect(
      GroundedAiStreamEventSchema.safeParse({
        type: "complete",
        response: { answer: "uncited" },
      }).success,
    ).toBe(false);
  });

});
