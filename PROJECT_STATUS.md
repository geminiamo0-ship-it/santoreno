# Santo Project Status — Living Handoff

> **Repository:** `geminiamo0-ship-it/santoreno`
> **Product:** Santo
> **Purpose:** This is the first file a new developer, coding agent, or AI assistant should read before changing the repository.
>
> **Rule:** Update this file whenever meaningful work is completed, a gate passes/fails, architecture changes, or priorities change. GitHub code, issues, PRs, commits, and Actions are the source of truth if any prose becomes stale.

## 1. Current state

Santo is a standalone B2B2C medical AI SaaS platform. Customer sites integrate with Santo by API/widget while Santo centrally owns AI infrastructure, global medical knowledge, AI Search, quota enforcement, citations, assets, usage, security, and tenant administration. Customer production databases remain untouched.

**Phase 0 / Issue #1 is complete.** PR #11 established the pnpm/Turborepo workspace, portal/API/widget/contracts packages, strict tooling, CI, and runtime smoke baseline. Post-merge `Verify` run **37155527270** passed.

**Phase 1 / Issue #2 is complete.** PR #15 established the Cloudflare foundation and real staging bindings. Remote staging acceptance passed on commit `ae2d85c5a9f3658c23d1e3c82b3bda92c0d0defe` in run **37195022577**. PR #15 was squash-merged as `3d519810e0f640261c378f1e6e6601aec68cde5f`; post-merge `Verify` **37195664585** passed.

**Phase 2 / Issue #3 is complete.** PR #17 implemented WorkOS RS256/JWKS verification, D1 tenants/memberships, minimal `super_admin`/`owner` authorization, tenant create/context/read/update APIs, and two-tenant fail-closed isolation. Final clean head `128a64ef4ea39c8fe947bd7d283ecb3c9af9442a` passed `Verify` **37203640840** and P2 staging acceptance **37203637755**. PR #17 was squash-merged as `a22218f2eba76c6b8f3cf4fbefec46bb3f2676ba`; post-merge `Verify` **37203749651** passed.

**Phase 3 / Issue #4 is complete.** Final PR #19 head `a803a045ce8982ec5e907bc8183343356c4f2ccf` passed exact-head `Verify` **37210253385 (#132)** and P3 Staging Acceptance **37210250754 (#9)**. PR #19 was squash-merged as `1d9ad9c334f6aff922917db8f7b49943e066e2fe`; post-merge `Verify` **37210341678 (#133)** passed. Issue #4 is closed.

**Phase 4 / Issue #5 implementation and live acceptance are green on PR #20, but the phase is not closed yet.** Clean head `32b2f7d334c0847eb2af44a026be9f2cb2a967f1` passed exact-head `Verify` **37212333641 (#151)** and exact-head `P4 Staging Acceptance` **37212330737 (#3)**. The live gate proved MedPark external-user session exchange, same-ID cross-tenant isolation, signed 15-minute Santo sessions, token verification, tamper denial, remote D1 tenant scoping, and full fixture cleanup.

**Current gate:** this status update changes PR #20's head. Require `Verify` and `P4 Staging Acceptance` green again on the new exact head. Then PR #20 may be marked ready and squash-merged. After merge, the exact `main` merge commit must pass `Verify`. Only then close #5, update #8, and activate #6.

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
- [ ] **#5 — P4:** `/v1/session/exchange` — acceptance green; merge/post-merge gate pending
- [ ] **#6 — P5:** Atomic `TenantMeterDO` quota engine
- [ ] **#7 — Vertical Slice:** Minimal grounded AI endpoint

Umbrella roadmap: **#8**.

Repository administration / branch-protection follow-up: **#10**.

## 4. Hard architecture gates

### Portal gate

Do not build the full customer portal before #5 and #6 are proven. Before then, portal work is limited to the smallest surfaces required for admin authentication, tenant context, and credential/session testing.

### Quota gate

With exactly one unit remaining and 100 simultaneous reservation attempts, the required result is:

```text
1 allowed
99 denied
```

No double-spend is acceptable.

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
- `super_admin` bootstrap is server-side only.
- Tenant identity never comes from arbitrary browser input.
- Cross-tenant reads/writes fail closed.

### P3 server-credential contract

- Tenant server secrets use cryptographically secure randomness.
- Plaintext is returned only at create/rotation time.
- D1 stores identification metadata and a verification hash, never recoverable plaintext.
- Server-secret authentication resolves tenant identity server-side.
- Rotation/revocation invalidate old credentials.
- `last_used_at`, allowed domains, and security audit events are persisted.
- Customer server secrets never enter browser/widget code.

### P4 external-user session contract on PR #20

- Migration `0004_external_users.sql` stores external users with unique `(tenant_id, external_user_id)` scope.
- `POST /v1/session/exchange` authenticates through the P3 customer server credential.
- Required input is `external_user_id`; email/display name are optional.
- Exchange never touches the customer's database.
- Scoped users are upserted through an explicit repository boundary.
- Santo sessions are signed server-side with HMAC-SHA256 using `SANTO_SESSION_SIGNING_KEY`.
- Token claims are `iss=Santo`, `aud=santo-ai`, `tenant`, `sub`, `session_id`, `jti`, `iat`, and `exp`.
- Session lifetime is configurable from 600–1200 seconds; staging/default proof uses 900 seconds.
- `GET /v1/session/context` verifies signature/claims/expiry and rechecks current tenant/user status.
- Same `external_user_id` under different tenants creates independent Santo users.
- Tampered and expired tokens fail closed.
- Signing keys, server secrets, and issued session tokens are not persisted in D1 or committed to the repository.

## 6. Core architecture rules

- Tenant identity comes from authenticated context, never arbitrary browser input.
- Every external-user lookup is scoped by `tenant_id + external_user_id`.
- Quota is server-side, atomic, and idempotent.
- Customer server secrets never enter browser bundles.
- Browser code never receives Cloudflare, R2, AI Search, model-provider, signing-key, or customer server credentials.
- No tenant-specific forks such as `if tenant === "medpark"`.
- AI output is structured, not arbitrary model-generated HTML.
- Citations must resolve to retrieved source IDs.
- Schema changes are migration-only.
- SQL belongs in repository/data-access boundaries, not HTTP handlers.

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
- P2 #3: WorkOS auth, tenancy, membership, authorization, and strict cross-tenant isolation accepted live; PR #17 merged as `a22218f2eba76c6b8f3cf4fbefec46bb3f2676ba`; post-merge `Verify` **37203749651** green.
- P3 #4: server credentials/domain controls accepted live; PR #19 merged as `1d9ad9c334f6aff922917db8f7b49943e066e2fe`; post-merge `Verify` **37210341678 (#133)** green; Issue #4 closed.
- P4 PR #20 created from verified P3 `main`.
- P4 repository implementation added `external_users`, repository boundaries, Zod contracts, session issue/verify service, API routes, runtime bindings, and security/isolation tests.
- Pre-live clean implementation head `9862cde35836cd063b2c1619267a340356dbe213` passed `Verify` **37211845862 (#145)**.
- Permanent P4 live acceptance workflow and harness were added; temporary formatter workflows were removed before clean acceptance.
- Clean P4 head `32b2f7d334c0847eb2af44a026be9f2cb2a967f1` passed `Verify` **37212333641 (#151)**.
- The same head passed P4 Staging Acceptance **37212330737 (#3)**: D1 migration/table, real WorkOS tenant fixtures, MedPark `58392` exchange, second-tenant same-ID isolation, token claims/lifetime/context, tamper/invalid denial, D1 evidence, and cleanup all succeeded.
- Issue #5 scope and acceptance checklists are checked with exact evidence; it intentionally remains open until merge + post-merge `main` Verify.

## 9. Next action

Do **not** start #6 yet.

Because this handoff update changes PR #20's head, require on that exact new head:

1. `Verify` — repository-policy, lint, typecheck, tests, build, smoke all green.
2. `P4 Staging Acceptance` — full live gate green including cleanup.

If both pass:

1. Mark PR #20 ready for review.
2. Squash-merge PR #20 using the repository convention.
3. Require `Verify` green on the exact resulting `main` merge commit.
4. Close Issue #5 as completed.
5. Update Issue #8 to mark #5 complete and #6 active.
6. Update this handoff to activate #6.
7. Only then begin the atomic `TenantMeterDO` quota engine.

## 10. Verification policy

`.github/workflows/verify.yml` is the mandatory repository gate: frozen install, lint/format, typecheck, tests, build, smoke, and repository policy.

P4 additionally requires `.github/workflows/p4-staging-acceptance.yml` on the exact candidate head before merge. It applies/validates the D1 migration, deploys staging with ephemeral masked secrets, uses real WorkOS-backed tenant fixtures, verifies external-user session exchange and D1 tenant isolation, and cleans all temporary fixtures/state.

A phase is not complete until required acceptance, merge, and post-merge evidence is recorded.

Branch protection/ruleset configuration remains an authorized-admin follow-up under Issue #10 because the connected GitHub integration cannot write that repository setting.
