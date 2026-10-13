import { ApiErrorResponseSchema } from "@santo/contracts";
import { GroundedAiQueryResponseSchema, type GroundedAiQueryResponse } from "@santo/contracts/ai";
import {
  ConversationCreateResponseSchema,
  ConversationReadResponseSchema,
  ConversationTurnListResponseSchema,
  type ConversationTurn,
} from "@santo/contracts/conversation";
import {
  TrustedSourceDetailResponseSchema,
  type TrustedSourceDetailResponse,
} from "@santo/contracts/source";

export interface SantoSessionProvider {
  (): Promise<string>;
}

export interface WidgetConversationStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WidgetClientOptions {
  apiBaseUrl: string;
  sessionProvider: SantoSessionProvider;
  fetchImpl?: typeof fetch;
  /** Must be unique per authenticated tenant AND end user. Never store a token. */
  store?: WidgetConversationStore;
  storeKey?: string;
}

export interface PendingQuestion {
  idempotencyKey: string;
  expectedSequence: number;
  text: string;
  libraryId: string | null;
}

interface PersistedState {
  conversationId: string;
  createKey: string;
  pending: PendingQuestion | null;
}

export class SantoWidgetApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "SantoWidgetApiError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIBRARY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function readState(value: string | null): PersistedState | null {
  if (!value) return null;
  try {
    const state: unknown = JSON.parse(value);
    if (!state || typeof state !== "object") return null;
    const row = state as Record<string, unknown>;
    if (typeof row.conversationId !== "string" || !UUID.test(row.conversationId)) return null;
    if (typeof row.createKey !== "string" || !UUID.test(row.createKey)) return null;
    if (row.pending !== null) {
      if (!row.pending || typeof row.pending !== "object") return null;
      const pending = row.pending as Record<string, unknown>;
      if (
        typeof pending.idempotencyKey !== "string" ||
        !UUID.test(pending.idempotencyKey) ||
        typeof pending.expectedSequence !== "number" ||
        !Number.isInteger(pending.expectedSequence) ||
        pending.expectedSequence < 0 ||
        pending.expectedSequence > 200 ||
        typeof pending.text !== "string" ||
        pending.text.length < 1 ||
        pending.text.length > 4000 ||
        (pending.libraryId !== null &&
          (typeof pending.libraryId !== "string" || !LIBRARY.test(pending.libraryId)))
      ) return null;
    }
    return state as PersistedState;
  } catch {
    return null;
  }
}

/** Host provides a refreshed end-user session; browser never sees a customer server key. */
export class SantoConversationClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private state: PersistedState | null = null;
  private sequence = 0;
  private readonly key: string | null;
  private turns: ConversationTurn[] = [];

  constructor(private readonly options: WidgetClientOptions) {
    const base = options.apiBaseUrl.trim().replace(/\/+$/, "");
    if (
      !base ||
      !(base.startsWith("/") && !base.startsWith("//")) &&
        !(base.startsWith("https://") && !base.includes("@"))
    ) {
      throw new Error("WIDGET_INVALID_API_ORIGIN");
    }
    this.base = base;
    this.fetcher = options.fetchImpl ?? fetch;
    this.key = options.store && options.storeKey?.trim() ? `santo:conversation:${options.storeKey}` : null;
    try {
      this.state = this.key ? readState(options.store?.getItem(this.key) ?? null) : null;
    } catch {
      this.state = null;
    }
  }

  get conversationId(): string | null { return this.state?.conversationId ?? null; }
  get nextSequence(): number { return this.sequence; }
  get pending(): PendingQuestion | null { return this.state?.pending ?? null; }
  get completedTurns(): readonly ConversationTurn[] { return this.turns; }

  private persist(): void {
    if (!this.key || !this.options.store) return;
    try {
      if (this.state) this.options.store.setItem(this.key, JSON.stringify(this.state));
      else this.options.store.removeItem(this.key);
    } catch {
      // Storage denial is not authorization failure; in-memory replay still works.
    }
  }

  private async request(path: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
    const token = await this.options.sessionProvider();
    if (!token || /\s/.test(token)) throw new SantoWidgetApiError(401, "SESSION_REQUIRED");
    let response: Response;
    try {
      response = await this.fetcher(this.base + path, {
        ...init,
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...init.headers,
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new SantoWidgetApiError(503, "WIDGET_NETWORK_ERROR");
    }
    if (response.status === 401 && retryAuth) return this.request(path, init, false);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const error = ApiErrorResponseSchema.safeParse(body);
      throw new SantoWidgetApiError(
        response.status,
        error.success ? error.data.error : "WIDGET_REQUEST_FAILED",
      );
    }
    return response;
  }

  private async json<T>(path: string, parse: (value: unknown) => T, body?: object): Promise<T> {
    const response = await this.request(path, body ? {
      method: "POST",
      body: JSON.stringify(body),
    } : { method: "GET" });
    try {
      return parse(await response.json());
    } catch {
      throw new SantoWidgetApiError(502, "WIDGET_INVALID_SERVER_RESPONSE");
    }
  }

  async connect(): Promise<readonly ConversationTurn[]> {
    if (!this.state) return [];
    const id = this.state.conversationId;
    try {
      const read = await this.json(`/v1/conversations/${id}`, (input) =>
        ConversationReadResponseSchema.parse(input));
      if (read.conversationId !== id) throw new SantoWidgetApiError(502, "WIDGET_INVALID_SERVER_RESPONSE");
      this.sequence = read.nextSequence;
      const listed = await this.json(`/v1/conversations/${id}/turns`, (input) =>
        ConversationTurnListResponseSchema.parse(input));
      this.turns = listed.turns;
      return this.turns;
    } catch (error) {
      if (error instanceof SantoWidgetApiError && error.status === 404) {
        this.reset();
        return [];
      }
      throw error;
    }
  }

  async ensureConversation(): Promise<string> {
    if (!this.state) {
      this.state = {
        conversationId: crypto.randomUUID(),
        createKey: crypto.randomUUID(),
        pending: null,
      };
      this.persist();
    }
    const id = this.state.conversationId;
    const created = await this.json(
      "/v1/conversations",
      (input) => ConversationCreateResponseSchema.parse(input),
      { conversationId: id, idempotencyKey: this.state.createKey },
    );
    if (created.conversationId !== id) throw new SantoWidgetApiError(502, "WIDGET_INVALID_SERVER_RESPONSE");
    this.sequence = created.nextSequence;
    return id;
  }

  async ask(text: string, libraryId: string | null): Promise<GroundedAiQueryResponse> {
    const question = text.trim();
    if (!question || question.length > 4000 || (libraryId !== null && !LIBRARY.test(libraryId))) {
      throw new SantoWidgetApiError(400, "INVALID_CONVERSATION_REQUEST");
    }
    const id = await this.ensureConversation();
    if (!this.state) throw new SantoWidgetApiError(503, "CONVERSATION_UNAVAILABLE");
    if (this.state.pending) {
      if (this.state.pending.text !== question || this.state.pending.libraryId !== libraryId) {
        throw new SantoWidgetApiError(409, "PENDING_TURN_REQUIRES_RETRY");
      }
    } else {
      this.state.pending = {
        idempotencyKey: crypto.randomUUID(),
        expectedSequence: this.sequence,
        text: question,
        libraryId,
      };
      this.persist();
    }
    const pending = this.state.pending;
    const result = await this.json(
      `/v1/conversations/${id}/ask`,
      (input) => GroundedAiQueryResponseSchema.parse(input),
      {
        idempotencyKey: pending.idempotencyKey,
        expectedSequence: pending.expectedSequence,
        text: pending.text,
        ...(pending.libraryId ? { libraryId: pending.libraryId } : {}),
      },
    );
    this.sequence = Math.max(this.sequence, pending.expectedSequence + 1);
    this.state.pending = null;
    this.persist();
    await this.refreshTurns().catch(() => undefined);
    return result;
  }

  async retryPending(): Promise<GroundedAiQueryResponse> {
    if (!this.state?.pending) throw new SantoWidgetApiError(400, "NO_PENDING_TURN");
    return this.ask(this.state.pending.text, this.state.pending.libraryId);
  }

  async refreshTurns(): Promise<readonly ConversationTurn[]> {
    if (!this.state) return [];
    return this.connect();
  }

  async sourceDetails(messageId: string, sourceId: string): Promise<TrustedSourceDetailResponse> {
    return this.json("/v1/sources/detail", (input) =>
      TrustedSourceDetailResponseSchema.parse(input), { messageId, sourceId });
  }

  async sourceImage(messageId: string, sourceId: string, assetId: string): Promise<Blob> {
    const path = `/v1/sources/${encodeURIComponent(messageId)}/${encodeURIComponent(sourceId)}/images/${encodeURIComponent(assetId)}`;
    const response = await this.request(path);
    const mime = response.headers.get("content-type") ?? "";
    if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(mime)) {
      throw new SantoWidgetApiError(502, "WIDGET_INVALID_IMAGE");
    }
    return response.blob();
  }

  reset(): void {
    this.state = null;
    this.sequence = 0;
    this.turns = [];
    this.persist();
  }
}
