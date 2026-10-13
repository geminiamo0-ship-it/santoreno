# Santo Staging — one-button tenant server key

Scope: **Staging pilot only**. This is a narrowly scoped operator console,
not the deferred customer portal. It uses the existing WorkOS-verified
`/v1/admin/tenants`, `/v1/portal/tenants/:id` and
`/v1/portal/tenants/:id/credentials` endpoints.

## Open the console

**https://santo-api-staging.geminiamo0.workers.dev/pilot/credentials**

The WorkOS **Staging** AuthKit application must have this exact URL under
allowed Redirect URIs. No WorkOS client secret, Santo server key, or Cloudflare
secret is needed in the browser. The Worker already has `WORKOS_CLIENT_ID`,
`WORKOS_ISSUER` and the WorkOS JWKS verifier.

1. Open the Staging console and **Sign in with WorkOS**. If using an
   organization-scoped login, enter the WorkOS organization ID first. The
   login uses WorkOS hosted OAuth authorization code + PKCE (S256).
2. If a Santo tenant already exists, enter its **Santo Tenant UUID** and
   select **Verify tenant ownership**. An Owner-scoped login will prefill
   its own tenant automatically; a Santo Super Admin is not automatically
   an owner and must have matching WorkOS organization context **and**
   explicit D1 owner membership.
3. For a **new** tenant, a Santo Super Admin can use **Initialize tenant**,
   giving a tenant name/slug, matching WorkOS org ID and WorkOS owner user ID.
   The UI then attempts owner verification. If the JWT has no matching
   `org_id`, sign in again under the intended WorkOS organization before
   attempting to issue a key.
4. Once verified, click **Generate API Key** and **Copy secret**. The key
   begins with `santo_sk_`. Put it into the existing website **server-side**
   deployment secret store as `SANTO_SERVER_API_KEY`; for Royal Bank use a
   Sensitive Vercel Environment Variable, never a `NEXT_PUBLIC_` variable.
5. Under **Initialize Tenant Quota** (Santo Super Admin only), enter the
   intended tenant-wide allowance and UTC quota cycle start/end. The form
   defaults the dates to the current UTC calendar month; the allowance has no
   preselected value because the operator must choose it explicitly.
   Review the tenant ID, dates and cap in the confirmation dialog before
   committing. The existing `POST /v1/admin/tenants/:tenantId/quota`
   enforces WorkOS Super Admin authorization and tenant existence.
   A zero-unit reserved `santo-operator-bootstrap` placeholder satisfies
   the initial-user contract without granting any real Royal account units.
6. Once it says **Tenant quota activated**, retry Royal Bank `/santo`.
   No additional Vercel variable or redeploy is needed. Royal Bank's
   `SANTO_DEFAULT_STUDENT_QUOTA` (100) provisions its actual students
   separately. Initial quota activation does not upload medical libraries.

## Security and lifecycle

- The console is exposed only when `SANTO_ENV=staging`, served on the same
  origin as the Santo Worker. Production and other environments return 404.
- The browser stores **only PKCE state/verifier** in sessionStorage for a
  maximum of ten minutes. WorkOS access token and Santo server secret stay in
  JavaScript memory; never in localStorage, sessionStorage, a URL or cookies.
  Refreshing the page intentionally requires sign-in again.
- The code exchange runs on the Worker, is restricted to same-origin JSON
  requests, returns only the short-lived access token/user/organization ID,
  and **discards WorkOS refresh tokens**.
- Tenant quota initialization is Super Admin only and deliberately confirms
  the requested tenant UUID, allowance and UTC cycle. Calling quota configure
  again with a new cycle start can reset the authoritative cycle counters:
  operators must not reinitialize active production usage by accident.
- The server continues to verify WorkOS JWT signatures/issuer/client/expiry,
  Santo Super Admin creation rights, matching organization owner membership,
  active tenant state and existing active credential conflicts.
- No secret is logged, persisted in browser storage or committed to GitHub.
  Issued Santo credentials are hashed in D1; raw values display **once**.
  If a key already exists, the API returns `ACTIVE_CREDENTIAL_EXISTS`; the
  console deliberately does not auto-revoke or rotate keys.
- The page uses strict CSP, no external scripts, no-store, deny framing,
  no-referrer and safe DOM text assignments rather than arbitrary HTML.
- The console is not a statement that licensed medical data, live tenant
  quotas or the Royal Bank Vercel application are fully activated.

## Deployment / acceptance

The `Pilot Credential Console Staging Deploy` workflow deploys only
`santo-api-staging` after exact-commit Verify passes, using
`wrangler deploy --env staging --keep-vars` to retain dashboard variables
and pre-existing Cloudflare secrets. It checks `/health`, serves the
console and verifies a non-secret WorkOS client ID.

Verify a real WorkOS login, owner-scoped tenant read, one-time credential
issuance, denied cross-tenant attempts and Vercel server-secret installation
before announcing that the live pilot integration has been accepted.
