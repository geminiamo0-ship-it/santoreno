# Santo Project Status — Living Handoff

> **Repository:** `geminiamo0-ship-it/santoreno`
> **Product:** Santo
> **Purpose:** This file is the first place any new developer, coding agent, or AI assistant should read before changing the repository.
>
> **Rule:** Update this file whenever meaningful work is completed, a gate passes/fails, architecture changes, or priorities change.

## 1. Current state

Santo is a standalone B2B2C medical AI SaaS platform. Customer sites embed Santo while Santo centrally owns AI infrastructure, global medical knowledge, AI Search, quota enforcement, sources/citations, images, usage, security, and tenant administration.

Customer production databases remain untouched. Integration is API-based only.

**Phase 0 is complete.** PR **#11** is merged to `main`, and post-merge GitHub Actions `Verify` run **37155527270** passed. The pnpm/Turborepo workspace, minimal portal/API/widget/contracts packages, strict tooling, CI, and runtime smoke checks are now the verified baseline.

## 2. Source-of-truth documents

Read in this order before implementation:

1. `PROJECT_STATUS.md` — current state and handoff.
2. `SANTO_MASTER_PLAN.md` — complete product/architecture plan.
3. `docs/ENGINEERING_GUARDRAILS.md` — mandatory anti-spaghetti and quality rules.
4. `AGENTS.md` — operational instructions for coding agents/AI assistants.
5. `CONTRIBUTING.md` — branch/PR/verification workflow.
6. GitHub Issue **#8** — ordered implementation roadmap and release gates.
7. GitHub Issues **#1–#7** — active Phase 0–5 backlog plus first grounded AI vertical slice.

## 3. Active implementation order

Do not reorder these without documenting the reason.

- [x] **#1 — P0:** Bootstrap Santoreno monorepo and CI
- [ ] **#2 — P1:** Provision Cloudflare foundation and bindings
- [ ] **#3 — P2:** Minimal B2B auth, tenancy, and tenant isolation
- [ ] **#4 — P3:** Customer server credentials and domain controls
- [ ] **#5 — P4:** Implement `/v1/session/exchange` for external users
- [ ] **#6 — P5:** Implement atomic `TenantMeterDO` quota engine
- [ ] **#7 — Vertical Slice:** One minimal grounded AI endpoint

Umbrella roadmap: **#8**.

Engineering guardrails: **#9**.

Repository administration / branch-protection task: **#10**.

## 4. Hard architecture gates

### Portal gate

**Do not build the full customer portal before #5 and #6 are proven.**

Before that, portal work is limited to the smallest surfaces needed for:

- admin authentication
- tenant creation
- tenant context
- credential issuance/rotation testing

Do not build polished Users, Plans, Usage, Branding, Billing, analytics dashboards, or elaborate navigation before the identity and quota gates pass.

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
- All Santo global medical libraries are available to all customers

## 6. Core architecture rules

- Tenant identity must come from authenticated context, never arbitrary browser input.
- Every external user lookup is scoped by `tenant_id + external_user_id`.
- Quota is server-side, atomic, and idempotent.
- Customer server secrets never enter browser bundles.
- Browser code never receives Cloudflare, R2, AI Search, or model provider credentials.
- No tenant-specific code forks or `if tenant === "medpark"` business logic.
- AI output is structured; never render arbitrary model-generated HTML.
- Citations must resolve to retrieved source IDs.
- Customer database stays untouched.

## 7. Completion/update protocol

Whenever work is completed:

1. Update the relevant GitHub issue checklist.
2. Add a concise issue comment with evidence: commit/PR/tests/result.
3. Close the issue only when all acceptance criteria pass.
4. Update Issue #8 if roadmap status or sequencing changed.
5. Update this `PROJECT_STATUS.md` checklist and the **Last completed work** section below.
6. Record major architecture decisions in `docs/adr/` when they materially affect future implementation.
7. Never claim a task is complete based only on code existing; required tests/gates must pass.
8. Every meaningful code/infrastructure step must pass GitHub Actions `Verify` before it is marked complete.

## 8. Last completed work

- Repository created: `geminiamo0-ship-it/santoreno`.
- `SANTO_MASTER_PLAN.md` committed to `main`.
- GitHub backlog created for Phase 0–5 and the first grounded AI vertical slice: Issues #1–#7.
- Umbrella roadmap and release gates created: Issue #8.
- Engineering continuity/anti-spaghetti documentation established under Issue #9.
- Pull request template added with architecture, verification, documentation, and rollback checks.
- ADR template added at `docs/adr/TEMPLATE.md`.
- `CODEOWNERS` added for repository ownership.
- Dependabot configured for npm and GitHub Actions updates.
- `CONTRIBUTING.md` added with branch, PR, Conventional Commit, and definition-of-done rules.
- Main-branch protection requirements documented in `docs/BRANCH_PROTECTION.md`.
- GitHub Actions `.github/workflows/verify.yml` added as the mandatory verification gate.
- README exposes the live `Verify` badge and verification rule.
- Repository-admin follow-up for actual `main` protection is tracked in Issue #10 because the connected integration cannot write branch-protection settings.
- **Phase 0 / Issue #1 is complete and merged via PR #11.** The repository now has a pinned pnpm workspace and lockfile, Turborepo, strict shared TypeScript config, Oxlint + Prettier, a minimal React Router/Vite portal shell, a minimal Hono Worker, shared Zod contracts, and a minimal Lit `<santo-ai>` package.
- The Phase 0 `Verify` gate runs frozen install, lint, typecheck, tests, build, and `pnpm smoke`. Smoke verifies the portal boots, the local Worker boots and serves the expected `/health` response, and portal/Worker/widget artifacts exist.
- PR acceptance `Verify` run `37155454786` passed on the final branch state.
- Post-merge `main` `Verify` run `37155527270` passed for merge commit `defcd8ff951c118387c3ffe7d3d61198a1840bb0`.

## 9. Next action

Start **Issue #2 — P1 Provision Cloudflare foundation and bindings**.

Do not skip directly to portal UI, billing, complete widget UX, tenancy, session exchange, quota, or advanced AI features out of documented order.

## 10. Verification policy

The workflow `.github/workflows/verify.yml` is the default machine-verification gate.

With the Phase 0 workspace present, it requires:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

The smoke gate verifies the Phase 0 runtime acceptance criteria, not just compilation: portal boot, local Worker boot with `/health`, and expected build artifacts including the Lit widget output.

A step is not considered complete until its relevant automated verification passes and the result is recorded in the issue/PR.

Branch protection/ruleset configuration is also required for `main` as documented in `docs/BRANCH_PROTECTION.md`. The currently connected GitHub integration does not expose a branch-protection write operation, so the actual repository setting must be enabled through an authorized GitHub administration surface and then verified separately.
