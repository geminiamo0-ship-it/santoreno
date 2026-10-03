# Engineering Guardrails — Santo

These rules are mandatory for implementation inside `santoreno`.

Their purpose is to keep Santo maintainable as it grows from the first vertical slice to a multi-tenant production SaaS.

## 1. Dependency direction

Use clear boundaries:

```text
Route / Controller
      ↓
Validation / Contract
      ↓
Use Case / Service
      ↓
Domain Logic
      ↓
Repository / Durable Object / External Adapter
```

Avoid routes that directly combine authentication, SQL, Durable Objects, AI Search, model calls, quota mutation, and response formatting.

## 2. Package boundaries

Expected top-level ownership:

- `apps/portal` — portal UI and route orchestration
- `workers/api` — HTTP/API composition
- `packages/contracts` — shared schemas/types/contracts
- `packages/widget` — embeddable Lit component only
- `packages/ui` — reusable Santo UI primitives when justified
- data-access code — explicit repository/adapters, not scattered queries

Rules:

- Portal must not directly access D1, Durable Objects, R2, or AI Search.
- Widget must not import Portal code.
- Infrastructure adapters must not depend on UI packages.
- Domain/business logic must not depend on React/Lit components.
- Avoid circular dependencies.

## 3. Route rule

A route should generally do only:

1. Parse request.
2. Authenticate/authorize.
3. Validate schema.
4. Call one use case/service.
5. Map a typed result to an HTTP response.

If a route contains substantial quota, tenant, SQL, search, or model logic, refactor it.

## 4. Business logic

Keep core rules in one place.

Examples that must not be duplicated:

- tenant resolution
- credential verification
- session token verification
- quota calculation
- reservation/finalization/release policy
- user/tenant suspension checks
- citation validation

Do not copy the same rule between portal/API/widget code.

## 5. Tenant rule

Never add customer-specific branches such as:

```ts
if (tenantId === 'medpark') { ... }
```

Customer differences must be configuration or data-driven.

Any requested tenant-specific behavior must first be evaluated as a generic product capability.

## 6. TypeScript rule

Use strict TypeScript.

- Avoid `any`.
- Avoid unsafe type assertions unless locally justified.
- Do not suppress compiler errors to make CI pass.
- Shared external contracts must be schema-validated, not types-only.

## 7. Contracts

Use shared Zod/OpenAPI-compatible schemas for:

- API request bodies
- API responses
- event payloads
- session exchange
- structured AI responses
- webhook payloads

Do not maintain independent handwritten interfaces for the same network contract in multiple packages.

## 8. Errors

Use structured error codes.

Examples:

```text
AUTH_INVALID
AUTH_EXPIRED
TENANT_SUSPENDED
USER_SUSPENDED
TENANT_QUOTA_EXHAUSTED
USER_QUOTA_EXHAUSTED
RATE_LIMITED
SEARCH_FAILED
MODEL_FAILED
MODEL_TIMEOUT
CITATION_INVALID
INTERNAL_ERROR
```

Do not make product behavior depend on matching free-form error strings.

## 9. Data access

- Schema changes happen through migrations.
- Do not manually mutate production schema outside the migration path.
- Keep D1 queries in explicit data-access/repository code.
- Do not scatter SQL across HTTP handlers and UI loaders.
- All tenant data queries must contain explicit tenant scope.

## 10. Durable Object rules

Durable Objects own hot strongly-consistent state where designed.

For quota:

- reserve/finalize/release must be atomic
- all three must be idempotent
- idempotency keys must have deterministic semantics
- state transitions must be testable

Do not write a second quota implementation outside `TenantMeterDO`.

## 11. AI boundary

Separate:

```text
retrieval
prompt/context construction
model adapter
citation validation
response shaping
```

Do not create one giant `askAI()` function that owns everything.

The model is not trusted to authorize data, charge quota, choose tenant context, or invent source metadata.

## 12. Files and size

File length is a signal, not an absolute law.

When a file approaches roughly 300–400 lines, explicitly review whether it contains multiple responsibilities.

Split by responsibility, not arbitrary line count.

Avoid giant service classes and generic `utils.ts` dumping grounds.

## 13. Naming

Prefer explicit names:

```text
exchangeExternalUserSession
reserveQuota
finalizeQuotaReservation
verifyTenantServerCredential
resolveRetrievedCitation
```

Avoid vague names such as:

```text
handleData
doStuff
processRequest
helper
common
misc
```

## 14. Magic values

Centralize:

- error codes
- roles
- event names
- default timeouts
- quota policy constants
- token audiences/issuers
- retry policy

Do not scatter magic strings or unexplained numeric values across the codebase.

## 15. Observability

Use structured logging.

Include safe identifiers such as:

```text
request_id
tenant_id
conversation_id
operation
status
latency
error_code
```

Avoid random `console.log()` debugging in merged production code.

Do not log server secrets, auth tokens, or unnecessary medical/user content.

## 16. Testing requirements

Core changes require tests.

Mandatory regression areas:

- cross-tenant isolation
- server-secret revocation/rotation
- session token tampering/expiry
- quota concurrency
- quota idempotency
- reserve/finalize/release transitions
- suspension behavior
- citation validation

Prefer meaningful integration tests over large volumes of snapshots.

## 17. Definition of done

Code existing is not enough.

A task is done only when:

- acceptance criteria pass
- required tests pass
- CI passes
- issue checklist is updated
- implementation evidence is posted to the issue
- relevant project status is updated

## 18. Dependency policy

Before adding a package, ask:

- Is this capability already provided by the platform/runtime?
- Does this dependency materially reduce complexity?
- Is it actively maintained?
- Is its size/runtime cost justified?
- Are we locking core business logic to it unnecessarily?

Avoid dependency accumulation for trivial helpers.

## 19. Abstraction policy

Do not over-engineer the first use case.

Create abstractions when there is a real boundary or multiple implementations are likely/known.

Good early abstractions:

- model adapter boundary
- retrieval adapter boundary
- credential verifier
- typed repository boundary

Bad early abstractions:

- factories around every service
- generic event buses for one event
- plugin systems before a second plugin exists
- microservices without isolation/scaling need

## 20. Feature flags/configuration

For behavior that may roll out gradually, prefer explicit configuration/feature flags over permanent branching scattered through business logic.

Feature flags must have an owner and eventual cleanup plan.

## 21. Security invariants

Never merge code that breaks these invariants:

- tenant identity is authenticated
- customer DB is not directly accessed
- server secrets are not browser-visible
- external users are scoped by tenant
- quota is server-side
- citations are server-validated
- model output is not rendered as arbitrary HTML

## 22. Pull request review checklist

Every PR should answer:

- Does this preserve package/layer boundaries?
- Is tenant scope explicit?
- Is business logic duplicated?
- Did we add unnecessary abstraction or dependency?
- Are network/data contracts validated?
- Are error codes structured?
- Are logs safe and structured?
- Does this need a migration?
- Are concurrency/idempotency concerns handled?
- Are tests sufficient?
- Does this require an ADR?
- Did the related issue/status documentation get updated?

## 23. Architecture Decision Records

For major decisions, add:

```text
docs/adr/NNNN-short-title.md
```

Each ADR should contain:

- Context
- Decision
- Alternatives considered
- Consequences
- Date/status

Use ADRs for decisions future developers are likely to question or reverse accidentally.

## 24. Current sequencing rule

Do not build the full tenant portal before session exchange and the atomic quota engine are proven.

Current implementation order is tracked in `PROJECT_STATUS.md` and GitHub Issue #8.

## 25. Golden rule

Before merging, ask:

> Does this make Santo easier or harder for the next developer to understand, test, and change safely?

If the answer is harder without a justified product or infrastructure benefit, redesign it.
