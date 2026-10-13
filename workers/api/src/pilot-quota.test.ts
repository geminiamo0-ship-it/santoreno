import { describe, expect, it } from "vitest";
import { QuotaUserEntitlementSchema } from "@santo/contracts";

import { createApp } from "./app";

const tenantId = "22222222-2222-4222-8222-222222222222";
const entitlement = {
  externalUserId: "student-1",
  status: "active",
  baseQuota: 100,
  bonusQuota: 0,
  expiresAt: null,
};

describe("pilot quota administration security", () => {
  it("refuses browser-supplied tenant caps or tenant identifiers in a user entitlement", () => {
    expect(QuotaUserEntitlementSchema.safeParse(entitlement).success).toBe(true);
    expect(QuotaUserEntitlementSchema.safeParse({
      ...entitlement, tenantId, monthlyAllowance: 99_999_999,
    }).success).toBe(false);
    expect(QuotaUserEntitlementSchema.safeParse({
      ...entitlement, baseQuota: -1,
    }).success).toBe(false);
  });

  it("rejects any non-super-admin portal principal before initializing quota", async () => {
    const app = createApp({
      verifyPortalToken: async () => ({
        userId: "ordinary-workos-user",
        organizationId: null,
        tokenRole: "owner",
      }),
    });
    const response = await app.request(
      `/v1/admin/tenants/${tenantId}/quota`,
      {
        method: "POST",
        headers: { authorization: "Bearer fake-but-stubbed", "content-type": "application/json" },
        body: JSON.stringify({
          tenantStatus: "active",
          monthlyAllowance: 1000,
          cycleStartAt: "2026-10-01T00:00:00Z",
          cycleEndAt: "2026-11-01T00:00:00Z",
          user: {
            externalUserId: "student-1",
            status: "active",
            baseQuota: 100,
            bonusQuota: 0,
            expiresAt: null,
          },
        }),
      },
      { SANTO_SUPER_ADMIN_USER_IDS: "verified-super-admin" },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "FORBIDDEN" });
  });
});
