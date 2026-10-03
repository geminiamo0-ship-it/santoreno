# Santoreno — Santo SaaS Master Plan

> **Repository:** `santoreno`  
> **Product brand:** **Santo**  
> **Document purpose:** End-to-end architecture, implementation, security, integration, product, and rollout plan for the Santo SaaS platform.

---

# 1. Executive Summary

Santo is a standalone, multi-tenant SaaS platform that provides embeddable medical AI capabilities to external websites and applications.

Santo is **not** a feature of Royal Bank and is **not** tied to MedPark or any single customer.

The product should allow any customer platform to embed Santo with minimal development effort while Santo centrally owns and manages:

- AI infrastructure
- Medical knowledge libraries
- Cloudflare AI Search
- Retrieval and RAG logic
- AI models
- Sources and citations
- Medical images
- Conversations
- User quotas
- Tenant quotas
- Usage analytics
- Customer portal
- Customer team permissions
- Branding
- API credentials
- Security
- Audit logs
- Subscription state
- White-label capabilities

The customer platform remains responsible for its own:

- Authentication
- Database
- Payments
- User accounts
- Website backend
- Application business logic

Santo must **never require direct access to the customer's production database**.

The integration boundary is API-based only.

---

# 2. Business Model

Santo is primarily a **B2B2C SaaS platform**.

```text
Santo
  ↓
Customer Platform / Tenant
  ↓
Customer's End Users
```

Examples:

```text
Santo → MedPark → MedPark students
Santo → Royal Bank → Royal Bank users
```

The customer can resell Santo access to its users using its own pricing model.

Initial billing model:

```text
End User
   ↓ pays
Customer Platform
   ↓ pays
Santo
```

Avoid marketplace revenue splitting in the MVP.

Do not initially implement:

- split payments
- merchant payouts
- reseller tax calculations
- KYC for customer end users
- customer-specific payment logic

---

# 3. Global Product Principle

All Santo customers receive access to the same global medical knowledge ecosystem.

There are **no tenant-specific library restrictions** in the initial product.

```text
Royal Bank  → ALL Santo libraries
MedPark     → ALL Santo libraries
Customer C  → ALL Santo libraries
```

Library selection inside the UI is a **search filter**, not an access-control feature.

```text
All Libraries
MRCP
USMLE
NBME
Guidelines
Cardiology
Pharmacology
...
```

This means:

- No duplicated library infrastructure per tenant.
- No separate AI Search per customer.
- No separate R2 bucket per customer.
- A new Santo library becomes available to all active customers automatically.

---

# 4. Final Recommended Technology Stack

| Layer | Technology |
|---|---|
| Language | TypeScript |
| Monorepo | pnpm + Turborepo |
| Portal | React + React Router v8 + Vite |
| Data fetching | TanStack Query |
| Tables | TanStack Table |
| Styling | Tailwind CSS + Radix primitives |
| Validation | Zod |
| API | Hono + Cloudflare Workers |
| Widget | Lit + Web Components + Shadow DOM |
| Portal Auth | WorkOS AuthKit |
| Control DB | Cloudflare D1 |
| Hot quota/state | SQLite Durable Objects |
| Assets | Cloudflare R2 |
| Retrieval | Cloudflare AI Search |
| Async | Cloudflare Queues |
| Analytics | Workers Analytics Engine |
| Security | WAF + Rate Limiting + Turnstile |
| Testing | Vitest + Playwright |
| CI/CD | GitHub Actions + Wrangler |
| API docs | OpenAPI |

Use TypeScript across Portal, API, Worker, SDK, Widget, shared schemas, and tests.

---

# 5. Repository Structure

Use one monorepo:

```text
santoreno/
│
├── apps/
│   └── portal/
│       ├── marketing/
│       ├── tenant/
│       └── super-admin/
│
├── workers/
│   └── api/
│
├── packages/
│   ├── widget/
│   ├── sdk/
│   ├── contracts/
│   ├── ui/
│   ├── auth/
│   └── config/
│
├── database/
│   ├── migrations/
│   └── seeds/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── security/
│   └── load/
│
├── infrastructure/
│   └── cloudflare/
│
├── docs/
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

Do not split the system into many repositories initially.

---

# 6. Portal

Use one React Router application for:

- Public Santo website
- Customer portal
- Santo Super Admin

Use permission-based routing rather than separate applications unless future scale justifies separation.

Customer portal navigation:

```text
Overview
Users
Plans
Usage
Branding
Integration
Team
Billing
Settings
```

Super Admin navigation:

```text
Overview
Tenants
Global Usage
Global Users
Content
AI Search
Models
Costs
Billing
Security
Audit
System Health
Settings
```

---

# 7. API / Backend

Use Cloudflare Workers + Hono.

Primary API domain:

```text
api.santo.<domain>
```

The API owns:

- Tenant validation
- Session exchange
- Customer API authentication
- End-user authentication
- Quota enforcement
- Conversation creation
- AI Search
- RAG
- LLM requests
- Source resolution
- Image resolution
- Usage metering
- Rate limiting
- Audit events
- Webhooks
- Branding configuration
- Portal data APIs

The AI core must not depend on the frontend framework.

---

# 8. Universal Embeddable Widget

Use Lit + TypeScript + Web Components + Shadow DOM.

Core element:

```html
<santo-ai></santo-ai>
```

Hosted script:

```html
<script
  type="module"
  src="https://cdn.santo.<domain>/v1/widget.js">
</script>
```

The same widget must work in:

- Next.js
- React
- Vue
- Angular
- Laravel
- Django
- PHP
- WordPress
- Static HTML

Widget modes:

```html
<santo-ai mode="floating"></santo-ai>
<santo-ai mode="inline"></santo-ai>
<santo-ai mode="full"></santo-ai>
```

The widget handles:

- Customer branding
- Santo branding
- Chat UI
- Streaming
- Sources
- Citations
- Images
- Library filters
- Conversation history
- Quota display if enabled
- Mobile responsiveness
- Accessibility
- Retries
- Connection state
- Full-screen mode

The widget must never contain:

- Santo server secrets
- Cloudflare API tokens
- R2 credentials
- AI Search credentials
- Customer backend secrets

---

# 9. Branding

Customer portal controls:

- AI display name
- Customer logo
- Accent color
- Welcome message
- Widget position
- Light/dark behavior
- Powered by Santo visibility
- Launcher label

Example:

```text
MedPark AI
Powered by Santo
```

White-label customers may hide Santo branding if commercially allowed.

Santo controls the core UX and layout. Customers customize branding, not arbitrary UI architecture.

---

# 10. Authentication Model

There are two completely different user classes.

## 10.1 Portal users

Examples:

- MedPark Owner
- MedPark Admin
- MedPark Support
- Analyst
- Santo Super Admin

Recommended provider: WorkOS AuthKit.

## 10.2 Customer end users

End users stay authenticated by the customer platform.

Example:

```text
MedPark login
    ↓
MedPark identifies user 58392
    ↓
MedPark backend performs Santo session exchange
    ↓
Santo returns short-lived token
    ↓
Santo widget uses that token
```

Do not create Santo passwords/accounts for every customer end user.

---

# 11. Tenant Model

Every customer is a tenant.

Examples:

```text
royal-bank
medpark
customer-c
```

Suggested tenant fields:

```text
id
slug
name
status
workos_org_id
subscription_status
monthly_allowance
created_at
updated_at
```

Royal Bank becomes a normal Santo tenant.

---

# 12. Tenant Roles

## Owner

Can manage everything including billing, team, API credentials, branding, users, plans, quotas, and settings.

## Admin

Can manage users, quotas, plans, branding, and basic integration settings.

## Support

Can search users, view AI state, add permitted bonus quota, extend expiry, suspend/re-enable AI.

Cannot view secrets or modify billing/critical settings.

## Analyst

Read-only analytics/report access.

---

# 13. External User Identity

Primary Santo identity:

```text
tenant_id + external_user_id
```

Example:

```text
tenant_id = medpark
external_user_id = 58392
```

Optional metadata:

```text
email
display_name
metadata_json
```

Only store it when useful.

---

# 14. Integration Philosophy

Customer developer target:

```text
1. Add Santo secret
2. Install tiny Santo connector
3. Render <santo-ai>
4. Done
```

Customers should not implement:

- AI logic
- RAG
- Search logic
- Quota logic
- Usage logic
- Source rendering
- Image rendering
- AI Search access
- Cloudflare credentials

---

# 15. Session Exchange

Customer backend calls:

```http
POST /v1/session/exchange
```

using its Santo server secret.

Payload:

```json
{
  "external_user_id": "58392"
}
```

Santo returns a short-lived token.

Recommended claims:

```text
iss = Santo
aud = santo-ai
tenant = medpark
sub = 58392
session_id = ...
jti = ...
iat = ...
exp = ...
```

Recommended lifetime: 10–20 minutes.

The customer backend refreshes it when needed.

---

# 16. Customer Credentials

Each tenant receives:

```text
Tenant ID
Server secret
Webhook secret
```

Future optional keys:

```text
publishable key
restricted management key
read-only reporting key
```

All secrets support:

```text
create
rotate
revoke
last-used visibility
```

Never expose server secrets in browser JavaScript.

---

# 17. Framework Connectors

Core protocol remains generic.

Initial packages:

```text
@santo/server
@santo/widget
@santo/react
@santo/node
```

Later, based on actual demand:

```text
Santo Laravel
Santo PHP
Santo Django
Santo WordPress Plugin
```

Do not pre-build every possible framework integration.

---

# 18. Cloudflare Resources

Create Santo-specific infrastructure.

```text
Worker:      santo-api
D1:          santo-control-plane
R2:          santo-content
AI Search:   santo-medical namespace
DOs:         TenantMeterDO, ConversationDO
Queues:      santo-events, santo-webhooks (can start combined)
Analytics:   Santo usage dataset
```

Use staging and production resources separately.

---

# 19. D1 Role

D1 is the Santo Control Plane database.

Store:

- Tenants
- Tenant configuration
- Team metadata
- External users
- Plans
- Entitlements
- Quota configuration
- Subscription state
- Branding
- API key metadata
- Webhooks
- Audit summaries
- Conversation index metadata
- Billing metadata

Do not use D1 as the high-concurrency hot counter store for quota spending.

---

# 20. Initial D1 Tables

```text
tenants
tenant_domains
tenant_members
tenant_api_keys
tenant_settings

external_users
external_user_profiles

tenant_plans
user_entitlements
quota_adjustments

subscriptions
billing_accounts

widget_configs

webhook_endpoints
webhook_deliveries

conversation_index
library_catalog
audit_logs
```

Example tenant table:

```sql
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  workos_org_id TEXT UNIQUE,
  subscription_status TEXT,
  monthly_allowance INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Example external users table:

```sql
CREATE TABLE external_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, external_user_id)
);
```

---

# 21. Quota Model

At minimum:

```text
Tenant Quota
    ↓
User Quota
```

Example:

```text
MedPark allowance = 2,000,000 units/month

User A = 500
User B = 2,000
User C = 10,000
```

A customer may distribute user quotas but must never bypass the tenant-level Santo allowance.

User entitlement fields:

```text
Base quota
Bonus quota
Used quota
Remaining quota
Plan
Expiry
Status
```

Example:

```text
Base quota       2,000
Bonus quota        500
Used                820
Remaining          1,680
```

---

# 22. Quota Adjustments

Every manual adjustment is auditable.

Suggested fields:

```text
tenant_id
external_user_id
delta
reason
actor_id
created_at
expires_at
idempotency_key
```

Example:

```text
+500
Reason: support compensation
Actor: support@medpark
```

---

# 23. TenantMeter Durable Object

Recommended identity:

```text
one DO per tenant
```

Example:

```text
TenantMeterDO("medpark")
```

Responsibilities:

- Tenant allowance
- User quotas
- Atomic usage reservation
- Idempotency
- Live usage counters
- Burst protection
- User suspension checks
- Tenant suspension checks

Suggested internal SQLite tables:

```text
users
usage_cycles
quota_adjustments
reservations
idempotency
```

---

# 24. Atomic Quota Reservation

Flow:

```text
Request
   ↓
Verify session
   ↓
TenantMeterDO
   ↓
Check tenant active
   ↓
Check tenant allowance
   ↓
Check user active
   ↓
Check user quota
   ↓
Reserve usage atomically
   ↓
Continue AI request
```

On hard AI failure, reservation should be released/refunded according to policy.

Critical race test:

```text
remaining quota = 1
100 simultaneous requests
```

Required:

```text
1 allowed
99 rejected
```

Anything else is a release blocker.

---

# 25. Conversation Durable Object

Use:

```text
ConversationDO(conversation_id)
```

Responsibilities:

- Conversation state
- Follow-up context
- Message ordering
- Idempotent message submission
- Stream coordination
- Context summary
- Optional short-term cache

Do not require every historical message to live forever inside the DO.

---

# 26. Global Medical Knowledge

All Santo tenants use one global knowledge platform.

```text
Santo Global Knowledge
│
├── MRCP
├── USMLE
├── NBME
├── Guidelines
├── Cardiology
├── Neurology
├── Pharmacology
└── Future Libraries
```

---

# 27. AI Search Strategy

Use a Santo-wide namespace:

```text
santo-medical
```

Organize instances by library/domain where useful:

```text
mrcp
usmle
nbme
guidelines
cardiology
pharmacology
...
```

Default search:

```text
All Libraries
```

Optional user filters:

```text
MRCP only
USMLE only
Guidelines only
```

These are search filters, not tenant permissions.

---

# 28. R2 Role

Use R2 as canonical asset storage.

```text
santo-content/
│
├── sources/
│   ├── originals/
│   ├── normalized/
│   └── previews/
│
├── images/
│   ├── originals/
│   ├── thumbnails/
│   └── optimized/
│
├── exports/
├── backups/
└── static/
```

Store:

- Original source files
- Medical images
- Source previews
- Thumbnails
- Export artifacts
- Static Santo assets

---

# 29. Content Metadata

Every source should have structured metadata:

```text
source_id
library_id
title
edition
year
author
publisher
source_type
specialty
topic
subtopic
page
section
language
asset_ids
version
published_at
```

---

# 30. Content Ingestion Pipeline

```text
Upload source
    ↓
Validate
    ↓
Normalize
    ↓
Extract metadata
    ↓
Associate images
    ↓
Create stable source IDs
    ↓
Index AI Search
    ↓
Run retrieval QA
    ↓
Publish
```

Content supports:

```text
library_version
source_version
index_version
```

Do not silently replace underlying content without traceability.

---

# 31. Sources and Citations

The model must not invent citations.

Correct path:

```text
AI Search
   ↓
Retrieved chunk IDs
   ↓
LLM receives grounded context
   ↓
LLM references known IDs
   ↓
Santo resolves metadata
   ↓
Widget renders trusted citation
```

Example:

```text
[1] ESC Guidelines 2025 — Page 42
```

The frontend must not trust arbitrary citation text generated by the model.

---

# 32. Medical Images

Images are structured assets.

Metadata:

```text
asset_id
source_id
page
caption
alt_text
R2_key
mime_type
width
height
```

API example:

```json
{
  "images": [
    {
      "asset_id": "img_123",
      "caption": "Anterior STEMI ECG",
      "source_id": "src_55"
    }
  ]
}
```

---

# 33. AI Response Contract

Do not return arbitrary model-generated HTML.

Return structured data:

```json
{
  "conversation_id": "conv_123",
  "message_id": "msg_456",
  "answer": "...",
  "sections": [],
  "citations": [],
  "sources": [],
  "images": [],
  "related_topics": [],
  "usage": {
    "units_charged": 1,
    "remaining": 481
  }
}
```

Suggested streaming events:

```text
message.started
answer.delta
citation.available
image.available
usage.updated
message.completed
message.failed
```

---

# 34. AI Request Lifecycle

```text
Widget
  ↓
Verify Santo session
  ↓
Validate tenant
  ↓
Validate allowed domain
  ↓
Rate limit
  ↓
TenantMeterDO
  ↓
Reserve quota
  ↓
ConversationDO
  ↓
AI Search
  ↓
Build grounded context
  ↓
LLM
  ↓
Stream answer
  ↓
Resolve sources
  ↓
Resolve images
  ↓
Finalize quota
  ↓
Analytics Engine
  ↓
Queue async events
```

---

# 35. Customer Portal — Overview

Display:

```text
Active AI Users
Requests this month
Remaining tenant allowance
Current plan
Recent activity
Usage graph
Top users
Errors
Integration status
```

---

# 36. Customer Portal — Users

Search by:

```text
External User ID
Email
Display Name
```

Example:

```text
Ahmed Mohamed
ID: 58392
Plan: Premium
Used: 820 / 2000
Expires: Dec 31
```

Actions:

```text
Add quota
Set bonus quota
Change plan
Extend expiry
Suspend AI
Resume AI
View usage
View audit history
```

User drawer example:

```text
Ahmed Mohamed

Base quota       2,000
Bonus quota        500
Used                820
Remaining          1,680

[+100]
[+500]
[+1000]
[Custom]

Expiry
31 Dec 2026

[Extend 1 Month]
[Custom Date]

Status
Active

[Suspend AI]
```

Changes affect Santo only; the customer's database stays untouched.

---

# 37. Plans

Customers can create entitlement templates:

```text
Free       20 AI uses
Silver     500 AI uses
Gold       2,000 AI uses
Premium    10,000 AI uses
```

These are Santo entitlement templates, not necessarily customer payment plans.

---

# 38. Customer Management API

Optional server-side endpoints:

```text
GET    /v1/users/:id
POST   /v1/users/:id/quota
POST   /v1/users/:id/plan
POST   /v1/users/:id/suspend
POST   /v1/users/:id/resume
POST   /v1/users/:id/expiry
GET    /v1/users/:id/usage
```

These require authenticated server-side customer credentials.

---

# 39. Webhooks

Possible events:

```text
user.quota.low
user.quota.exhausted
user.suspended
tenant.quota.low
tenant.quota.exhausted
subscription.expiring
subscription.expired
integration.error
```

Webhook requirements:

- Signed payload
- Unique event ID
- Timestamp
- Retries
- Idempotency
- Delivery logs

---

# 40. Billing Model

Initial billing is tenant-level, not end-user-level.

Store:

```text
tenant
plan
billing status
allowance
overage configuration
renewal date
contract metadata
```

Possible commercial formula:

```text
Base tenant fee + AI usage + premium features
```

Externally use simple terms such as:

```text
AI Uses
AI Questions
Santo Credits
```

Internally track:

```text
input tokens
output tokens
model
AI Search operations
provider cost
estimated total cost
latency
```

---

# 41. Analytics Engine

Use Workers Analytics Engine for high-volume telemetry instead of writing every request to D1.

Dimensions:

```text
tenant
user
model
library
status
region
endpoint
```

Measures:

```text
latency
tokens
units
cost
search_ms
ttft_ms
total_ms
```

D1 remains for durable business records.

---

# 42. Queues

Use Cloudflare Queues for async work:

```text
usage events
analytics aggregation
webhooks
billing events
audit exports
notifications
cost aggregation
```

Consumers must be idempotent.

---

# 43. Audit Logging

Audit sensitive actions:

```text
actor
tenant
role
action
target
before
after
timestamp
request_id
context
```

Example:

```text
support@medpark added +500 quota to user 58392
```

---

# 44. Security Principles

Santo must enforce:

```text
Zero trust between tenants
No customer DB access
No secrets in browser
No AI Search credentials in browser
No R2 credentials in browser
Short-lived end-user sessions
Explicit role permissions
Strict tenant scoping
Validated structured output
Strong auditability
```

---

# 45. Tenant Isolation

Never trust arbitrary browser tenant identifiers.

Every tenant-scoped operation derives tenant identity from authenticated credentials.

Never query external users by:

```text
external_user_id
```

alone.

Always use:

```text
tenant_id + external_user_id
```

Automated IDOR tests must verify MedPark credentials cannot access Royal Bank data and vice versa.

---

# 46. Domain Security

A tenant may define allowed domains:

```text
medpark.com
www.medpark.com
```

Origin validation is useful but **is not authentication**.

Security depends primarily on server-issued Santo session tokens.

Copying the Santo script to another website must not grant access.

---

# 47. Rate Limiting

Apply separately from business quota.

Possible dimensions:

```text
IP
tenant
user
session
endpoint
```

Rate limiting protects infrastructure.

Quota controls commercial consumption.

---

# 48. WAF and Turnstile

Use Cloudflare WAF for API/portal/CDN protection.

Use Turnstile where appropriate:

- Portal registration
- Risky login flows
- Public forms
- Trial forms

Do not put Turnstile inside every authenticated AI request.

---

# 49. Secrets

Store production secrets securely.

Never commit:

```text
WorkOS secrets
LLM provider secrets
Webhook secrets
Santo signing secrets
Customer server secrets
```

to Git.

---

# 50. AI Output Security

Treat model output as untrusted.

Never render arbitrary raw HTML.

Use:

- structured JSON
- constrained Markdown
- sanitized rendering
- known UI components

Block scripts, inline event handlers, unsafe iframe HTML, and unsafe URLs.

---

# 51. Content Licensing Gate

Before commercial distribution, every Santo library must have clear rights status.

Content must be:

```text
Owned by Santo
or
Commercially licensed
or
Legally redistributable
```

Technical availability does not imply redistribution rights.

This is a commercial launch gate.

---

# 52. Initial Medical Scope

Initial positioning:

```text
Medical education
Medical knowledge assistance
Study and reference support
```

Avoid identifiable patient data in the MVP.

If Santo later supports clinical/patient data, create a separate privacy/compliance program first.

---

# 53. Public Santo Website

Suggested pages:

```text
Home
Features
How It Works
For Medical Platforms
White Label
Developers
Pricing
Docs
Login
```

Core message:

> Add source-grounded medical AI to your platform without building AI infrastructure.

---

# 54. Integration Wizard

Portal should generate customer-specific instructions.

Example:

```text
Integration

Framework:
[ Laravel ]

Step 1
Add Santo secret

Step 2
Install connector

Step 3
Add <santo-ai>

Step 4
Test connection

✓ Connected
```

Framework choices:

```text
Next.js
React
Laravel
PHP
WordPress
Django
Other
```

The wizard changes examples, not the Santo protocol.

---

# 55. Integration Health

Show:

```text
Status
Last session exchange
Last AI request
Domain
SDK version
Widget version
Recent errors
```

---

# 56. Versioning

Widget:

```text
/v1/widget.js
/v2/widget.js
```

API:

```text
/v1/...
```

Breaking changes require a new major/API version.

Use OpenAPI for machine-readable API contracts and future SDK generation.

---

# 57. Environments

Maintain:

```text
Local
Staging
Production
```

Each has isolated:

```text
D1
DO namespaces
AI Search configuration
Secrets
WorkOS environment
Queues
```

Production must never use staging secrets.

---

# 58. Git Workflow

```text
feature branch
   ↓
pull request
   ↓
lint
   ↓
typecheck
   ↓
unit tests
   ↓
integration tests
   ↓
preview/staging deploy
   ↓
Playwright
   ↓
merge main
   ↓
production deployment
```

Use GitHub Actions.

Do not manually patch production Workers.

---

# 59. Testing Stack

Use:

```text
Vitest
Playwright
Integration tests
Load tests
Security regression tests
```

Categories:

```text
unit
integration
e2e
security
load
resilience
```

---

# 60. Widget Compatibility Tests

Test inside:

```text
React
Next.js
Vue
plain HTML
WordPress-like page
Laravel-rendered page
```

Test hostile host CSS such as:

```css
button { all: unset; }
div { font-size: 40px; }
* { box-sizing: content-box; }
```

Shadow DOM must protect Santo presentation.

---

# 61. Browser and Accessibility Matrix

At minimum:

```text
Chrome
Edge
Safari
Firefox
```

Screens:

```text
Desktop
Tablet
Mobile
```

Accessibility from day one:

```text
Keyboard navigation
Focus management
ARIA labels
Screen-reader support
Color contrast
Reduced motion
Accessible dialogs
```

Localization architecture should be prepared for English and Arabic, including RTL-safe UI.

---

# 62. Performance Metrics

Track separately:

```text
Widget startup
Session exchange latency
Quota check latency
AI Search latency
LLM TTFT
LLM generation latency
Source resolution latency
Total request latency
Error rate
```

Every request should have identifiers such as:

```text
request_id
tenant_id
conversation_id
message_id
model
```

Avoid logging full prompts by default.

---

# 63. Error Taxonomy

Suggested codes:

```text
AUTH_INVALID
TENANT_SUSPENDED
USER_SUSPENDED
TENANT_QUOTA_EXHAUSTED
USER_QUOTA_EXHAUSTED
RATE_LIMITED
SEARCH_FAILED
MODEL_TIMEOUT
MODEL_FAILED
SOURCE_RESOLUTION_FAILED
INTERNAL_ERROR
```

---

# 64. Load Testing

Separate infrastructure testing from expensive live-model testing.

Infrastructure mode uses mocked model responses and stresses:

```text
Session exchange
D1
TenantMeterDO
ConversationDO
API routing
Tenant isolation
```

Then real AI mode with controlled concurrency:

```text
50
100
250
500 concurrent users
```

Increase only after latency, reliability, and cost are understood.

Release gates include:

```text
0 cross-tenant leaks
Atomic quota correctness
Stable session exchange
Stable quota checks
No runaway queue backlog
No uncontrolled model cost
Responsive widget
```

---

# 65. Failure Handling

## AI provider failure

- Return useful error
- Do not corrupt conversation
- Release/refund reservation according to policy

## AI Search failure

- Do not fabricate an unsupported grounded answer
- Return retrieval failure state

## Queue failure

- User response should not depend on immediate async processing
- Retry safely

## Analytics failure

- Must not block user response

## Customer webhook failure

- Retry asynchronously
- Must not block AI

---

# 66. Suspension

Santo Super Admin can instantly suspend a tenant.

Expected behavior:

```text
New session exchanges denied
Existing tokens denied on next request
AI requests denied
Portal restricted appropriately
```

Customer admins can suspend individual external users with immediate effect.

---

# 67. Internal Cost Intelligence

Per request track enough to answer:

```text
What does each tenant cost Santo?
Which model is expensive?
Which users are anomalous?
Average cost per AI use?
Gross margin per tenant?
```

Potential fields:

```text
tenant_id
user_id
model
input_tokens
output_tokens
search_operations
units_charged
estimated_provider_cost
latency
status
```

---

# 68. Super Admin Security

Require strong protection for Super Admin:

- MFA
- short admin session duration
- audit logs
- explicit elevated permissions
- optional re-authentication for destructive actions and secret rotation

---

# 69. Data Minimization and Privacy

Preferred end-user data:

```text
tenant_id
external_user_id
status
quota state
```

Name/email are optional.

Customer agreements should define:

- Data Santo receives
- Logging
- Retention
- AI providers
- Customer responsibilities
- User identifiers
- Content ownership
- Data deletion process

---

# 70. Backups and Recovery

Back up:

- D1 business/configuration data
- R2 source metadata/assets as appropriate
- Critical Santo configuration
- Deployment manifests
- Source/index mapping metadata

Recovery must be tested.

A backup that has never been restored is not proven.

---

# 71. Migration from Existing Royal AI

Reuse useful existing work:

```text
Current prompt logic
Existing AI Search knowledge
Retrieval tuning
Source metadata
Image handling
Relevant UI concepts
```

But move ownership to Santo.

Final relationship:

```text
Royal Bank
    ↓
Santo
```

Royal Bank becomes a tenant, not the owner of the AI core.

---

# 72. First Pilot Tenants

Use:

```text
Royal Bank
MedPark
```

This proves:

- Independent applications
- Different branding
- Different users
- Separate quotas
- Shared Santo core
- Shared global knowledge

Avoid customer-specific code forks.

---

# 73. Implementation Phases

## Phase 0 — Project Bootstrap

Create:

```text
pnpm workspace
Turborepo
TypeScript config
linting
formatting
GitHub Actions
staging environment
production environment
```

Deliverable:

```text
Portal boots
Worker boots
Widget builds
CI passes
```

## Phase 1 — Cloudflare Foundation

Create:

```text
santo-api Worker
santo-control-plane D1
santo-content R2
Durable Object namespaces
Queues
Analytics Engine dataset
AI Search namespace
```

Deliverable:

```text
Health endpoint
D1 migration
DO binding
R2 access
Queue test
```

## Phase 2 — Authentication and Tenancy

Implement:

```text
WorkOS AuthKit
Organizations
Tenant records
Membership mapping
Roles
Permissions
Super Admin
```

Deliverable:

```text
Santo admin creates MedPark
MedPark owner logs in
MedPark cannot see another tenant
```

## Phase 3 — Customer Credentials

Implement:

```text
Tenant ID
Server secret
Secret hashing/storage
Rotation
Revocation
last_used_at
Allowed domains
```

## Phase 4 — Session Exchange

Implement:

```text
POST /v1/session/exchange
```

Deliverable:

```text
MedPark backend can get a Santo session for user 58392
```

## Phase 5 — Quota Engine

Implement:

```text
TenantMeterDO
Tenant allowance
User quota
Bonus quota
Expiry
User status
Tenant status
Atomic reservation
Idempotency
```

Gate:

```text
100 concurrent requests against one remaining unit → exactly one succeeds
```

## Phase 6 — Global AI Search

Implement:

```text
Santo AI Search namespace
Library catalog
Cross-library search
Optional filter
Retrieval metadata
```

## Phase 7 — AI Core

Implement:

```text
Model adapter
RAG prompt builder
Streaming
Conversation IDs
Structured response
Timeout/error policy
```

## Phase 8 — Sources and Images

Implement:

```text
Stable source IDs
Citation validation
Source metadata lookup
R2 image assets
Image previews
Source drawer data
```

## Phase 9 — ConversationDO

Implement:

```text
Conversation state
Follow-ups
Message ordering
Context summary
Stream coordination
Idempotency
```

## Phase 10 — Santo Widget

Build:

```text
Launcher
Chat panel
Full-screen mode
Message renderer
Streaming text
Citation chip
Sources drawer
Image card
Image lightbox
Library filter
Composer
Quota indicator
Error state
Connection state
```

## Phase 11 — Widget Compatibility

Verify:

```text
React
Next.js
Vue
Laravel-rendered page
WordPress-like page
Plain HTML
```

## Phase 12 — Tenant Portal

Implement:

```text
Overview
Users
Plans
Usage
Branding
Integration
Team
Billing
Settings
```

## Phase 13 — Branding

Implement:

```text
AI name
Logo
Accent
Welcome message
Launcher position
Powered by Santo
Preview
```

## Phase 14 — Management API

Implement:

```text
quota
plan
expiry
suspend
resume
usage
```

## Phase 15 — Queues and Webhooks

Implement signed delivery, retries, logs, and idempotency.

## Phase 16 — Analytics

Portal graphs:

```text
requests/day
active users
usage by user
usage by model
latency
errors
tenant allowance
estimated cost
```

## Phase 17 — Security Hardening

Implement/test:

```text
WAF
rate limits
CORS
CSP
Turnstile
secret rotation
tenant scoping
IDOR tests
role tests
audit logs
abuse controls
```

## Phase 18 — Load Testing

Test:

```text
Session exchange
Quota
Widget config
Conversation creation
Search
Mock-model requests
Real-model requests
```

## Phase 19 — Pilot

Onboard:

```text
Royal Bank
MedPark
```

Observe integration, quota, latency, sources, widget behavior, portal workflow, cost, and support burden.

## Phase 20 — Production Launch

Launch only when production gates pass.

---

# 74. Production Launch Gates

```text
✓ No cross-tenant access
✓ Atomic quota under concurrency
✓ API keys rotate/revoke correctly
✓ Widget framework independence
✓ Mobile works
✓ Sources validated server-side
✓ Images map to real sources
✓ AI failures do not charge incorrectly
✓ Queue consumers idempotent
✓ Tenant suspend instant
✓ User suspend instant
✓ Metering reconciles
✓ Cost tracking works
✓ Audit trail complete
✓ Staging isolated from Production
✓ Backups/recovery tested
✓ Content licensing reviewed
✓ Privacy terms ready
✓ Monitoring running
```

---

# 75. What Not to Build Initially

Do not build:

```text
Separate DB per customer
Separate R2 per customer
Separate AI Search per customer
Supabase dependency
Customer database access
Marketplace payout system
Mobile apps
20 framework SDKs
Full drag-and-drop UI builder
Microservice explosion
Customer-specific Santo forks
```

Keep Santo centralized and generic.

---

# 76. Recommended Customer Experience

Santo Super Admin:

```text
Create Tenant
→ MedPark
→ Add owner
→ Set allowance
→ Set domains
→ Generate server secret
```

MedPark developer:

```text
Add Santo secret
Install tiny connector
Add <santo-ai>
```

MedPark owner logs into the Santo portal and manages:

```text
Users
Quotas
Plans
Branding
Usage
Team
```

MedPark student:

```text
Login to MedPark
→ Open MedPark AI
→ Santo recognizes user
→ Checks quota
→ Searches global Santo knowledge
→ Streams answer
→ Shows sources and images
```

---

# 77. Example Final Workflow

```text
MedPark user 58392
        ↓
MedPark login
        ↓
MedPark backend
        ↓
Santo session exchange
        ↓
Santo token
        ↓
<santo-ai>
        ↓
TenantMeterDO
        ↓
Global AI Search
        ↓
LLM
        ↓
Sources + Images
        ↓
Answer
```

If MedPark support adds:

```text
+500 quota
```

through Santo Portal, Santo updates immediately. No MedPark database write is required.

---

# 78. Suggested Domains

Architecture should support:

```text
www.<santo-domain>
app.<santo-domain>
api.<santo-domain>
cdn.<santo-domain>
docs.<santo-domain>
```

Do not hardcode final domain names in source code.

---

# 79. Core Product Principles

1. **Build once, embed anywhere.**
2. **Customer DB stays untouched.**
3. **All Santo medical libraries are global.**
4. **Tenant data is strictly isolated.**
5. **Quota enforcement is server-side and atomic.**
6. **Customer integration must be minimal.**
7. **Widget must be framework-agnostic.**
8. **Sources must be verifiable.**
9. **Images must map to real sources.**
10. **AI output is structured, not arbitrary HTML.**
11. **Usage and cost are measurable from day one.**
12. **No customer-specific forks.**
13. **Santo owns AI infrastructure; customers own their users and billing.**
14. **Security is a product requirement, not an afterthought.**

---

# 80. Immediate Next Steps

Implementation order inside `santoreno`:

```text
1. Bootstrap pnpm + Turborepo
2. Create React Router portal app
3. Create Hono Worker
4. Create Lit widget package
5. Configure staging Cloudflare environment
6. Create D1
7. Create initial migrations
8. Create Durable Object bindings
9. Create R2
10. Create Queues
11. Connect AI Search namespace
12. Add health endpoint
13. Add CI/CD
14. Add WorkOS
15. Implement tenants
16. Implement server secrets
17. Implement /v1/session/exchange
18. Implement TenantMeterDO
19. Implement first grounded AI endpoint
20. Embed Santo widget in a plain HTML test host
```

Do not begin with elaborate portal visuals before platform primitives work.

---

# 81. First Technical Milestone

The first meaningful vertical slice proves:

```text
Create tenant
     ↓
Issue server secret
     ↓
Exchange external user ID for Santo token
     ↓
Render <santo-ai>
     ↓
Ask one question
     ↓
Check quota atomically
     ↓
Search Santo knowledge
     ↓
Generate grounded answer
     ↓
Show verified source
     ↓
Record usage
```

When this works end-to-end, the architecture is validated.

---

# 82. MVP Definition

Santo MVP is ready when:

```text
Two independent tenants work
Two different brands work
External user authentication works
Atomic quota works
Global search works
Streaming AI works
Sources work
Images work
Customer user management works
Santo Super Admin works
Widget works in unrelated frameworks
Usage analytics works
Basic billing state works
Security gates pass
Load test passes
```

---

# 83. Long-Term Extensions

After the core is stable:

```text
Enterprise SSO
SCIM
Advanced white label
Customer custom domains
Customer-uploaded private knowledge
Private tenant libraries
Model routing
Multiple AI personas
Voice
Mobile SDK
Advanced reporting
Automated billing
Usage-based invoicing
Enterprise SLAs
Regional deployment
Clinical-compliance track
Developer marketplace
```

These are not MVP requirements.

---

# 84. Final Architecture Summary

```text
                         SANTO
                           │
          ┌────────────────┴────────────────┐
          │                                 │
   Customer Portal                    Santo API
 React Router / React              Hono / Workers
          │                                 │
       WorkOS                               │
          │              ┌──────────────────┼──────────────────┐
          │              │                  │                  │
          │             D1          TenantMeterDO      ConversationDO
          │        Control Plane          Quota             Context
          │                                 │                  │
          │                                 └──────────┬───────┘
          │                                            │
          │                                      Santo AI Core
          │                                            │
          │                     ┌──────────────────────┼──────────────┐
          │                     │                      │              │
          │                 AI Search                  R2          Models
          │              Global Knowledge        Sources/Images      │
          │                     │                      │              │
          │                     └──────────────────────┴──────────────┘
          │                                            │
          │                                      Structured answer
          │                                            │
          └────────────────────────────────────────────┤
                                                       │
                                              <santo-ai>
                                               Lit Widget
                                                       │
                     ┌─────────────────────────────────┼───────────────────┐
                     │                                 │                   │
                 Royal Bank                         MedPark             Site C
```

---

# 85. Final Decision

The `santoreno` repository is the single source of truth for Santo.

Initial architecture:

```text
TypeScript
pnpm
Turborepo

React Router
React
Vite

Hono
Cloudflare Workers

Lit
Web Components
Shadow DOM

WorkOS AuthKit

Cloudflare D1
SQLite Durable Objects
R2
AI Search
Queues
Analytics Engine

GitHub Actions
Vitest
Playwright
OpenAPI
Zod
```

No Supabase dependency is required for Santo.

Royal Bank and MedPark should operate as independent Santo tenants.

The core goal is:

> **Santo becomes a reusable medical AI infrastructure platform that any website can embed with minimal code while Santo centrally manages the AI, knowledge, sources, images, quotas, usage, security, branding, and customer administration.**

---

# 86. Repository Rule

Every implementation decision in `santoreno` should be tested against one question:

> **Does this keep Santo generic enough to serve the next 100 customers without customer-specific code?**

If the answer is no, redesign it before merging.
