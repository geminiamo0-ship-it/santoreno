# Santo Project Status — Living Handoff

> **Repository:** `geminiamo0-ship-it/santoreno`
> **Product:** Santo
> **Purpose:** This file is the first place any new developer, coding agent, or AI assistant should read before changing the repository.
>
> **Rule:** Update this file whenever meaningful work is completed, a gate passes/fails, architecture changes, or priorities change.

## 1. Current state

Santo is a standalone B2B2C medical AI SaaS platform. Customer sites embed Santo while Santo centrally owns AI infrastructure, global medical knowledge, AI Search, quota enforcement, sources/citations, images, usage, security, and tenant administration.

Customer production databases remain untouched. Integration is API-based only.

## 2. Source-of-truth documents

Read in this order before implementation:

1. `PROJECT_STATUS.md` — current state and handoff.
2. `SANTO_MASTER_PLAN.md` — complete product/architecture plan.
3. `docs/ENGINEERING_GUARDRAILS.md` — mandatory anti-spaghetti and quality rules.
4. `AGENTS.md` — operational instructions for coding agents/AI assistants.
5. GitHub Issue **#8** — ordered implementation roadmap and release gates.
6. GitHub Issues **#1–#7** — active Phase 0–5 backlog plus first grounded AI vertical slice.

## 3. Active implementation order

Do not reorder these without documenting the reason.

- [ ] **#1 — P0:** Bootstrap Santoreno monorepo and CI
- [ ] **#2 — P1:** Provision Cloudflare foundation and bindings
- [ ] **#3 — P2:** Minimal B2B auth, tenancy, and tenant isolation
- [ ] **#4 — P3:** Customer server credentials and domain controls
- [ ] **#5 — P4:** Implement `/v1/session/exchange` for external users
- [ ] **#6 — P5:** Implement atomic `TenantMeterDO` quota engine
- [ ] **#7 — Vertical Slice:** One minimal grounded AI endpoint

Umbrella roadmap: **#8**.

Engineering guardrails: **#9**.

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

## 8. Last completed work

- Repository created: `geminiamo0-ship-it/santoreno`.
- `SANTO_MASTER_PLAN.md` committed to `main`.
- GitHub backlog created for Phase 0–5 and the first grounded AI vertical slice: Issues #1–#7.
- Umbrella roadmap and release gates created: Issue #8.
- Engineering continuity/anti-spaghetti documentation is being established as part of Issue #9.

No implementation phase (#1–#7) has been marked complete yet.

## 9. Next action

Start with **Issue #1 — P0 Bootstrap Santoreno monorepo and CI**.

Do not skip directly to portal UI, billing, complete widget UX, or advanced AI features.
