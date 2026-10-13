import { ApiErrorResponseSchema } from "@santo/contracts";
import { TrustedSourceDetailRequestSchema } from "@santo/contracts/source";

import type { SantoBindings } from "../runtime/bindings";
import { D1ExternalUserRepository, type ExternalUserRepository } from "../session/repository";
import { SessionError, SessionExchangeService } from "../session/service";
import { SantoSessionTokenService, SessionTokenError } from "../session/token";
import { D1TenantRepository, type TenantRepository } from "../tenancy/repository";
import { TrustedSourceService } from "./service";
import { R2VerifiedSourceStore, SourceResolutionError } from "./store";

export interface TrustedSourceHandlerDependencies {
  tenantRepositoryFactory?: (env: SantoBindings) => TenantRepository;
  externalUserRepositoryFactory?: (env: SantoBindings) => ExternalUserRepository;
  sourceStoreFactory?: (env: SantoBindings) => R2VerifiedSourceStore;
}

function errorResponse(code: string, status: number): Response {
  return Response.json(ApiErrorResponseSchema.parse({ error: code }), {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function defaultTenantRepository(env: SantoBindings): TenantRepository {
  if (!env.CONTROL_DB) {
    throw new SourceResolutionError(503, "SOURCE_UNAVAILABLE");
  }
  return new D1TenantRepository(env.CONTROL_DB);
}

function defaultExternalUserRepository(env: SantoBindings): ExternalUserRepository {
  if (!env.CONTROL_DB) {
    throw new SourceResolutionError(503, "SOURCE_UNAVAILABLE");
  }
  return new D1ExternalUserRepository(env.CONTROL_DB);
}

function defaultStore(env: SantoBindings): R2VerifiedSourceStore {
  if (!env.CONTENT_BUCKET) throw new SourceResolutionError(503, "SOURCE_UNAVAILABLE");
  return new R2VerifiedSourceStore(env.CONTENT_BUCKET);
}

function imageRequest(url: URL): {
  messageId: string;
  sourceId: string;
  assetId: string;
} | null {
  const match = /^\/v1\/sources\/([^/]+)\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  try {
    return {
      messageId: decodeURIComponent(match[1]!),
      sourceId: decodeURIComponent(match[2]!),
      assetId: decodeURIComponent(match[3]!),
    };
  } catch {
    return null;
  }
}

export function createTrustedSourceHandler(dependencies: TrustedSourceHandlerDependencies = {}) {
  const tenantRepositoryFactory = dependencies.tenantRepositoryFactory ?? defaultTenantRepository;
  const externalUserRepositoryFactory =
    dependencies.externalUserRepositoryFactory ?? defaultExternalUserRepository;
  const sourceStoreFactory = dependencies.sourceStoreFactory ?? defaultStore;

  return async function handleTrustedSourceRequest(
    request: Request,
    env: SantoBindings,
  ): Promise<Response> {
    const url = new URL(request.url);
    const isDetail = url.pathname === "/v1/sources/detail";
    const image = imageRequest(url);
    if (!isDetail && !image) return errorResponse("SOURCE_NOT_FOUND", 404);
    if ((isDetail && request.method !== "POST") || (image && request.method !== "GET")) {
      return errorResponse("METHOD_NOT_ALLOWED", 405);
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
      const service = new TrustedSourceService(sourceStoreFactory(env));

      if (isDetail) {
        const parsed = TrustedSourceDetailRequestSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) return errorResponse("INVALID_SOURCE_REQUEST", 400);
        return Response.json(await service.detail(session, parsed.data), {
          headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
        });
      }

      if (!image) return errorResponse("SOURCE_NOT_FOUND", 404);
      const lookup = { messageId: image.messageId, sourceId: image.sourceId };
      const parsed = TrustedSourceDetailRequestSchema.safeParse(lookup);
      if (!parsed.success) return errorResponse("INVALID_SOURCE_REQUEST", 400);
      const asset = await service.image(session, parsed.data, image.assetId);
      return new Response(asset.bytes.buffer, {
        status: 200,
        headers: {
          "Content-Type": asset.contentType,
          "Content-Disposition": "inline",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      });
    } catch (error) {
      if (
        error instanceof SessionTokenError ||
        error instanceof SessionError ||
        error instanceof SourceResolutionError
      ) {
        return errorResponse(error.code, error.status);
      }
      throw error;
    }
  };
}

export const handleTrustedSourceRequest = createTrustedSourceHandler();
