import { chmod, readFile, writeFile } from "node:fs/promises";

const P2_STATE_PATH = process.env.P2_WORKOS_STATE_PATH ?? "/tmp/santo-p2-workos-state.json";
const P4_STATE_PATH = process.env.P4_SESSION_STATE_PATH ?? "/tmp/santo-p4-session-state.json";
const EXTERNAL_USER_ID = "58392";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function mask(value) {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function saveState(state) {
  await writeFile(P4_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await chmod(P4_STATE_PATH, 0o600);
}

async function request(workerUrl, path, authorization, { method = "GET", body } = {}) {
  const response = await fetch(`${workerUrl}${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: response.status, body: payload };
}

function portalAuth(token) {
  return `Bearer ${token}`;
}

function serverAuth(secret) {
  return `Santo ${secret}`;
}

function sessionAuth(token) {
  return `Bearer ${token}`;
}

function decodeClaims(token) {
  const segments = token.split(".");
  expect(segments.length === 3, "Session token is not a three-part JWT");
  return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
}

function tamperToken(token) {
  const segments = token.split(".");
  expect(segments.length === 3, "Cannot tamper malformed JWT");
  const signature = segments[2];
  const replacement = signature[0] === "a" ? "b" : "a";
  return `${segments[0]}.${segments[1]}.${replacement}${signature.slice(1)}`;
}

async function issueCredential(workerUrl, tenantId, ownerToken, label) {
  const response = await request(
    workerUrl,
    `/v1/portal/tenants/${tenantId}/credentials`,
    portalAuth(ownerToken),
    { method: "POST" },
  );
  expect(response.status === 201, `${label} credential issuance returned HTTP ${response.status}`);
  expect(
    typeof response.body?.secret === "string" &&
      /^santo_sk_[0-9a-f]{12}_[0-9a-f]{64}$/.test(response.body.secret),
    `${label} credential issuance did not return a valid one-time secret`,
  );
  mask(response.body.secret);
  return response.body.secret;
}

function validateSession(response, tenantId, label) {
  expect(response.status === 200, `${label} session exchange returned HTTP ${response.status}`);
  expect(response.body?.tokenType === "Bearer", `${label} session token type is invalid`);
  expect(response.body?.expiresIn === 900, `${label} session TTL is not 900 seconds`);
  expect(response.body?.user?.tenantId === tenantId, `${label} session returned wrong tenant`);
  expect(
    response.body?.user?.externalUserId === EXTERNAL_USER_ID,
    `${label} session returned wrong external user ID`,
  );
  const token = response.body?.accessToken;
  expect(
    typeof token === "string" && token.split(".").length === 3,
    `${label} session token is invalid`,
  );
  mask(token);

  const claims = decodeClaims(token);
  expect(claims.iss === "Santo", `${label} token issuer is invalid`);
  expect(claims.aud === "santo-ai", `${label} token audience is invalid`);
  expect(claims.tenant === tenantId, `${label} token tenant claim is invalid`);
  expect(claims.sub === EXTERNAL_USER_ID, `${label} token subject is invalid`);
  expect(typeof claims.session_id === "string", `${label} token is missing session_id`);
  expect(typeof claims.jti === "string", `${label} token is missing jti`);
  expect(Number.isInteger(claims.iat), `${label} token is missing iat`);
  expect(Number.isInteger(claims.exp), `${label} token is missing exp`);
  expect(claims.exp - claims.iat === 900, `${label} token lifetime claims are invalid`);

  return { token, user: response.body.user, claims };
}

async function verify() {
  const workerUrl = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const p2 = await readJson(P2_STATE_PATH);

  const medparkTenantId = p2.santo?.tenants?.medpark?.id;
  const isolationTenantId = p2.santo?.tenants?.isolation?.id;
  const medparkOwnerToken = p2.workos?.users?.medparkOwner?.accessToken;
  const isolationOwnerToken = p2.workos?.users?.isolationOwner?.accessToken;
  for (const [name, value] of Object.entries({
    medparkTenantId,
    isolationTenantId,
    medparkOwnerToken,
    isolationOwnerToken,
  })) {
    if (!value) throw new Error(`P2 state is missing ${name}`);
  }

  const medparkSecret = await issueCredential(
    workerUrl,
    medparkTenantId,
    medparkOwnerToken,
    "MedPark",
  );
  const isolationSecret = await issueCredential(
    workerUrl,
    isolationTenantId,
    isolationOwnerToken,
    "Isolation tenant",
  );

  const invalidPayload = await request(
    workerUrl,
    "/v1/session/exchange",
    serverAuth(medparkSecret),
    {
      method: "POST",
      body: { external_user_id: "" },
    },
  );
  expect(
    invalidPayload.status === 400 && invalidPayload.body?.error === "INVALID_SESSION_REQUEST",
    "Invalid session payload was not rejected explicitly",
  );

  const invalidCredential = await request(
    workerUrl,
    "/v1/session/exchange",
    serverAuth(
      "santo_sk_000000000000_0000000000000000000000000000000000000000000000000000000000000",
    ),
    { method: "POST", body: { external_user_id: EXTERNAL_USER_ID } },
  );
  expect(invalidCredential.status === 401, "Invalid server credential was not rejected");

  const medparkExchange = await request(
    workerUrl,
    "/v1/session/exchange",
    serverAuth(medparkSecret),
    {
      method: "POST",
      body: {
        external_user_id: EXTERNAL_USER_ID,
        email: "student58392@medpark.example.net",
        display_name: "MedPark Student",
      },
    },
  );
  const medpark = validateSession(medparkExchange, medparkTenantId, "MedPark");

  const medparkContext = await request(
    workerUrl,
    "/v1/session/context",
    sessionAuth(medpark.token),
  );
  expect(
    medparkContext.status === 200,
    `MedPark session context returned HTTP ${medparkContext.status}`,
  );
  expect(medparkContext.body?.tenantId === medparkTenantId, "MedPark token resolved wrong tenant");
  expect(
    medparkContext.body?.externalUserId === EXTERNAL_USER_ID,
    "MedPark token resolved wrong external user",
  );
  expect(
    medparkContext.body?.sessionId === medpark.claims.session_id,
    "MedPark context session ID does not match token",
  );

  const isolationExchange = await request(
    workerUrl,
    "/v1/session/exchange",
    serverAuth(isolationSecret),
    { method: "POST", body: { external_user_id: EXTERNAL_USER_ID } },
  );
  const isolation = validateSession(isolationExchange, isolationTenantId, "Isolation tenant");
  expect(
    isolation.user.id !== medpark.user.id,
    "Same external user ID was not isolated into distinct Santo users across tenants",
  );

  const isolationContext = await request(
    workerUrl,
    "/v1/session/context",
    sessionAuth(isolation.token),
  );
  expect(isolationContext.status === 200, "Isolation tenant session context failed");
  expect(
    isolationContext.body?.tenantId === isolationTenantId,
    "Isolation token resolved MedPark or another tenant",
  );

  const modifiedToken = tamperToken(medpark.token);
  mask(modifiedToken);
  const tampered = await request(workerUrl, "/v1/session/context", sessionAuth(modifiedToken));
  expect(
    tampered.status === 401 && tampered.body?.error === "INVALID_SESSION_TOKEN",
    "Tampered Santo session token was not rejected",
  );

  await saveState({
    externalUserId: EXTERNAL_USER_ID,
    medpark: { tenantId: medparkTenantId, userId: medpark.user.id },
    isolation: { tenantId: isolationTenantId, userId: isolation.user.id },
  });

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "",
        "### P4 real external-user session acceptance",
        "",
        "- MedPark server-secret session exchange: passed",
        "- External user `58392` tenant scope: passed",
        "- Same external ID in second tenant: isolated",
        "- JWT issuer/audience/tenant/sub/session_id/jti/iat/exp: verified",
        "- 15-minute lifetime: verified",
        "- Session middleware/context verification: passed",
        "- Tampered token: 401 INVALID_SESSION_TOKEN",
        "- Invalid payload: 400 INVALID_SESSION_REQUEST",
        "- Invalid server credential: 401",
        "- Server credentials and session tokens: masked and absent from persisted P4 state",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  console.log("P4 live external-user session acceptance passed.");
}

const command = process.argv[2];
if (command === "verify") await verify();
else throw new Error("Expected command: verify");
