import { ConversationStateCore, ConversationStateError } from "./conversation-core";
import { ConversationTurnCore } from "./conversation-turn-core";
import type { DurableObjectStorageLike } from "./tenant-meter-core";

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

function failure(error: unknown): Response {
  if (error instanceof ConversationStateError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof Error && error.name === "ZodError") {
    return Response.json({ error: "INVALID_CONVERSATION_REQUEST" }, { status: 400 });
  }
  throw error;
}

export class ConversationDO {
  private readonly core: ConversationStateCore;
  private readonly turns: ConversationTurnCore;

  constructor(state: DurableObjectStateLike) {
    this.core = new ConversationStateCore(state.storage);
    this.turns = new ConversationTurnCore(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ service: "conversation-do", status: "ok", storage: "sqlite" });
    }

    if (request.method !== "POST") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    try {
      const payload: unknown = await request.json().catch(() => null);
      switch (url.pathname) {
        case "/create":
          return Response.json(this.core.create(payload));
        case "/append":
          return Response.json(this.core.append(payload));
        case "/begin-turn":
          return Response.json(this.turns.begin(payload));
        case "/complete-turn":
          return Response.json(this.turns.complete(payload));
        case "/fail-turn":
          return Response.json(this.turns.fail(payload));
        case "/list-turns":
          return Response.json(this.turns.list(payload));
        case "/read":
          return Response.json(this.core.read(payload));
        case "/delete":
          return Response.json(this.core.delete(payload));
        default:
          return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      }
    } catch (error) {
      return failure(error);
    }
  }
}
