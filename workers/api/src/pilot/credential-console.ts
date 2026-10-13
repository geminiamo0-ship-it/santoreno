import type { SantoBindings } from "../runtime/bindings";

export const pilotCredentialHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow"><title>Santo · Pilot credentials</title>
  <link rel="stylesheet" href="/pilot/credentials.css">
  <script src="/pilot/credentials.js" defer></script>
</head>
<body>
  <main class="shell">
    <header><span class="brand">SANTO <small>OPERATIONS</small></span><span class="badge">STAGING ONLY</span></header>
    <div class="heading"><p class="eyebrow">Pilot activation</p><h1>Server API credentials</h1>
      <p>Sign in with WorkOS, select your tenant, then issue its server credential. This page never stores credentials.</p></div>
    <div id="notice" class="notice" role="status" aria-live="polite">Sign in to continue.</div>
    <section class="panel" id="auth-panel">
      <h2>1. WorkOS owner sign-in</h2>
      <label for="login-org">WorkOS organization ID <span class="hint">(optional, for organization-scoped sign-in)</span></label>
      <input id="login-org" autocomplete="off" placeholder="org_..." spellcheck="false">
      <div class="actions"><button id="sign-in" type="button">Sign in with WorkOS</button><span class="hint">Use your Santo Super Admin / tenant owner account.</span></div>
    </section>
    <section class="panel" id="tenant-panel" hidden>
      <div class="between"><h2>2. Select tenant</h2><button id="sign-out" type="button" class="quiet">End session</button></div>
      <p id="identity" class="hint"></p>
      <label for="tenant-id">Santo Tenant ID <span class="hint">(UUID — not WorkOS org ID)</span></label>
      <input id="tenant-id" autocomplete="off" placeholder="Paste existing tenant UUID" spellcheck="false">
      <div class="actions"><button id="verify-tenant" type="button" class="secondary">Verify tenant ownership</button><button id="copy-tenant" type="button" class="quiet">Copy Tenant ID</button></div>
      <div id="create-panel" class="create" hidden>
        <h3>First-time tenant initialization</h3>
        <p class="hint">Santo Super Admin only. If tenant already exists, paste its UUID above instead.</p>
        <label for="tenant-name">Tenant name</label><input id="tenant-name" autocomplete="off" placeholder="Customer name">
        <label for="tenant-slug">Tenant slug</label><input id="tenant-slug" autocomplete="off" placeholder="customer-name">
        <label for="workos-org">WorkOS organization ID</label><input id="workos-org" autocomplete="off" placeholder="org_..." spellcheck="false">
        <label for="owner-id">WorkOS owner user ID</label><input id="owner-id" autocomplete="off" placeholder="user_..." spellcheck="false">
        <div class="actions"><button id="create-tenant" type="button" class="secondary">Initialize tenant</button></div>
      </div>
    </section>
    <section class="panel" id="credential-panel" hidden>
      <h2>3. Generate Server API Key</h2>
      <p>Only an authorized tenant owner can issue a key. If an active key exists, it must be rotated separately.</p>
      <button id="generate-key" type="button">Generate API Key</button>
      <div id="secret-panel" class="secret" hidden>
        <label for="secret-value">One-time secret — save in Vercel as <code>SANTO_SERVER_API_KEY</code></label>
        <input id="secret-value" type="password" readonly autocomplete="off" spellcheck="false">
        <div class="actions"><button type="button" id="copy-secret">Copy secret</button><button type="button" class="quiet" id="toggle-secret">Show / hide</button><button type="button" class="quiet" id="clear-secret">Clear display</button></div>
        <p class="hint">Never put this secret into frontend code, chat, GitHub or a public environment variable. It cannot be retrieved again.</p>
      </div>
    </section>
    <footer>Pilot operator tool · WorkOS-verified authorization · No full tenant portal</footer>
  </main>
</body>
</html>`;

export const pilotCredentialCss = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f0ede5;background:#141615;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-width:320px}
.shell{max-width:760px;margin:auto;padding:26px 22px 60px}
header,.between,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header,.between{justify-content:space-between}
.brand{font-weight:800;letter-spacing:.14em}.brand small{font-size:10px;color:#aa9b7b}
.badge{padding:7px 10px;border:1px solid #655b44;border-radius:20px;color:#d5b577;font-size:11px;letter-spacing:.08em}
.heading{margin:58px 0 30px}.eyebrow{color:#c6a96b;text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:700}
h1{font-size:clamp(2rem,5vw,3rem);letter-spacing:-.04em;margin:6px 0 12px}
h2{font-size:19px;margin:0 0 18px}h3{font-size:16px;margin:0 0 12px}
p{line-height:1.6;color:#bbbdb8}
.panel{background:#1d211f;border:1px solid #363a34;border-radius:16px;padding:24px;margin:17px 0}
label{display:block;font-size:13px;font-weight:650;margin:16px 0 9px}
input{display:block;width:100%;background:#121512;border:1px solid #56594e;border-radius:8px;color:#f6f4ed;font:inherit;padding:12px 13px}
input:focus-visible,button:focus-visible{outline:2px solid #e2ba70;outline-offset:2px}
button{border:1px solid #d3b77e;background:#d3b77e;color:#24231e;font:inherit;font-size:14px;font-weight:700;padding:11px 16px;border-radius:9px;cursor:pointer}
button:disabled{opacity:.55;cursor:wait}
button.secondary{background:#35382e;color:#e6d2a5;border-color:#736b54}
button.quiet{background:transparent;color:#d3b77e;border-color:#5c5849}
.actions{margin-top:16px}.hint{color:#aaada5;font-size:12px;line-height:1.6}
.notice{border:1px solid #5c5849;border-radius:10px;color:#e6d2a5;padding:13px 15px;font-size:13px;line-height:1.5}
.notice.error{border-color:#9d5c59;color:#f0b8b2}
.create{border-top:1px solid #44473d;padding-top:22px;margin-top:26px}
.secret{border:1px solid #7e6948;background:#25261e;padding:18px;border-radius:10px;margin-top:20px}
code{color:#e6d2a5;overflow-wrap:anywhere}
footer{color:#888c83;font-size:12px;margin-top:34px}
[hidden]{display:none!important}
@media(max-width:540px){.heading{margin-top:36px}.panel{padding:18px}button{width:100%}}
`;

export const pilotCredentialHeaders = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

interface CodeExchangeRequest {
  code: string;
  codeVerifier: string;
}

function isCodeExchangeRequest(value: unknown): value is CodeExchangeRequest {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.code === "string" &&
    input.code.length > 5 &&
    input.code.length <= 1024 &&
    typeof input.codeVerifier === "string" &&
    /^[A-Za-z0-9_-]{43,128}$/.test(input.codeVerifier)
  );
}

export async function exchangePilotAuthorizationCode(
  request: Request,
  env: SantoBindings,
  exchange: typeof fetch = fetch,
): Promise<Response> {
  const headers = { ...pilotCredentialHeaders, "Content-Type": "application/json" };
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ error: "ORIGIN_NOT_ALLOWED" }, { status: 403, headers });
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  }
  if (!env.WORKOS_CLIENT_ID) {
    return Response.json({ error: "WORKOS_NOT_CONFIGURED" }, { status: 503, headers });
  }
  const raw = await request.text();
  if (raw.length > 2048) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  }
  if (!isCodeExchangeRequest(input)) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  }
  let result: Response;
  try {
    result = await exchange("https://api.workos.com/user_management/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.WORKOS_CLIENT_ID,
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.codeVerifier,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return Response.json({ error: "WORKOS_UNAVAILABLE" }, { status: 502, headers });
  }
  if (!result.ok) {
    return Response.json({ error: "WORKOS_SIGN_IN_FAILED" }, { status: 401, headers });
  }
  let json: unknown;
  try {
    json = await result.json();
  } catch {
    return Response.json({ error: "WORKOS_INVALID_RESPONSE" }, { status: 502, headers });
  }
  if (typeof json !== "object" || json === null) {
    return Response.json({ error: "WORKOS_INVALID_RESPONSE" }, { status: 502, headers });
  }
  const payload = json as Record<string, unknown>;
  const user = payload.user;
  if (typeof payload.access_token !== "string" || typeof user !== "object" || !user) {
    return Response.json({ error: "WORKOS_INVALID_RESPONSE" }, { status: 502, headers });
  }
  const userId = (user as Record<string, unknown>).id;
  if (typeof userId !== "string") {
    return Response.json({ error: "WORKOS_INVALID_RESPONSE" }, { status: 502, headers });
  }
  // Never expose the long-lived WorkOS refresh token to the operator UI.
  return Response.json(
    {
      accessToken: payload.access_token,
      userId,
      organizationId: typeof payload.organization_id === "string" ? payload.organization_id : null,
    },
    { status: 200, headers },
  );
}
