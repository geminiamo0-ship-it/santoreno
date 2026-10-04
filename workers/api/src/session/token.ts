import { SantoSessionClaimsSchema, type SantoSessionClaims } from "@santo/contracts";

import type { SantoBindings } from "../runtime/bindings";

const SESSION_ISSUER = "Santo" as const;
const SESSION_AUDIENCE = "santo-ai" as const;
const DEFAULT_SESSION_TTL_SECONDS = 900;
const MIN_SESSION_TTL_SECONDS = 600;
const MAX_SESSION_TTL_SECONDS = 1200;
const MIN_SIGNING_KEY_LENGTH = 32;

interface JwtHeader {
  alg?: string;
  typ?: string;
}

export interface SessionTokenPrincipal {
  tenantId: string;
  externalUserId: string;
  sessionId: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

export interface IssuedSessionToken {
  token: string;
  claims: SantoSessionClaims;
  expiresIn: number;
}

export class SessionTokenError extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly code:
      | "SESSION_AUTH_REQUIRED"
      | "SESSION_AUTH_CONFIG_ERROR"
      | "INVALID_SESSION_TOKEN"
      | "SESSION_TOKEN_EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "SessionTokenError";
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment))) as T;
}

function resolveTtlSeconds(env: SantoBindings): number {
  const raw = env.SANTO_SESSION_TTL_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_SESSION_TTL_SECONDS ||
    parsed > MAX_SESSION_TTL_SECONDS
  ) {
    throw new SessionTokenError(
      503,
      "SESSION_AUTH_CONFIG_ERROR",
      `SANTO_SESSION_TTL_SECONDS must be between ${MIN_SESSION_TTL_SECONDS} and ${MAX_SESSION_TTL_SECONDS}`,
    );
  }

  return parsed;
}

function resolveSigningSecret(env: SantoBindings): string {
  const secret = env.SANTO_SESSION_SIGNING_KEY?.trim();
  if (!secret || secret.length < MIN_SIGNING_KEY_LENGTH) {
    throw new SessionTokenError(
      503,
      "SESSION_AUTH_CONFIG_ERROR",
      "SANTO_SESSION_SIGNING_KEY must contain at least 32 characters",
    );
  }

  return secret;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function requireBearerToken(authorizationHeader?: string): string {
  if (!authorizationHeader) {
    throw new SessionTokenError(401, "SESSION_AUTH_REQUIRED", "Missing Authorization header");
  }

  const [scheme, token, ...extra] = authorizationHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token || extra.length > 0) {
    throw new SessionTokenError(401, "SESSION_AUTH_REQUIRED", "Expected a Bearer session token");
  }

  return token;
}

export class SantoSessionTokenService {
  constructor(
    private readonly env: SantoBindings,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async issue(input: { tenantId: string; externalUserId: string }): Promise<IssuedSessionToken> {
    const ttl = resolveTtlSeconds(this.env);
    const iat = this.nowSeconds();
    const claims = SantoSessionClaimsSchema.parse({
      iss: SESSION_ISSUER,
      aud: SESSION_AUDIENCE,
      tenant: input.tenantId,
      sub: input.externalUserId,
      session_id: crypto.randomUUID(),
      jti: crypto.randomUUID(),
      iat,
      exp: iat + ttl,
    });
    const headerSegment = encodeJson({ alg: "HS256", typ: "JWT" });
    const payloadSegment = encodeJson(claims);
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const key = await importSigningKey(resolveSigningSecret(this.env));
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));

    return {
      token: `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`,
      claims,
      expiresIn: ttl,
    };
  }

  async verifyBearerToken(authorizationHeader?: string): Promise<SessionTokenPrincipal> {
    const token = requireBearerToken(authorizationHeader);
    const segments = token.split(".");
    if (segments.length !== 3) {
      throw new SessionTokenError(401, "INVALID_SESSION_TOKEN", "Malformed Santo session token");
    }

    const [headerSegment, payloadSegment, signatureSegment] = segments;
    if (!headerSegment || !payloadSegment || !signatureSegment) {
      throw new SessionTokenError(401, "INVALID_SESSION_TOKEN", "Malformed Santo session token");
    }

    let header: JwtHeader;
    let rawClaims: unknown;
    try {
      header = decodeJson<JwtHeader>(headerSegment);
      rawClaims = decodeJson<unknown>(payloadSegment);
    } catch {
      throw new SessionTokenError(401, "INVALID_SESSION_TOKEN", "Malformed Santo session token");
    }

    if (header.alg !== "HS256" || header.typ !== "JWT") {
      throw new SessionTokenError(401, "INVALID_SESSION_TOKEN", "Unsupported Santo token header");
    }

    const key = await importSigningKey(resolveSigningSecret(this.env));
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signatureSegment),
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    );
    if (!verified) {
      throw new SessionTokenError(
        401,
        "INVALID_SESSION_TOKEN",
        "Santo session signature is invalid",
      );
    }

    const parsedClaims = SantoSessionClaimsSchema.safeParse(rawClaims);
    if (!parsedClaims.success) {
      throw new SessionTokenError(401, "INVALID_SESSION_TOKEN", "Santo session claims are invalid");
    }

    const claims = parsedClaims.data;
    const now = this.nowSeconds();
    if (claims.exp <= now) {
      throw new SessionTokenError(401, "SESSION_TOKEN_EXPIRED", "Santo session token has expired");
    }
    if (claims.iat > now + 60 || claims.exp <= claims.iat) {
      throw new SessionTokenError(401, "INVALID_SESSION_TOKEN", "Santo session timing is invalid");
    }

    return {
      tenantId: claims.tenant,
      externalUserId: claims.sub,
      sessionId: claims.session_id,
      jti: claims.jti,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    };
  }
}
