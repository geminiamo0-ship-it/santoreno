import { describe, expect, it } from "vitest";

import { app } from "./app";

describe("Santo API bootstrap", () => {
  it("returns a typed health response", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "santo-api",
      status: "ok",
    });
  });
});
