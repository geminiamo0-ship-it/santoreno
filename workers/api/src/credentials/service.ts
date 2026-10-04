import type {
  AllowedDomainsResponse,
  CredentialIssueResponse,
  ServerContextResponse,
  ServerCredentialMetadata,
} from "@santo/contracts";

import type { TenantRepository } from "../tenancy/repository";
import type { CredentialRepository, ServerCredentialRecord } from "./repository";

export interface ServerPrincipal {
  tenantId: string;
  credentialId: string;
}

export class CredentialError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    readonly code:
      | "SERVER_AUTH_REQUIRED"
      | "SERVER_CREDENTIAL_INVALID"
      | "SERVER_CREDENTIAL_INACTIVE"
      | "SERVER_TENANT_INACTIVE"
      | "CREDENTIAL_NOT_FOUND"
      | "ACTIVE_CREDENTIAL_EXISTS"
      | "CREDENTIALS_NOT_CONFIGURED"
      | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

function randomHex(byteLength: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(byteLength)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function metadata(record: ServerCredentialRecord): ServerCredentialMetadata {
  return {
    id: record.id,
    tenantId: record.tenantId,
    prefix: record.keyPrefix,
    status: record.status,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    rotatedFromId: record.rotatedFromId,
  };
}

async function issueRecord(
  tenantId: string,
  rotatedFromId: string | null,
): Promise<{ secret: string; record: ServerCredentialRecord }> {
  const prefix = randomHex(6);
  const material = randomHex(32);
  const secret = `santo_sk_${prefix}_${material}`;
  const now = new Date().toISOString();

  return {
    secret,
    record: {
      id: crypto.randomUUID(),
      tenantId,
      keyPrefix: prefix,
      secretHash: await sha256Hex(secret),
      status: "active",
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
      rotatedFromId,
    },
  };
}

function parseAuthorizationHeader(authorizationHeader?: string): { secret: string; prefix: string } {
  const match = authorizationHeader?.match(
    /^Santo (santo_sk_([0-9a-f]{12})_[0-9a-f]{64})$/,
  );
  if (!match) {
    throw new CredentialError(401, "SERVER_AUTH_REQUIRED", "A Santo server credential is required");
  }

  return { secret: match[1], prefix: match[2] };
}

export class ServerCredentialService {
  constructor(
    private readonly credentials: CredentialRepository,
    private readonly tenants: TenantRepository,
  ) {}

  async createCredential(tenantId: string, actorWorkosUserId: string): Promise<CredentialIssueResponse> {
    if (await this.credentials.findActiveByTenantId(tenantId)) {
      throw new CredentialError(
        409,
        "ACTIVE_CREDENTIAL_EXISTS",
        "Rotate or revoke the active credential before issuing another",
      );
    }

    const issued = await issueRecord(tenantId, null);
    await this.credentials.createCredential(issued.record, actorWorkosUserId);
    return { credential: metadata(issued.record), secret: issued.secret };
  }

  async rotateCredential(
    tenantId: string,
    credentialId: string,
    actorWorkosUserId: string,
  ): Promise<CredentialIssueResponse> {
    const current = await this.credentials.findById(tenantId, credentialId);
    if (!current) {
      throw new CredentialError(404, "CREDENTIAL_NOT_FOUND", "Credential does not exist");
    }
    if (current.status !== "active") {
      throw new CredentialError(409, "SERVER_CREDENTIAL_INACTIVE", "Credential is not active");
    }

    const replacement = await issueRecord(tenantId, current.id);
    await this.credentials.rotateCredential(current, replacement.record, actorWorkosUserId);
    return { credential: metadata(replacement.record), secret: replacement.secret };
  }

  async revokeCredential(
    tenantId: string,
    credentialId: string,
    actorWorkosUserId: string,
  ): Promise<ServerCredentialMetadata> {
    const current = await this.credentials.findById(tenantId, credentialId);
    if (!current) {
      throw new CredentialError(404, "CREDENTIAL_NOT_FOUND", "Credential does not exist");
    }
    if (current.status === "revoked") {
      return metadata(current);
    }

    const revokedAt = new Date().toISOString();
    await this.credentials.revokeCredential(current, actorWorkosUserId, revokedAt);
    return metadata({ ...current, status: "revoked", revokedAt });
  }

  async authenticate(authorizationHeader?: string): Promise<ServerPrincipal> {
    const parsed = parseAuthorizationHeader(authorizationHeader);
    const record = await this.credentials.findByPrefix(parsed.prefix);
    if (!record || record.status !== "active") {
      throw new CredentialError(401, "SERVER_CREDENTIAL_INVALID", "Server credential is invalid");
    }

    const suppliedHash = await sha256Hex(parsed.secret);
    if (!constantTimeEqual(suppliedHash, record.secretHash)) {
      throw new CredentialError(401, "SERVER_CREDENTIAL_INVALID", "Server credential is invalid");
    }

    const tenant = await this.tenants.findTenantById(record.tenantId);
    if (!tenant || tenant.status !== "active") {
      throw new CredentialError(403, "SERVER_TENANT_INACTIVE", "Tenant is not active");
    }

    await this.credentials.touchLastUsed(record.id, new Date().toISOString());
    return { tenantId: record.tenantId, credentialId: record.id };
  }

  assertTenant(principal: ServerPrincipal, requestedTenantId: string): ServerContextResponse {
    if (principal.tenantId !== requestedTenantId) {
      throw new CredentialError(403, "FORBIDDEN", "Credential cannot access another tenant");
    }
    return { tenantId: principal.tenantId, credentialId: principal.credentialId };
  }

  async replaceAllowedDomains(
    tenantId: string,
    domains: string[],
    actorWorkosUserId: string,
  ): Promise<AllowedDomainsResponse> {
    const normalized = [...new Set(domains.map((domain) => domain.toLowerCase()))].sort();
    await this.credentials.replaceAllowedDomains(
      tenantId,
      normalized,
      actorWorkosUserId,
      new Date().toISOString(),
    );
    return { tenantId, domains: normalized };
  }

  async getAllowedDomains(tenantId: string): Promise<AllowedDomainsResponse> {
    return { tenantId, domains: await this.credentials.getAllowedDomains(tenantId) };
  }
}
