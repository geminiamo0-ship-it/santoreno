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

The last three **completed** server-verified turns are converted into
a bounded 1,600-character history string. Current prompts keep no more than
4,000 characters overall; historical content is explicitly labeled
untrusted, never used as citation authority. A full durable summary and
large-conversation compaction policy remain part of Issue #52.

On a confirmed charge-free failure, the turn is marked `retryable` and the
Durable Object advances its billing epoch. This permits a new reservation
without reusing a previously released quota key. If finalization is
uncertain or generation succeeded but the conversation commit failed,
the epoch stays unchanged; retries reuse the same billing key to prevent
double charging. A previously finalized generation retry failure has its
own `CHARGED_GENERATION_RETRY_FAILED` error and also preserves its epoch.
Leases last 180 seconds and can be reclaimed when expired.

Deletion removes conversation-owned metadata, pending/completed turns,
and user-message rows atomically. R2 snapshots remain governed by the
existing 30-day logical retention and production lifecycle cleanup policy.

## Not implemented yet

The first #54 state slice did not generate answers. The next #56 slice
adds server-verified turn persistence, follow-up retrieval and buffered
stream coordination; durable context summarization and complete failure
recovery still require Phase 9 acceptance. These are further requirements of Issue #52. It does
not claim that Phase 9 is complete or that the full widget is ready.

The existing Phase 7/8 AI and source authorization paths remain unchanged.
Future assistant turn persistence must be coupled to the authoritative
`TenantMeterDO` finalization and must not trust model-authored citations.

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
