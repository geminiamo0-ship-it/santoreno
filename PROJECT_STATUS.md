# Santo Project Status — Living Handoff

> **Repository:** `geminiamo0-ship-it/santoreno`
> **Product:** Santo
> **Purpose:** This is the first file a new developer, coding agent, or AI assistant should read before changing the repository.
>
> **Rule:** Update this file whenever meaningful work is completed, a gate passes/fails, architecture changes, or priorities change. GitHub code, issues, PRs, commits, and Actions are the source of truth if any prose becomes stale.

## 1. Current state

Santo is a standalone B2B2C medical AI SaaS platform. Customer sites integrate with Santo by API/widget while Santo centrally owns AI infrastructure, global medical knowledge, AI Search, quota enforcement, citations, assets, usage, security, and tenant administration. Customer production databases remain untouched.

**Phase 0 / Issue #1 is complete.** PR #11 established the pnpm/Turborepo workspace, portal/API/widget/contracts packages, strict tooling, CI, and runtime smoke baseline. Post-merge `Verify` **37155527270** passed.

**Phase 1 / Issue #2 is complete.** PR #15 established the Cloudflare foundation and real staging bindings. PR #15 was squash-merged as `3d519810e0f640261c378f1e6e6601aec68cde5f`; post-merge `Verify` **37195664585** passed.

**Phase 2 / Issue #3 is complete.** PR #17 implemented WorkOS auth, D1 tenants/memberships, minimal authorization, tenant APIs, and strict two-tenant isolation. PR #17 was squash-merged as `a22218f2eba76c6b8f3cf4fbefec46bb3f2676ba`; post-merge `Verify` **37203749651** passed.

**Phase 3 / Issue #4 is complete.** PR #19 final head `a803a045ce8982ec5e907bc8183343356c4f2ccf` passed `Verify` **37210253385 (#132)** and P3 Staging Acceptance **37210250754 (#9)**. PR #19 was squash-merged as `1d9ad9c334f6aff922917db8f7b49943e066e2fe`; post-merge `Verify` **37210341678 (#133)** passed.

**Phase 4 / Issue #5 is complete.** PR #20 final head `de82949c612d7295433153f318c8b140fc48ecf7` passed exact-head `Verify` **37212527419 (#152)** and P4 Staging Acceptance **37212523930 (#4)**. PR #20 was squash-merged to `main` as `54300a908ea139731cfd2e433949b31517bae479`; exact post-merge `Verify` **37212761714 (#153)** passed both `repository-policy` and `code-quality`. Issue #5 is closed as completed.

P4 live acceptance proved real WorkOS-backed MedPark external-user `58392` session exchange, signed 15-minute Santo sessions, token context verification, same-ID cross-tenant isolation, tamper/invalid denial, remote D1 tenant scoping, secret/token non-persistence, and complete fixture cleanup.

**Current active implementation issue:** **#6 — P5 atomic `TenantMeterDO` quota engine.** Start from verified `main` commit `54300a908ea139731cfd2e433949b31517bae479`. Do not start broad AI or full portal work until the quota concurrency/idempotency gate passes.

## 2. Source-of-truth documents

Read in this order before implementation:

1. `PROJECT_STATUS.md`
2. `SANTO_MASTER_PLAN.md`
3. `docs/ENGINEERING_GUARDRAILS.md`
4. `AGENTS.md`
5. `CONTRIBUTING.md`
6. GitHub Issue #8 — roadmap and release gates
7. GitHub Issue #9 — engineering continuity/guardrails
8. The currently active implementation issue

## 3. Active implementation order

Do not reorder these without documenting the reason.

- [x] **#1 — P0:** Bootstrap Santoreno monorepo and CI
- [x] **#2 — P1:** Provision Cloudflare foundation and bindings
- [x] **#3 — P2:** Minimal B2B auth, tenancy, and tenant isolation
- [x] **#4 — P3:** Customer server credentials and domain controls
- [x] **#5 — P4:** `/v1/session/exchange` for external users
- [ ] **#6 — P5:** Atomic `TenantMeterDO` quota engine — current active issue
- [ ] **#7 — Vertical Slice:** Minimal grounded AI endpoint

Umbrella roadmap: **#8**.

Repository administration / branch-protection follow-up: **#10**.

## 4. Hard architecture gates

### Portal gate

Do not build the full customer portal until #6 is proven. Portal work remains limited to the smallest surfaces needed for administration and integration testing.

### Quota gate

With exactly one unit remaining and 100 simultaneous reservation attempts, the required result is:

```text
1 allowed
99 denied
```

No double-spend is acceptable.

Additionally:

- reserve/finalize/release are atomic
- all three are idempotent
- replay cannot double-charge or accidentally refund finalized work
- tenant allowance overrides an oversized user quota
- suspended tenant/user is denied immediately
- tenant state is isolated by the per-tenant Durable Object key

### Grounding gate

The first AI endpoint must prove:

```text
Santo session
→ atomic quota reserve
→ global AI Search
→ grounded context
→ one model call
→ verified citation
→ structured JSON
→ finalize usage
```

No fabricated citations are permitted.

## 5. Stable architecture and verified phase contracts

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
- Workers Analytics Engine for usage telemetry
- Zod contracts
- Vitest/Playwright/integration/security/load testing strategy
- No Supabase dependency in Santo core
- No direct customer production-database access

### Cloudflare binding contract

- `CONTROL_DB` → D1 control plane
- `CONTENT_BUCKET` → R2
- `TENANT_METER` → SQLite Durable Object
- `CONVERSATION` → SQLite Durable Object
- `EVENT_QUEUE` → Queue
- `USAGE_ANALYTICS` → Analytics Engine
- `AI_SEARCH` → AI Search namespace

### P2 identity/tenancy contract

- WorkOS portal tokens are verified server-side.
- WorkOS `org_id` maps to a Santo D1 tenant.
- Owner authorization requires explicit `(tenant_id, workos_user_id)` membership.
- Tenant identity never comes from arbitrary browser input.
- Cross-tenant reads/writes fail closed.

### P3 server-credential contract

- Tenant server secrets use cryptographically secure randomness.
- Plaintext is returned only at create/rotation time.
- D1 stores only safe credential metadata + verification hash.
- Server-secret authentication resolves tenant identity server-side.
- Rotation/revocation invalidate old credentials.
- `last_used_at`, allowed domains, and security audit events are persisted.
- Customer server secrets never enter browser/widget code.

### P4 external-user session contract

- `external_users` is uniquely scoped by `(tenant_id, external_user_id)`.
- `POST /v1/session/exchange` authenticates through the tenant server secret.
- Santo sessions are signed server-side and short-lived.
- Claims: `iss=Santo`, `aud=santo-ai`, `tenant`, `sub`, `session_id`, `jti`, `iat`, `exp`.
- Lifetime is configurable from 600–1200 seconds; verified staging lifetime is 900 seconds.
- Session verification rechecks signature, claims, expiry, tenant state, and user state.
- Same external ID in different tenants creates independent Santo users.
- Signing keys, server secrets, and session tokens are not persisted in D1 or committed.

### P5 quota architecture target

- One SQLite-backed `TenantMeterDO` is keyed per tenant initially, e.g. `TenantMeterDO("medpark")`.
- The DO owns authoritative hot tenant + per-user quota state for that tenant.
- AI generation/search does not run inside the DO; the DO only performs quota/state operations.
- Required state includes tenant allowance/status, user quota/status, usage cycles, reservations, and idempotency.
- `reserve` occurs before expensive AI work; `finalize` after successful charged work; `release` only for defined hard-failure cases.
- DO state transitions must be deterministic and independently testable.
- Do not introduce per-user DOs or sharding unless measured load tests justify a later architecture change.

## 6. Core architecture rules

- Tenant identity comes from authenticated context, never arbitrary browser input.
- Every external-user lookup is scoped by `tenant_id + external_user_id`.
- Quota is server-side, atomic, and idempotent.
- Customer server secrets never enter browser bundles.
- Browser code never receives Cloudflare, R2, AI Search, model-provider, signing-key, or customer server credentials.
- No tenant-specific business forks.
- AI output is structured, not arbitrary model-generated HTML.
- Citations must resolve to retrieved source IDs.
- Schema changes are migration-only.
- SQL belongs in repository/data-access boundaries, not HTTP handlers.
- There must be only one authoritative quota implementation: `TenantMeterDO`.

## 7. Completion/update protocol

Whenever work is completed:

1. Update the active GitHub issue checklist.
2. Add concise issue evidence with commit/PR/run IDs.
3. Keep the issue open until acceptance, merge, and required post-merge gates pass.
4. Update Issue #8 only when roadmap status/sequencing changes.
5. Update this file when meaningful work/gate state changes.
6. Add an ADR only for a material architecture decision.
7. Never claim completion because code merely exists.
8. Every meaningful code/infrastructure step must pass GitHub Actions `Verify`.
9. CI failure blocks progression; fix the actual failure rather than bypassing it.

## 8. Last completed work

- P0 #1: merged via PR #11; post-merge `Verify` **37155527270** green.
- P1 #2: Cloudflare staging foundation accepted; PR #15 merged as `3d519810e0f640261c378f1e6e6601aec68cde5f`; post-merge `Verify` **37195664585** green.
- P2 #3: WorkOS auth/tenancy/isolation accepted live; PR #17 merged as `a22218f2eba76c6b8f3cf4fbefec46bb3f2676ba`; post-merge `Verify` **37203749651** green.
- P3 #4: server credentials/domain controls accepted live; PR #19 merged as `1d9ad9c334f6aff922917db8f7b49943e066e2fe`; post-merge `Verify` **37210341678 (#133)** green.
- P4 #5: final PR #20 head `de82949c612d7295433153f318c8b140fc48ecf7` passed `Verify` **37212527419 (#152)** and P4 Staging Acceptance **37212523930 (#4)**.
- PR #20 was squash-merged as `54300a908ea139731cfd2e433949b31517bae479`; post-merge `Verify` **37212761714 (#153)** passed completely.
- Issue #5 is closed as completed; Issue #8 marks #5 complete and #6 active.
- Issue #6 contains the hard 100-way race gate and is the only active implementation phase.

## 9. Next action

Continue **Issue #6 — P5 atomic `TenantMeterDO` quota engine** from the verified P4 baseline.

Implement in the smallest coherent dependency order:

1. Inspect the existing `TenantMeterDO` smoke placeholder and runtime conventions.
2. Define a compact SQLite schema for tenant quota state, per-user quota state, usage cycles, reservations, and idempotency.
3. Define shared Zod contracts for quota sync/read/reserve/finalize/release operations and typed denial reasons.
4. Implement DO-internal state transitions first, without AI/search/portal logic.
5. Add deterministic unit/integration tests for allowance math, suspension, expiry/reset, reserve/finalize/release, and replay/idempotency.
6. Add the mandatory 100-way race test: one remaining unit must yield exactly 1 allowed / 99 denied.
7. Expose only the minimal authenticated API surface needed for acceptance/testing.
8. Run `Verify`; then build repeatable real staging acceptance against the deployed SQLite Durable Object.
9. Only after #6 acceptance, merge, and post-merge Verify may #7 begin.

Do not build full quota management UI, billing, analytics dashboards, AI generation, or broad widget work in this phase.

## 10. Verification policy

`.github/workflows/verify.yml` remains the mandatory repository gate: frozen install, lint/format, typecheck, tests, build, smoke, and repository policy.

P5 must additionally prove the concurrency/idempotency gate against the authoritative `TenantMeterDO` implementation. A phase is not complete until required acceptance, merge, and post-merge evidence is recorded.

Branch protection/ruleset configuration remains an authorized-admin follow-up under Issue #10 because the connected GitHub integration cannot write that repository setting.
