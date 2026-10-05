# Santo Project Status — Living Handoff

> **Repository:** `geminiamo0-ship-it/santoreno`
> **Product:** Santo
> **Purpose:** First file a new developer, coding agent, or AI assistant should read before changing the repository.
>
> **Rule:** GitHub code, issues, PRs, commits, and Actions are the source of truth. Update this file whenever meaningful work completes, a gate passes/fails, architecture changes, or the active issue changes.

## 1. Current state

Santo is a standalone B2B2C medical AI SaaS platform. Customer sites integrate with Santo by API/widget while Santo centrally owns AI infrastructure, global medical knowledge, AI Search, quota enforcement, citations, assets, usage, security, and tenant administration. Customer production databases remain untouched.

Completed foundation and proven AI core prerequisites:

- **P0 / #1 complete** — monorepo, strict tooling, CI, portal/API/widget/contracts baseline.
- **P1 / #2 complete** — Cloudflare staging foundation and real bindings.
- **P2 / #3 complete** — WorkOS auth, D1 tenants/memberships, tenant isolation.
- **P3 / #4 complete** — tenant server credentials, rotation/revocation, domain controls.
- **P4 / #5 complete** — `/v1/session/exchange`, tenant-scoped external users, short-lived Santo session tokens.
- **P5 / #6 complete** — authoritative SQLite `TenantMeterDO`, atomic reserve/finalize/release, idempotency, live concurrency acceptance.
- **P6 vertical slice / #7 complete** — authenticated grounded AI request through quota → AI Search → Workers AI → server-validated citation → structured response → exactly-once usage finalization.
- **Phase 6 global retrieval / #33 complete** — global AI Search catalog, `All Libraries` default, validated `library_id` filtering, normalized retrieval metadata, library-scoped idempotency, and real two-library staging acceptance.

### Latest completed phase — Phase 6 global retrieval / Issue #33

PR #35 final clean head:

`a5746b8b87ad23c6aeada29740e7c0ae7955e5bb`

Exact pre-merge gates on that same SHA:

- `Verify` **37327203385 (#283)** — repository policy, formatting/lint, typecheck, tests, build, and smoke passed.
- `P33 Global Search Staging Acceptance` **37327194943 (#15)** — real WorkOS-backed tenant/session, two run-isolated AI Search libraries, MRCP-only retrieval, USMLE-only retrieval, All Libraries behavior, real Workers AI generation, server-validated citations, library-scoped idempotency, invalid-filter fail-closed behavior, deterministic quota release, and complete fixture cleanup passed.

PR #35 was squash-merged to `main` as:

`81d15a61140cee28d1a9a7909cb27e1a70b7ba14`

Exact post-merge `Verify`:

- **37330375869 (#284)** — repository policy, formatting/lint, typecheck, tests, build, and smoke passed.

Phase 6 therefore proves that one Santo-wide knowledge ecosystem can be filtered by stable library identifiers without turning library selection into tenant authorization.

### Current active issue — #36

**#36 — Phase 7: Full AI Core: prompt builder, streaming, model policy, and error handling.**

Phase 7 must extend the proven #7/#33 path without moving authority into model/provider code.

Current Phase 7 scope:

- refine the model adapter boundary
- add a deterministic evidence-only RAG prompt builder
- make non-streaming and streaming response contracts explicit
- add streaming without bypassing quota or citation validation
- define timeout, cancellation, upstream-error, malformed-output, and no-evidence policies
- preserve server-side citation validation
- preserve `All Libraries` default and validated `library_id` filtering
- add deterministic regressions for prompt/model/stream/error/quota/idempotency/citation behavior
- add exact-head staging acceptance for the real Phase 7 runtime path

Do not jump directly to sources/images, `ConversationDO`, the full widget, framework integrations, or the full tenant portal before Phase 7 is completed.

## 2. Read order before implementation

1. `PROJECT_STATUS.md`
2. `SANTO_MASTER_PLAN.md`
3. `docs/ENGINEERING_GUARDRAILS.md`
4. `AGENTS.md`
5. `CONTRIBUTING.md`
6. GitHub Issue #8 — umbrella roadmap and release gates
7. GitHub Issue #9 — engineering continuity/guardrails tracker
8. **GitHub Issue #36 — current active implementation issue**

## 3. Active implementation order

Completed:

- [x] **#1 — P0:** Bootstrap Santoreno monorepo and CI
- [x] **#2 — P1:** Provision Cloudflare foundation and bindings
- [x] **#3 — P2:** Minimal B2B auth, tenancy, and tenant isolation
- [x] **#4 — P3:** Customer server credentials and domain controls
- [x] **#5 — P4:** `/v1/session/exchange` for external users
- [x] **#6 — P5:** Atomic `TenantMeterDO` quota engine
- [x] **#7 — P6 vertical slice:** Minimal grounded AI endpoint
- [x] **#33 — Phase 6:** Global AI Search catalog and filtered retrieval

Current:

- [ ] **#36 — Phase 7:** Full AI Core — **CURRENT ACTIVE ISSUE**

Then, in roadmap order:

- [ ] Phase 8 — sources and images
- [ ] Phase 9 — `ConversationDO`
- [ ] Phase 10 — full Lit `<santo-ai>` widget
- [ ] Phase 11 — framework compatibility
- [ ] Phase 12 — full tenant portal
- [ ] Phase 13+ — branding, management API, queues/webhooks, analytics, security hardening, load testing, pilot, production launch

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

Verified live on Cloudflare SQLite Durable Objects.

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

### Grounding gate — passed

Issue #7 proved:

- auth happens before quota/search/model work
- quota reserve happens before expensive work
- Santo global AI Search evidence is retrieved
- model context is bounded by retrieved evidence
- returned citation IDs are validated server-side against retrieved source IDs
- no evidence/search failure/invented citations fail closed
- successful completion finalizes exactly one charge
- identical retry cannot double-charge with idempotency reuse
- defined non-chargeable hard failures release deterministically
- one real Workers AI model call works behind a narrow model adapter

### Global retrieval gate — passed

Issue #33 proved:

- `All Libraries` remains the default when `library_id` is omitted
- a validated library filter restricts retrieval to the selected global catalog entry
- unknown library IDs fail closed without silently broadening retrieval
- library filtering is never tenant authorization
- normalized evidence carries stable source/library/instance/item/title/page/section/text/score metadata
- quota idempotency includes retrieval-library scope
- the same authenticated runtime path works against at least two distinct global libraries
- citations remain server-validated against actually retrieved evidence
- live fixtures and staging state clean up successfully

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
- Workers AI model binding for the proven AI path
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
- `CONVERSATION` → SQLite Durable Object binding reserved for Phase 9
- `EVENT_QUEUE` → Queue
- `USAGE_ANALYTICS` → Analytics Engine
- `AI_SEARCH` → AI Search namespace
- `AI` → Workers AI model binding

### Identity and tenancy

- WorkOS portal tokens are verified server-side.
- WorkOS `org_id` maps to a Santo D1 tenant.
- Owner authorization requires explicit `(tenant_id, workos_user_id)` membership.
- External users are uniquely scoped by `(tenant_id, external_user_id)`.
- `POST /v1/session/exchange` authenticates with the tenant server secret.
- Santo sessions are signed, short-lived, and tenant-scoped.
- Claims include `iss=Santo`, `aud=santo-ai`, `tenant`, `sub`, `session_id`, `jti`, `iat`, `exp`.
- Verified staging lifetime is 900 seconds.
- Verification rechecks signature, claims, expiry, tenant state, and user state.
- Signing keys, server secrets, and session tokens are not persisted in D1 or committed.

### Quota

- `TenantMeterDO` is the single authoritative hot-path quota implementation.
- One SQLite Durable Object is keyed per authenticated tenant.
- `reserve`, `finalize`, and `release` run inside synchronous Durable Object storage transactions.
- Reservation/idempotency records prevent double reserve/charge/refund.
- Tenant allowance is checked before user allowance.
- `DurableObjectQuotaService` is the narrow caller boundary for AI routes.
- AI Search/model generation never runs inside the quota Durable Object.
- Do not add a second quota implementation, per-user DOs, or sharding without measured evidence.

### Grounded AI boundary

- `POST /v1/ai/query` is authenticated by the Santo end-user session, not tenant/user IDs supplied by request input.
- Route/controller code remains orchestration-only and delegates to services/adapters.
- Quota reservation happens before retrieval/model work.
- Retrieval is behind a narrow Cloudflare AI Search adapter.
- Prompt/context construction, retrieval, model invocation, citation validation, quota orchestration, and response shaping remain separate responsibilities.
- Model output is structured and treated as untrusted.
- Citation IDs are validated server-side against the retrieved evidence set.
- Missing evidence, retrieval failure, invalid model output, and invented citations do not produce a sourced medical answer.
- Successful completion finalizes quota; defined non-chargeable hard failures release the reservation.
- Idempotency prevents identical retries from double-charging and includes retrieval-library scope.
- Telemetry excludes secrets, tokens, and unnecessary medical/user content.

### Global retrieval boundary

- `library_id` is optional request scope; omission means All Libraries.
- Library selection affects retrieval scope only and never grants tenant authorization.
- Library catalog resolution is behind `LibraryCatalogPort`.
- `CloudflareAiSearchRetrieval` consumes the catalog boundary and sends only selected AI Search instance IDs.
- Unknown library IDs fail closed before an AI Search query is sent.
- Retrieved evidence carries stable source, library, instance, item, title, page/section, text, and score fields for downstream citation/source resolution.

## 6. Core rules that must not drift

- Tenant identity always comes from authenticated context.
- External-user access is always scoped by `tenant_id + external_user_id`.
- Quota is server-side, atomic, and idempotent.
- Browser code never receives customer server secrets, Cloudflare credentials, model-provider secrets, signing keys, R2 credentials, or AI Search credentials.
- No tenant-specific business forks or customer-specific code paths.
- No direct customer production-database access.
- Portal/widget never access D1, Durable Objects, R2, AI Search, or model providers directly.
- Global Santo libraries are shared; library selection is a retrieval filter, not tenant authorization.
- AI output is structured JSON, not arbitrary model-generated HTML.
- Citation IDs must be validated server-side against retrieved source IDs.
- No fabricated citations.
- Model/provider code is never an authorization, tenancy, quota, or citation authority.
- SQL belongs in repository/data-access or Durable Object state boundaries, not HTTP handlers.
- D1 schema changes are migration-only.
- Keep one authoritative quota implementation: `TenantMeterDO`.
- Continue in Issue #8 roadmap order; avoid premature portal/UI expansion.

## 7. Verification and update protocol

For every meaningful step:

1. Make the smallest clean implementation tied to the active issue.
2. Add/update tests.
3. Run GitHub Actions `Verify` on the exact implementation head.
4. Fix any CI failure before continuing; never bypass the gate.
5. Run issue-specific staging/live acceptance where required on the exact same head.
6. Prove the issue acceptance criteria, not merely that code exists.
7. Update the active issue checklist and add exact commit/PR/run evidence.
8. Update this handoff when meaningful state changes.
9. Update Issue #8 when roadmap completion/sequencing changes.
10. Add an ADR only for a material architecture decision.
11. Require exact post-merge `Verify` before closing an implementation issue.

## 8. Completion history

- P0 / #1 — PR #11; post-merge `Verify` **37155527270** green.
- P1 / #2 — PR #15 merged as `3d519810e0f640261c378f1e6e6601aec68cde5f`; post-merge `Verify` **37195664585** green.
- P2 / #3 — PR #17 merged as `a22218f2eba76c6b8f3cf4fbefec46bb3f2676ba`; post-merge `Verify` **37203749651** green.
- P3 / #4 — PR #19 merged as `1d9ad9c334f6aff922917db8f7b49943e066e2fe`; post-merge `Verify` **37210341678 (#133)** green.
- P4 / #5 — PR #20 merged as `54300a908ea139731cfd2e433949b31517bae479`; post-merge `Verify` **37212761714 (#153)** green. Final handoff PR #21 merged as `778939780a80d3b36a3b48e380192a25d0f39b94`; `Verify` **37213063804 (#155)** green.
- P5 / #6 — PR #22 final head `cd947538c1fefabe2abfb04acd2f26e07cf1a549`; `Verify` **37215999005 (#173)** green; P5 Staging Acceptance **37215996145 (#9)** green; squash-merged as `02994f482918364a8351bf947d50064f6fb34313`; post-merge `Verify` **37216156725 (#174)** green.
- P6 vertical slice / #7 — PR #25 final docs head `59679a56eb273e2f343e2d6ee7d94babf9409b1e`; `Verify` **37305283632 (#250)** green; P6 Staging Acceptance **37305276676 (#26)** green; squash-merged as `8d1a422c514869844fefc9c5c29c1ffdf2bc923e`; exact post-merge `Verify` **37306176415 (#251)** green.
- Phase 6 global retrieval / #33 — PR #35 final clean head `a5746b8b87ad23c6aeada29740e7c0ae7955e5bb`; `Verify` **37327203385 (#283)** green; P33 Global Search Staging Acceptance **37327194943 (#15)** green; squash-merged as `81d15a61140cee28d1a9a7909cb27e1a70b7ba14`; exact post-merge `Verify` **37330375869 (#284)** green.

## 9. Next action

Continue **Issue #36 only**.

Start Phase 7 with the smallest clean AI Core increment. Preserve all proven #7/#33 boundaries and do not build the full widget, sources/images UI, conversation state, or tenant portal yet.

Recommended first implementation sequence:

1. Inspect the existing model adapter, prompt construction, `/v1/ai/query` orchestration, response contracts, and current timeout/error behavior.
2. Define the minimal Phase 7 interfaces/contracts before adding streaming.
3. Add deterministic tests first for the selected increment.
4. Implement the smallest adapter/prompt/error-policy change tied directly to #36 acceptance criteria.
5. Run exact-head `Verify` before expanding scope.
6. Add live/staging acceptance only when the increment reaches a real-runtime boundary that needs proof.

For every change: implement → test → exact-head `Verify` → issue evidence → handoff update when project state changes.

## 10. Repository administration note

Branch protection/ruleset configuration remains an authorized-admin follow-up under Issue #10 because the connected GitHub integration cannot write that repository setting.