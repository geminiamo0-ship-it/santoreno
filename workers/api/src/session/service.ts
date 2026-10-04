import type {
  ExternalUser,
  SessionContextResponse,
  SessionExchangeRequest,
  SessionExchangeResponse,
} from "@santo/contracts";

import type { ServerPrincipal } from "../credentials/service";
import type { TenantRepository } from "../tenancy/repository";
import type { ExternalUserRecord, ExternalUserRepository } from "./repository";
import { SantoSessionTokenService, type SessionTokenPrincipal } from "./token";

export class SessionError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 503,
    readonly code:
      | "SESSION_NOT_CONFIGURED"
      | "TENANT_SUSPENDED"
      | "USER_SUSPENDED"
      | "SESSION_USER_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

function externalUser(record: ExternalUserRecord): ExternalUser {
  return {
    id: record.id,
    tenantId: record.tenantId,
    externalUserId: record.externalUserId,
    email: record.email,
    displayName: record.displayName,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class SessionExchangeService {
  constructor(
    private readonly users: ExternalUserRepository,
    private readonly tenants: TenantRepository,
    private readonly tokens: SantoSessionTokenService,
  ) {}

  async exchange(
    serverPrincipal: ServerPrincipal,
    input: SessionExchangeRequest,
  ): Promise<SessionExchangeResponse> {
    const tenant = await this.tenants.findTenantById(serverPrincipal.tenantId);
    if (!tenant || tenant.status !== "active") {
      throw new SessionError(403, "TENANT_SUSPENDED", "Tenant is not active");
    }

    const user = await this.users.upsertExternalUser({
      tenantId: serverPrincipal.tenantId,
      externalUserId: input.external_user_id,
      email: input.email,
      displayName: input.display_name,
    });
    if (user.status !== "active") {
      throw new SessionError(403, "USER_SUSPENDED", "External user is suspended");
    }

    const issued = await this.tokens.issue({
      tenantId: user.tenantId,
      externalUserId: user.externalUserId,
    });

    return {
      accessToken: issued.token,
      tokenType: "Bearer",
      expiresIn: issued.expiresIn,
      expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
      user: externalUser(user),
    };
  }

  async resolve(principal: SessionTokenPrincipal): Promise<SessionContextResponse> {
    const tenant = await this.tenants.findTenantById(principal.tenantId);
    if (!tenant || tenant.status !== "active") {
      throw new SessionError(403, "TENANT_SUSPENDED", "Tenant is not active");
    }

    const user = await this.users.findByTenantAndExternalId(
      principal.tenantId,
      principal.externalUserId,
    );
    if (!user) {
      throw new SessionError(404, "SESSION_USER_NOT_FOUND", "Session user does not exist");
    }
    if (user.status !== "active") {
      throw new SessionError(403, "USER_SUSPENDED", "External user is suspended");
    }

    return {
      tenantId: principal.tenantId,
      externalUserId: principal.externalUserId,
      sessionId: principal.sessionId,
      expiresAt: new Date(principal.expiresAt * 1000).toISOString(),
    };
  }
}
