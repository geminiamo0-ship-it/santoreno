# Cloudflare foundation

Issue #2 owns the first Santo Cloudflare infrastructure layer. This document records the stable resource and binding contract so later phases do not invent names independently.

## Stable Worker bindings

| Binding           | Resource                 | Purpose                                            |
| ----------------- | ------------------------ | -------------------------------------------------- |
| `CONTROL_DB`      | D1                       | Santo control-plane relational data and migrations |
| `CONTENT_BUCKET`  | R2                       | Santo-owned content/assets                         |
| `TENANT_METER`    | SQLite Durable Object    | Future strongly consistent tenant quota state      |
| `CONVERSATION`    | SQLite Durable Object    | Future conversation coordination/state             |
| `EVENT_QUEUE`     | Queue                    | Async Santo events and delivery work               |
| `USAGE_ANALYTICS` | Workers Analytics Engine | High-cardinality usage telemetry                   |
| `AI_SEARCH`       | AI Search namespace      | Santo global retrieval namespace                   |

## Resource names

### Local

- Worker: `santo-api`
- D1: `santo-control-plane-local`
- R2: `santo-content-local`
- Queue: `santo-events-local`
- Analytics Engine dataset: `santo_usage_local`
- AI Search: intentionally not simulated; local code skips this binding

### Staging

- Worker: `santo-api-staging`
- D1: `santo-control-plane-staging`
- R2: `santo-content-staging`
- Queue: `santo-events-staging`
- Analytics Engine dataset: `santo_usage_staging`
- AI Search namespace: `default`

### Production

- Worker: `santo-api`
- D1: `santo-control-plane`
- R2: `santo-content`
- Queue: `santo-events`
- Analytics Engine dataset: `santo_usage`
- AI Search namespace: `default`

## Durable Objects

`TenantMeterDO` and `ConversationDO` are declared with SQLite storage. Phase 1 only proves namespace/binding reachability; quota and conversation behavior remain explicit non-goals until their later phases.

## D1 migrations

Migrations live in `workers/api/migrations/` and are applied through Wrangler. The first migration creates only the `infra_smoke_events` table used to prove Queue dequeue + D1 reachability.

Local verification:

```text
pnpm --filter @santo/api run d1:migrate:local
```

Remote staging migration must not run until `santo-control-plane-staging` has been provisioned and its real UUID has been written into the staging D1 binding.

## Smoke endpoints

`GET /__infra/smoke` checks D1, R2, both Durable Object bindings, Queue enqueue, Analytics Engine write dispatch, and AI Search when a remote binding exists. AI Search is deliberately `skipped` locally because it is a remote-only service in local development.

`GET /__infra/queue-smoke/:eventId` verifies that the Queue consumer handled the test event and persisted the receipt in D1.

Both endpoints return `404` in production. They never return resource IDs, account identifiers, credentials, tokens, bucket contents, search results, or free-form infrastructure exceptions.

## Remaining account-side provisioning gate

Repository configuration alone cannot create the real staging D1 UUID or prove a staging deployment. Before Issue #2 can close, an authenticated Cloudflare administration surface must create/confirm the staging resources, populate the real D1 UUID, deploy `--env staging`, apply the D1 migration remotely, and run the staging smoke path. Do not mark those acceptance criteria complete based only on local simulation.
