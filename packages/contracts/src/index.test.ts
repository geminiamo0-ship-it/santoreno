import { describe, expect, it } from "vitest";

import { HealthResponseSchema } from "./index";

describe("HealthResponseSchema", () => {
  it("rejects an invalid status", () => {
    const result = HealthResponseSchema.safeParse({
      service: "santo-api",
      status: "unknown",
    });

    expect(result.success).toBe(false);
  });
});
