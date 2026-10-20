import { ApiErrorResponseSchema } from "@santo/contracts";
import { GroundedAiQueryRequestSchema, GroundedAiQueryResponseSchema } from "@santo/contracts/ai";

import { DurableObjectQuotaService, QuotaServiceError } from "../quota/service";
import type { QuotaService } from "../quota/types";
import type { SantoBindings } from "../runtime/bindings";
import { R2VerifiedSourceStore, type SourceSnapshotWriter } from "../sources/store";
import { D1ExternalUserRepository, type ExternalUserRepository } from "../session/repository";
import { SessionError, SessionExchangeService } from "../session/service";
import { SantoSessionTokenService, SessionTokenError } from "../session/token";
import { D1TenantRepository, type TenantRepository } from "../tenancy/repository";
import { GroundedAiError } from "./errors";
import { AI_STAGE_TIMEOUTS } from "./deadline";
import { AiSearchNamespaceLibraryCatalog } from "./library-catalog";
import { createGroundedModel } from "./model";
import { CloudflareAiSearchRetrieval } from "./retrieval";
import { CuratedEvidenceRetrieval } from "./evidence-curation";
import { AmbossAdjacentRetrieval } from "./amboss-adjacent";
import { CloudflareGalleryImageRetrieval } from "./image-gallery";
import { GroundedAiService } from "./service";
import { streamValidatedGroundedAnswer } from "./stream";
import { AnalyticsEngineAiTelemetry } from "./telemetry";
import type { AiTelemetryPort, ModelPort, RetrievalPort } from "./types";

export interface GroundedAiHandlerDependencies {
  tenantRepositoryFactory?: (env: SantoBindings) => TenantRepository;
  externalUserRepositoryFactory?: (env: SantoBindings) => ExternalUserRepository;
  quotaServiceFactory?: (env: SantoBindings) => QuotaService;
  retrievalFactory?: (env: SantoBindings) => RetrievalPort;
  modelFactory?: (env: SantoBindings) => ModelPort;
  telemetryFactory?: (env: SantoBindings) => AiTelemetryPort;
  sourceStoreFactory?: (env: SantoBindings) => SourceSnapshotWriter | null;
  stageTimeouts?: { retrievalMs: number; modelMs: number };
}

function errorResponse(code: string, status: number): Response {
  return Response.json(ApiErrorResponseSchema.parse({ error: code }), { status });
}

function defaultTenantRepository(env: SantoBindings): TenantRepository {
  if (!env.CONTROL_DB) {
    throw new SessionError(503, "SESSION_NOT_CONFIGURED", "CONTROL_DB binding is required");
  }
  return new D1TenantRepository(env.CONTROL_DB);
}

function defaultExternalUserRepository(env: SantoBindings): ExternalUserRepository {
  if (!env.CONTROL_DB) {
    throw new SessionError(503, "SESSION_NOT_CONFIGURED", "CONTROL_DB binding is required");
  }
  return new D1ExternalUserRepository(env.CONTROL_DB);
}

function defaultQuotaService(env: SantoBindings): QuotaService {
  if (!env.TENANT_METER) {
    throw new GroundedAiError(503, "QUOTA_UNAVAILABLE", "TENANT_METER binding is required");
  }
  return new DurableObjectQuotaService(env.TENANT_METER);
}

export function createGroundedAiHandler(dependencies: GroundedAiHandlerDependencies = {}) {
  const tenantRepositoryFactory = dependencies.tenantRepositoryFactory ?? defaultTenantRepository;
  const externalUserRepositoryFactory =
    dependencies.externalUserRepositoryFactory ?? defaultExternalUserRepository;
  const quotaServiceFactory = dependencies.quotaServiceFactory ?? defaultQuotaService;
  const retrievalFactory =
    dependencies.retrievalFactory ??
    ((env) => {
      // Deliberately fail closed when the list is unset: Santo must not
      // search any unrelated Royal Bank instances in the default namespace.
      const allowed = new Set(
        (env.SANTO_AI_SEARCH_INSTANCE_IDS ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)),
      );
      const retrieval = new CloudflareAiSearchRetrieval(
        env.AI_SEARCH,
        new AiSearchNamespaceLibraryCatalog(env.AI_SEARCH, allowed),
        env.SANTO_ENV === "staging" && env.SANTO_MEDICAL_RETRIEVAL_V2 === "true",
        env.SANTO_ENV === "staging" && env.SANTO_MEDICAL_QUERY_REWRITE_V1 === "true",
        env.AI,
        env.SANTO_ENV === "staging" && env.SANTO_QWEN_ROUTING_V1 === "true",
        env.SANTO_ENV === "staging" && env.SANTO_AI_SEARCH_SINGLE_REQUEST_V1 === "true",
        env.SANTO_ENV === "staging" &&
          env.SANTO_ANKING_CARDS_V1 === "true" &&
          env.SANTO_ANKING_RIGHTS_CLEARED_V1 === "true" &&
          env.SANTO_AI_SEARCH_SINGLE_REQUEST_V1 === "true",
        env.SANTO_ENV === "staging" && env.SANTO_ANKING_V12_FULL_SEARCH_V1 === "true",
        env.SANTO_ENV === "staging" && env.SANTO_SEARCH_FAST_PATH_V1 === "true",
        env.SANTO_ENV === "staging" &&
          env.SANTO_LUNA_PREVIEW === "true" &&
          env.SANTO_PLAIN_TEXT_LUNA_V1 === "true" &&
          env.SANTO_FORWARD_ALL_SEARCH_HITS_V1 === "true",
      );
      const expanded =
        env.SANTO_ENV === "staging" &&
        env.SANTO_AMBOSS_ADJACENT_R2_V1 === "true" &&
        env.CONTENT_BUCKET
          ? new AmbossAdjacentRetrieval(retrieval, env.CONTENT_BUCKET)
          : retrieval;
      // Only the staged one-call forward-all route is curated. Preserve
      // legacy retrieval, Production, source identities and gallery hits.
      return env.SANTO_ENV === "staging" &&
        env.SANTO_LUNA_PREVIEW === "true" &&
        env.SANTO_PLAIN_TEXT_LUNA_V1 === "true" &&
        env.SANTO_FORWARD_ALL_SEARCH_HITS_V1 === "true"
        ? new CuratedEvidenceRetrieval(expanded)
        : expanded;
    });
  const modelFactory = dependencies.modelFactory ?? createGroundedModel;
  const sourceStoreFactory =
    dependencies.sourceStoreFactory ??
    ((env: SantoBindings) =>
      env.CONTENT_BUCKET ? new R2VerifiedSourceStore(env.CONTENT_BUCKET) : null);
  const telemetryFactory =
    dependencies.telemetryFactory ?? ((env) => new AnalyticsEngineAiTelemetry(env.USAGE_ANALYTICS));

  return async function handleGroundedAiQuery(
    request: Request,
    env: SantoBindings,
    onProvisionalAnswer?: (text: string) => void,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse("METHOD_NOT_ALLOWED", 405);
    }

    const parsed = GroundedAiQueryRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse("INVALID_AI_QUERY", 400);
    }

    try {
      const tokens = new SantoSessionTokenService(env);
      const principal = await tokens.verifyBearerToken(
        request.headers.get("authorization") ?? undefined,
      );
      const session = await new SessionExchangeService(
        externalUserRepositoryFactory(env),
        tenantRepositoryFactory(env),
        tokens,
      ).resolve(principal);

      const response = await new GroundedAiService(
        quotaServiceFactory(env),
        retrievalFactory(env),
        modelFactory(env),
        telemetryFactory(env),
        undefined,
        dependencies.stageTimeouts ??
          (env.SANTO_ENV === "staging" && env.SANTO_LUNA_PREVIEW === "true"
            ? { ...AI_STAGE_TIMEOUTS, modelMs: 180_000 }
            : undefined),
        sourceStoreFactory(env),
        env.SANTO_GENERAL_MEDICAL_FALLBACK === "true",
        env.SANTO_ENV === "staging" && env.SANTO_SINGLE_PASS_GENERATION_V1 === "true",
        env.SANTO_ENV === "staging" &&
          env.SANTO_LUNA_PREVIEW === "true" &&
          env.SANTO_SINGLE_PASS_GENERATION_V1 === "true" &&
          env.SANTO_PLAIN_TEXT_LUNA_V1 === "true",
        env.SANTO_ENV === "staging" && env.SANTO_LUNA_RICH_IMAGES_V1 === "true",
        env.CONTENT_BUCKET,
        env.SANTO_ENV === "staging" && env.SANTO_QWEN_ROUTING_V1 === "true",
        env.SANTO_ENV === "staging" &&
          env.SANTO_GALLERY_IMAGES_V1 === "true" &&
          env.SANTO_AI_SEARCH_SINGLE_REQUEST_V1 === "true" &&
          env.CONTENT_BUCKET
          ? new CloudflareGalleryImageRetrieval(env.CONTENT_BUCKET)
          : undefined,
        undefined, // Find the Card is isolated, never requested by Luna.
        env.SANTO_ENV === "staging" &&
          env.SANTO_LUNA_PREVIEW === "true" &&
          env.SANTO_PLAIN_TEXT_LUNA_V1 === "true" &&
          env.SANTO_LUNA_UNIFIED_PROMPT_V1 === "true",
      ).query(session, parsed.data, request.signal, onProvisionalAnswer);

      const validated = GroundedAiQueryResponseSchema.parse(response);
      const accept = request.headers.get("accept") ?? "";
      const wantsStream = accept
        .split(",")
        .some((item) => item.trim().split(";")[0]?.trim() === "text/event-stream");
      return wantsStream ? streamValidatedGroundedAnswer(validated) : Response.json(validated);
    } catch (error) {
      if (
        error instanceof SessionTokenError ||
        error instanceof SessionError ||
        error instanceof GroundedAiError ||
        error instanceof QuotaServiceError
      ) {
        return errorResponse(error.code, error.status);
      }
      throw error;
    }
  };
}

export const handleGroundedAiQuery = createGroundedAiHandler();
