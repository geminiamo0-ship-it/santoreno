import {
  ConversationBeginTurnResponseSchema,
  ConversationBeginTurnSchema,
  ConversationFinishTurnSchema,
  ConversationRetryTurnSchema,
  ConversationTurnListResponseSchema,
  ConversationTurnSchema,
  type ConversationActor,
  type ConversationBeginTurnResponse,
  type ConversationTurn,
} from "@santo/contracts/conversation";
import { GroundedAiQueryResponseSchema } from "@santo/contracts/ai";

import type { DurableObjectStorageLike, SqlStorageLike } from "./tenant-meter-core";
import { ConversationStateError } from "./conversation-core";

interface MetaRow {
  conversation_id: string;
  tenant_id: string;
  external_user_id: string;
}
interface TurnRow {
  idempotency_key: string;
  message_id: string;
  sequence: number;
  expected_sequence: number;
  question: string;
  library_id: string | null;
  status: "pending" | "completed" | "retryable";
  attempt_id: string;
  lease_until_ms: number;
  response_json: string | null;
  context_text: string;
  quota_epoch: number;
}
interface SequenceRow {
  next_sequence: number;
}
const LEASE_MS = 180_000;

export const TURN_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_turns (
  idempotency_key TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE,
  expected_sequence INTEGER NOT NULL,
  question TEXT NOT NULL,
  library_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','retryable')),
  attempt_id TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  response_json TEXT,
  context_text TEXT NOT NULL DEFAULT '',
  quota_epoch INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turns_sequence ON conversation_turns (sequence DESC);
`;

function first<T>(sql: SqlStorageLike, query: string, ...bindings: unknown[]): T | null {
  return sql.exec<T>(query, ...bindings).toArray()[0] ?? null;
}

function owner(sql: SqlStorageLike, actor: ConversationActor, id: string): void {
  const row = first<MetaRow>(
    sql,
    "SELECT conversation_id, tenant_id, external_user_id FROM conversation_meta WHERE singleton = 1",
  );
  if (
    !row ||
    row.conversation_id !== id ||
    row.tenant_id !== actor.tenantId ||
    row.external_user_id !== actor.externalUserId
  ) {
    throw new ConversationStateError(404, "CONVERSATION_NOT_FOUND");
  }
}

function toTurn(row: TurnRow): ConversationTurn {
  const response =
    row.response_json === null
      ? null
      : GroundedAiQueryResponseSchema.parse(JSON.parse(row.response_json));
  return ConversationTurnSchema.parse({
    messageId: row.message_id,
    sequence: row.sequence,
    question: row.question,
    libraryId: row.library_id,
    status: row.status,
    response,
  });
}

function recentContext(sql: SqlStorageLike): string {
  const rows = sql
    .exec<TurnRow>(
      "SELECT * FROM conversation_turns WHERE status = 'completed' ORDER BY sequence DESC LIMIT 3",
    )
    .toArray()
    .reverse();
  const parts = rows.map((row) => {
    const response = toTurn(row).response;
    if (!response) return "";
    return `Previous user: ${row.question.slice(0, 160)}\nVerified assistant: ${response.answer.slice(0, 280)}`;
  });
  return parts.join("\n").slice(0, 1600);
}

/** This core owns only conversation sequencing and verified response persistence, never quota. */
export class ConversationTurnCore {
  constructor(
    private readonly storage: DurableObjectStorageLike,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    storage.sql.exec(TURN_SCHEMA);
  }

  begin(input: unknown): ConversationBeginTurnResponse {
    const request = ConversationBeginTurnSchema.parse(input);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      owner(sql, request.actor, request.conversationId);
      const existing = first<TurnRow>(
        sql,
        "SELECT * FROM conversation_turns WHERE idempotency_key = ?",
        request.idempotencyKey,
      );
      if (existing) {
        if (
          existing.question !== request.text ||
          existing.library_id !== (request.libraryId ?? null) ||
          existing.expected_sequence !== request.expectedSequence
        ) {
          throw new ConversationStateError(409, "CONVERSATION_IDEMPOTENCY_CONFLICT");
        }
        if (existing.status === "completed") {
          return ConversationBeginTurnResponseSchema.parse({
            state: "completed",
            attemptId: null,
            turn: toTurn(existing),
            context: "",
            quotaEpoch: existing.quota_epoch,
          });
        }
        if (existing.status === "pending" && existing.lease_until_ms > this.nowMs()) {
          throw new ConversationStateError(409, "CONVERSATION_TURN_BUSY");
        }
        const attemptId = this.newId();
        sql.exec(
          "UPDATE conversation_turns SET status = 'pending', attempt_id = ?, lease_until_ms = ? WHERE idempotency_key = ?",
          attemptId,
          this.nowMs() + LEASE_MS,
          request.idempotencyKey,
        );
        const renewed = { ...existing, status: "pending" as const, attempt_id: attemptId };
        return ConversationBeginTurnResponseSchema.parse({
          state: "started",
          attemptId,
          turn: toTurn(renewed),
          context: existing.context_text,
          quotaEpoch: existing.quota_epoch,
        });
      }
      const competing = first<TurnRow>(
        sql,
        "SELECT * FROM conversation_turns WHERE status = 'pending' LIMIT 1",
      );
      if (competing) throw new ConversationStateError(409, "CONVERSATION_TURN_BUSY");
      const next =
        first<SequenceRow>(
          sql,
          "SELECT COALESCE(MAX(sequence) + 1, 0) AS next_sequence FROM conversation_messages",
        )?.next_sequence ?? 0;
      if (next !== request.expectedSequence) {
        throw new ConversationStateError(409, "CONVERSATION_SEQUENCE_CONFLICT");
      }
      if (next >= 200) {
        throw new ConversationStateError(413, "CONVERSATION_LIMIT_REACHED");
      }
      const messageId = this.newId();
      const attemptId = this.newId();
      const now = this.nowMs();
      const context = recentContext(sql);
      sql.exec(
        `INSERT INTO conversation_messages
          (sequence, message_id, idempotency_key, expected_sequence, role, text, created_at_ms)
         VALUES (?, ?, ?, ?, 'user', ?, ?)`,
        next,
        messageId,
        `ask:${request.idempotencyKey}`,
        request.expectedSequence,
        request.text,
        now,
      );
      sql.exec(
        `INSERT INTO conversation_turns
          (idempotency_key, message_id, sequence, expected_sequence, question, library_id, status, attempt_id, lease_until_ms, response_json, context_text, quota_epoch)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, 0)`,
        request.idempotencyKey,
        messageId,
        next,
        request.expectedSequence,
        request.text,
        request.libraryId ?? null,
        attemptId,
        now + LEASE_MS,
        context,
      );
      return ConversationBeginTurnResponseSchema.parse({
        state: "started",
        attemptId,
        context,
        quotaEpoch: 0,
        turn: {
          messageId,
          sequence: next,
          question: request.text,
          libraryId: request.libraryId ?? null,
          status: "pending",
          response: null,
        },
      });
    });
  }

  complete(input: unknown): ConversationTurn {
    const request = ConversationFinishTurnSchema.parse(input);
    const response = GroundedAiQueryResponseSchema.parse(request.response);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      owner(sql, request.actor, request.conversationId);
      const row = first<TurnRow>(
        sql,
        "SELECT * FROM conversation_turns WHERE idempotency_key = ?",
        request.idempotencyKey,
      );
      if (!row || row.attempt_id !== request.attemptId || row.status !== "pending") {
        throw new ConversationStateError(409, "CONVERSATION_TURN_BUSY");
      }
      sql.exec(
        "UPDATE conversation_turns SET status = 'completed', response_json = ?, lease_until_ms = 0 WHERE idempotency_key = ?",
        JSON.stringify(response),
        request.idempotencyKey,
      );
      return toTurn({ ...row, status: "completed", response_json: JSON.stringify(response) });
    });
  }

  fail(input: unknown): { retryable: true } {
    const request = ConversationRetryTurnSchema.parse(input);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      owner(sql, request.actor, request.conversationId);
      const row = first<TurnRow>(
        sql,
        "SELECT * FROM conversation_turns WHERE idempotency_key = ?",
        request.idempotencyKey,
      );
      if (!row || row.attempt_id !== request.attemptId || row.status !== "pending") {
        throw new ConversationStateError(409, "CONVERSATION_TURN_BUSY");
      }
      sql.exec(
        "UPDATE conversation_turns SET status = 'retryable', lease_until_ms = 0, quota_epoch = quota_epoch + ? WHERE idempotency_key = ?",
        request.rotateQuotaKey === true ? 1 : 0,
        request.idempotencyKey,
      );
      return { retryable: true };
    });
  }

  list(input: unknown): { turns: ConversationTurn[] } {
    const request = ConversationRetryTurnSchema.omit({
      idempotencyKey: true,
      attemptId: true,
    }).parse(input);
    const sql = this.storage.sql;
    owner(sql, request.actor, request.conversationId);
    const turns = sql
      .exec<TurnRow>("SELECT * FROM conversation_turns ORDER BY sequence DESC LIMIT 10")
      .toArray()
      .reverse()
      .map(toTurn);
    return ConversationTurnListResponseSchema.parse({ turns });
  }
}
