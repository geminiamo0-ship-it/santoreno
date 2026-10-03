# Santo (`santoreno`)

[![Verify](https://github.com/geminiamo0-ship-it/santoreno/actions/workflows/verify.yml/badge.svg)](https://github.com/geminiamo0-ship-it/santoreno/actions/workflows/verify.yml)

Santo is a standalone multi-tenant medical AI SaaS platform designed to be embedded into external websites with minimal integration work.

## Start here

Before changing code, read:

1. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — current progress, gates, and next action.
2. [`SANTO_MASTER_PLAN.md`](./SANTO_MASTER_PLAN.md) — complete architecture and product plan.
3. [`docs/ENGINEERING_GUARDRAILS.md`](./docs/ENGINEERING_GUARDRAILS.md) — mandatory engineering/anti-spaghetti rules.
4. [`AGENTS.md`](./AGENTS.md) — instructions for coding agents and AI assistants.
5. [`CONTRIBUTING.md`](./CONTRIBUTING.md) — branch, PR, verification, and definition-of-done rules.
6. GitHub Issue **#8** — implementation roadmap.

## Verification rule

Every meaningful implementation step must pass GitHub Actions **Verify** before it is marked complete.

Once Phase 0 creates the pnpm workspace, the workflow requires frozen install, lint, typecheck, tests, and build.

## Current implementation focus

```text
#1 Bootstrap monorepo + CI
#2 Cloudflare foundation
#3 Minimal B2B auth/tenancy/isolation
#4 Customer server credentials
#5 /v1/session/exchange
#6 Atomic TenantMeterDO quota engine
#7 Minimal grounded AI endpoint
```

**Do not build the full tenant portal before session exchange and the quota engine are proven.**

## Product principle

> Build once, embed anywhere.

Customer databases remain untouched. Santo centrally manages AI infrastructure, global medical knowledge, grounded retrieval, quota, usage, sources/citations, images, and tenant administration.
