import { describe, expect, it } from "vitest";

import {
  CreateTenantRequestSchema,
  HealthResponseSchema,
  QuotaConfigureRequestSchema,
  QuotaReserveRequestSchema,
} from "./index";

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

describe("quota contracts", () => {
  it("requires an ordered quota cycle", () => {
    const result = QuotaConfigureRequestSchema.safeParse({
      tenantId: "fca2b199-7e22-45cc-96ec-3b509e7f0d95",
      tenantStatus: "active",
      monthlyAllowance: 100,
      cycleStartAt: "2026-10-31T00:00:00.000Z",
      cycleEndAt: "2026-10-01T00:00:00.000Z",
      user: {
        externalUserId: "58392",
        status: "active",
        baseQuota: 10,
        bonusQuota: 2,
        expiresAt: null,
      },
    });

    expect(result.success).toBe(false);
  });

  it("defaults a reservation to one unit and rejects extra tenant input", () => {
    const parsed = QuotaReserveRequestSchema.parse({
      tenantId: "fca2b199-7e22-45cc-96ec-3b509e7f0d95",
      externalUserId: "58392",
      idempotencyKey: "req-1",
    });
    expect(parsed.units).toBe(1);

    const injected = QuotaReserveRequestSchema.safeParse({
      tenantId: "fca2b199-7e22-45cc-96ec-3b509e7f0d95",
      externalUserId: "58392",
      idempotencyKey: "req-2",
      units: 1,
      otherTenantId: "a5d5d18e-3caf-4761-afc0-e25cc923cc5f",
    });
    expect(injected.success).toBe(false);
  });
});
