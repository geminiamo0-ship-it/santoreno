import {
  ConversationAppendResponseSchema,
  ConversationCreateResponseSchema,
  ConversationDeleteResponseSchema,
  ConversationInternalAppendSchema,
  ConversationInternalCreateSchema,
  ConversationInternalReadSchema,
  ConversationReadResponseSchema,
  type ConversationActor,
  type ConversationAppendResponse,
  type ConversationCreateResponse,
  type ConversationDeleteResponse,
  type ConversationMessage,
  type ConversationReadResponse,
} from "@santo/contracts/conversation";

import type { DurableObjectStorageLike, SqlStorageLike } from "./tenant-meter-core";

const MAX_MESSAGES = 200;
const READ_PAGE_SIZE = 50;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  conversation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  title TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  sequence INTEGER PRIMARY KEY CHECK (sequence >= 0),
  message_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role = 'user'),
  text TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
`;

interface ConversationRow {
  conversation_id: string;
  tenant_id: string;
  external_user_id: string;
  creation_key: string;
  title: string | null;
  created_at_ms: number;
}

interface MessageRow {
  message_id: string;
  sequence: number;
  idempotency_key: string;
  expected_sequence: number;
  role: "user";
  text: string;
  created_at_ms: number;
}

function first<T>(sql: SqlStorageLike, query: string, ...parameters: unknown[]): T | null {
  return sql.exec<T>(query, ...parameters).toArray()[0] ?? null;
}

export class ConversationStateError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 413,
    readonly code:
      | "CONVERSATION_OWNER_MISMATCH"
      | "CONVERSATION_NOT_FOUND"
      | "CONVERSATION_ID_MISMATCH"
      | "CONVERSATION_IDEMPOTENCY_CONFLICT"
      | "CONVERSATION_SEQUENCE_CONFLICT"
      | "CONVERSATION_LIMIT_REACHED",
  ) {
    super(code);
    this.name = "ConversationStateError";
  }
}

function requireConversation(
  sql: SqlStorageLike,
  actor: ConversationActor,
  conversationId: string,
): ConversationRow {
  const row = first<ConversationRow>(sql, "SELECT * FROM conversation_meta WHERE singleton = 1");
  if (!row) throw new ConversationStateError(404, "CONVERSATION_NOT_FOUND");
  if (row.conversation_id !== conversationId) {
    throw new ConversationStateError(409, "CONVERSATION_ID_MISMATCH");
  }
  if (row.tenant_id !== actor.tenantId || row.external_user_id !== actor.externalUserId) {
    throw new ConversationStateError(404, "CONVERSATION_NOT_FOUND");
  }
  return row;
}

function nextSequence(sql: SqlStorageLike): number {
  const row = first<{ next_sequence: number }>(
    sql,
    "SELECT COALESCE(MAX(sequence) + 1, 0) AS next_sequence FROM conversation_messages",
  );
  return row?.next_sequence ?? 0;
}

function toMessage(row: MessageRow): ConversationMessage {
  return {
    messageId: row.message_id,
    sequence: row.sequence,
    role: row.role,
    text: row.text,
    createdAt: new Date(row.created_at_ms).toISOString(),
  };
}

function toCreation(row: ConversationRow, next: number): ConversationCreateResponse {
  return ConversationCreateResponseSchema.parse({
    conversationId: row.conversation_id,
    title: row.title,
    createdAt: new Date(row.created_at_ms).toISOString(),
    nextSequence: next,
  });
}

export class ConversationStateCore {
  constructor(
    private readonly storage: DurableObjectStorageLike,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    storage.sql.exec(SCHEMA);
  }

  create(input: unknown): ConversationCreateResponse {
    const request = ConversationInternalCreateSchema.parse(input);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const existing = first<ConversationRow>(
        sql,
        "SELECT * FROM conversation_meta WHERE singleton = 1",
      );
      if (existing) {
        requireConversation(sql, request.actor, request.conversationId);
        if (
          existing.creation_key !== request.idempotencyKey ||
          existing.title !== (request.title ?? null)
        ) {
          throw new ConversationStateError(409, "CONVERSATION_IDEMPOTENCY_CONFLICT");
        }
        return toCreation(existing, nextSequence(sql));
      }
      const createdAt = this.nowMs();
      sql.exec(
        `INSERT INTO conversation_meta
          (singleton, conversation_id, tenant_id, external_user_id, creation_key, title, created_at_ms)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
        request.conversationId,
        request.actor.tenantId,
        request.actor.externalUserId,
        request.idempotencyKey,
        request.title ?? null,
        createdAt,
      );
      return ConversationCreateResponseSchema.parse({
        conversationId: request.conversationId,
        title: request.title ?? null,
        createdAt: new Date(createdAt).toISOString(),
        nextSequence: 0,
      });
    });
  }

  append(input: unknown): ConversationAppendResponse {
    const request = ConversationInternalAppendSchema.parse(input);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      requireConversation(sql, request.actor, request.conversationId);
      const existing = first<MessageRow>(
        sql,
        "SELECT * FROM conversation_messages WHERE idempotency_key = ? LIMIT 1",
        request.idempotencyKey,
      );
      if (existing) {
        if (
          existing.expected_sequence !== request.expectedSequence ||
          existing.text !== request.text
        ) {
          throw new ConversationStateError(409, "CONVERSATION_IDEMPOTENCY_CONFLICT");
        }
        return ConversationAppendResponseSchema.parse({
          message: toMessage(existing),
          nextSequence: existing.sequence + 1,
          replayed: true,
        });
      }
      const sequence = nextSequence(sql);
      if (sequence !== request.expectedSequence) {
        throw new ConversationStateError(409, "CONVERSATION_SEQUENCE_CONFLICT");
      }
      if (sequence >= MAX_MESSAGES) {
        throw new ConversationStateError(413, "CONVERSATION_LIMIT_REACHED");
      }
      const messageId = this.newId();
      const createdAt = this.nowMs();
      sql.exec(
        `INSERT INTO conversation_messages
          (sequence, message_id, idempotency_key, expected_sequence, role, text, created_at_ms)
         VALUES (?, ?, ?, ?, 'user', ?, ?)`,
        sequence,
        messageId,
        request.idempotencyKey,
        request.expectedSequence,
        request.text,
        createdAt,
      );
      return ConversationAppendResponseSchema.parse({
        message: toMessage({
          sequence,
          message_id: messageId,
          idempotency_key: request.idempotencyKey,
          expected_sequence: request.expectedSequence,
          role: "user",
          text: request.text,
          created_at_ms: createdAt,
        }),
        nextSequence: sequence + 1,
        replayed: false,
      });
    });
  }

  read(input: unknown): ConversationReadResponse {
    const request = ConversationInternalReadSchema.parse(input);
    const sql = this.storage.sql;
    const row = requireConversation(sql, request.actor, request.conversationId);
    const next = nextSequence(sql);
    const messages = sql
      .exec<MessageRow>(
        "SELECT * FROM conversation_messages ORDER BY sequence DESC LIMIT ?",
        READ_PAGE_SIZE,
      )
      .toArray()
      .reverse()
      .map(toMessage);
    return ConversationReadResponseSchema.parse({
      ...toCreation(row, next),
      messages,
      totalMessages: next,
    });
  }
  delete(input: unknown): ConversationDeleteResponse {
    const request = ConversationInternalReadSchema.parse(input);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      requireConversation(sql, request.actor, request.conversationId);
      sql.exec("DELETE FROM conversation_messages");
      sql.exec("DELETE FROM conversation_meta WHERE singleton = 1");
      return ConversationDeleteResponseSchema.parse({ deleted: true });
    });
  }

}
