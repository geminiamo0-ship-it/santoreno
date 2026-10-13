import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app";
import type { SantoBindings } from "../runtime/bindings";
import { exchangePilotAuthorizationCode } from "./credential-console";

const staging: SantoBindings = {
  SANTO_ENV: "staging",
  WORKOS_CLIENT_ID: "client_test123",
};

const validPayload = {
  code: "code-from-workos",
  codeVerifier: "v".repeat(43),
};

function exchangeRequest(
  body: unknown,
  origin = "https://santo.example",
): Request {
  return new Request("https://santo.example/pilot/credentials/exchange", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Staging-only pilot credential console", () => {
  it("serves a CSP-constrained, non-cacheable owner UI and no browser secret", async () => {
    const app = createApp();
    const response = await app.request("/pilot/credentials", {}, staging);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const html = await response.text();
    expect(html).toContain("Generate API Key");
    expect(html).toContain("/pilot/credentials.js");
    expect(html).not.toContain("santo_sk_");
    expect(html).not.toContain("client_test123");

    const scriptResponse = await app.request("/pilot/credentials.js", {}, staging);
    expect(scriptResponse.headers.get("content-type")).toContain("application/javascript");
    expect(await scriptResponse.text()).toContain("code_challenge_method");
  });

  it("fails closed outside staging and exposes only public WorkOS client id", async () => {
    const app = createApp();
    for (const path of [
      "/pilot/credentials",
      "/pilot/credentials.js",
      "/pilot/credentials/config",
    ]) {
      expect((await app.request(path, {}, { SANTO_ENV: "production" })).status).toBe(404);
    }
    const config = await app.request("/pilot/credentials/config", {}, staging);
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toEqual({ clientId: "client_test123" });
    const missing = await app.request(
      "/pilot/credentials/config",
      {},
      { SANTO_ENV: "staging" },
    );
    expect(missing.status).toBe(503);
  });

  it("rejects cross-origin and malformed token exchange without calling WorkOS", async () => {
    const exchange = vi.fn<typeof fetch>();
    const badOrigin = await exchangePilotAuthorizationCode(
      exchangeRequest(validPayload, "https://evil.example"),
      staging,
      exchange,
    );
    expect(badOrigin.status).toBe(403);
    const invalid = await exchangePilotAuthorizationCode(
      exchangeRequest({ ...validPayload, codeVerifier: "short" }),
      staging,
      exchange,
    );
    expect(invalid.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("never returns a WorkOS refresh token to the browser", async () => {
    const exchange = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "short-lived-jwt",
        refresh_token: "do-not-send-to-browser",
        user: { id: "user_owner" },
        organization_id: "org_owner",
      }),
    );
    const result = await exchangePilotAuthorizationCode(
      exchangeRequest(validPayload),
      staging,
      exchange,
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    await expect(result.json()).resolves.toEqual({
      accessToken: "short-lived-jwt",
      userId: "user_owner",
      organizationId: "org_owner",
    });
    const [, options] = exchange.mock.calls[0] ?? [];
    expect(JSON.parse(String(options?.body))).toEqual({
      client_id: "client_test123",
      grant_type: "authorization_code",
      code: validPayload.code,
      code_verifier: validPayload.codeVerifier,
    });
    expect(options?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("does not forward upstream identity data or secrets on WorkOS failure", async () => {
    const exchange = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: "bad_code", refresh_token: "leak" }, { status: 401 }),
    );
    const result = await exchangePilotAuthorizationCode(
      exchangeRequest(validPayload),
      staging,
      exchange,
    );
    expect(result.status).toBe(401);
    await expect(result.json()).resolves.toEqual({ error: "WORKOS_SIGN_IN_FAILED" });
  });
});
