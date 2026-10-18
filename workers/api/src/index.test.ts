import { describe, expect, it } from "vitest";
import type { SantoBindings } from "./runtime/bindings";
import worker from "./index";

describe("actual Worker route dispatch for verified image batches", () => {
  const env = {
    SANTO_ENV: "staging",
    SANTO_LIBRARY_READER_V1: "true",
    SANTO_SESSION_SIGNING_KEY: "test-signing-key-longer-than-thirty-two-characters",
  } as SantoBindings;

  const request = (method: string, path: string, bindings: SantoBindings = env) =>
    worker.fetch(
      new Request("https://santo.test" + path, { method }),
      bindings,
      {} as Parameters<typeof worker.fetch>[2],
    );

  it("dispatches image batch to the library reader, not generic source router", async () => {
    const batch = await request("POST", "/v1/sources/article-images/batch");
    expect(batch.status).toBe(401);
    const error = (await batch.json()) as { error?: string };
    expect(error.error).not.toBe("SOURCE_NOT_FOUND");

    const oldArticle = await request("POST", "/v1/sources/article");
    expect(oldArticle.status).toBe(401);
    expect((await request("GET", "/v1/sources/article-images/batch")).status).toBe(405);
  });

  it("remains disabled if the medical article feature flag is off", async () => {
    const disabled = { ...env, SANTO_LIBRARY_READER_V1: "false" };
    const response = await request("POST", "/v1/sources/article-images/batch", disabled);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "LIBRARY_NOT_FOUND" });
  });
});
