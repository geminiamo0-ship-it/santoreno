# Phase 9 — Conversation state and ordered message contract

> Status: First implementation slice on PR #54 / Issue #52. This is not the
> complete Phase 9 AI follow-up workflow.

## Scope

Santo uses one SQLite-backed `ConversationDO` per conversation ID. The
authenticated API owns tenant/user authorization and translates public
requests into internal messages. The Durable Object checks the tenant and
external user on **every** read, append, create replay, and deletion operation.

A `conversationId` is a **client-created UUID**, used only as a routing key.
It is never an authorization capability. A client must reuse the same ID and
idempotency key to retry creation. The tenant identity always derives from
the verified Santo session.

No customer database, second quota engine, or tenant-specific configuration
is involved in this slice.

## HTTP routes

All routes require a current Santo end-user `Authorization: Bearer` session
and return `Cache-Control: no-store`.

| Route                                             | Behavior                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /v1/conversations`                          | Create; body `{conversationId, idempotencyKey, title?}`                  |
| `GET /v1/conversations/:conversationId`           | Read owner-scoped conversation metadata and latest messages              |
| `POST /v1/conversations/:conversationId/messages` | Append one user message; body `{idempotencyKey, expectedSequence, text}` |
| `DELETE /v1/conversations/:conversationId`        | Remove owner-scoped SQLite message and metadata rows                     |

Public requests must not contain `actor`, `tenantId`, `externalUserId`,
roles, assistant content, or client-selected citations. The shared Zod
schemas in `@santo/contracts/conversation` are the network contract.

## Ordering and replay

- The DO uses synchronous SQLite storage transactions for mutations.
- `expectedSequence` is an optimistic compare-and-append position.
- Of competing distinct-key appends at the same position, only one may
  succeed; the rest return `CONVERSATION_SEQUENCE_CONFLICT` (HTTP 409).
- Identical retries with the same idempotency key, position and trimmed
  text replay the original message ID and position, without inserting a
  second message.
- Reusing that key with changed text or sequence returns
  `CONVERSATION_IDEMPOTENCY_CONFLICT` (HTTP 409).
- A conversation accepts at most **200 user messages** in this first slice.
  Reads return only the most recent **50 messages**, ordered ascending;
  `totalMessages` and `nextSequence` expose the bounded offset.
- All timestamps and stable message IDs come from the server/DO.

Owner mismatch returns the same `CONVERSATION_NOT_FOUND` response as an
unknown conversation, so a guessed identifier cannot confirm a different
tenant's/user's object.

## Deletion and privacy

Only the current owner can call the deletion endpoint. It removes the
current SQLite rows, allowing run-scoped staging fixtures to be cleaned up.
Persistent provider backups or lower-level WAL retention are outside the
API's guarantee and require an explicit production data-retention policy.

## Phase 9 follow-up turn lifecycle (PR #56)

The authenticated `POST /v1/conversations/:conversationId/ask` accepts
`{idempotencyKey, expectedSequence, text, libraryId?}`. The matching
`GET /v1/conversations/:conversationId/turns` returns the latest 10 turns,
including their completion state and authoritative server-verified answer.

The API verifies the Santo session before touching conversation state.
`ConversationDO` atomically leases one pending turn and pins a stable
idempotency key, query, library and bounded prior context. Competing
concurrent turns fail with HTTP 409. Only one lease holder may commit the
answer; a stale lease cannot overwrite a newer attempt. A completed retry
replays the identical persisted response and bypasses model/quota work.

Generation reuses the existing Phase 7 grounded AI handler, including
authoritative `TenantMeterDO` reserve/finalize/release, AI Search, strict
citation validation and R2 snapshot persistence. Only after it returns a
validated and finalized response does the conversation commit that answer.
JSON and buffered SSE are emitted **after** that commit. The response uses
the existing versioned Phase 7 response format.

A persistent, deterministic rolling summary is built only from **completed**
server-verified answer/question pairs. Each entry is an extractive snippet
(question capped at 90 characters, answer at 155), and SQLite holds at most
1,200 characters of recent compacted history. When the limit is reached,
the oldest entries are evicted; this is intentionally **not** a semantic
model-generated summary and does not promise perfect long-term recall.
For pre-summary SQLite objects, the most recent three completed turns are
safely compacted once as migration fallback. Summaries are written in the
same SQLite transaction that marks a turn complete, and removed on owner
deletion. Previously pinned context never changes when retrying a turn.
All history is untrusted context, not citation authority. Current prompts
still cap total text at 4,000 characters.

On a confirmed charge-free failure, the turn is marked `retryable` and the
Durable Object advances its billing epoch. This permits a new reservation
without reusing a previously released quota key. If finalization is
uncertain or generation succeeded but the conversation commit failed,
the epoch stays unchanged; retries reuse the same billing key to prevent
double charging. A previously finalized generation retry failure has its
own `CHARGED_GENERATION_RETRY_FAILED` error and also preserves its epoch.
Leases last 180 seconds and can be reclaimed when expired. A lease that
has expired does not block unrelated new messages forever; a timed-out
old turn may only reacquire its lease if no **other unexpired** turn is
active. A newer verified answer may finish before an older reclaimed turn;
the rolling summary only advances with increasing sequence, preventing
older completions from overwriting newer memory. A caller should retry a
failed turn with its original key to recover a missed answer.

Deletion removes conversation-owned metadata, pending/completed turns,
and user-message rows atomically. R2 snapshots remain governed by the
existing 30-day logical retention and production lifecycle cleanup policy.

## Delivery boundary

PR #54 implemented ordered conversation storage; PR #56 implemented
grounded follow-ups and quota-safe replay. The final Phase 9 slice adds
durable, bounded extractive summary and stale lease fencing.
This is **not** an unlimited conversation memory or model-generated
clinical summary. Expiry and quota finalization uncertainty are surfaced
as typed retry states, rather than implying that a failed request did not
charge. The Phase 10 widget must persist and reuse conversation and
idempotency keys, handle HTTP 409/503 and reconnect by reading `/turns`.
The full widget/portal remain out of scope for Phase 9.

## Verification

- Strict contract tests reject forged actor fields and unverified roles.
- Deterministic core tests check user/tenant isolation, 100 competing
  append attempts, same-key replay, conflicting replay, bounded reads,
  recreation over persisted state, and authorized deletion.
- HTTP tests prove auth-first routing, suspended tenant denial and
  no client-selected tenant authority.
- `P9 Conversation State Staging Acceptance` must prove the same paths
  with **real** WorkOS sessions and SQLite Durable Objects on the
  exact implementation head that passed `Verify`.
- The staging suite must clean up the run-scoped conversation through
  the owner-authorized delete route, plus P2 tenant/WorkOS fixtures.

Do not close Issue #52 until AI follow-ups, bounded context/summary, quota,
streaming, failure lifecycle and full live acceptance are proven.
