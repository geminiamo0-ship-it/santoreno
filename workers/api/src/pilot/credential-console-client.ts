// Served by Santo's staging Worker without third-party scripts or portal dependencies.
export const pilotCredentialScript = `(() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  const endpoint = "/pilot/credentials";
  const redirectUri = location.origin + endpoint;
  const pkceStoreKey = "santo.pilot.pkce";
  let accessToken = null;
  let selectedTenantId = null;
  let secret = null;
  let accountUserId = null;
  let accountOrgId = null;
  let busy = false;
  let isSuperAdmin = false;
  let quotaInitialized = false;

  function notice(message, isError = false) {
    el("notice").textContent = message;
    el("notice").classList.toggle("error", isError);
  }

  function resetSecret() {
    secret = null;
    el("secret-value").value = "";
    el("secret-value").type = "password";
    el("secret-panel").hidden = true;
  }

  function setBusy(value) {
    busy = value;
    for (const button of document.querySelectorAll("button")) {
      button.disabled = value || (button.id === "initialize-quota" && quotaInitialized);
    }
  }

  function clearAuth() {
    accessToken = null;
    selectedTenantId = null;
    accountUserId = null;
    accountOrgId = null;
    isSuperAdmin = false;
    quotaInitialized = false;
    el("quota-panel").hidden = true;
    el("quota-result").hidden = true;
    resetSecret();
    el("auth-panel").hidden = false;
    el("tenant-panel").hidden = true;
    el("credential-panel").hidden = true;
    el("tenant-id").value = "";
  }

  function b64url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, "").split("+").join("-").split("/").join("_");
  }

  async function request(path, options = {}) {
    if (!accessToken) throw new Error("Please sign in again.");
    const headers = { Authorization: "Bearer " + accessToken };
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      credentials: "omit",
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("Unexpected response from Santo.");
    }
    if (!response.ok) {
      const code = typeof body.error === "string" ? body.error : "REQUEST_FAILED";
      if (response.status === 401) clearAuth();
      if (code === "ACTIVE_CREDENTIAL_EXISTS") {
        throw new Error("This tenant already has an active key. Rotate or revoke it via the owner API before issuing a new one.");
      }
      throw new Error("Santo rejected request (" + response.status + "): " + code);
    }
    return body;
  }

  async function execute(action) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      notice(error instanceof Error ? error.message : "Operation failed.", true);
    } finally {
      setBusy(false);
    }
  }

  function requireTenantId() {
    const id = el("tenant-id").value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Enter a valid Santo Tenant UUID, not the WorkOS organization ID.");
    }
    return id;
  }

  async function verifyTenant() {
    resetSecret();
    const id = requireTenantId();
    const tenant = await request("/v1/portal/tenants/" + encodeURIComponent(id));
    if (tenant.id !== id || tenant.status !== "active") {
      throw new Error("Tenant is not active or ownership was not verified.");
    }
    selectedTenantId = tenant.id;
    el("credential-panel").hidden = false;
    el("quota-panel").hidden = !isSuperAdmin;
    el("quota-result").hidden = true;
    quotaInitialized = false;
    el("initialize-quota").disabled = false;
    notice("Verified owner access to " + tenant.name + ". You can generate its server key.");
  }

  async function loadContext() {
    const context = await request("/v1/portal/context");
    if (context.role !== "owner" && context.role !== "super_admin") {
      throw new Error("Santo owner authorization is required.");
    }
    el("auth-panel").hidden = true;
    el("tenant-panel").hidden = false;
    el("identity").textContent =
      "Authorized WorkOS user: " + context.userId + " · Santo role: " + context.role;
    el("owner-id").value = context.userId;
    el("workos-org").value = accountOrgId || "";
    isSuperAdmin = context.role === "super_admin";
    el("create-panel").hidden = !isSuperAdmin;
    setCycleDefaults();
    if (context.tenant && typeof context.tenant.id === "string") {
      el("tenant-id").value = context.tenant.id;
      await verifyTenant();
    } else {
      notice("Authenticated. Enter your existing Santo Tenant UUID or initialize a new tenant as Super Admin.");
    }
  }

  async function signIn() {
    const configResponse = await fetch(endpoint + "/config", { cache: "no-store" });
    if (!configResponse.ok) throw new Error("WorkOS authentication is not configured in staging.");
    const config = await configResponse.json();
    if (!/^client_[A-Za-z0-9]+$/.test(config.clientId || "")) {
      throw new Error("Missing valid WorkOS Client ID in staging.");
    }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = b64url(new Uint8Array(digest));
    const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
    sessionStorage.setItem(pkceStoreKey, JSON.stringify({ verifier, state, at: Date.now() }));
    const auth = new URL("https://api.workos.com/user_management/authorize");
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("client_id", config.clientId);
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("state", state);
    auth.searchParams.set("code_challenge_method", "S256");
    auth.searchParams.set("code_challenge", challenge);
    const organization = el("login-org").value.trim();
    if (organization) {
      if (!/^org_[A-Za-z0-9]+$/.test(organization)) throw new Error("Invalid WorkOS organization ID.");
      auth.searchParams.set("organization_id", organization);
    } else {
      auth.searchParams.set("provider", "authkit");
    }
    location.assign(auth.toString());
  }

  async function completeAuthRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) return;
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    history.replaceState(null, "", endpoint);
    const saved = sessionStorage.getItem(pkceStoreKey);
    sessionStorage.removeItem(pkceStoreKey);
    if (error) throw new Error("WorkOS sign-in failed (" + error + ").");
    if (!saved || !code || !state) throw new Error("Login verifier missing; restart sign-in.");
    let proof;
    try { proof = JSON.parse(saved); } catch { throw new Error("Invalid login verifier."); }
    if (
      typeof proof.verifier !== "string" || proof.state !== state ||
      typeof proof.at !== "number" || Date.now() - proof.at > 600000
    ) throw new Error("Login expired or state mismatch; restart sign-in.");
    const response = await fetch(endpoint + "/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ code, codeVerifier: proof.verifier }),
    });
    const data = await response.json();
    if (!response.ok || typeof data.accessToken !== "string") {
      throw new Error("WorkOS token exchange failed (" + (data.error || response.status) + ").");
    }
    accessToken = data.accessToken;
    accountUserId = data.userId;
    accountOrgId = data.organizationId;
    if (accountUserId && accountOrgId) {
      el("workos-org").value = accountOrgId;
    }
    await loadContext();
  }

  async function createTenant() {
    resetSecret();
    const name = el("tenant-name").value.trim();
    const slug = el("tenant-slug").value.trim();
    const workosOrgId = el("workos-org").value.trim();
    const ownerWorkosUserId = el("owner-id").value.trim();
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !workosOrgId || !ownerWorkosUserId) {
      throw new Error("Fill in name, a lowercase slug, WorkOS org ID and owner user ID.");
    }
    const tenant = await request("/v1/admin/tenants", {
      method: "POST",
      body: { name, slug, workosOrgId, ownerWorkosUserId },
    });
    el("tenant-id").value = tenant.id;
    selectedTenantId = null;
    // Credential issuance still requires a matching organization-scoped owner token.
    await verifyTenant();
  }

  async function generateKey() {
    resetSecret();
    const tenantId = requireTenantId();
    if (tenantId !== selectedTenantId) {
      throw new Error("Verify this tenant before issuing a key.");
    }
    // Re-check owner authorization at issuance time. The API enforces it again.
    await request("/v1/portal/tenants/" + encodeURIComponent(tenantId));
    const response = await request("/v1/portal/tenants/" + encodeURIComponent(tenantId) + "/credentials", {
      method: "POST",
    });
    if (!/^santo_sk_[0-9a-f]{12}_[0-9a-f]{64}$/.test(response.secret || "")) {
      throw new Error("Santo returned an invalid key; do not deploy.");
    }
    secret = response.secret;
    el("secret-value").value = secret;
    el("secret-panel").hidden = false;
    notice("Key issued. Copy it now and store it in Vercel as a Sensitive, server-only variable.");
  }

  function setCycleDefaults() {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    el("quota-start").value = start.toISOString().slice(0, 10);
    el("quota-end").value = end.toISOString().slice(0, 10);
  }

  function quotaCycleDate(id) {
    const raw = el(id).value;
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(raw)) {
      throw new Error("Choose a valid UTC quota cycle date.");
    }
    const value = new Date(raw + "T00:00:00.000Z");
    if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== raw) {
      throw new Error("Invalid quota cycle date.");
    }
    return value;
  }

  async function initializeQuota() {
    if (!isSuperAdmin) throw new Error("Santo Super Admin authorization is required.");
    const id = requireTenantId();
    if (id !== selectedTenantId) throw new Error("Verify the tenant before updating quota.");
    const monthlyAllowance = Number(el("quota-cap").value);
    if (!Number.isSafeInteger(monthlyAllowance) || monthlyAllowance < 1 || monthlyAllowance > 100000000) {
      throw new Error("Enter a monthly tenant allowance between 1 and 100,000,000 units.");
    }
    const start = quotaCycleDate("quota-start");
    const end = quotaCycleDate("quota-end");
    if (end <= start || end <= new Date()) {
      throw new Error("Quota cycle end must be after the start and in the future.");
    }
    // Deliberate operator confirmation before a potentially destructive cycle reconfiguration.
    const proceed = window.confirm(
      "Initialize Santo Tenant Quota?\\n\\nTenant: " + id +
      "\\nMonthly allowance: " + monthlyAllowance +
      "\\nUTC cycle: " + start.toISOString().slice(0, 10) +
      " through " + end.toISOString().slice(0, 10) +
      "\\n\\nIMPORTANT: Reconfiguring an existing cycle may reset usage counters. Continue only for a new tenant or a planned quota change."
    );
    if (!proceed) return;
    const snapshot = await request("/v1/admin/tenants/" + encodeURIComponent(id) + "/quota", {
      method: "POST",
      body: {
        tenantStatus: "active",
        monthlyAllowance,
        cycleStartAt: start.toISOString(),
        cycleEndAt: end.toISOString(),
        user: {
          externalUserId: "santo-operator-bootstrap",
          status: "active",
          baseQuota: 0,
          bonusQuota: 0,
          expiresAt: null,
        },
      },
    });
    if (snapshot.tenantId !== id || snapshot.tenant?.limit !== monthlyAllowance) {
      throw new Error("Quota response did not match the requested tenant and allowance.");
    }
    el("quota-result").textContent =
      "Tenant quota initialized: " + snapshot.tenant.remaining + " of " + snapshot.tenant.limit +
      " units remaining. Students still receive their own quotas through Royal Bank.";
    el("quota-result").hidden = false;
    quotaInitialized = true;
    el("initialize-quota").disabled = true;
    notice("Tenant quota activated. Return to Royal Bank /santo and retry; no new Vercel deploy is required.");
  }

  async function copy(value, label) {
    if (!value) throw new Error("There is nothing to copy yet.");
    await navigator.clipboard.writeText(value);
    notice(label + " copied. Keep it private.");
  }

  el("sign-in").addEventListener("click", () => execute(signIn));
  el("sign-out").addEventListener("click", () => {
    clearAuth();
    notice("Console session ended. WorkOS may still have an external SSO session.");
  });
  el("verify-tenant").addEventListener("click", () => execute(verifyTenant));
  el("tenant-id").addEventListener("input", () => {
    selectedTenantId = null;
    el("credential-panel").hidden = true;
    el("quota-panel").hidden = true;
    el("quota-result").hidden = true;
    resetSecret();
  });
  el("copy-tenant").addEventListener("click", () => execute(async () => {
    await copy(requireTenantId(), "Tenant ID");
  }));
  el("create-tenant").addEventListener("click", () => execute(createTenant));
  el("generate-key").addEventListener("click", () => execute(generateKey));
  el("initialize-quota").addEventListener("click", () => execute(initializeQuota));
  el("copy-secret").addEventListener("click", () => execute(async () => {
    await copy(secret, "Server API Key");
  }));
  el("toggle-secret").addEventListener("click", () => {
    el("secret-value").type = el("secret-value").type === "password" ? "text" : "password";
  });
  el("clear-secret").addEventListener("click", () => {
    resetSecret();
    notice("Secret cleared from the page. It cannot be retrieved after leaving.");
  });
  execute(completeAuthRedirect);
})();`;
