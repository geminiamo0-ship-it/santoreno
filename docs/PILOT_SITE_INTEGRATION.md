# Santo Pilot — use an existing website, no customer portal required

**Status:** implementation guide for the pilot. This does **not** indicate
that production medical libraries or a MedPark/Royal Bank live site are linked.

## Responsibility split

- Customer **backend** owns login, subscriptions and which external users are
  entitled to Santo. It stores the tenant's Santo server credential **server-side**.
- Santo verifies that server credential and scopes every configuration to its
  authenticated tenant, then issues short-lived end-user Santo sessions.
- Santo's **TenantMeterDO** enforces both the tenant allowance and student
  allowance. The customer database is never consulted by Santo.
- The browser widget receives only the Santo end-user session and never a
  tenant API key or privileged quota configuration endpoint.

## 1. Tenant one-time setup (Santo operator only)

Santo's WorkOS-verified Super Admin, listed by user ID in
`SANTO_SUPER_ADMIN_USER_IDS`, can bootstrap the tenant's quota cycle.
Never give this action or credential to the customer frontend.

```http
POST /v1/admin/tenants/<TENANT_UUID>/quota
Authorization: Bearer <WORKOS_SUPER_ADMIN_ACCESS_TOKEN>
Content-Type: application/json
```

```json
{
  "tenantStatus": "active",
  "monthlyAllowance": 5000,
  "cycleStartAt": "2026-10-01T00:00:00.000Z",
  "cycleEndAt": "2026-11-01T00:00:00.000Z",
  "user": {
    "externalUserId": "initial-student",
    "status": "active",
    "baseQuota": 25,
    "bonusQuota": 0,
    "expiresAt": null
  }
}
```

The tenant cap is a **Santo-owner** decision. A customer server key cannot
raise the tenant cap or change quota cycles. Be careful when changing an
existing tenant's `cycleStartAt`: the authoritative quota engine starts a
new cycle and resets cycle counters. Production operators must audit changes.

## 2. Student entitlement from an existing customer backend

After authenticating the student and checking the site's paid entitlement,
the customer's own backend may call:

```http
POST /v1/server/quota/users
Authorization: Bearer <TENANT_SERVER_CREDENTIAL>
Content-Type: application/json
```

```json
{
  "externalUserId": "student-123",
  "status": "active",
  "baseQuota": 75,
  "bonusQuota": 5,
  "expiresAt": null
}
```

To suspend a student, resend the same body with `"status": "suspended"`.
To read authoritative counters, the backend calls
`GET /v1/server/quota/users/student-123` with that server credential.

**Important:** changing `baseQuota` or `bonusQuota` preserves already-used
and currently-reserved units. It cannot refund past charges. Reducing the
allowance below usage yields zero remaining quota. Suspending prevents new
reservations; already-inflight requests may finish.

If the tenant quota is not bootstrapped, the user endpoint fails closed
with `TENANT_QUOTA_NOT_CONFIGURED`.

## 3. End-user session handoff

Customer backend checks its normal website session, membership and
subscription, then exchanges via:
`POST /v1/session/exchange` with the **tenant server credential**.
The body uses `external_user_id` (and optional email/display name).
The browser receives **only** `accessToken` and expiry via an authenticated
same-origin endpoint, e.g. `/api/santo/session`.

For an actual pilot, prefer a **same-origin proxy** at `/santo` to reach
the Santo API. The proxy must restrict forwarded paths to
`/v1/conversations`, `/v1/conversations/*` and `/v1/sources/*`;
never proxy `/v1/admin` or `/v1/server` into the browser, and never
place `santo_sk_...` in JavaScript, HTML or a public environment variable.
Authenticate the site's user, apply origin/CSRF protection appropriate for
its cookie session, and avoid caching medical/user responses.

## 4. Embed the widget in the existing site

Build `@santo/widget`; the standalone browser ESM artifact is
`packages/widget/dist/browser/santo-ai.js`. Host that static file on the
customer's normal asset origin (or a trusted Santo CDN).

```html
<script type="module" src="/assets/santo-ai.js"></script>
<santo-ai assistant-name="Santo"></santo-ai>
<script type="module">
  const widget = document.querySelector("santo-ai");
  widget.libraries = [
    { id: "mrcp", label: "MRCP" },
    { id: "usmle", label: "USMLE" }
  ];
  widget.configure({
    apiBaseUrl: "/santo",
    // This user-authenticated same-origin endpoint obtains a short-lived
    // end-user Santo session from the customer backend, NOT a server key.
    sessionProvider: async () => {
      const response = await fetch("/api/santo/session", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Unable to obtain Santo user session");
      return (await response.json()).accessToken;
    },
    // Scope to BOTH verified tenant and student; avoid raw email addresses.
    sessionScope: "tenant-scoped-student-identifier"
  });
</script>
```

Only configure the widget after site authentication, and **reset/reconfigure
the widget when users change**. The optional `sessionScope` stores
conversation ID and pending retry key in sessionStorage, not authentication
tokens. Never display previous user content across user switches.

If the browser cannot use sessionStorage, in-memory retry remains available
for that tab session.

## 5. Pilot acceptance before advertising a live integration

- Tenant bootstrap and student entitlement, then live session exchange.
- A subscribed student can ask and follow up; an unsubscribed/suspended
  student cannot start a new charged AI generation.
- Quota is reduced exactly once for a completed answer, even after timeout,
  retry, double click, or network interruption.
- Verified sources and images belong to the authenticated tenant/user and
  message. No fake URLs, unvalidated model markdown HTML or exposed R2 keys.
- Validate mobile/desktop UI, slow network, stale session, 409 conflict,
  429 exhaustion, source errors and browser refresh.
- Upload **licensed** real medical content, index it and verify quality.
  Existing P9 staging fixtures are synthetic, not medical-library ingestion.
- Record real host smoke evidence and source/citation quality gates. Until
  then this repository is a tested implementation, not a live pilot.

Full Santo portal, branding and billing dashboard remain deferred.
