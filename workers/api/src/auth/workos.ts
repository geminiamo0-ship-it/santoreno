import type { SantoBindings } from "../runtime/bindings";

export interface PortalIdentity {
  userId: string;
  organizationId: string | null;
  tokenRole: string | null;
}

export type PortalTokenVerifier = (
  env: SantoBindings,
  authorizationHeader: string | undefined,
) => Promise<PortalIdentity>;

export class PortalAuthError extends Error {
  constructor(
    readonly code: "AUTH_REQUIRED" | "AUTH_CONFIG_ERROR" | "INVALID_AUTH_TOKEN",
    message: string,
  ) {
    super(message);
    this.name = "PortalAuthError";
  }
}

interface WorkOSJwtHeader {
  alg?: string;
  kid?: string;
}

interface WorkOSJwtClaims {
  iss?: string;
  sub?: string;
  client_id?: string;
  org_id?: string;
  role?: string;
  exp?: number;
  nbf?: number;
}

interface WorkOSJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface WorkOSJwksResponse {
  keys?: WorkOSJwk[];
}

interface WorkOSConfig {
  clientId: string;
  issuer: string;
  jwksUrl: string;
}

function decodeBase64Url(segment: string): Uint8Array {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson<T>(segment: string): T {
  const bytes = decodeBase64Url(segment);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, "");
}

function requireBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new PortalAuthError("AUTH_REQUIRED", "Missing Authorization header");
  }

  const [scheme, token, ...extra] = authorizationHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token || extra.length > 0) {
    throw new PortalAuthError("AUTH_REQUIRED", "Expected a Bearer access token");
  }

  return token;
}

function resolveWorkOSConfig(env: SantoBindings): WorkOSConfig {
  const clientId = env.WORKOS_CLIENT_ID?.trim();
  const issuer = env.WORKOS_ISSUER?.trim();

  if (!clientId || !issuer) {
    throw new PortalAuthError(
      "AUTH_CONFIG_ERROR",
      "WORKOS_CLIENT_ID and WORKOS_ISSUER must be configured",
    );
  }

  const configuredJwksUrl = env.WORKOS_JWKS_URL?.trim();
  const defaultJwksUrl = `https://api.workos.com/sso/jwks/${encodeURIComponent(clientId)}`;

  return {
    clientId,
    issuer: normalizeIssuer(issuer),
    jwksUrl: configuredJwksUrl || defaultJwksUrl,
  };
}

async function fetchSigningKey(jwksUrl: string, kid: string): Promise<CryptoKey> {
  const response = await fetch(jwksUrl, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "Unable to load WorkOS signing keys");
  }

  const body = (await response.json()) as WorkOSJwksResponse;
  const key = body.keys?.find((candidate) => candidate.kid === kid);

  if (!key) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "WorkOS signing key was not found");
  }

  try {
    return await crypto.subtle.importKey(
      "jwk",
      key,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["verify"],
    );
  } catch {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "WorkOS signing key is invalid");
  }
}

function validateClaims(claims: WorkOSJwtClaims, env: SantoBindings): PortalIdentity {
  const { clientId, issuer } = resolveWorkOSConfig(env);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const isExpired = claims.exp !== undefined && claims.exp <= nowSeconds;
  const isNotActiveYet = claims.nbf !== undefined && claims.nbf > nowSeconds;

  if (!claims.sub || !claims.iss || claims.exp === undefined) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "Required WorkOS claims are missing");
  }

  if (normalizeIssuer(claims.iss) !== issuer) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "Unexpected WorkOS token issuer");
  }

  if (claims.client_id !== clientId) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "Unexpected WorkOS client ID");
  }

  if (isExpired || isNotActiveYet) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "WorkOS access token is not active");
  }

  return {
    userId: claims.sub,
    organizationId: claims.org_id ?? null,
    tokenRole: claims.role ?? null,
  };
}

export const verifyWorkOSBearerToken: PortalTokenVerifier = async (env, authorizationHeader) => {
  const token = requireBearerToken(authorizationHeader);
  const segments = token.split(".");

  if (segments.length !== 3) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "Malformed WorkOS access token");
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "Malformed WorkOS access token");
  }

  let header: WorkOSJwtHeader;
  let claims: WorkOSJwtClaims;
  try {
    header = decodeJson<WorkOSJwtHeader>(headerSegment);
    claims = decodeJson<WorkOSJwtClaims>(payloadSegment);
  } catch {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "Malformed WorkOS JWT payload");
  }

  if (header.alg !== "RS256" || !header.kid) {
    throw new PortalAuthError("INVALID_AUTH_TOKEN", "Unsupported WorkOS JWT header");
  }

  const config = resolveWorkOSConfig(env);
  const key = await fetchSigningKey(config.jwksUrl, header.kid);
  const signingValue = `${headerSegment}.${payloadSegment}`;
  const signingInput = new TextEncoder().encode(signingValue);
  const signature = decodeBase64Url(signatureSegment);
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signingInput,
  );

  if (!verified) {
    throw new PortalAuthError(
      "INVALID_AUTH_TOKEN",
      "WorkOS access token signature is invalid",
    );
  }

  return validateClaims(claims, env);
};
