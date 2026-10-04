import {
  ApiErrorResponseSchema,
  CreateTenantRequestSchema,
  HealthResponseSchema,
  InfrastructureSmokeResponseSchema,
  PortalContextResponseSchema,
  QueueSmokeStatusResponseSchema,
  TenantSchema,
  UpdateTenantRequestSchema,
} from "@santo/contracts";
import { Hono, type MiddlewareHandler } from "hono";

import {
  PortalAuthError,
  type PortalIdentity,
  type PortalTokenVerifier,
  verifyWorkOSBearerToken,
} from "./auth/workos";
import { runInfrastructureSmoke, wasQueueSmokeProcessed } from "./infrastructure/smoke";
import type { SantoBindings } from "./runtime/bindings";
import { D1TenantRepository, type TenantRepository } from "./tenancy/repository";
import { TenantControlService, TenancyError } from "./tenancy/service";

type SantoAppEnvironment = {
  Bindings: SantoBindings;
  Variables: {
    portalIdentity: PortalIdentity;
  };
};

export interface SantoAppDependencies {
  verifyPortalToken?: PortalTokenVerifier;
  tenantRepositoryFactory?: (env: SantoBindings) => TenantRepository;
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

function errorPayload(error: string) {
  return ApiErrorResponseSchema.parse({ error });
}

export function createApp(dependencies: SantoAppDependencies = {}) {
  const app = new Hono<SantoAppEnvironment>();
  const verifyPortalToken = dependencies.verifyPortalToken ?? verifyWorkOSBearerToken;
  const tenantRepositoryFactory =
    dependencies.tenantRepositoryFactory ?? createDefaultTenantRepository;

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

  return app;
}

export const app = createApp();
