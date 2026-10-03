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

  it("hides staging infrastructure smoke without the smoke token", async () => {
    const response = await app.request(
      "/__infra/smoke",
      {},
      {
        SANTO_ENV: "staging",
        INFRA_SMOKE_TOKEN: "expected-token",
      },
    );

    expect(response.status).toBe(404);
  });

  it("accepts the staging smoke token before checking bindings", async () => {
    const response = await app.request(
      "/__infra/smoke",
      {
        headers: {
          "x-santo-infra-smoke-token": "expected-token",
        },
      },
      {
        SANTO_ENV: "staging",
        INFRA_SMOKE_TOKEN: "expected-token",
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      environment: "staging",
      status: "degraded",
    });
  });
});
