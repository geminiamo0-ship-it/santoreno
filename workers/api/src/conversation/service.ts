import { ApiErrorResponseSchema } from "@santo/contracts";
import {
  ConversationAppendResponseSchema,
  ConversationBeginTurnResponseSchema,
  ConversationTurnSchema,
  ConversationTurnListResponseSchema,
  ConversationCreateResponseSchema,
  ConversationDeleteResponseSchema,
  ConversationReadResponseSchema,
  type ConversationActor,
  type ConversationAskRequest,
  type ConversationBeginTurnResponse,
  type ConversationTurn,
  type ConversationAppendRequest,
  type ConversationAppendResponse,
  type ConversationCreateRequest,
  type ConversationCreateResponse,
  type ConversationDeleteResponse,
  type ConversationReadResponse,
} from "@santo/contracts/conversation";

import type { DurableObjectNamespaceLike } from "../runtime/bindings";

export class ConversationServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ConversationServiceError";
  }
}

/** This is a routing key, never an authorization grant. The DO validates the actor on every call. */
export class ConversationService {
  constructor(private readonly namespace: DurableObjectNamespaceLike) {}

  private async call<T>(
    conversationId: string,
    operation:
      | "create"
      | "read"
      | "append"
      | "delete"
      | "begin-turn"
      | "complete-turn"
      | "fail-turn"
      | "list-turns",
    payload: unknown,
    validate: (value: unknown) => T,
  ): Promise<T> {
    const stub = this.namespace.get(this.namespace.idFromName(`conversation:${conversationId}`));
    let response: Response;
    try {
      response = await stub.fetch(
        new Request(`https://santo.internal/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    } catch {
      throw new ConversationServiceError(503, "CONVERSATION_UNAVAILABLE");
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(body);
      throw new ConversationServiceError(
        response.status,
        parsed.success ? parsed.data.error : "CONVERSATION_UNAVAILABLE",
      );
    }
    const parsed = validate(body);
    return parsed;
  }

  create(
    actor: ConversationActor,
    request: ConversationCreateRequest,
  ): Promise<ConversationCreateResponse> {
    return this.call(request.conversationId, "create", { ...request, actor }, (body) =>
      ConversationCreateResponseSchema.parse(body),
    );
  }

  append(
    actor: ConversationActor,
    conversationId: string,
    request: ConversationAppendRequest,
  ): Promise<ConversationAppendResponse> {
    return this.call(conversationId, "append", { ...request, actor, conversationId }, (body) =>
      ConversationAppendResponseSchema.parse(body),
    );
  }

  read(actor: ConversationActor, conversationId: string): Promise<ConversationReadResponse> {
    return this.call(conversationId, "read", { actor, conversationId }, (body) =>
      ConversationReadResponseSchema.parse(body),
    );
  }
  delete(actor: ConversationActor, conversationId: string): Promise<ConversationDeleteResponse> {
    return this.call(conversationId, "delete", { actor, conversationId }, (body) =>
      ConversationDeleteResponseSchema.parse(body),
    );
  }
  beginTurn(
    actor: ConversationActor,
    conversationId: string,
    input: ConversationAskRequest,
  ): Promise<ConversationBeginTurnResponse> {
    return this.call(conversationId, "begin-turn", { actor, conversationId, ...input }, (value) =>
      ConversationBeginTurnResponseSchema.parse(value),
    );
  }

  completeTurn(
    actor: ConversationActor,
    conversationId: string,
    idempotencyKey: string,
    attemptId: string,
    response: import("@santo/contracts/ai").GroundedAiQueryResponse,
  ): Promise<ConversationTurn> {
    return this.call(
      conversationId,
      "complete-turn",
      { actor, conversationId, idempotencyKey, attemptId, response },
      (value) => ConversationTurnSchema.parse(value),
    );
  }

  async failTurn(
    actor: ConversationActor,
    conversationId: string,
    idempotencyKey: string,
    attemptId: string,
  ): Promise<void> {
    await this.call(
      conversationId,
      "fail-turn",
      { actor, conversationId, idempotencyKey, attemptId },
      (value) => {
        if ((value as { retryable?: unknown })?.retryable !== true)
          throw new ConversationServiceError(503, "CONVERSATION_UNAVAILABLE");
      },
    );
  }

  listTurns(actor: ConversationActor, conversationId: string): Promise<ConversationTurn[]> {
    return this.call(
      conversationId,
      "list-turns",
      { actor, conversationId },
      (value) => ConversationTurnListResponseSchema.parse(value).turns,
    );
  }
}
