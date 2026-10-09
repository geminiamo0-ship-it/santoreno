# AGENTS.md — Santo Coding Agent Instructions

This repository is the source of truth for Santo.

Any coding agent, AI assistant, or new developer must read the following before making changes:

1. `PROJECT_STATUS.md`
2. `SANTO_MASTER_PLAN.md`
3. `docs/ENGINEERING_GUARDRAILS.md`
4. GitHub Issue #8 (roadmap)
5. The active issue being implemented

## Current priority

The proven foundation through Issue #36 / Phase 7 is complete, including verified `/v1/session/exchange`, atomic `TenantMeterDO` quota, filtered global AI Search, and citation-validated, buffered SSE AI responses.

**Active implementation issue: #43 — Phase 8 trusted sources, citation details, and R2 images.**

Read Issue #8 and Issue #43, plus `PROJECT_STATUS.md`, before new code. Do not repeat completed Phase 7 work. Continue in roadmap order; ConversationDO, full widget, and full tenant portal remain deferred.

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
