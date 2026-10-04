import { afterEach, describe, expect, it, vi } from "vitest";

import type { SantoBindings } from "../runtime/bindings";
import { PortalAuthError, verifyWorkOSBearerToken } from "./workos";

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

async function createSignedToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const headerSegment = textToBase64Url(JSON.stringify({ alg: "RS256", kid: "test-key" }));
  const payloadSegment = textToBase64Url(JSON.stringify(claims));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function createSigningFixture() {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  if (!("privateKey" in generated) || !("publicKey" in generated)) {
    throw new Error("Expected an RSA key pair");
  }

  const exported = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const publicJwk = {
    ...exported,
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };

  return {
    privateKey: generated.privateKey,
    publicJwk,
  };
}

const env: SantoBindings = {
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_ISSUER: "https://api.workos.com",
  WORKOS_JWKS_URL: "https://auth.example.test/oauth2/jwks",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkOS AuthKit access-token verification", () => {
  it("verifies an RS256 WorkOS token and returns authenticated organization context", async () => {
    const fixture = await createSigningFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ keys: [fixture.publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const token = await createSignedToken(fixture.privateKey, {
      iss: "https://api.workos.com/",
      sub: "user_123",
      client_id: "client_test",
      org_id: "org_123",
      role: "owner",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(verifyWorkOSBearerToken(env, `Bearer ${token}`)).resolves.toEqual({
      userId: "user_123",
      organizationId: "org_123",
      tokenRole: "owner",
    });
  });

  it("rejects a validly signed token from the wrong issuer", async () => {
    const fixture = await createSigningFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ keys: [fixture.publicJwk] }), { status: 200 })),
    );

    const token = await createSignedToken(fixture.privateKey, {
      iss: "https://attacker.example",
      sub: "user_123",
      client_id: "client_test",
      org_id: "org_123",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(verifyWorkOSBearerToken(env, `Bearer ${token}`)).rejects.toMatchObject<
      Partial<PortalAuthError>
    >({
      code: "INVALID_AUTH_TOKEN",
    });
  });

  it("rejects malformed or missing bearer credentials before tenant resolution", async () => {
    await expect(verifyWorkOSBearerToken(env, undefined)).rejects.toMatchObject<
      Partial<PortalAuthError>
    >({
      code: "AUTH_REQUIRED",
    });

    await expect(verifyWorkOSBearerToken(env, "Bearer not-a-jwt")).rejects.toMatchObject<
      Partial<PortalAuthError>
    >({
      code: "INVALID_AUTH_TOKEN",
    });
  });
});
