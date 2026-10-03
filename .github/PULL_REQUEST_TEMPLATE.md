## Summary

Describe the change and why it is needed.

## Related issue

Closes #

## Architecture checklist

- [ ] I read `PROJECT_STATUS.md`, `AGENTS.md`, and `docs/ENGINEERING_GUARDRAILS.md`.
- [ ] This change preserves package/layer boundaries.
- [ ] Tenant scope is explicit and derived from authenticated context where applicable.
- [ ] I did not add customer-specific business logic or a tenant-specific fork.
- [ ] I did not duplicate core business logic.
- [ ] New network/data contracts are schema-validated.
- [ ] Any schema change is implemented through a migration.
- [ ] Concurrency/idempotency concerns are handled where applicable.
- [ ] No server secret, Cloudflare credential, model credential, or sensitive token is exposed to browser code.
- [ ] AI citations remain server-validated where applicable.

## Verification

- [ ] GitHub Actions `Verify` passed for this change.
- [ ] Relevant unit/integration/security/load tests were added or updated.
- [ ] Manual verification was performed only where automation is not practical and is documented below.

### Evidence

Paste the relevant GitHub Actions run, test output, screenshots, or concise verification notes.

## Documentation / continuity

- [ ] The related issue checklist was updated.
- [ ] `PROJECT_STATUS.md` was updated if project state changed.
- [ ] Issue #8 was updated if roadmap sequencing/status changed.
- [ ] An ADR was added/updated if this changes a major architecture decision.

## Risk and rollback

Describe meaningful failure modes and how this change can be rolled back safely.
