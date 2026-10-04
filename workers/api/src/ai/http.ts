import {
  ApiErrorResponseSchema,
  GroundedAiQueryRequestSchema,
  GroundedAiQueryResponseSchema,
  type SessionContextResponse,
} from "@santo/contracts";

import { DurableObjectQuotaService } from "../quota/service";
import type { SantoBindings } from "../runtime/bindings";
import { D1ExternalUserRepository } from "../session/repository";
import { SessionError, SessionExchangeService } from "../session/service";
import { SantoSessionTokenService, SessionTokenError } from "../session/token";
import { D1TenantRepository } from "../tenancy/repository";
import { WorkersAiGroundedModel } from "./model";
import { CloudflareAiSearchRetrieval } from "./retrieval";
import { GroundedAiError, GroundedAiQueryService } from "./service";
import type { GroundedAiQueryInput, GroundedAiResult } from "./types";

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export interface GroundedAiHttpDependencies {
  authenticateSession?: (
    request: Request,
    env: SantoBindings,
  ) => Promise<SessionContextResponse>;
  query?: (input: GroundedAiQueryInput, env: SantoBindings) => Promise<GroundedAiResult>;
}

function errorPayload(error: string) {
  return ApiErrorResponseSchema.parse({ error });
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return null;
  }
  return value;
}

async function defaultAuthenticateSession(
  request: Request,
  env: SantoBindings,
): Promise<SessionContextResponse> {
  if (!env.CONTROL_DB) {
    throw new SessionError(503, "SESSION_NOT_CONFIGURED", "CONTROL_DB binding is required");
  }

  const tokens = new SantoSessionTokenService(env);
  const principal = await tokens.verifyBearerToken(request.headers.get("authorization") ?? undefined);
  const sessions = new SessionExchangeService(
    new D1ExternalUserRepository(env.CONTROL_DB),
    new D1TenantRepository(env.CONTROL_DB),
    tokens,
  );
  return sessions.resolve(principal);
}

async function defaultQuery(
  input: GroundedAiQueryInput,
  env: SantoBindings,
): Promise<GroundedAiResult> {
  if (!env.TENANT_METER || !env.AI_SEARCH || !env.AI) {
    throw new GroundedAiError(
      503,
      "AI_NOT_CONFIGURED",
      "TENANT_METER, AI_SEARCH, and AI bindings are required",
    );
  }

  const service = new GroundedAiQueryService(
    new DurableObjectQuotaService(env.TENANT_METER),
    new CloudflareAiSearchRetrieval(env.AI_SEARCH, env.SANTO_AI_SEARCH_INSTANCE_IDS),
    new WorkersAiGroundedModel(env.AI, env.SANTO_MODEL_ID),
  );
  return service.query(input);
}

function recordTelemetry(
  env: SantoBindings,
  session: SessionContextResponse,
  status: "success" | "error",
  startedAt: number,
  errorCode?: string,
): void {
  try {
    env.USAGE_ANALYTICS?.writeDataPoint({
      indexes: [session.tenantId],
      blobs: ["grounded_ai_query", status, session.sessionId, errorCode ?? ""],
      doubles: [Date.now() - startedAt],
    });
  } catch {
    // Telemetry is explicitly non-authoritative and must never change request semantics.
  }
}

export async function handleGroundedAiQuery(
  request: Request,
  env: SantoBindings,
  dependencies: GroundedAiHttpDependencies = {},
): Promise<Response> {
  const startedAt = Date.now();
  const authenticateSession = dependencies.authenticateSession ?? defaultAuthenticateSession;
  const query = dependencies.query ?? defaultQuery;

  let session: SessionContextResponse;
  try {
    session = await authenticateSession(request, env);
  } catch (error) {
    if (error instanceof SessionTokenError || error instanceof SessionError) {
      return Response.json(errorPayload(error.code), { status: error.status });
    }
    throw error;
  }

  const parsed = GroundedAiQueryRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    recordTelemetry(env, session, "error", startedAt, "INVALID_AI_QUERY");
    return Response.json(errorPayload("INVALID_AI_QUERY"), { status: 400 });
  }

  const key = idempotencyKey(request);
  if (!key) {
    recordTelemetry(env, session, "error", startedAt, "INVALID_IDEMPOTENCY_KEY");
    return Response.json(errorPayload("INVALID_IDEMPOTENCY_KEY"), { status: 400 });
  }

  try {
    const result = await query(
      {
        session,
        question: parsed.data.question,
        idempotencyKey: key,
      },
      env,
    );
    recordTelemetry(env, session, "success", startedAt);
    return Response.json(GroundedAiQueryResponseSchema.parse(result));
  } catch (error) {
    if (error instanceof GroundedAiError) {
      recordTelemetry(env, session, "error", startedAt, error.code);
      return Response.json(errorPayload(error.code), { status: error.status });
    }
    throw error;
  }
}
