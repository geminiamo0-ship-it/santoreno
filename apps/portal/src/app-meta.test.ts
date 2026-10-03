import { describe, expect, it } from "vitest";

import { getPortalStatus, PORTAL_NAME } from "./app-meta";

describe("portal bootstrap metadata", () => {
  it("exposes a stable bootstrap identity", () => {
    expect(PORTAL_NAME).toBe("Santo");
    expect(getPortalStatus()).toBe("bootstrap-ready");
  });
});
