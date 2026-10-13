# AGENTS.md — Santo Coding Agent Instructions

This repository is the source of truth for Santo.

Any coding agent, AI assistant, or new developer must read the following before making changes:

1. `PROJECT_STATUS.md`
2. `SANTO_MASTER_PLAN.md`
3. `docs/ENGINEERING_GUARDRAILS.md`
4. GitHub Issue #8 (roadmap)
5. The active issue being implemented

## Current priority

The fully verified foundation now includes **Phase 9 / Issue #52**:
authenticated SQLite ConversationDO state, strict tenant/user boundaries,
ordered conversations and multi-turn AI follow-ups, validated citations
and R2 source/image delivery, quota-safe idempotent replays, buffered SSE,
persisted bounded verified context, and expiry-aware lease recovery.
Phase 9's final PR #57 passed exact-head `Verify 38445457126` and real
`P9 Summary & Lease Staging 38445450546` on the same SHA, merged as
`17e032e3935cad4f6ec290ee770e3baaf09f6540` with post-merge
`Verify 38446592614` success.

**Active implementation issue: #58 — Phase 10 Santo embeddable Lit Widget.**

Read Issue #8, Issue #58, the completed Issue #52, `PROJECT_STATUS.md`
and the master plan before code. Do not repeat the completed AI, quota,
conversation or source-work. Reuse those through authenticated APIs only.
The full tenant portal and framework compatibility sign-off are deferred
to Phase 12 and Phase 11 respectively.

## Mandatory behavior after every meaningful change

- Update the active GitHub issue checklist.
- Add an issue comment with implementation/test evidence.
- Update `PROJECT_STATUS.md` when progress/state changes.
- Update Issue #8 if roadmap sequencing/status changes.
- Add an ADR for major architecture decisions.
- Close issues only after acceptance criteria and required tests pass.

## Hard architecture rules

- No direct access to customer production databases.
- No Supabase dependency in Santo core.
- No tenant-specific forks or hard-coded MedPark/Royal behavior.
- Tenant identity comes from authenticated context.
- External users are always scoped by `tenant_id + external_user_id`.
- Customer server secrets never reach browser code.
- Quota is server-side, atomic, and idempotent.
- Portal/widget must not directly access D1/DO/R2/AI Search.
- AI output is structured, not arbitrary HTML.
- Citations must be verified against retrieved source IDs.
- Do not claim work is complete without tests/evidence.

## Implementation style

Prefer:

```text
Route
→ Validation/Auth
→ Use Case / Service
→ Domain logic
→ Repository / DO / External adapter
```

Avoid giant route handlers or giant AI service functions combining every responsibility.

## If context is missing

Do not guess prior progress.

Read `PROJECT_STATUS.md`, inspect the relevant GitHub issues/commits, and continue from the recorded state.

## Definition of clean continuation

A different AI or developer should be able to open this repository, read the files above, inspect the active issue, and continue without requiring hidden conversation context.
