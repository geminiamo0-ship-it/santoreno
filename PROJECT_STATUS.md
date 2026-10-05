# Santo Project Status — Living Handoff

> **Repository:** `geminiamo0-ship-it/santoreno`
> **Product:** Santo
> **Purpose:** First file a new developer, coding agent, or AI assistant should read before changing the repository.
>
> **Rule:** GitHub code, issues, PRs, commits, and Actions are the source of truth. Update this file whenever meaningful work completes, a gate passes/fails, architecture changes, or the active issue changes.

## 1. Current state

Santo is a standalone B2B2C medical AI SaaS platform. Customer sites integrate with Santo by API/widget while Santo centrally owns AI infrastructure, global medical knowledge, AI Search, quota enforcement, citations, assets, usage, security, and tenant administration. Customer production databases remain untouched.

Completed foundation:

- **P0 / #1 complete** — monorepo, strict tooling, CI, portal/API/widget/contracts baseline.
- **P1 / #2 complete** — Cloudflare staging foundation and real bindings.
- **P2 / #3 complete** — WorkOS auth, D1 tenants/memberships, tenant isolation.
- **P3 / #4 complete** — tenant server credentials, rotation/revocation, domain controls.
- **P4 / #5 complete** — `/v1/session/exchange`, tenant-scoped external users, short-lived Santo session tokens.
- **P5 / #6 complete** — authoritative SQLite `TenantMeterDO`, atomic reserve/finalize/release, idempotency, live concurrency acceptance.

### Latest completed phase — P5 / Issue #6

PR #22 final pre-merge head `cd947538c1fefabe2abfb04acd2f26e07cf1a549` passed:

- exact-head `Verify` **37215999005 (#173)**
- exact-head `P5 Staging Acceptance` **37215996145 (#9)**

Live Cloudflare acceptance proved exactly **1 allowed / 99 denied** from 100 simultaneous reservations with one unit remaining, plus reserve/finalize idempotency, deterministic release, tenant-cap precedence, tenant/user suspension, quota expiry, tenant isolation, and usage-cycle rollover.

PR #22 was squash-merged to `main` as `02994f482918364a8351bf947d50064f6fb34313`. Exact post-merge `main` `Verify` **37216156725 (#174)** passed. Issue #6 is closed as completed.

### Current active phase — P6 / Issue #7

**#7 — Vertical Slice: Add one minimal grounded AI endpoint.**

PR #25 clean implementation head `fae800b04acf0a871310af086b11d496c87f8742` passed:

- exact-head `Verify` **37297555868 (#246)**
- exact-head `P6 Staging Acceptance` **37297549764 (#23)**

The live staging gate proved the complete first grounded path using real platform services:

```text
real WorkOS-backed MedPark tenant
→ real Santo external-user session
→ atomic TenantMeterDO reserve
→ run-isolated Cloudflare AI Search fixture indexed + retrieved
→ one real Workers AI model call
→ server-validated citation to actually retrieved evidence
→ structured response
→ finalize exactly one quota unit
```

It also proved that an identical idempotent retry did not double-charge, a new request after the single user unit was consumed was denied for exhausted quota, and AI Search/D1/WorkOS staging fixtures were cleaned successfully.

The last live-gate blocker was a test-harness fixture-ID mismatch, not a grounding/runtime bypass: the REST harness created a dynamic run-isolated AI Search instance while the protected Worker setup path still searched for an old fixed ID. The clean fix passes the run-isolated fixture ID into the protected non-production setup endpoint and validates the expected P6 ID pattern. No temporary workflow remains in the clean candidate head.

**P6 is not complete yet.** This documentation update changes the branch head, so the resulting final pre-merge head must pass both `Verify` and `P6 Staging Acceptance` again. Only then may PR #25 become ready and merge. Issue #7 remains open until the exact merge commit also passes post-merge Verify.

Required milestone path:

```text
Santo session
→ atomic quota reserve
→ global AI Search
→ grounded context
→ one model call
→ verified citations
→ structured JSON
→ finalize usage
```

On defined non-chargeable hard failures after reservation, release exactly once. Do not fabricate citations or return an ungrounded medical answer when evidence is missing.

## 2. Read order before implementation

1. `PROJECT_STATUS.md`
2. `SANTO_MASTER_PLAN.md`
3. `docs/ENGINEERING_GUARDRAILS.md`
4. `AGENTS.md`
5. `CONTRIBUTING.md`
6. Issue #8 — umbrella roadmap and release gates
7. Issue #9 — engineering continuity/guardrails
8. **Issue #7 — current active implementation issue**

## 3. Active implementation order

- [x] **#1 — P0:** Bootstrap Santoreno monorepo and CI
- [x] **#2 — P1:** Provision Cloudflare foundation and bindings
- [x] **#3 — P2:** Minimal B2B auth, tenancy, and tenant isolation
- [x] **#4 — P3:** Customer server credentials and domain controls
- [x] **#5 — P4:** `/v1/session/exchange` for external users
- [x] **#6 — P5:** Atomic `TenantMeterDO` quota engine
- [ ] **#7 — Vertical Slice:** Minimal grounded AI endpoint — **CURRENT ACTIVE ISSUE; PRE-MERGE LIVE ACCEPTANCE PASSED**

Umbrella roadmap: **#8**.

Repository administration / branch-protection follow-up: **#10**.

## 4. Proven architecture gates

### Identity gate — passed

- Tenant identity comes from authenticated context.
- Customer server secrets are server-side only and can be rotated/revoked.
- External-user sessions are short-lived and tenant-scoped.
- Same external ID in different tenants remains isolated.
- Invalid/tampered/expired sessions fail closed.

### Quota gate — passed

Required race:

```text
1 remaining unit
100 simultaneous reserve attempts
→ 1 allowed
→ 99 denied
```

Verified live repeatedly on Cloudflare SQLite Durable Objects.

Also proven:

- reserve replay does not double-reserve
- finalize replay does not double-charge
- conflicting idempotency reuse is denied
- release restores capacity exactly once
- finalized usage cannot be replay-refunded
- tenant allowance overrides oversized user quota
- tenant/user suspension denies immediately
- expired quota is denied
- tenant state is isolated by Durable Object key
- expired usage cycles advance/reset deterministically

### Grounding gate — pre-merge acceptance passed; merge gate pending

Exact clean implementation head `fae800b04acf0a871310af086b11d496c87f8742` passed the live P6 gate and proved:

- valid Santo session accepted
- invalid/expired session denied before search/model work
- quota reserved before expensive work
- exhausted quota denied before search/model work
- Santo global AI Search evidence retrieved
- answer generated from bounded retrieved evidence
- every returned citation validated against actually retrieved source IDs
- no-evidence/search-failure and invented-citation paths fail closed in deterministic tests
- successful request finalizes exactly one charge
- identical retried request cannot double-charge when idempotency is reused
- defined non-chargeable hard failures release deterministically
- real Workers AI call succeeds behind the model adapter boundary

The grounding gate becomes fully complete only after the final docs head repeats both gates, PR #25 merges, and the exact merge commit passes post-merge Verify.

## 5. Stable architecture contracts

### Platform

- TypeScript + pnpm + Turborepo
- React Router/Vite portal
- Hono Cloudflare Worker API
- Lit Web Component widget
- WorkOS AuthKit for portal B2B auth
- Cloudflare D1 control plane
- SQLite Durable Objects for hot strongly-consistent state
- R2 for content/assets
- Cloudflare AI Search for retrieval
- Cloudflare Queues for async events
- Workers Analytics Engine for telemetry
- Zod contracts
- Vitest/Playwright/integration/security/load testing strategy
- no Supabase dependency in Santo core
- no direct customer production-database access

### Binding contract

- `CONTROL_DB` → D1
- `CONTENT_BUCKET` → R2
- `TENANT_METER` → SQLite Durable Object
- `CONVERSATION` → SQLite Durable Object
- `EVENT_QUEUE` → Queue
- `USAGE_ANALYTICS` → Analytics Engine
- `AI_SEARCH` → AI Search namespace
- `AI` → Workers AI model binding

### P2 identity/tenancy

- WorkOS portal tokens verified server-side.
- WorkOS `org_id` maps to a Santo D1 tenant.
- Owner authorization requires explicit `(tenant_id, workos_user_id)` membership.
- Tenant identity never comes from arbitrary browser input.
- Cross-tenant reads/writes fail closed.

### P3 server credentials

- Secrets use cryptographically secure randomness.
- Plaintext is returned only at create/rotation time.
- D1 stores verification-safe data, not recoverable plaintext secrets.
- Rotation/revocation invalidate old credentials.
- `last_used_at`, allowed domains, and audit events persist.
- Customer server secrets never enter browser/widget code.

### P4 session exchange

- External users are uniquely scoped by `(tenant_id, external_user_id)`.
- `POST /v1/session/exchange` authenticates with the tenant server secret.
- Santo sessions are signed, short-lived, and tenant-scoped.
- Claims include `iss=Santo`, `aud=santo-ai`, `tenant`, `sub`, `session_id`, `jti`, `iat`, `exp`.
- Verified staging lifetime is 900 seconds.
- Verification rechecks signature, claims, expiry, tenant state, and user state.
- Signing keys, server secrets, and session tokens are not persisted in D1 or committed.

### P5 quota

- `TenantMeterDO` is the single authoritative hot-path quota implementation.
- One SQLite Durable Object is keyed per authenticated tenant.
- State includes `tenant_state`, `user_quota`, `usage_cycles`, and `reservations`.
- `reserve`, `finalize`, and `release` run inside synchronous Durable Object storage transactions.
- Reservation/idempotency records prevent double reserve/charge/refund.
- Tenant allowance is checked before user allowance.
- Expired cycles roll forward/reset deterministically.
- `DurableObjectQuotaService` is the narrow caller boundary for AI routes.
- AI Search/model generation never runs inside the quota Durable Object.
- Do not add per-user DOs or sharding without measured evidence.

### P6 grounded AI candidate

- `POST /v1/ai/query` is authenticated by the Santo end-user session, not tenant/user IDs from request input.
- The route delegates to a grounded AI service instead of combining auth, quota, retrieval, model, citation, and response logic inline.
- Quota reservation happens before retrieval/model work.
- Retrieval is behind a Cloudflare AI Search adapter and returns a bounded normalized evidence set.
- Prompt/context construction, retrieval, model invocation, citation validation, quota orchestration, and response shaping remain separate responsibilities.
- One configured Workers AI model adapter is used for this milestone.
- Model output is structured and untrusted; citation IDs are validated server-side against the retrieved evidence set.
- Missing evidence, search failure, invalid model output, and invented citations do not produce a sourced medical answer.
- Successful completion finalizes quota; defined non-chargeable hard failures release the reservation.
- Idempotency derives a deterministic quota key so an identical retry cannot double-charge.
- Minimal safe telemetry uses Analytics Engine without secrets, tokens, or unnecessary medical content.
- P6 staging acceptance uses a temporary run-isolated AI Search fixture and cleans it after the gate.

## 6. Core rules that must not drift

- Tenant identity always comes from authenticated context.
- External-user access is always scoped by `tenant_id + external_user_id`.
- Quota is server-side, atomic, and idempotent.
- Browser code never receives customer server secrets, Cloudflare credentials, model-provider secrets, signing keys, R2 credentials, or AI Search credentials.
- No tenant-specific business forks.
- AI output is structured JSON, not arbitrary model-generated HTML.
- Citation IDs must be validated server-side against retrieved source IDs.
- No fabricated citations.
- SQL belongs in repository/data-access or Durable Object state boundaries, not HTTP handlers.
- D1 schema changes are migration-only.
- Keep one authoritative quota implementation: `TenantMeterDO`.
- Do not expand into streaming, ConversationDO, images, full widget, broad model routing, or full portal until #7 is merged, post-merge verified, and closed.

## 7. Verification and update protocol

For every meaningful step:

1. Make the smallest clean implementation.
2. Add/update tests.
3. Run GitHub Actions `Verify`.
4. Fix any CI failure before continuing; never bypass the gate.
5. Prove the issue acceptance criteria with live acceptance where required.
6. Update the active issue checklist and add exact commit/PR/run evidence.
7. Update this handoff when meaningful state changes.
8. Update Issue #8 only when roadmap/sequencing changes.
9. Keep the issue open until implementation, acceptance, merge, and required post-merge verification all pass.
10. Add an ADR only for a material architecture decision.

## 8. Completion history

- P0 / #1 — PR #11; post-merge `Verify` **37155527270** green.
- P1 / #2 — PR #15 merged as `3d519810e0f640261c378f1e6e6601aec68cde5f`; post-merge `Verify` **37195664585** green.
- P2 / #3 — PR #17 merged as `a22218f2eba76c6b8f3cf4fbefec46bb3f2676ba`; post-merge `Verify` **37203749651** green.
- P3 / #4 — PR #19 merged as `1d9ad9c334f6aff922917db8f7b49943e066e2fe`; post-merge `Verify` **37210341678 (#133)** green.
- P4 / #5 — PR #20 merged as `54300a908ea139731cfd2e433949b31517bae479`; post-merge `Verify` **37212761714 (#153)** green. Final handoff PR #21 merged as `778939780a80d3b36a3b48e380192a25d0f39b94`; `Verify` **37213063804 (#155)** green.
- P5 / #6 — PR #22 final head `cd947538c1fefabe2abfb04acd2f26e07cf1a549`; `Verify` **37215999005 (#173)** green; P5 Staging Acceptance **37215996145 (#9)** green; squash-merged as `02994f482918364a8351bf947d50064f6fb34313`; post-merge `Verify` **37216156725 (#174)** green.
- P6 / #7 — active PR #25. Clean implementation head `fae800b04acf0a871310af086b11d496c87f8742`; `Verify` **37297555868 (#246)** green; P6 Staging Acceptance **37297549764 (#23)** green. Final docs-head gates and merge/post-merge verification remain pending.

## 9. Next action

Continue **Issue #7 only**.

This file is the final pre-merge documentation change for the current candidate. The next required sequence is:

1. Let GitHub Actions run `Verify` on the new branch head created by this documentation commit.
2. Require `P6 Staging Acceptance` to run against that exact same head and pass the full real WorkOS → Santo session → quota → AI Search → Workers AI → validated citation → idempotent usage path plus cleanup.
3. If either gate fails, fix the actual failure before continuing and repeat both gates on the resulting clean head.
4. Once both are green on the same final head, record their exact run IDs in Issue #7 / PR #25, mark PR #25 ready, and squash merge.
5. Require `Verify` on the exact merge commit on `main`.
6. Only after that post-merge Verify passes: close Issue #7, mark #7 complete in Issue #8, and document that Master Plan §123 first technical milestone is proven.

Do not start deferred streaming, ConversationDO, images/source drawer, full widget, broad model routing, or full tenant portal work before that sequence is complete.

## 10. Repository administration note

Branch protection/ruleset configuration remains an authorized-admin follow-up under Issue #10 because the connected GitHub integration cannot write that repository setting.
