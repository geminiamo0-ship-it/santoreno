# Environment configuration

Santo keeps environment shape explicit without committing secrets.

- `local.json` is the locally simulated Cloudflare foundation used by CI smoke tests.
- `staging.json` is the staging resource contract.
- `production.json` is the production resource contract.
- Secret values belong in the relevant deployment secret store and must never be committed.
- D1 database UUIDs are intentionally `null` until the corresponding Cloudflare resources are actually provisioned; do not invent or copy IDs between environments.

Binding names are stable across environments (`CONTROL_DB`, `CONTENT_BUCKET`, `TENANT_METER`, `CONVERSATION`, `EVENT_QUEUE`, `USAGE_ANALYTICS`, `AI_SEARCH`). Resource names vary by environment and are documented here and in `docs/CLOUDFLARE_FOUNDATION.md`.
