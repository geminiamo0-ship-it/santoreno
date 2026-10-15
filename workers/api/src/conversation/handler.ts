import { ApiErrorResponseSchema } from "@santo/contracts";
import {
  ConversationAppendRequestSchema,
  ConversationAskRequestSchema,
  ConversationCreateRequestSchema,
  ConversationIdSchema,
} from "@santo/contracts/conversation";

import type { SantoBindings } from "../runtime/bindings";
import { GroundedAiError } from "../ai/errors";
import { streamValidatedGroundedAnswer } from "../ai/stream";
import { streamProvisionalConversationAnswer } from "./native-stream";
import { ConversationAskService } from "./ask-service";
import { D1ExternalUserRepository, type ExternalUserRepository } from "../session/repository";
import { SessionError, SessionExchangeService } from "../session/service";
import { SantoSessionTokenService, SessionTokenError } from "../session/token";
import { D1TenantRepository, type TenantRepository } from "../tenancy/repository";
import { ConversationService, ConversationServiceError } from "./service";

interface ConversationHandlerDependencies {
  tenantRepositoryFactory?: (env: SantoBindings) => TenantRepository;
  externalUserRepositoryFactory?: (env: SantoBindings) => ExternalUserRepository;
  serviceFactory?: (env: SantoBindings) => ConversationService;
  askServiceFactory?: (client: ConversationService) => ConversationAskService;
}

function errorResponse(code: string, status: number): Response {
  return Response.json(ApiErrorResponseSchema.parse({ error: code }), {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function tenantRepository(env: SantoBindings): TenantRepository {
  if (!env.CONTROL_DB) {
    throw new SessionError(503, "SESSION_NOT_CONFIGURED", "CONTROL_DB required");
  }
  return new D1TenantRepository(env.CONTROL_DB);
}

function externalUserRepository(env: SantoBindings): ExternalUserRepository {
  if (!env.CONTROL_DB) {
    throw new SessionError(503, "SESSION_NOT_CONFIGURED", "CONTROL_DB required");
  }
  return new D1ExternalUserRepository(env.CONTROL_DB);
}

function conversationService(env: SantoBindings): ConversationService {
  if (!env.CONVERSATION) {
    throw new ConversationServiceError(503, "CONVERSATION_UNAVAILABLE");
  }
  return new ConversationService(env.CONVERSATION);
}

function route(
  url: URL,
  method: string,
):
  | { operation: "create" }
  | { operation: "read" | "append" | "delete" | "ask" | "turns"; conversationId: string }
  | null {
  if (url.pathname === "/v1/conversations" && method === "POST") {
    return { operation: "create" };
  }
  const match = /^\/v1\/conversations\/([^/]+)(\/messages|\/ask|\/turns)?$/.exec(url.pathname);
  if (!match) return null;
  const conversationId = match[1] ?? "";
  if (!ConversationIdSchema.safeParse(conversationId).success) return null;
  if (!match[2] && method === "GET") return { operation: "read", conversationId };
  if (!match[2] && method === "DELETE") return { operation: "delete", conversationId };
  if (match[2] === "/messages" && method === "POST") return { operation: "append", conversationId };
  if (match[2] === "/ask" && method === "POST") return { operation: "ask", conversationId };
  if (match[2] === "/turns" && method === "GET") return { operation: "turns", conversationId };
  return null;
}

export function createConversationHandler(deps: ConversationHandlerDependencies = {}) {
  const tenants = deps.tenantRepositoryFactory ?? tenantRepository;
  const users = deps.externalUserRepositoryFactory ?? externalUserRepository;
  const service = deps.serviceFactory ?? conversationService;
  const askService =
    deps.askServiceFactory ?? ((client: ConversationService) => new ConversationAskService(client));

  return async function handleConversation(
    request: Request,
    env: SantoBindings,
  ): Promise<Response> {
    const selected = route(new URL(request.url), request.method);
    if (!selected) return errorResponse("NOT_FOUND", 404);
    try {
      const tokens = new SantoSessionTokenService(env);
      const principal = await tokens.verifyBearerToken(
        request.headers.get("authorization") ?? undefined,
      );
      const session = await new SessionExchangeService(users(env), tenants(env), tokens).resolve(
        principal,
      );
      const actor = {
        tenantId: session.tenantId,
        externalUserId: session.externalUserId,
      };
      const client = service(env);
      if (selected.operation === "create") {
        const parsed = ConversationCreateRequestSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) return errorResponse("INVALID_CONVERSATION_REQUEST", 400);
        const body = await client.create(actor, parsed.data);
        return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
      }
      if (selected.operation === "append") {
        const parsed = ConversationAppendRequestSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) return errorResponse("INVALID_CONVERSATION_REQUEST", 400);
        return Response.json(await client.append(actor, selected.conversationId, parsed.data), {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (selected.operation === "ask") {
        const parsed = ConversationAskRequestSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) return errorResponse("INVALID_CONVERSATION_REQUEST", 400);
        const acceptsSse = (request.headers.get("accept") ?? "")
          .split(",")
          .some((item) => item.trim().split(";")[0]?.trim() === "text/event-stream");
        // Provider-native progressive text is a Staging-only opt-in. Drafts
        // are never portrayed as verified, sourced or charged until completion.
        if (acceptsSse && env.SANTO_ENV === "staging" && env.SANTO_NATIVE_STREAMING_V1 === "true") {
          // Only an opt-in client receives draft_delta frames; existing consumers
          // keep the original cumulative-draft SSE contract unchanged.
          const draftFormat = (request.headers.get("accept") ?? "").includes("santo-draft=delta")
            ? "delta"
            : "cumulative";
          return streamProvisionalConversationAnswer((onDraft) =>
            askService(client).ask(
              actor,
              selected.conversationId,
              parsed.data,
              request.headers.get("authorization") ?? "",
              env,
              request.signal,
              onDraft,
            ), draftFormat,
          );
        }
        const answer = await askService(client).ask(
          actor,
          selected.conversationId,
          parsed.data,
          request.headers.get("authorization") ?? "",
          env,
          request.signal,
        );
        return acceptsSse
          ? streamValidatedGroundedAnswer(answer)
          : Response.json(answer, { headers: { "Cache-Control": "no-store" } });
      }
      if (selected.operation === "turns") {
        return Response.json(
          { turns: await client.listTurns(actor, selected.conversationId) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (selected.operation === "delete") {
        return Response.json(await client.delete(actor, selected.conversationId), {
          headers: { "Cache-Control": "no-store" },
        });
      }
      return Response.json(await client.read(actor, selected.conversationId), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (
        error instanceof SessionTokenError ||
        error instanceof SessionError ||
        error instanceof ConversationServiceError ||
        error instanceof GroundedAiError
      ) {
        return errorResponse(error.code, error.status);
      }
      throw error;
    }
  };
}

export const handleConversation = createConversationHandler();
