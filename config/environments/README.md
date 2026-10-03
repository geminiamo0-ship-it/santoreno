# Environment configuration

Santo keeps environment shape explicit without committing secrets.

- `local.json` documents local defaults.
- `staging.json` documents staging identity only.
- `production.json` documents production identity only.
- Secret values belong in the relevant deployment secret store and must never be committed.

Cloudflare resource bindings are intentionally deferred to Phase 1 / Issue #2.
