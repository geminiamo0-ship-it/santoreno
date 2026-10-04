import { describe, expect, it } from "vitest";

import { QuotaStateError } from "./tenant-meter-core";

describe("QuotaStateError", () => {
  it("carries stable HTTP and machine-readable error metadata", () => {
    const error = new QuotaStateError(409, "IDEMPOTENCY_CONFLICT", "conflict");

    expect(error.name).toBe("QuotaStateError");
    expect(error.status).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
