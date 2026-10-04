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

**Phase 4 / Issue #5 is complete.** PR #20 final head `de82949c612d7295433153f318c8b140fc48ecf7` passed exact-head `Verify` **37212527419 (#152)** and P4 Staging Acceptance **37212523930 (#4)**. PR #20 was squash-merged as `54300a908ea139731cfd2e433949b31517bae479`; exact post-merge `Verify` **37212761714 (#153)** passed. Final P4 handoff PR #21 was merged as `778939780a80d3b36a3b48e380192a25d0f39b94`; post-merge `Verify` **37213063804 (#155)** passed.

**Phase 5 / Issue #6 implementation and live acceptance are green on PR #22, but the phase is not closed yet.** Latest accepted implementation head `517f002940018996477e61ef7896e5d230f0b22f` passed exact-head `Verify` **37215785645 (#172)** and exact-head `P5 Staging Acceptance` **37215781824 (#8)**. The live Cloudflare gate again proved exactly **1 allowed / 99 denied** from 100 simultaneous reservations with one unit remaining, plus idempotency, release/finalize terminal behavior, tenant-cap precedence, suspension/expiry denial, tenant isolation, and quota-cycle rollover.

During finalization, CI also exposed and fixed two verification-quality issues without weakening runtime semantics: the P4 tampered-token regression now mutates a byte-significant Base64URL signature character deterministically, and the P5 staging infrastructure smoke uses a bounded deployment-propagation retry while still requiring HTTP 200, `status=ok`, and `TenantMeterDO=ok`. Both fixes are included in the accepted head above.

**Current gate:** this handoff update changes PR #22's head once more. Require `Verify` and `P5 Staging Acceptance` green on the resulting exact documentation head. Only then mark PR #22 ready, squash-merge it, and require exact post-merge `main` `Verify`. Issue #6 stays open and #7 must not start until those gates pass.

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
- [ ] **#6 — P5:** Atomic `TenantMeterDO` quota engine — live gate green; merge/post-merge gate pending
- [ ] **#7 — Vertical Slice:** Minimal grounded AI endpoint

Umbrella roadmap: **#8**.

Repository administration / branch-protection follow-up: **#10**.

## 4. Hard architecture gates

### Portal gate

Do not build the full customer portal until #6 is merged and post-merge verified. Portal work remains limited to the smallest surfaces needed for administration and integration testing.

### Quota gate

Required result with exactly one unit remaining and 100 simultaneous reservation attempts:

```text
1 allowed
99 denied
```

**Verified live repeatedly on P5, including accepted head `517f002...`: exactly `1 allowed / 99 denied`.**

Also verified live:

- reserve replay does not double-reserve
- finalize replay does not double-charge
- conflicting reuse of an idempotency key is denied
- release restores reserved capacity exactly once
- finalized usage cannot be replay-refunded
- tenant allowance overrides oversized per-user allowance
- tenant/user suspension is enforced immediately
- expired user quota is denied
- quota state is isolated by tenant Durable Object key
- expired usage-cycle boundaries advance/reset deterministically

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
- Tampered-token tests mutate a byte-significant signature character rather than a trailing Base64URL character whose unused padding bits could decode to unchanged signature bytes.

### P5 quota implementation on PR #22

- `TenantMeterDO` is the only authoritative hot-path quota implementation.
- One SQLite-backed Durable Object is keyed per authenticated tenant.
- DO SQLite state is split into `tenant_state`, `user_quota`, `usage_cycles`, and `reservations`.
- Tenant state holds monthly allowance, status, used/reserved counts, and cycle boundaries.
- User state holds base quota, bonus quota, status, expiry, and used/reserved counts.
- `reserve`, `finalize`, and `release` execute inside synchronous Durable Object storage transactions.
- Reservation/idempotency keys persist the state transition result and prevent double reservation/charge/refund.
- Denied reservations preserve deterministic denial reasons for replay.
- Tenant allowance is checked before user allowance.
- Expired cycles roll forward and reset current counters deterministically.
- `DurableObjectQuotaService` is the narrow caller boundary; future AI/routes must not know SQL/DO internals.
- Runtime smoke exercises real SQLite DO configure → reserve → replay → finalize → finalized-release denial.
- P5 staging acceptance is protected, non-production-only, and exercises the deployed Cloudflare Durable Object directly.
- Staging smoke tolerates only a bounded Cloudflare deployment-propagation window; it still fails unless the authenticated smoke endpoint converges to HTTP 200, `status=ok`, and `TenantMeterDO=ok`.
- AI generation/search does not execute inside `TenantMeterDO`.
- Do not introduce per-user DOs or sharding unless measured load tests later justify it.

## 6. Core architecture rules

- Tenant identity comes from authenticated context, never arbitrary browser input.
- Every external-user lookup is scoped by `tenant_id + external_user_id`.
- Quota is server-side, atomic, and idempotent.
- Customer server secrets never enter browser bundles.
- Browser code never receives Cloudflare, R2, AI Search, model-provider, signing-key, or customer server credentials.
- No tenant-specific business forks.
- AI output is structured, not arbitrary model-generated HTML.
- Citations must resolve to retrieved source IDs.
- Schema changes are migration-only where D1 is concerned; DO-local SQLite schema belongs to the DO implementation.
- SQL belongs in repository/data-access or Durable Object state boundaries, not HTTP handlers.
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
- P4 #5: PR #20 merged as `54300a908ea139731cfd2e433949b31517bae479`; post-merge `Verify` **37212761714 (#153)** green. Final handoff PR #21 merged as `778939780a80d3b36a3b48e380192a25d0f39b94`; post-merge `Verify` **37213063804 (#155)** green.
- P5 branch `feat/issue-6-atomic-quota` was created from verified `main` `778939780a80d3b36a3b48e380192a25d0f39b94`.
- P5 implemented strict shared quota contracts, authoritative SQLite `TenantMeterDO`, transactional reserve/finalize/release, idempotency, cycle/reset logic, tenant/user suspension and expiry, and a narrow quota service boundary.
- Initial clean P5 candidate `011b777a1f3840c3e32b9c80b51609ebe7097ce7` passed `Verify` **37214781630 (#167)** and P5 Staging Acceptance **37214779313 (#3)**.
- Finalization exposed a flaky P4 tampered-session regression caused by mutating the last Base64URL character; the test now changes a byte-significant signature character deterministically.
- Finalization also exposed a staging-deployment propagation race where unauthenticated `/health` could reach the new Worker version before the new ephemeral smoke token converged globally. P5 smoke now retries for a bounded window while preserving the full strict assertion.
- Latest accepted P5 implementation head `517f002940018996477e61ef7896e5d230f0b22f` passed exact-head `Verify` **37215785645 (#172)** and exact-head P5 Staging Acceptance **37215781824 (#8)**.
- The latest live P5 run again proved the real `TENANT_METER` gate, including exactly `1 allowed / 99 denied` and all idempotency/isolation/suspension/cycle assertions.
- Temporary P5 formatter workflows were deleted before accepted clean heads; no temporary formatter workflow is part of the intended final tree.
- Issue #6 checklist and pre-merge evidence are updated; the issue intentionally remains open until merge + post-merge `main` verification.

## 9. Next action

Do **not** start #7 yet.

Because this handoff commit changes PR #22's head, require on this exact resulting head:

1. `Verify` — repository-policy, lint, typecheck, tests, build, smoke all green.
2. `P5 Staging Acceptance` — real Cloudflare quota gate green again, including exactly `1 allowed / 99 denied`.

If both pass:

1. Mark PR #22 ready for review.
2. Squash-merge PR #22 using the repository convention.
3. Require `Verify` green on the exact resulting `main` merge commit.
4. Close Issue #6 as completed with exact evidence.
5. Update Issue #8 to mark #6 complete and #7 active.
6. Update the living handoff to activate #7.
7. Only then begin the minimal grounded AI vertical slice.

Do not build full quota management UI, billing, analytics dashboards, broad portal work, or broad AI product features before this gate closes.

## 10. Verification policy

`.github/workflows/verify.yml` remains the mandatory repository gate: frozen install, lint/format, typecheck, tests, build, smoke, and repository policy.

P5 additionally requires `.github/workflows/p5-staging-acceptance.yml` on the exact candidate head before merge. It deploys the staging Worker with masked ephemeral test secrets and proves the real `TENANT_METER` SQLite Durable Object race/idempotency/isolation gates. The authenticated infrastructure smoke is propagation-safe but remains fail-closed if the strict assertions do not converge within the bounded retry window.

A phase is not complete until required acceptance, merge, and post-merge evidence is recorded.

Branch protection/ruleset configuration remains an authorized-admin follow-up under Issue #10 because the connected GitHub integration cannot write that repository setting.
