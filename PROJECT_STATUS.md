## 2026-10-31 — #306 source-gate review conflict regression (unmerged)
- Review of PR #307 found a fail-open approval condition: a different independent reviewer could request changes while another approved, and the gate would still accept; mixed-case GitHub author aliases also escaped the self-review check. The first page of 100 reviews could silently hide a later veto.
- Candidate branch now rejects any outstanding independent CHANGES_REQUESTED, compares logins case-insensitively, and denies potentially incomplete 100-review histories. Offline regression covers cross-reviewer conflicts, case aliases, pagination limit and dismissed-request recovery. Exact-head CI and independent review are pending; no Dev/Production deployment or Noor migration/flag change.

## 2026-10-31 — Noor P0 #286 reviewed-PR SHA Dev gate candidate (#306)

- Branch `test/306-noor-reviewed-pr-sha-staging` adds a **manual-only** `noor_pr_number` option to the existing isolated Noor Dev workflow, with exact SHA verification, same-repo/main-only, non-draft, independent exact-head approval, exact-head successful Verify, and a second eligibility check before Dev deployment. Default main-only push and manual dispatch behavior remains verified and unchanged.
- Offline fail-closed tests cover fork/draft/closed/wrong-base, self/stale/withdrawn review, wrong-event/failing Verify and invalid PR input. No secrets or Production code changed. See `docs/NOOR_REVIEWED_PR_DEV_GATE.md`.
- **Candidate only:** require PR CI and independent review before merge; no reviewed Noor #288 PR-head staging dispatch, D1 0023 application or signed teacher ink acceptance has occurred. Noor #286 remains OPEN; cumulative ink flag OFF.

## Noor Phase 07A remote Dev report gate — #256 (source only; no remote acceptance yet)

- Parent Noor [#186](https://github.com/geminiamo0-ship-it/nour-elquran/issues/186), draft [PR #187](https://github.com/geminiamo0-ship-it/nour-elquran/pull/187). Only when Noor **main** exact-sha Verify is SUCCESS will the existing staging workflow test new 0013 D1, real signed synthetic scheduled lesson, explicitly synthetic Start/End D1 audit, authorized Sheikh draft/publish/replay/new revision and latest-only owner read, sibling/foreign denial and post-revocation teacher 404.
- Santoreno source branch `test/256-noor-reports-dev` extends existing Noor-only runner (`scripts/noor_private_staging.py`) with modular `scripts/noor_report_staging.py`, offline identity/schema-denial tests, scoped CI. Never touches Santo core/medical data or Production. Existing `noor-core-staging` / `noor-site-staging` only, Chrome remains optional.
- This records a **planned Dev acceptance**, not deployment or passed E2E; do not close #256 or Noor #186 before exact staging run is recorded. On failure keep PRs open, inspect non-secret logs and correct. Synthetic lesson reports are not evidence of real Classroom presence/guardian consent. Staff privileges and synthetic Sheikh state are cleaned by the inherited `finally` block.

## Noor Phase 06A1 isolated Dev policy-denial gate — #254 (source branch, pending remote verification)

- Noor [#182](https://github.com/geminiamo0-ship-it/nour-elquran/issues/182) merged its D1 0012 fail-closed consent and asset tables, with owner-only disabled API; [#180](https://github.com/geminiamo0-ship-it/nour-elquran/issues/180) remains open for guardian identity/consent, retention/delete/export and private R2 upload/playback.
- Scoped Santoreno branch `test/254-noor-audio-policy-dev` adds read-only remote D1 migration/lock verification and authenticated synthetic owner/sibling vs foreign/anonymous API checks to the existing `noor-site-staging` + `noor-core-staging` pipeline. No audio writes, R2 buckets, guardian grants, synthetic Chrome or Santo Worker changes. Python unit tests mock the networking and reject missing SQL lock or enabled status.
- **Not yet Dev-verified** until Noor main exact push Verify, Santoreno PR Verify/validation and a Santoreno main remote staging workflow with evidence. Do not declare production audio available; rollback existing staging Worker only if necessary, never drop additive D1 tables.

## Noor Phase 05B remote synthetic submit/review gate — #252 (branch, not deployed)

- Noor source [PR #179](https://github.com/geminiamo0-ship-it/nour-elquran/pull/179) merged `b0b03c2278325cc63de2b38770cc4eb05781ca46`; exact PR [Verify #40974785462](https://github.com/geminiamo0-ship-it/nour-elquran/actions/runs/40974785462) 4/4 SUCCESS; **postmerge main Verify + Santoreno stage pending**.
- Santoreno branch `test/252-noor-submission-review-dev`: add strictly scoped HTTP smoke to existing Noor-only synthetic teacher/owner D1 session. Tests explicit student note submit, replay 200, altered op 409, no duplicate attempt before review; Sheikh review retry and accept, owner sees both immutable attempts, foreign owner 404 and revoked Sheikh 404. No actual child/guardian/audio data.
- Cloudflare D1 migration 0011 is additive; use existing dedicated `noor-core-staging` and `noor-site-staging` only. Chrome on demand, not on every push. This API test is **not** a visual approval of the new training/review UI.

## Noor Phase 05A remote published assignments — #250 (branch only)

- Noor source [PR #176](https://github.com/geminiamo0-ship-it/nour-elquran/pull/176) merged at `bff8c6be7015a0a3fd48254158f5e93b58e23527`; postmerge [Verify #40970402157](https://github.com/geminiamo0-ship-it/nour-elquran/actions/runs/40970402157) passed all fast gates. No real user/Production deployment.
- Santoreno branch `test/250-noor-assignments-api-dev` extends the existing pinned Noor-only D1 staging synthetic primary teacher journey to publish canonical Hafs 1:1-7 task, validate replay 200, changed-op 409, invalid verse 400, owner reload and foreign owner 404 and revoked teacher cannot republish. Retains finally privilege cleanup.
- Per owner preference, existing 5-viewport Chrome suites are now **OFF by default for ordinary staging deployments** and selectable only via manual `workflow_dispatch.browser_qa=true`; remote API/Worker/D1 synthetic acceptance remains mandatory.
- **No remote run on this branch yet.** Must pass exact-head Santoreno Verify and Noor-source main gate, then main staging deployment + API acceptance. Screenshots only if opt-in; API success alone does not establish new assignments UI visual fidelity.

## Noor authenticated Sheikh connected Dev QA — #248 (BRANCH, not deployed)

- Sources Noor #169 / #167 / #162 and master #155. Scoped Santoreno branch `test/248-noor-connected-teacher-dev` opts in the existing `noor-site-staging` build to connected mode. Real qualified teacher uses current primary roster, academic plan and schedule; signed-out visitor keeps original marked demo, authenticated non-teacher gets role-denied with **no fixture fallback**.
- Remote synthetic QA runs under the existing temporary role grant and assignment BEFORE their finally cleanup; Chrome consumes ephemeral secure Better Auth cookies via runner child env (never logged) and captures five-size teacher screenshots; API revocation/owner reads unchanged. No other Cloudflare Worker/D1, SMS, Production or Santo deploy target.
- **No branch CI or remote deploy accepted yet**. Do not merge until Noor #169 exact main Verify, Santoreno exact-head Verify, main pipeline and screenshot review pass. On any failure, disable teacher and revoke grant in finally.

## Noor responsive account remote browser UX gate — #246 (branch only)

- Noor [#160](https://github.com/geminiamo0-ship-it/nour-elquran/issues/160) and PR #166 address the connected mobile header learner name that was clipped in actual Dev Chrome evidence. The Santoreno branch `test/246-noor-mobile-account-staging` extends the **existing** synthetic Chrome test with a long Arabic name, five responsive widths, selector visibility, menu placement, logout access and no horizontal overflow.
- Scope stays on `noor-site-staging` and `noor-core-staging`; the updated Noor-only workflow path filter will run CI validation on PR and actual deployment only on Santoreno main after verifying the Noor source main SHA. No other staging or Santo Production service.
- **Not yet remotely deployed or visually accepted**. Next: exact-head Santoreno Verify + staging validate; merge only after Noor #166 merges with successful postmerge Verify; inspect remote Chrome screenshots in Actions artifact before closing #246 and #160.

## Noor Phase 02A teacher plan staging gate — #244 (branch only)

- Noor merged PR #165 SHA `87023653c5a8cc75ca9aea5a98e52a8ed034ee83` passed [postmerge Verify #40961335247](https://github.com/geminiamo0-ship-it/nour-elquran/actions/runs/40961335247) attempt 2 (4/4); first Chrome physical-tap smoke was timing-sensitive, rerun passed.
- Santoreno #244 branch adds remote synthetic teacher qualification, assignment, academic plan CAS, owner/student read, foreign-owner 404, revoked-teacher 404 and **finally** cleanup of test grants/teacher status. Only the pinned Noor `noor-core-staging` D1 / `noor-site-staging` Worker may be used.
- **No remote test executed or accepted yet from this branch.** Deploy only after Santoreno exact-head Verify and source-main gate; no Production/Santo or actual learner data. This currently verifies API and D1, not connected teacher UI on remote Chrome. Track the UI follow-up in Noor #162.

## Noor D1 learner lifecycle remote acceptance — #242 (implementation branch, not deployed)

- Noor parent #155 / #157, Draft PR #158. Santoreno branch `feat/242-noor-profile-staging-smoke` extends the **existing** `noor-site-staging` deployment script with synthetic HTTP rename/CAS/idempotency/404/archive and read-only D1 history-count proof. The Worker and database remain the dedicated Noor development resources.
- Source-of-truth gating remains: only checkout verified Noor **main** after exact postmerge Verify. No feature deploy or remote acceptance claimed at branch stage.
- Before closing: Santoreno Verify for exact PR head, Noor merged/push Verify, Santoreno main workflow's remote deploy+smoke run and audit of changed resource names. No real guardian phone verification or Production changes.
- Rollback: revert staging Worker build without dropping D1 audit or Quran records; keep #242 OPEN until all remote gates verified.

# Santo Project Status — Living Handoff

## Public Noor demo preview #227 — rollout candidate, not yet cloud-verified

- Owner requested no site-wide password on the existing Noor staging URL. Noor [#118](https://github.com/geminiamo0-ship-it/nour-elquran/issues/118) adds a **read-only** public page/static asset path only, preserving stage Basic access for all APIs and write methods.
- This branch edits only scoped Noor workflow/script: Next build `NEXT_PUBLIC_ACCOUNT_UI=false` displays labeled mock learners; stage Worker uses `NOOR_PUBLIC_PREVIEW=true`, preserves private credentials + D1, and checks public landing/student/real JS HTTP 200, unauthenticated API HTTP 401 and private synthetic account/session/isolation end-to-end.
- No public phone registrations; no OTP, actual learner data, Santo resources or Noor production changes. Remote verification is pending exact Noor main merge and green CI.

## Noor isolated Cloudflare staging #219 — remotely VERIFIED (2026-10-29)

- Using encrypted Santoreno GitHub Actions Cloudflare credentials, dedicated `noor-core-staging` D1 and `noor-site-staging` Worker were provisioned **without modifying Santo Workers/D1/DO/R2 or Noor production**. Noor main source `dff83b382b3774a7476ae8dee64b7454fd09859c` passed its own four CI jobs.
- [Noor Private Staging remote run 40810303172](https://github.com/geminiamo0-ship-it/santoreno/actions/runs/40810303172) **SUCCESS** on exact Santoreno main `fb02bdaa866723c012e2a735e46a5c936954e3cf` with paired [Verify 40810302568](https://github.com/geminiamo0-ship-it/santoreno/actions/runs/40810302568) SUCCESS.
- The real Cloudflare remote smoke passed private Basic access denial on site/API/assets (401), gated /health and /ready 200, synthetic registration with unverified phone, HttpOnly/SameSite cookie, owned learner creation/list, cross-account 404 and logout session revocation. All tests used invented data; no OTP/SMS/WhatsApp/email sent.
- Scoped workflow `.github/workflows/noor-private-staging.yml` and `scripts/noor_private_staging.py` run only for changes to their paths or manual dispatch. Secrets generated on runner are not logged. Human QA requires Cloudflare Access or rotating `STAGING_ACCESS_PASSWORD` to a known private value, without exposing it in issues. Do not reuse synthetic accounts as real identities.
- Noor issue [#114](https://github.com/geminiamo0-ship-it/nour-elquran/issues/114) is the canonical acceptance evidence. Backup/restore, staff/child restrictions, real browser visual QA, billing and messaging remain separate tasks, and Santo clinical system is unaffected.

> **Repository:** `geminiamo0-ship-it/santoreno`
> **Product:** Santo
> **Purpose:** First file a new developer, coding agent, or AI assistant should read before changing the repository.
>
> **Rule:** GitHub code, issues, PRs, commits, and Actions are the source of truth. Update this file whenever meaningful work completes, a gate passes/fails, architecture changes, or the active issue changes.

### Royal-style Santo chat parity — PR #94 + Royal Bank PR #113 (14 Oct 2026)

- Santo reusable Lit widget PR #94 merged as `24d597186a3bbd4571e4b4e3d16593819f905743`, with post-merge repository-policy/code-quality checks SUCCESS. Royal-like gold question bubble and one compact assistant card with safe markdown headings, comparison tables, lists, callouts and server-backed source cards. Human-friendly labels for canonical R2 item keys do not invent medical article titles.
- Royal Bank host PR #113 merged as `ceaac30c8ad11dd308ae4b9051583f7829840921`, with exact-head and post-merge Verify success. Its Santo Pilot uses Royal AI's compact `DeepDiveMarkdown` rather than card-per-heading animations. Verified persisted `/ask` responses render without post-response sequential GET requests, retaining idempotent save/retry and reload restoration.
- Santo AI core and quota unchanged. The visible ~20s `ask` server wait from browser timings is NOT fixed by UI changes. No claim of immediate model-native token streaming; buffered server-validated generation still applies.
- Updated widget browser bundle publishing, browser QA on a real site, multi-library live RAG validation and final pilot acceptance remain outstanding. Issue #58 stays open.

### Royal-style Medical Copilot responses — PR #93 (14 Oct 2026)

- Compared actual Royal Bank `DeepDiveMarkdown`, `RoyalAIButton`, source cards, and OpenRouter RAG/general fallback design to Santo's central Worker/Widget/Conversation architecture.
- PR #93 changes the **shared Santo Lit widget** to render safe Markdown headings, comparison tables, lists, code and high-yield callout cards, bilingual/RTL-safe text and actionable verified-source cards. No raw HTML from model.
- Santo Workers AI can now **optionally** answer with transparent `groundingMode: general` when real RAG evidence is absent or inadequate, without fake Santo citations. Existing auth, tenant/user quota, atomic reserve/finalize, conversation replay and validated streaming remain authoritative. Retrieval outages still fail closed.
- Feature flag `SANTO_GENERAL_MEDICAL_FALLBACK` is enabled only for **Staging**, with Production left disabled pending real staging/browser acceptance. Staging retrieval now targets the isolated One Examination index while preserving `library_id=one-examination`.
- CI, PR merge, deployed staging browser acceptance and live medical answers **must be verified before claiming complete**. Source Explorer and Phase 10 issues stay open until those gates pass.

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
- **Phase 7 full AI core / #36 complete** — centralized model policy, bounded evidence-only RAG prompts, strict structured JSON and SSE response contracts, server-validated citations, atomic quota finalization, timeout/cancellation safety, idempotent retries and real staging acceptance.

### Phase 6 global retrieval — Issue #33

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

### Latest completed phase — Phase 7 AI Core / Issue #36

Phase 7 was delivered in clean increments:

- PR #38 — centralized model adapter and generation policy; exact post-merge `Verify` **37926643388**.
- PR #39 — deterministic, bounded, evidence-only prompts and injection-resistant source serialization; exact post-merge `Verify` **37927141394**.
- PR #42 — explicit Zod JSON/SSE response contracts, fully validated buffered streaming, bounded retrieval/model deadlines and cancellation, structured errors, charge-free failure release and replay/idempotency regressions.

The final PR #42 head `6c1ba89448725507dcade62b95963753e127de10` passed both required exact-head gates:

- `Verify` **37931171789** — repository policy, formatting/lint, strict typecheck, tests, build, smoke.
- `P7 Validated Streaming Staging Acceptance` **37931165458** — real WorkOS tenant and session, two run-isolated AI Search libraries, Workers AI generation, MRCP/USMLE/All Libraries filters, validated citations, SSE delta/complete output, same-key quota replay, invalid-library rejection, and successful fixture cleanup.

PR #42 was squash-merged as `29805bc85ac864e66b7cdc7cd787ac52c1749613`. Exact post-merge `Verify` **37932098841** passed.

**Streaming limitation:** JSON-mode Workers AI does not provide provider-native token streaming. Santo intentionally buffers and validates the full output and finalizes quota before emitting SSE frames; this avoids unverified sourced medical content. Do not advertise provider-token time-to-first-byte streaming. See `docs/AI_STREAMING_CONTRACT.md`.

Phase 7 and Phase 8 are fully verified. **Phase 9 / Issue #52 is now also complete and post-merge verified.** Next implementation target: **Issue #58 — Phase 10 Santo Widget**. Full tenant portal remains deferred.

### Latest completed phase — Phase 8 trusted sources and R2 media / Issue #43

- PR #49 added strict server-verified citation/source-detail metadata and
  canonical image/R2 manifest contracts, including six security regressions.
  Final head `6d4ddf5bb927147f9869f7f22385a71ca614c350` passed
  **Verify 38414736636**. Squash merge: `05b75ba9384ece2250983994e92190a69cfadd9b`;
  exact post-merge **Verify 38415599816** passed.
- PR #50 implemented tenant/user/message-scoped verified source snapshots,
  authenticated source details and images, R2 canonical media manifests,
  fail-closed image handling, no-store delivery and source-persistence-before-
  quota-finalize safety, with deterministic regression tests.
- PR #50 final head `3769cdc9d79e4deb671bb512e9d9c02f4b05f7dd`
  passed **Verify 38419869177** and **P8 Trusted Sources Staging Acceptance
  38419858440** on the exact same commit. Live acceptance exercised real
  WorkOS-backed sessions, indexed AI Search fixtures, Workers AI, R2 media,
  cross-tenant isolation, authorized image delivery and cleanup.
- PR #50 squash merge: `93ac404f3de1c59949eb856e41d5a8cb433afb8a`;
  exact post-merge **Verify 38420860631** passed.
- **Phase 8 code/staging acceptance complete.** Source storage access is
  logically time-bounded; configure physical R2 lifecycle cleanup as documented
  in `docs/TRUSTED_SOURCE_CONTRACT.md` before production launch.
- Next: **#52 Phase 9 ConversationDO**, state, follow-ups, ordering, context
  summary, idempotency and stream coordination. Do not begin Phase 10/portal
  before Phase 9 acceptance is proven.

### Phase 9 first implementation slice — Issue #52

- **PR #54 completed first state-only slice:** strict conversation
  contracts, per-conversation SQLite Durable Object, owner-scoped
  create/read/append/delete routes, transactional compare-and-append, stable
  idempotent replay, bounded 200-message storage and latest-50-message reads.
- PR #54 final head `50fb8311b02e16ce15b81f1d8f6a096a2bc1f876`
  passed exact-head **Verify 38435332142** and real **P9 Conversation State
  Staging Acceptance 38435322343** on that same commit.
- Live staging proved WorkOS-backed sessions, real SQLite DO state,
  **1 success / 99 conflicts** in 100 simultaneous appends, same-key
  replay, cross-tenant/user denial and run-scoped fixture cleanup.
- Squash-merged into main as `1dc142677c34cf10a4450f01bde14cead3c2be16`;
  exact post-merge **Verify 38435667470** passed.
- User/tenant authority comes only from an authenticated Santo end-user
  session; Durable Object routing IDs are never authorization grants.
- **Not Phase 9 completion:** verified assistant turns, quota-linked AI
  follow-ups, bounded context summaries, stream coordination, complete
  failure lifecycle and final staging acceptance are still required.
- Source of network/state contract:
  `docs/CONVERSATION_STATE_CONTRACT.md`.

### Phase 9 grounded follow-ups — PR #56 merged and verified

- PR #56 added authenticated `/ask` and `/turns`, SQLite-backed AI turn
  leases, verified persisted answers, bounded history, retry-safe quota
  epochs, and no unverified SSE before quota finalization/DO commit.
- Exact head `8538c076d27856b2486aeb6eafb18385a294c1d8` passed
  **Verify 38441908597** and live **P9 Grounded Follow-ups 38441897200**.
- Squash merged `5d386bbbc6849015e74579388d94d5938a36fb9a`;
  post-merge **Verify 38444007239** passed.
- Final summary/lease hardening merged as **PR #57**:
  `17e032e3935cad4f6ec290ee770e3baaf09f6540`.
  Final head `84e785a7067fc0257f843655f84e2eb89956b279`
  passed exact-head **Verify 38445457126** and live **P9 Summary & Lease
  Staging Acceptance 38445450546** on the identical SHA.
- Exact post-merge **Verify 38446592614** passed on the squash commit.
- Adds SQLite-transactional, bounded **1,200-character extractive summary**
  of completed server-verified turns only (not unbounded model memory),
  owner deletion, upgrade fallback and expiry-aware active lease fencing.
- **Phase 9 complete under the scoped accepted contracts.** Issue #52
  is closed after evidence update. Earlier mistaken auto-close by PR #56
  was corrected before final acceptance.

### Phase 10 pilot-first delivery — PRs #61, #63, #62

The **Pilot MVP implementation slice** is merged and passes code/unit/build
gates. It does NOT claim that a real customer site has been connected or that
production medical libraries have been ingested.

- **PR #61**: verified typed Lit conversation client, owner-scoped reconnect,
  per-student optional browser-session conversation IDs, stable same-key retries,
  grounded JSON responses, server-owned citation details and authenticated
  source images. Final head `4b7726152a0cbf4e067be0d736b7cd7d62af4d07`
  passed **Verify 38452224965**, merged
  `3a14a2008885f0fee3b9b2d1c3d8c287b5bdfd5b`; exact post-merge
  **Verify 38452409599** passed.
- **PR #63**: bundle stand-alone Lit+contracts web component at
  `packages/widget/dist/browser/santo-ai.js` via pinned Vite,
  head `98c98e24925ad85f69e03ecf3283f474a2e11e4b`
  **Verify 38452754183**, merged
  `d9f5982a5d0ee0c84d785e67717e6ac699cd7114`;
  exact post-merge **Verify 38453040414** passed.
- **PR #62**: secure customer-backend-only student quota operations
  `POST /v1/server/quota/users`, `GET /v1/server/quota/users/:externalUserId`,
  and Santo WorkOS Super Admin-only tenant cap bootstrapping
  `POST /v1/admin/tenants/:tenantId/quota`. Calls scope tenant only from
  verified credentials; user quota updates preserve spent/reserved units.
  Final head `26440b8352317fb1dabe1ec97c32ecbe0c33377b`
  **Verify 38453258247** passed; merged
  `022c4e54bd5bc8e525d2df5c6dfff8c42673c5f6`;
  exact post-merge **Verify 38453505941** passed.
- **Pilot integration instructions:** `docs/PILOT_SITE_INTEGRATION.md`
  is the customer-backend session and entitlement handoff. No tenant server
  secrets may reach browser code. Website must supply a safe same-origin proxy
  and short-lived user session token.
- **Remaining external pilot gates:** legal licensed medical content ingestion
  and source quality checks; operator-authorized tenant setup; connected
  customer website backend/session/proxy; real browser/mobile + live staging
  acceptance including quota exhaustion/suspension, auth isolation, reconnect,
  citations/images, and actual pilot release smoke evidence.
- Full customer portal, commercial billing, visual polish and broad
  compatibility are deferred. **Issue #58 stays OPEN** until real widget
  acceptance; do not claim Phase 10 or launch complete from Verify alone.

## 2. Read order before implementation

1. `PROJECT_STATUS.md`
2. `SANTO_MASTER_PLAN.md`
3. `docs/ENGINEERING_GUARDRAILS.md`
4. `AGENTS.md`
5. `CONTRIBUTING.md`
6. GitHub Issue #8 — umbrella roadmap and release gates
7. GitHub Issue #9 — engineering continuity/guardrails tracker
8. **GitHub Issue #52 — completed Phase 9 acceptance**
9. **GitHub Issue #58 — current active implementation issue, Phase 10**

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
- [x] **#36 — Phase 7:** Verified AI Core, validated SSE and bounded failure lifecycle
- [x] **#43 — Phase 8:** Trusted sources, citation details and R2 images (post-merge verified)
- [x] **#52 — Phase 9:** ConversationDO ordered state, grounded follow-ups, verified memory and lease recovery — **COMPLETE**

Current:

- [ ] **#58 — Phase 10:** full embeddable Lit `<santo-ai>` widget — **CURRENT ACTIVE ISSUE**

Then, in roadmap order:

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
- Phase 7 AI Core / #36 — PRs #38/#39/#42; final PR #42 head `6c1ba89448725507dcade62b95963753e127de10`; `Verify` **37931171789** and P7 Staging Acceptance **37931165458** green on that head; merged `29805bc85ac864e66b7cdc7cd787ac52c1749613`; post-merge `Verify` **37932098841** green.
- Phase 8 / #43 — PR #49 post-merge `Verify` **38415599816**; PR #50 final head `3769cdc9d79e4deb671bb512e9d9c02f4b05f7dd` with exact-head `Verify` **38419869177** and P8 real staging **38419858440** passed; merged `93ac404f3de1c59949eb856e41d5a8cb433afb8a`; post-merge `Verify` **38420860631** passed.

### Staging pilot credential button — merged and deployed (14 Oct 2026)

- **PR #68 merged** `af0998f3b97bb7d4fec08678c87204898f9a39c5`.
  Exact-head Verify **38477996865** and exact post-merge Verify
  **38478107926** both passed.
- **Staging Worker deployment 38478108210 succeeded**, preserving Cloudflare
  user-managed vars/secrets and smoke-testing `/health`, the console page
  and non-secret WorkOS client configuration. Production was not deployed.
- **Operator URL:** `https://santo-api-staging.geminiamo0.workers.dev/pilot/credentials`.
  The exact callback is registered as an allowed WorkOS Staging Redirect URI.
- Hosted WorkOS PKCE sign-in; one-time Generate API Key / Copy buttons;
  optional Super Admin tenant initialization and existing owner-verified
  tenant/credential APIs. No customer-specific bypass, second credential
  store or direct browser access to Santo internal infrastructure.
- WorkOS access token and generated Santo secret are held only in browser
  memory; WorkOS refresh token is discarded by the Worker and never
  returned to the browser. Browser UI is staging-only with strict CSP.
- **Not yet proven live:** real owner browser sign-in, tenant creation,
  actual `santo_sk_` credential issuance, quota bootstrap, Vercel sensitive
  key installation, Vercel BLOCKED release resolution, Royal Bank browser
  end-to-end acceptance, and licensed-content ingestion. Do not claim
  Santo Pilot or Royal Bank integration is fully live.
- Runbook: `docs/PILOT_CREDENTIAL_CONSOLE.md`.
  The full portal remains deferred; Issue #58 stays OPEN.

### Phase 10 Staging tenant-quota UI — verified staging deployment (14 Oct 2026)

- Royal Bank live `/santo` moved from `SANTO_NOT_CONFIGURED` to
  `TENANT_QUOTA_NOT_CONFIGURED` after its Vercel server secret was installed.
  Student default `SANTO_DEFAULT_STUDENT_QUOTA=100` is distinct from
  the tenant-wide TenantMeterDO cap.
- **PR #70 merged** `c14aa940b94dabcbfb7811836ee68d6a46981757`.
  Exact-head Verify passed at `fb69a60c3c4f3b3dcdb9aed5bcb5c6556a4a6ec8`;
  exact post-merge **Verify 38482416299** passed, including policy, lint,
  formatting, TypeScript, tests and build.
- Staging-only Worker **Deploy 38482416486 SUCCESS**, preserving dashboard
  secrets/variables and smoke-testing health, console, WorkOS client config
  and the new **Initialize Tenant Quota** control.
- Operator console: `https://santo-api-staging.geminiamo0.workers.dev/pilot/credentials`.
  WorkOS Super Admin verifies an existing tenant, chooses explicit monthly cap
  and UTC cycle dates and confirms a possible cycle reset. The existing
  Super Admin-only `POST /v1/admin/tenants/:tenantId/quota` is unchanged.
  No customer/tenant-specific bypass or new browser-accessible server key.
- The generic `santo-operator-bootstrap` placeholder has 0 user units, to
  satisfy the existing initial-user request contract. Royal students remain
  provisioned independently from their own authenticated website backend.
- **Live operator bootstrap NOT YET PERFORMED**: user must sign in with
  WorkOS and submit the chosen quota cap/cycle for the existing Royal tenant.
  Royal /santo end-to-end live acceptance, licensed content ingestion, quality
  and grounded AI success are **not yet proven**. No production deployment
  or actual tenant quota mutation was performed here.
- Operator runbook: `docs/PILOT_CREDENTIAL_CONSOLE.md`. Phase 10 / #58
  remains OPEN; full portal is deferred.

### WorkOS owner tenant-ID recovery — implementation pending (14 Oct 2026)

- Royal Bank operator forgot the Santo Tenant UUID after successful
  tenant/key creation and after encountering `TENANT_QUOTA_NOT_CONFIGURED`.
  The WorkOS organization ID is known but is **not** a Santo UUID.
- Add a read-only `GET /v1/portal/my-tenant` backed by existing
  `findTenantByWorkOSOrgId` plus `getTenant` owner authorization. Neither
  WorkOS Super Admin privilege alone nor a user-provided organization ID
  grants access; a signed WorkOS organization + explicit owner membership is
  required.
- Staging console button **Find my Tenant ID** resolves and prefills the
  UUID without creating a second tenant, key, or quota, while preserving the
  active Super Admin quota bootstrap workflow.
- Branch `feat/pilot-tenant-id-lookup`. CI, merge, staging deployment, real
  WorkOS browser lookup and quota activation **still require verification**.

### Santo Medical Education Copilot v1 — verified design, implementation pending (14 Oct 2026)

- Approved product direction: a provider-neutral medical tutor, question-bank
  and medical-library assistant with natural medically relevant conversation.
- **Design Issue #73 CLOSED**, **PR #74 merged** at
  `34928d166af8520c3cbdb92a9a12e3089fc3d28f`.
- Final PR head `7e3b92500d00c2701745a90aa4331b3d24c3b07a` passed
  repository-policy and code-quality. Exact post-merge **Verify 38486395119**
  passed both checks (format/lint, typecheck, test, build and smoke).
- Canonical candidate prompt version `santo.copilot.core.v1`:
  `docs/prompts/SANTO_MEDICAL_EDUCATION_COPILOT_V1.md`; routing, citations,
  quota, exam-disclosure and bilingual acceptance:
  `docs/COPILOT_ROUTING_V1.md`; proposed ADR:
  `docs/adr/0001-copilot-intent-routing.md`.
- **Implementation Issue #75 OPEN** (not implemented). Preserve current
  authenticated RAG/Workers AI/AI Search/citation/atomic-quota behavior.
  Deterministic greetings, intent classification and clinical safety UX
  are design goals, **NOT LIVE**. The existing `hi` call can still return
  `INSUFFICIENT_EVIDENCE` until implementation and staging gates pass.
- Full Phase 10 Pilot / Issue #58 still needs licensed medical content,
  authoritative exam-context integration, real host/browser acceptance and
  separate rollout confirmation. No Santo/Royal production changes here.

### Professor-grade grounded teaching — deployed to Staging only (14 Oct 2026)

- **Issue #77** / **PR #78** merged to main at
  `6cfd6f78933544a085d422947aecaa6e9ac3f72a`.
- Exact PR head `fb8151c6d599e0a2b75b0f4c86993fd8458cef33`
  passed repository-policy and code-quality. **Post-merge Verify**
  `38488562398` SUCCESS (format, lint, typecheck, unit tests, build, smoke).
- **Staging deployment** `38488562400` SUCCESS: deployed Santo Staging
  Worker with `wrangler deploy --env staging --keep-vars`, preserving
  existing user-managed vars and secrets. Live health, pilot console
  and unauthorized AI request (401) smoke passed. Production untouched.
- Grounded path now prompts for professor-grade, mechanism-led, concise-when
  appropriate synthesis of **only retrieved evidence** and optional
  directly supported high-yield pearls. Max output cap 900 -> 1500 tokens.
- `docs/PROFESSOR_GRADE_TEACHING.md` defines behavior and quality-evaluation
  matrix. Existing auth, model provider (Llama 3.3 70B), evidence bounds,
  structured citations, source R2 snapshots, quota, idempotency and SSE
  remain unchanged. **Copilot social chat / Intent Router (Issue #75) is NOT
  implemented**; no unsupported medical-answer fallback.
- **Not yet proven:** actual sourced medical explanation quality, reference
  fidelity, bilingual outcomes, p95 latency and provider cost on licensed
  real content (Issue #58). Issue #77 stays open until real expert review
  and a deliberate production rollout decision.

### Phase 10 Source Explorer + 7,049 article corpus — PR #83 in review (14 Oct 2026)

- **Issue #82** / Santo **PR #83** adds staging-only authenticated
  `/v1/libraries` catalog, article listing/reading and
  `POST /v1/sources/article` verified-citation resolution to original
  private R2 article and exact **section**. Bounded JSON and strict
  browser media allowlist; no third-party raw HTML rendering.
- Santo Lit widget now includes a responsive reader, article navigation
  and citation-section jump. Royal Bank **PR #111** adds the student-facing
  Source Explorer, browse action and authenticated proxy allowlisting.
- User licensed SQLite corpus inspected: 7,049 records across five libraries
  (AMBOSS 1,481, USMLE 948, One Examination 384, PassMedicine 3,109,
  Pastest 1,127). Offline sanitized structured export produced
  7,049 article JSON + 67,524 Markdown index sections + six catalog
  JSON files (74,579 uploadable private R2 objects); local compressed
  bundle around 29 MiB. **No medical source content committed to GitHub**.
- `scripts/export_medical_libraries.py` and
  `scripts/upload_medical_libraries_r2.py` implement reproducible export
  and resumable operator-local upload; private target
  `santo-content-staging` only; never the public images bucket.
- **Not yet uploaded/indexed:** no Cloudflare R2 credentials are available
  to this chat runtime; public `r2.dev` host was verified only for images.
  Configure five AI Search instances with canonical per-section
  `itemKey`, wait for indexing, and verify authentic medical citations.
- Runtime feature flag `SANTO_LIBRARY_READER_V1=true` is Staging-only.
  Production remains disabled. Real student end-to-end and source-fidelity
  tests cannot pass before the private corpus is uploaded/indexed.
- **Merged/verified:** Santo PR #83 at
  `730a443ec1f327cf14fa6918d5332aa45d093585` passed post-merge
  Verify `38500681584` and Staging Worker deployment `38500681521`
  (healthy worker; anonymous library reads and citation article requests
  denied with HTTP 401). No production Santo deployment.
- Royal Bank PR #111 merged at
  `0226e8ed5e1c381c4ca640b5d37ee1cc26f433b7`; Verify
  `38500696262` SUCCESS and Vercel statuses for `royal-bank-fmg3`
  and `royal-bank-effi` report successful deployments.
- **Not accepted yet:** true authenticated citation-to-article read and
  cross-library search cannot pass before uploading 74,579 objects to
  private Staging R2, registering five AI Search instances and checking
  indexing. Issue #82 and Pilot #58 stay OPEN. No false 'library live' claim.

### Private GitHub Actions medical corpus import — PR #85 (14 October 2026)

- **User decision:** orchestrate the medical corpus deployment from GitHub Actions,
  not from their Windows workstation. Existing `santoreno` repository is
  **PUBLIC**; committing the 71 MiB licensed ZIP or using a public Release
  would reveal third-party article content. Do not do that.
- PR #85 adds manual, reviewer-gated `medical-library-private-r2-import.yml`
  to download only a SHA-256 pinned bundle from a **separate PRIVATE GitHub
  repository Release**, validate 74,579 objects and 5 expected library counts,
  then optionally upload to `santo-content-staging` with scoped R2 S3 keys,
  verify remote object counts/head metadata, and configure five restricted
  R2-backed AI Search instances.
- Separate negative safety tests reject tampered checksums, directory
  traversal, unexpected .sqlite/text entries and incomplete archives.
  Requires manual approval and explicit staging-only confirmation for R2
  uploads; dry-run is default. Production never targeted.
- Exact known 71 MiB ZIP SHA-256:
  `708398d7b8fcc8b2b6b82142a2e819a8d322d30596f8a892eda57672b7eaa700`.
  Private source archive currently resides in this conversation, **not**
  in a private GitHub Release; no private R2 upload or AI Search index
  creation performed. GitHub connector cannot upload the 71 MiB
  conversation file to a private release or create that private source repo.
- **Owner prerequisite:** create private source repo + private release
  asset; configure `SANTO_PRIVATE_LIBRARY_REPO` variable and protected
  environment secrets (private repo read token, bucket-scoped R2 S3
  credentials, AI Search service token). See
  `docs/GITHUB_MEDICAL_LIBRARY_IMPORT.md`.
- PR, merge, protected staging workflow run and live corpus indexing
  **not yet verified** at this checkpoint. Issue #82 / Phase 10 #58
  remain OPEN until actual end-to-end sourced-reader acceptance.

## 9. Next action

**Royal Bank Pilot staging checkpoint — 2026-10-14:**

- Royal Bank WorkOS Staging organization created; designated AuthKit owner accepted the invitation.
- PR #65 fixes Super Admin + explicitly owned tenant access, with matching WorkOS org and D1 owner membership.
- PR #65 merged as `9cba22c85b29ece0a063fe1be72ec5a7b92e2208`; post-merge Verify `38474767800` passed.
- PR #66 merged as `ff13751fb82c796bfc1efab7c3c3a4b12e0b5907`; post-merge Verify `38475058909` passed.
- **Staging Worker deployed and healthy:** Pilot Staging Worker Deploy `38475058919` SUCCESS.
- Royal Bank Vercel has server-only Santo API origin and default quota configured.
- **NOT DONE:** Santo tenant creation, tenant quota bootstrap, credential issue, Vercel Santo server key, Vercel BLOCKED release, real Royal browser acceptance, licensed corpus ingestion.
- Issue #58 has exact operational evidence in the Royal Bank staging checkpoint comment.

**Active: Issue #58 Phase 10 Pilot acceptance; code implementation is merged,
real host acceptance still pending.**

Do NOT rewrite the completed conversation, AI, citation or quota engines.
The next user-agreed handoff is: confirm licensed medical sample dataset and
ingest into the global Santo AI Search/R2 library with stable metadata and
verified citation/image mapping; configure tenant cap and per-student quotas;
integrate `dist/browser/santo-ai.js` with the authenticated backend of an
existing website following `docs/PILOT_SITE_INTEGRATION.md`; run real browser,
mobile, HTTP/auth, quota, source and retry acceptance. Use exact live evidence,
not synthetic-only fixtures, before closing Issue #58 or claiming Pilot live.

Full Santo customer portal, advanced branding, analytics and billing are
deferred until after this Pilot. Never expose server credentials to browsers.

## 10. Repository administration note

Branch protection/ruleset configuration remains an authorized-admin follow-up under Issue #10 because the connected GitHub integration cannot write that repository setting.
