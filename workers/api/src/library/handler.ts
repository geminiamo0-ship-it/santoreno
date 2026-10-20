import { ApiErrorResponseSchema } from "@santo/contracts";
import type { SantoBindings } from "../runtime/bindings";
import { D1ExternalUserRepository, type ExternalUserRepository } from "../session/repository";
import { SessionError, SessionExchangeService } from "../session/service";
import { SantoSessionTokenService, SessionTokenError } from "../session/token";
import { D1TenantRepository, type TenantRepository } from "../tenancy/repository";
import { SourceResolutionError } from "../sources/store";
import { LibraryReaderService, LibraryReaderError } from "./reader";
import { PubMedArticleViewerService } from "./research-article";
import { R2VerifiedSourceStore } from "../sources/store";

export interface LibraryReaderDependencies {
  tenants?: (env: SantoBindings) => TenantRepository;
  users?: (env: SantoBindings) => ExternalUserRepository;
  reader?: (env: SantoBindings) => LibraryReaderService;
}
function error(code: string, status: number): Response {
  return Response.json(ApiErrorResponseSchema.parse({ error: code }), {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export function createLibraryReaderHandler(deps: LibraryReaderDependencies = {}) {
  return async (request: Request, env: SantoBindings): Promise<Response> => {
    if (env.SANTO_ENV !== "staging" || env.SANTO_LIBRARY_READER_V1 !== "true") {
      return error("LIBRARY_NOT_FOUND", 404);
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const catalog = path === "/v1/libraries";
    const citation = path === "/v1/sources/article";
    const researchCitation = path === "/v1/sources/research-article";
    const listed = /^\/v1\/libraries\/([^/]+)\/articles$/.exec(path);
    const detail = /^\/v1\/libraries\/([^/]+)\/articles\/([^/]+)$/.exec(path);
    if (!catalog && !citation && !researchCitation && !listed && !detail) return error("LIBRARY_NOT_FOUND", 404);
    if (citation || researchCitation ? request.method !== "POST" : request.method !== "GET") {
      return error("METHOD_NOT_ALLOWED", 405);
    }
    try {
      const tokens = new SantoSessionTokenService(env);
      const principal = await tokens.verifyBearerToken(
        request.headers.get("authorization") ?? undefined,
      );
      const getTenant =
        deps.tenants ??
        ((binding: SantoBindings) => {
          if (!binding.CONTROL_DB) throw new LibraryReaderError(503, "LIBRARY_UNAVAILABLE");
          return new D1TenantRepository(binding.CONTROL_DB);
        });
      const getUsers =
        deps.users ??
        ((binding: SantoBindings) => {
          if (!binding.CONTROL_DB) throw new LibraryReaderError(503, "LIBRARY_UNAVAILABLE");
          return new D1ExternalUserRepository(binding.CONTROL_DB);
        });
      const session = await new SessionExchangeService(
        getUsers(env),
        getTenant(env),
        tokens,
      ).resolve(principal);
      const service = deps.reader
        ? deps.reader(env)
        : env.CONTENT_BUCKET
          ? new LibraryReaderService(env.CONTENT_BUCKET)
          : null;
      if (!service) throw new LibraryReaderError(503, "LIBRARY_UNAVAILABLE");
      if (catalog) return Response.json(await service.catalog(), { headers: HEADERS });
      if (researchCitation) {
        if (env.SANTO_RESEARCH_ENABLED !== "true" || !env.CONTENT_BUCKET) {
          return error("LIBRARY_NOT_FOUND", 404);
        }
        const reader = new PubMedArticleViewerService(new R2VerifiedSourceStore(env.CONTENT_BUCKET));
        return Response.json(
          await reader.fromCitation(session, await request.json().catch(() => null)),
          { headers: HEADERS },
        );
      }
      if (citation)
        return Response.json(
          await service.fromCitation(session, await request.json().catch(() => null)),
          { headers: HEADERS },
        );
      if (listed) {
        const rawCursor = url.searchParams.get("cursor") ?? "0";
        if (!/^(0|[1-9][0-9]{0,3})$/.test(rawCursor)) {
          return error("INVALID_LIBRARY_REQUEST", 400);
        }
        return Response.json(
          await service.list(listed[1]!, url.searchParams.get("q") ?? "", Number(rawCursor)),
          { headers: HEADERS },
        );
      }
      return Response.json(await service.article(detail![1]!, detail![2]!), { headers: HEADERS });
    } catch (caught) {
      if (
        caught instanceof SessionTokenError ||
        caught instanceof SessionError ||
        caught instanceof LibraryReaderError ||
        caught instanceof SourceResolutionError
      ) {
        return error(caught.code, caught.status);
      }
      throw caught;
    }
  };
}
export const handleLibraryReader = createLibraryReaderHandler();
