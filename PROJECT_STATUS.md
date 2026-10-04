# Santo Project Status — Living Handoff

> **Repository:** `geminiamo0-ship-it/santoreno`
> **Product:** Santo
> **Purpose:** This is the first file a new developer, coding agent, or AI assistant should read before changing the repository.
>
> **Rule:** Update this file whenever meaningful work is completed, a gate passes/fails, architecture changes, or priorities change. GitHub code, issues, PRs, commits, and Actions are the source of truth if any prose becomes stale.

## 1. Current state

Santo is a standalone B2B2C medical AI SaaS platform. Customer sites integrate with Santo by API/widget while Santo centrally owns AI infrastructure, global medical knowledge, AI Search, quota enforcement, citations, assets, usage, security, and tenant administration. Customer production databases remain untouched.

**Phase 0 / Issue #1 is complete.** PR #11 established the pnpm/Turborepo workspace, portal/API/widget/contracts packages, strict tooling, CI, and runtime smoke baseline. Post-merge `Verify` run **37155527270** passed.

**Phase 1 / Issue #2 is complete.** PR #15 established the Cloudflare foundation and real staging bindings. Remote staging acceptance passed on commit `ae2d85c5a9f3658c23d1e3c82b3bda92c0d0defe` in run **37195022577**, with evidence artifact **11300284166** (`sha256:13c11eb101cce3d60a135a53f32848a0ce02e75da76aad68006c6d9a073593f2`). PR #15 was squash-merged as `3d519810e0f640261c378f1e6e6601aec68cde5f`; post-merge `Verify` **37195664585** passed.

The staging Worker is `santo-api-staging` at `https://santo-api-staging.geminiamo0.workers.dev`. Staging has verified D1, R2, both SQLite Durable Objects, Queue producer/consumer, Analytics Engine, and AI Search. The staging D1 UUID is `f875f14a-100a-4731-9e9e-1beed957fd16`.

**Phase 2 / Issue #3 is complete.** PR #17 implemented WorkOS RS256/JWKS verification, D1 tenants/memberships, minimal `super_admin`/`owner` authorization, tenant create/context/read/update APIs, and two-tenant fail-closed isolation. Final clean head `128a64ef4ea39c8fe947bd7d283ecb3c9af9442a` passed `Verify` **37203640840** and P2 staging acceptance **37203637755**. PR #17 was squash-merged as `a22218f2eba76c6b8f3cf4fbefec46bb3f2676ba`; post-merge `Verify` **37203749651** passed.

**Phase 3 / Issue #4 implementation and live acceptance are green on PR #19, but the phase is not closed yet.** The last code-clean head before this status update was `447f32672f84b23aa94b3dc563176c3706cec283`. It passed exact-head `Verify` **37209816647 (#131)** and exact-head `P3 Staging Acceptance` **37209812978 (#8)**. The live gate proved real WorkOS-backed MedPark auth, server-secret issue/authentication, wrong-tenant denial, rotation, revocation, allowed domains, `last_used_at`, hash-only D1 persistence, rotation lineage, security audit events, absence of plaintext secret in persisted evidence, and successful cleanup of D1/WorkOS fixtures.

The temporary one-shot P3 evidence workflow and fixer script were removed before those final clean-head gates. The final PR diff contains only permanent P3 implementation/testing/acceptance files.

**Current gate:** this `PROJECT_STATUS.md` update creates a new PR head, so PR #19 must again pass `Verify` and `P3 Staging Acceptance` on that exact head. Only then may PR #19 be merged. After merge, the exact `main` merge commit must pass `Verify`; only after that do we close #4, mark it complete in #8, and activate #5.

## 2. Source-of-truth documents

Read in this order before implementation:

1. `PROJECT_STATUS.md` — current state and handoff.
2. `SANTO_MASTER_PLAN.md` — complete product/architecture plan.
3. `docs/ENGINEERING_GUARDRAILS.md` — mandatory anti-spaghetti and quality rules.
4. `AGENTS.md` — operational instructions for coding agents/AI assistants.
5. `CONTRIBUTING.md` — branch/PR/verification workflow.
6. GitHub Issue #8 — ordered implementation roadmap and release gates.
7. GitHub Issue #9 — engineering continuity/guardrails.
8. The currently active implementation issue.

## 3. Active implementation order

Do not reorder these without documenting the reason.

- [x] **#1 — P0:** Bootstrap Santoreno monorepo and CI
- [x] **#2 — P1:** Provision Cloudflare foundation and bindings
- [x] **#3 — P2:** Minimal B2B auth, tenancy, and tenant isolation
- [ ] **#4 — P3:** Customer server credentials and domain controls — acceptance green; merge/post-merge gate pending
- [ ] **#5 — P4:** Implement `/v1/session/exchange` for external users
- [ ] **#6 — P5:** Implement atomic `TenantMeterDO` quota engine
- [ ] **#7 — Vertical Slice:** One minimal grounded AI endpoint

Umbrella roadmap: **#8**.

Repository administration / branch-protection follow-up: **#10**.

## 4. Hard architecture gates

### Portal gate

**Do not build the full customer portal before #5 and #6 are proven.** Before then, portal work is limited to the smallest surfaces needed for admin authentication, tenant creation/context, and credential issuance/rotation testing. Do not build polished Users, Plans, Usage, Branding, Billing, analytics dashboards, or elaborate navigation early.

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

## 5. Current architecture decisions

- Language: TypeScript
- Monorepo: pnpm + Turborepo
- Portal: React + React Router v8 + Vite
- API: Hono on Cloudflare Workers
- Widget: Lit Web Components + Shadow DOM
- Portal B2B auth: WorkOS AuthKit
- Control database: Cloudflare D1
- Hot quota/state: SQLite-backed Durable Objects
- Content/assets: Cloudflare R2
- Retrieval: Cloudflare AI Search
- Async events: Cloudflare Queues
- Usage telemetry: Workers Analytics Engine
- Validation/contracts: Zod + OpenAPI
- Tests: Vitest + Playwright + integration/security/load suites
- No Supabase dependency in Santo core
- No direct customer database access
- Global Santo medical knowledge is shared across tenants

### Phase 1 stable Cloudflare binding contract

- `CONTROL_DB` → D1 control plane
- `CONTENT_BUCKET` → R2 content/assets
- `TENANT_METER` → SQLite Durable Object namespace
- `CONVERSATION` → SQLite Durable Object namespace
- `EVENT_QUEUE` → Cloudflare Queue
- `USAGE_ANALYTICS` → Workers Analytics Engine dataset
- `AI_SEARCH` → Cloudflare AI Search namespace

### Phase 2 identity/tenancy foundation

- Portal API bearer tokens are verified server-side as RS256 JWTs against WorkOS JWKS.
- Token issuer, `client_id`, expiry/not-before, and subject are validated before tenant resolution.
- WorkOS `org_id` maps to a Santo D1 tenant; WorkOS role claims are not the sole Santo authorization source.
- Owner authorization requires explicit `(tenant_id, workos_user_id)` membership in D1.
- `super_admin` bootstrap is server-side configuration only.
- Current-tenant routes reject requested tenant IDs differing from authenticated Santo tenant context.
- `WORKOS_API_KEY` is CI-only for temporary staging fixture creation/authentication and is never deployed to the Worker.

### Phase 3 server-credential foundation on PR #19

- Tenant server credentials are generated server-side with cryptographically secure randomness.
- Plaintext is returned only at initial issue/rotation time; D1 stores only identification metadata and a verification hash.
- Credential authentication resolves tenant identity server-side; caller-supplied tenant identity cannot override it.
- Credential rotation revokes the old credential according to the defined transition policy and records lineage.
- Explicit revocation denies subsequent use.
- Successful credential authentication records `last_used_at`.
- Tenant allowed domains are persisted in the control plane.
- Security audit events cover credential create/rotate/revoke and domain updates.
- The P3 PR does not add portal/widget secret handling; customer server secrets remain server-only.
- Live staging acceptance queries D1 directly to prove hash-only persistence and required lifecycle/audit state.

## 6. Core architecture rules

- Tenant identity comes from authenticated context, never arbitrary browser input.
- Every external user lookup is scoped by `tenant_id + external_user_id`.
- Quota is server-side, atomic, and idempotent.
- Customer server secrets never enter browser bundles.
- Browser code never receives Cloudflare, R2, AI Search, model-provider, or customer server credentials.
- No tenant-specific forks or `if tenant === "medpark"` business logic.
- AI output is structured; never render arbitrary model-generated HTML.
- Citations must resolve to retrieved source IDs.
- Customer production databases stay untouched.
- Schema changes are migration-only.

## 7. Completion/update protocol

Whenever work is completed:

1. Update the relevant GitHub issue checklist.
2. Add a concise issue comment with commit/PR/test evidence.
3. Keep the issue open until all acceptance, merge, and required post-merge gates pass.
4. Update Issue #8 only when roadmap status/sequencing actually changes.
5. Update this file when meaningful work or gate state changes.
6. Record a new ADR only for a material architecture decision.
7. Never claim completion because code merely exists; required tests/gates must pass.
8. Every meaningful code/infrastructure step must pass GitHub Actions `Verify` before being marked complete.
9. CI failure blocks progression; fix the actual failure instead of bypassing the gate.

## 8. Last completed work

- **Phase 0 / #1:** merged via PR #11; post-merge `Verify` **37155527270** green.
- **Phase 1 / #2:** real Cloudflare staging foundation accepted; PR #15 merged as `3d519810e0f640261c378f1e6e6601aec68cde5f`; post-merge `Verify` **37195664585** green.
- Phase 1 remote evidence artifact: **11300284166** (`santo-staging-evidence`), digest `sha256:13c11eb101cce3d60a135a53f32848a0ce02e75da76aad68006c6d9a073593f2`.
- **Phase 2 / #3:** WorkOS auth, tenancy, membership, authorization, and strict cross-tenant isolation accepted live; PR #17 merged as `a22218f2eba76c6b8f3cf4fbefec46bb3f2676ba`; post-merge `Verify` **37203749651** green.
- P2 real staging acceptance authenticated temporary WorkOS identities, created MedPark plus a second tenant, proved MedPark resolves only MedPark, proved cross-tenant read/write attempts return 403, and cleaned both D1 and WorkOS fixtures.
- WorkOS multi-application issuer behavior is regression-covered: token `client_id` identifies the Santo Staging application while `iss` references the verified environment issuer.
- **P3 / #4 repository implementation is on PR #19.** It adds D1 migration `0003_server_credentials.sql`, server credential repository/service/authentication routes, domain controls, lifecycle/audit tests, shared contracts, and a repeatable live staging acceptance harness.
- **P3 final code-clean head `447f32672f84b23aa94b3dc563176c3706cec283` passed exact-head `Verify` `37209816647` (#131).**
- **P3 live staging acceptance `37209812978` (#8) passed on the same exact head.** It verified real WorkOS-backed MedPark owner context, credential issue/auth/isolation, rotation/revocation, allowed domains, hash-only D1 storage, `last_used_at`, rotation lineage, audit events, and fixture cleanup.
- Temporary one-shot P3 evidence tooling was removed before the clean-head gates. PR #19 now contains only permanent implementation/testing/acceptance files.
- Issue #4 scope and acceptance checklists are checked with exact evidence, but the issue intentionally remains open until PR #19 merges and post-merge `main` Verify passes.

## 9. Next action

**Do not start Issue #5 yet.**

Because this status update changes PR #19's head, require both of these on the new exact head:

1. GitHub Actions `Verify` — all required jobs green.
2. `P3 Staging Acceptance` — full live gate green, including cleanup.

If both pass, merge PR #19 using the repository's normal merge convention. Then require `Verify` green on the exact resulting `main` merge commit. Only after that:

- close Issue #4 as completed;
- update Issue #8 to mark #4 complete and #5 active;
- begin #5 from the verified `main` baseline;
- update this living handoff on the #5 branch to record Phase 3 as fully complete and Phase 4 as active.

No P4 code should be written before that sequence completes.

## 10. Verification policy

`.github/workflows/verify.yml` is the mandatory machine-verification gate. It includes the frozen install, lint/format policy, typecheck, tests, build, smoke checks, and repository policy checks required by the current repository.

The local smoke gate verifies the Phase 0 runtime baseline plus the Phase 1 Cloudflare foundation: portal boot, Worker `/health`, D1 access/migrations, R2, both Durable Objects, Queue enqueue/dequeue with D1 receipt persistence, Analytics Engine dispatch, and expected build artifacts. AI Search is verified remotely rather than simulated locally.

A step is not complete until its relevant automated verification passes and the evidence is recorded in GitHub.

Branch protection/ruleset configuration is still required for `main` as documented in `docs/BRANCH_PROTECTION.md`. The connected GitHub integration cannot write branch-protection settings, so that repository setting remains an authorized-admin follow-up tracked by Issue #10.
