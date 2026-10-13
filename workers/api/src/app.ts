import {
  AllowedDomainsResponseSchema,
  ApiErrorResponseSchema,
  CreateTenantRequestSchema,
  CredentialIssueResponseSchema,
  HealthResponseSchema,
  InfrastructureSmokeResponseSchema,
  PortalContextResponseSchema,
  QueueSmokeStatusResponseSchema,
  QuotaSnapshotSchema,
  QuotaConfigureRequestSchema,
  QuotaUserEntitlementSchema,
  ServerContextResponseSchema,
  ServerCredentialMetadataSchema,
  SessionContextResponseSchema,
  SessionExchangeRequestSchema,
  SessionExchangeResponseSchema,
  TenantSchema,
  UpdateAllowedDomainsRequestSchema,
  UpdateTenantRequestSchema,
  type SessionContextResponse,
} from "@santo/contracts";
import { Hono, type MiddlewareHandler } from "hono";

import {
  PortalAuthError,
  type PortalIdentity,
  type PortalTokenVerifier,
  verifyWorkOSBearerToken,
} from "./auth/workos";
import { D1CredentialRepository, type CredentialRepository } from "./credentials/repository";
import {
  CredentialError,
  ServerCredentialService,
  type ServerPrincipal,
} from "./credentials/service";
import { runInfrastructureSmoke, wasQueueSmokeProcessed } from "./infrastructure/smoke";
import type { SantoBindings } from "./runtime/bindings";
import {
  exchangePilotAuthorizationCode,
  pilotCredentialCss,
  pilotCredentialHeaders,
  pilotCredentialHtml,
} from "./pilot/credential-console";
import { pilotCredentialScript } from "./pilot/credential-console-client";
import { DurableObjectQuotaService, QuotaServiceError } from "./quota/service";
import { D1ExternalUserRepository, type ExternalUserRepository } from "./session/repository";
import { SessionError, SessionExchangeService } from "./session/service";
import { SantoSessionTokenService, SessionTokenError } from "./session/token";
import { D1TenantRepository, type TenantRepository } from "./tenancy/repository";
import { TenantControlService, TenancyError } from "./tenancy/service";

type SantoAppEnvironment = {
  Bindings: SantoBindings;
  Variables: {
    portalIdentity: PortalIdentity;
    serverPrincipal: ServerPrincipal;
    sessionContext: SessionContextResponse;
  };
};

export interface SantoAppDependencies {
  verifyPortalToken?: PortalTokenVerifier;
  tenantRepositoryFactory?: (env: SantoBindings) => TenantRepository;
  credentialRepositoryFactory?: (env: SantoBindings) => CredentialRepository;
  externalUserRepositoryFactory?: (env: SantoBindings) => ExternalUserRepository;
}

function isInfrastructureSmokeAuthorized(env: SantoBindings, providedToken?: string): boolean {
  if (env.SANTO_ENV === "production") {
    return false;
  }

  if (env.SANTO_ENV === "local" || env.SANTO_ENV === undefined) {
    return true;
  }

  const expectedToken = env.INFRA_SMOKE_TOKEN;
  return Boolean(expectedToken && providedToken && providedToken === expectedToken);
}

function createDefaultTenantRepository(env: SantoBindings): TenantRepository {
  if (!env.CONTROL_DB) {
    throw new TenancyError(503, "TENANCY_NOT_CONFIGURED", "CONTROL_DB binding is required");
  }

  return new D1TenantRepository(env.CONTROL_DB);
}

function createDefaultCredentialRepository(env: SantoBindings): CredentialRepository {
  if (!env.CONTROL_DB) {
    throw new CredentialError(503, "CREDENTIALS_NOT_CONFIGURED", "CONTROL_DB binding is required");
  }

  return new D1CredentialRepository(env.CONTROL_DB);
}

function createDefaultExternalUserRepository(env: SantoBindings): ExternalUserRepository {
  if (!env.CONTROL_DB) {
    throw new SessionError(503, "SESSION_NOT_CONFIGURED", "CONTROL_DB binding is required");
  }

  return new D1ExternalUserRepository(env.CONTROL_DB);
}

function errorPayload(error: string) {
  return ApiErrorResponseSchema.parse({ error });
}

export function createApp(dependencies: SantoAppDependencies = {}) {
  const app = new Hono<SantoAppEnvironment>();
  const verifyPortalToken = dependencies.verifyPortalToken ?? verifyWorkOSBearerToken;
  const tenantRepositoryFactory =
    dependencies.tenantRepositoryFactory ?? createDefaultTenantRepository;
  const credentialRepositoryFactory =
    dependencies.credentialRepositoryFactory ?? createDefaultCredentialRepository;
  const externalUserRepositoryFactory =
    dependencies.externalUserRepositoryFactory ?? createDefaultExternalUserRepository;

  const requirePortalAuth: MiddlewareHandler<SantoAppEnvironment> = async (context, next) => {
    try {
      const identity = await verifyPortalToken(context.env, context.req.header("authorization"));
      context.set("portalIdentity", identity);
      await next();
    } catch (error) {
      if (error instanceof PortalAuthError) {
        const status = error.code === "AUTH_CONFIG_ERROR" ? 503 : 401;
        return context.json(errorPayload(error.code), status);
      }
      throw error;
    }
  };

  function tenantService(context: { env: SantoBindings }): TenantControlService {
    return new TenantControlService(tenantRepositoryFactory(context.env), context.env);
  }

  function credentialService(context: { env: SantoBindings }): ServerCredentialService {
    return new ServerCredentialService(
      credentialRepositoryFactory(context.env),
      tenantRepositoryFactory(context.env),
    );
  }

  function sessionService(context: { env: SantoBindings }): SessionExchangeService {
    return new SessionExchangeService(
      externalUserRepositoryFactory(context.env),
      tenantRepositoryFactory(context.env),
      new SantoSessionTokenService(context.env),
    );
  }

  const requireServerAuth: MiddlewareHandler<SantoAppEnvironment> = async (context, next) => {
    try {
      const principal = await credentialService(context).authenticate(
        context.req.header("authorization"),
      );
      context.set("serverPrincipal", principal);
      await next();
    } catch (error) {
      if (error instanceof CredentialError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  };

  const requireSessionAuth: MiddlewareHandler<SantoAppEnvironment> = async (context, next) => {
    try {
      const principal = await new SantoSessionTokenService(context.env).verifyBearerToken(
        context.req.header("authorization"),
      );
      const resolved = await sessionService(context).resolve(principal);
      context.set("sessionContext", resolved);
      await next();
    } catch (error) {
      if (error instanceof SessionTokenError || error instanceof SessionError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  };

  // Small, staging-only owner console for pilot setup. All mutations reuse
  // existing authenticated Santo tenant/credential APIs; never expose secrets here.
  app.get("/pilot/credentials", (context) => {
    if (context.env.SANTO_ENV !== "staging") return context.notFound();
    return new Response(pilotCredentialHtml, {
      headers: { ...pilotCredentialHeaders, "Content-Type": "text/html; charset=utf-8" },
    });
  });

  app.get("/pilot/credentials.css", (context) => {
    if (context.env.SANTO_ENV !== "staging") return context.notFound();
    return new Response(pilotCredentialCss, {
      headers: { ...pilotCredentialHeaders, "Content-Type": "text/css; charset=utf-8" },
    });
  });

  app.get("/pilot/credentials.js", (context) => {
    if (context.env.SANTO_ENV !== "staging") return context.notFound();
    return new Response(pilotCredentialScript, {
      headers: {
        ...pilotCredentialHeaders,
        "Content-Type": "application/javascript; charset=utf-8",
      },
    });
  });

  app.get("/pilot/credentials/config", (context) => {
    if (context.env.SANTO_ENV !== "staging") return context.notFound();
    if (!context.env.WORKOS_CLIENT_ID) {
      return context.json({ error: "WORKOS_NOT_CONFIGURED" }, 503, pilotCredentialHeaders);
    }
    return context.json({ clientId: context.env.WORKOS_CLIENT_ID }, 200, pilotCredentialHeaders);
  });

  app.post("/pilot/credentials/exchange", (context) => {
    if (context.env.SANTO_ENV !== "staging") return context.notFound();
    return exchangePilotAuthorizationCode(context.req.raw, context.env);
  });

  app.get("/", (context) => context.text("Santo API"));

  app.get("/health", (context) => {
    const response = HealthResponseSchema.parse({
      service: "santo-api",
      status: "ok",
    });

    return context.json(response);
  });

  app.get("/__infra/smoke", async (context) => {
    if (
      !isInfrastructureSmokeAuthorized(context.env, context.req.header("x-santo-infra-smoke-token"))
    ) {
      return context.notFound();
    }

    const response = InfrastructureSmokeResponseSchema.parse(
      await runInfrastructureSmoke(context.env),
    );

    return context.json(response, response.status === "ok" ? 200 : 503);
  });

  app.get("/__infra/queue-smoke/:eventId", async (context) => {
    if (
      !isInfrastructureSmokeAuthorized(context.env, context.req.header("x-santo-infra-smoke-token"))
    ) {
      return context.notFound();
    }

    const eventId = context.req.param("eventId");
    const response = QueueSmokeStatusResponseSchema.safeParse({
      eventId,
      processed: await wasQueueSmokeProcessed(context.env, eventId),
    });

    if (!response.success) {
      return context.json(errorPayload("INVALID_SMOKE_EVENT_ID"), 400);
    }

    return context.json(response.data);
  });

  app.use("/v1/admin/*", requirePortalAuth);
  app.use("/v1/portal/*", requirePortalAuth);
  app.use("/v1/server/*", requireServerAuth);

  app.post("/v1/admin/tenants", async (context) => {
    const parsed = CreateTenantRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(errorPayload("INVALID_TENANT_REQUEST"), 400);
    }

    try {
      const tenant = await tenantService(context).createTenant(
        context.get("portalIdentity"),
        parsed.data,
      );
      return context.json(TenantSchema.parse(tenant), 201);
    } catch (error) {
      if (error instanceof TenancyError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.get("/v1/portal/context", async (context) => {
    try {
      const response = await tenantService(context).getPortalContext(context.get("portalIdentity"));
      return context.json(PortalContextResponseSchema.parse(response));
    } catch (error) {
      if (error instanceof TenancyError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  // Read-only lookup for a forgotten tenant UUID. The signed WorkOS org
  // and explicit Santo owner membership must both match (also for Super Admin).
  app.get("/v1/portal/my-tenant", async (context) => {
    try {
      const tenant = await tenantService(context).getMyTenant(context.get("portalIdentity"));
      return context.json(TenantSchema.parse(tenant), 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof TenancyError) {
        return context.json(errorPayload(error.code), error.status, {
          "Cache-Control": "no-store",
        });
      }
      throw error;
    }
  });

  app.get("/v1/portal/tenants/:tenantId", async (context) => {
    try {
      const tenant = await tenantService(context).getTenant(
        context.get("portalIdentity"),
        context.req.param("tenantId"),
      );
      return context.json(TenantSchema.parse(tenant));
    } catch (error) {
      if (error instanceof TenancyError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.patch("/v1/portal/tenants/:tenantId", async (context) => {
    const parsed = UpdateTenantRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(errorPayload("INVALID_TENANT_REQUEST"), 400);
    }

    try {
      const tenant = await tenantService(context).updateTenant(
        context.get("portalIdentity"),
        context.req.param("tenantId"),
        parsed.data,
      );
      return context.json(TenantSchema.parse(tenant));
    } catch (error) {
      if (error instanceof TenancyError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.post("/v1/portal/tenants/:tenantId/credentials", async (context) => {
    const tenantId = context.req.param("tenantId");
    try {
      await tenantService(context).getTenant(context.get("portalIdentity"), tenantId);
      const issued = await credentialService(context).createCredential(
        tenantId,
        context.get("portalIdentity").userId,
      );
      return context.json(CredentialIssueResponseSchema.parse(issued), 201);
    } catch (error) {
      if (error instanceof TenancyError || error instanceof CredentialError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.post("/v1/portal/tenants/:tenantId/credentials/:credentialId/rotate", async (context) => {
    const tenantId = context.req.param("tenantId");
    try {
      await tenantService(context).getTenant(context.get("portalIdentity"), tenantId);
      const issued = await credentialService(context).rotateCredential(
        tenantId,
        context.req.param("credentialId"),
        context.get("portalIdentity").userId,
      );
      return context.json(CredentialIssueResponseSchema.parse(issued), 201);
    } catch (error) {
      if (error instanceof TenancyError || error instanceof CredentialError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.delete("/v1/portal/tenants/:tenantId/credentials/:credentialId", async (context) => {
    const tenantId = context.req.param("tenantId");
    try {
      await tenantService(context).getTenant(context.get("portalIdentity"), tenantId);
      const revoked = await credentialService(context).revokeCredential(
        tenantId,
        context.req.param("credentialId"),
        context.get("portalIdentity").userId,
      );
      return context.json(ServerCredentialMetadataSchema.parse(revoked));
    } catch (error) {
      if (error instanceof TenancyError || error instanceof CredentialError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.get("/v1/portal/tenants/:tenantId/domains", async (context) => {
    const tenantId = context.req.param("tenantId");
    try {
      await tenantService(context).getTenant(context.get("portalIdentity"), tenantId);
      return context.json(
        AllowedDomainsResponseSchema.parse(
          await credentialService(context).getAllowedDomains(tenantId),
        ),
      );
    } catch (error) {
      if (error instanceof TenancyError || error instanceof CredentialError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.put("/v1/portal/tenants/:tenantId/domains", async (context) => {
    const parsed = UpdateAllowedDomainsRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(errorPayload("INVALID_ALLOWED_DOMAINS"), 400);
    }

    const tenantId = context.req.param("tenantId");
    try {
      await tenantService(context).getTenant(context.get("portalIdentity"), tenantId);
      return context.json(
        AllowedDomainsResponseSchema.parse(
          await credentialService(context).replaceAllowedDomains(
            tenantId,
            parsed.data.domains,
            context.get("portalIdentity").userId,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof TenancyError || error instanceof CredentialError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.get("/v1/server/tenants/:tenantId/context", (context) => {
    try {
      return context.json(
        ServerContextResponseSchema.parse(
          credentialService(context).assertTenant(
            context.get("serverPrincipal"),
            context.req.param("tenantId"),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof CredentialError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  // Tenant-scoped pilot integration. The server credential decides tenant
  // identity; browser cannot supply tenant or quota administration fields.
  // Operational quota bootstrap, not a customer-facing portal capability.
  // Only Santo's verified WorkOS Super Admin can set the tenant allowance.
  app.post("/v1/admin/tenants/:tenantId/quota", async (context) => {
    const admin = context.get("portalIdentity");
    const ids = (context.env.SANTO_SUPER_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!ids.includes(admin.userId)) return context.json(errorPayload("FORBIDDEN"), 403);
    const raw: unknown = await context.req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || "tenantId" in raw) {
      return context.json(errorPayload("INVALID_QUOTA_REQUEST"), 400);
    }
    const parsed = QuotaConfigureRequestSchema.safeParse({
      ...raw,
      tenantId: context.req.param("tenantId"),
    });
    if (!parsed.success) return context.json(errorPayload("INVALID_QUOTA_REQUEST"), 400);
    if (!context.env.TENANT_METER) return context.json(errorPayload("QUOTA_UNAVAILABLE"), 503);
    const tenant = await tenantRepositoryFactory(context.env).findTenantById(parsed.data.tenantId);
    if (!tenant) return context.json(errorPayload("TENANT_NOT_FOUND"), 404);
    try {
      const snapshot = await new DurableObjectQuotaService(context.env.TENANT_METER).configure(
        parsed.data,
      );
      return context.json(QuotaSnapshotSchema.parse(snapshot), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      if (error instanceof QuotaServiceError) {
        return Response.json(errorPayload(error.code), {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        });
      }
      throw error;
    }
  });

  app.post("/v1/server/quota/users", async (context) => {
    const parsed = QuotaUserEntitlementSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json(errorPayload("INVALID_USER_ENTITLEMENT"), 400);
    if (!context.env.TENANT_METER) return context.json(errorPayload("QUOTA_UNAVAILABLE"), 503);
    try {
      const result = await new DurableObjectQuotaService(context.env.TENANT_METER).configureUser({
        tenantId: context.get("serverPrincipal").tenantId,
        ...parsed.data,
      });
      return context.json(QuotaSnapshotSchema.parse(result), 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof QuotaServiceError) {
        return Response.json(errorPayload(error.code), {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        });
      }
      throw error;
    }
  });

  app.get("/v1/server/quota/users/:externalUserId", async (context) => {
    if (!context.env.TENANT_METER) return context.json(errorPayload("QUOTA_UNAVAILABLE"), 503);
    const externalUserId = context.req.param("externalUserId");
    if (externalUserId.length < 1 || externalUserId.length > 255) {
      return context.json(errorPayload("INVALID_USER_ENTITLEMENT"), 400);
    }
    try {
      const result = await new DurableObjectQuotaService(context.env.TENANT_METER).read({
        tenantId: context.get("serverPrincipal").tenantId,
        externalUserId,
      });
      return context.json(QuotaSnapshotSchema.parse(result), 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof QuotaServiceError) {
        return Response.json(errorPayload(error.code), {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        });
      }
      throw error;
    }
  });

  app.post("/v1/session/exchange", requireServerAuth, async (context) => {
    const parsed = SessionExchangeRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(errorPayload("INVALID_SESSION_REQUEST"), 400);
    }

    try {
      const response = await sessionService(context).exchange(
        context.get("serverPrincipal"),
        parsed.data,
      );
      return context.json(SessionExchangeResponseSchema.parse(response));
    } catch (error) {
      if (error instanceof SessionError || error instanceof SessionTokenError) {
        return context.json(errorPayload(error.code), error.status);
      }
      throw error;
    }
  });

  app.get("/v1/session/context", requireSessionAuth, (context) =>
    context.json(SessionContextResponseSchema.parse(context.get("sessionContext"))),
  );

  return app;
}

export const app = createApp();
