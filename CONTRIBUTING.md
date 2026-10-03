# Contributing to Santo

Santo uses GitHub as the source of truth for implementation state and verification.

## Before changing code

Read, in order:

1. `PROJECT_STATUS.md`
2. `SANTO_MASTER_PLAN.md`
3. `docs/ENGINEERING_GUARDRAILS.md`
4. `AGENTS.md`
5. GitHub Issue #8 and the active implementation issue

## Branch and PR workflow

1. Create a focused branch from `main`.
2. Make one coherent change tied to an issue.
3. Add or update tests with the implementation.
4. Push the branch and open a PR.
5. GitHub Actions `Verify` must pass.
6. Record verification evidence in the PR and related issue.
7. Merge only after required checks and acceptance criteria pass.
8. Update `PROJECT_STATUS.md` when project state changes.

Avoid unrelated changes in the same PR.

## Commit style

Use Conventional Commit-style prefixes:

```text
feat: add session exchange endpoint
fix: prevent duplicate quota reservation
infra: add D1 staging binding
test: add tenant isolation regression
refactor: separate citation validation service
docs: update project handoff
chore: update tooling
```

Optional scopes are allowed when useful:

```text
feat(api): add tenant credential verifier
fix(quota): make release idempotent
```

Do not optimize for perfectly formatted history at the cost of clarity. Commit messages should state what changed.

## Definition of done

A task is complete only when:

- acceptance criteria pass
- required tests exist and pass
- GitHub Actions `Verify` is green
- security/concurrency gates relevant to the change pass
- the issue checklist is current
- evidence is posted to the issue/PR
- `PROJECT_STATUS.md` is updated when applicable

Code existing on a branch is not completion.

## Architecture discipline

Follow `docs/ENGINEERING_GUARDRAILS.md`.

In particular:

- no direct portal/widget access to D1, Durable Objects, R2, or AI Search
- no tenant-specific business forks
- no direct customer database access
- no duplicated quota implementation
- tenant scope must be authenticated and explicit
- network/data contracts must be schema-validated
- AI citations must be server-validated
- schema changes must use migrations

## ADRs

For a material architecture decision, copy:

```text
docs/adr/TEMPLATE.md
```

into:

```text
docs/adr/NNNN-short-title.md
```

and fill in context, decision, alternatives, consequences, and verification.

## Verification principle

Every meaningful implementation step must have machine-verifiable evidence where practical. GitHub Actions is the default verification surface.

Manual verification is supplementary, not a replacement for tests that can reasonably be automated.
