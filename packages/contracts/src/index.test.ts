import { describe, expect, it } from "vitest";

import { CreateTenantRequestSchema, HealthResponseSchema } from "./index";

describe("HealthResponseSchema", () => {
  it("rejects an invalid status", () => {
    const result = HealthResponseSchema.safeParse({
      service: "santo-api",
      status: "unknown",
    });

    expect(result.success).toBe(false);
  });
});

describe("CreateTenantRequestSchema", () => {
  it("accepts a normalized tenant request", () => {
    const result = CreateTenantRequestSchema.safeParse({
      slug: "medpark",
      name: "MedPark",
      workosOrgId: "org_medpark",
      ownerWorkosUserId: "user_medpark",
    });

    expect(result.success).toBe(true);
  });

  it("rejects arbitrary browser-controlled tenant fields", () => {
    const result = CreateTenantRequestSchema.safeParse({
      slug: "medpark",
      name: "MedPark",
      workosOrgId: "org_medpark",
      ownerWorkosUserId: "user_medpark",
      tenantId: "attacker-selected-tenant",
    });

    expect(result.success).toBe(false);
  });
});
