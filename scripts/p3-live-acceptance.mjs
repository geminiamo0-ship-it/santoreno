import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const P2_STATE_PATH = process.env.P2_WORKOS_STATE_PATH ?? "/tmp/santo-p2-workos-state.json";
const P3_STATE_PATH = process.env.P3_CREDENTIAL_STATE_PATH ?? "/tmp/santo-p3-credential-state.json";

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
  await writeFile(P3_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await chmod(P3_STATE_PATH, 0o600);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function request(workerUrl, path, authorization, { method = "GET", body } = {}) {
  const response = await fetch(`${workerUrl}${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

function validateIssueResponse(response, tenantId, label) {
  expect(response.status === 201, `${label} returned HTTP ${response.status}`);
  const secret = response.body?.secret;
  const credential = response.body?.credential;
  expect(
    typeof secret === "string" && /^santo_sk_[0-9a-f]{12}_[0-9a-f]{64}$/.test(secret),
    `${label} did not return a valid one-time server secret`,
  );
  expect(credential?.tenantId === tenantId, `${label} returned the wrong tenant`);
  expect(typeof credential?.id === "string", `${label} is missing the credential ID`);
  expect(typeof credential?.prefix === "string", `${label} is missing the credential prefix`);
  mask(secret);
  return { secret, credential };
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

  const crossTenantIssue = await request(
    workerUrl,
    `/v1/portal/tenants/${medparkTenantId}/credentials`,
    portalAuth(isolationOwnerToken),
    { method: "POST" },
  );
  expect(
    crossTenantIssue.status === 403 && crossTenantIssue.body?.error === "FORBIDDEN",
    "Second tenant owner was able to issue a MedPark credential",
  );

  const issueResponse = await request(
    workerUrl,
    `/v1/portal/tenants/${medparkTenantId}/credentials`,
    portalAuth(medparkOwnerToken),
    { method: "POST" },
  );
  const issued = validateIssueResponse(issueResponse, medparkTenantId, "Credential issuance");

  const state = {
    medparkTenantId,
    isolationTenantId,
    issued: {
      id: issued.credential.id,
      prefix: issued.credential.prefix,
      hash: sha256(issued.secret),
    },
    rotated: null,
  };
  await saveState(state);

  const ownContext = await request(
    workerUrl,
    `/v1/server/tenants/${medparkTenantId}/context`,
    serverAuth(issued.secret),
  );
  expect(ownContext.status === 200, `MedPark server context returned HTTP ${ownContext.status}`);
  expect(ownContext.body?.tenantId === medparkTenantId, "Server credential resolved wrong tenant");
  expect(
    ownContext.body?.credentialId === issued.credential.id,
    "Server credential resolved wrong credential ID",
  );

  const crossTenantContext = await request(
    workerUrl,
    `/v1/server/tenants/${isolationTenantId}/context`,
    serverAuth(issued.secret),
  );
  expect(
    crossTenantContext.status === 403 && crossTenantContext.body?.error === "FORBIDDEN",
    "MedPark server credential was not denied against the second tenant",
  );

  const replacementLastCharacter = issued.secret.endsWith("0") ? "1" : "0";
  const invalidSecret = `${issued.secret.slice(0, -1)}${replacementLastCharacter}`;
  mask(invalidSecret);
  const invalidContext = await request(
    workerUrl,
    `/v1/server/tenants/${medparkTenantId}/context`,
    serverAuth(invalidSecret),
  );
  expect(invalidContext.status === 401, "Modified server secret was not rejected");

  const domains = await request(
    workerUrl,
    `/v1/portal/tenants/${medparkTenantId}/domains`,
    portalAuth(medparkOwnerToken),
    {
      method: "PUT",
      body: { domains: ["APP.MEDPARK.COM", "medpark.com", "medpark.com"] },
    },
  );
  expect(domains.status === 200, `Allowed-domain update returned HTTP ${domains.status}`);
  expect(
    JSON.stringify(domains.body?.domains) === JSON.stringify(["app.medpark.com", "medpark.com"]),
    "Allowed domains were not normalized and deduplicated",
  );

  const rotateResponse = await request(
    workerUrl,
    `/v1/portal/tenants/${medparkTenantId}/credentials/${issued.credential.id}/rotate`,
    portalAuth(medparkOwnerToken),
    { method: "POST" },
  );
  const rotated = validateIssueResponse(rotateResponse, medparkTenantId, "Credential rotation");
  expect(rotated.secret !== issued.secret, "Rotation returned the old server secret");
  expect(
    rotated.credential.rotatedFromId === issued.credential.id,
    "Rotated credential does not reference the previous credential",
  );

  state.rotated = {
    id: rotated.credential.id,
    prefix: rotated.credential.prefix,
    hash: sha256(rotated.secret),
  };
  await saveState(state);

  const oldAfterRotate = await request(
    workerUrl,
    `/v1/server/tenants/${medparkTenantId}/context`,
    serverAuth(issued.secret),
  );
  expect(oldAfterRotate.status === 401, "Old server secret still works after rotation");

  const newAfterRotate = await request(
    workerUrl,
    `/v1/server/tenants/${medparkTenantId}/context`,
    serverAuth(rotated.secret),
  );
  expect(newAfterRotate.status === 200, "Rotated server secret does not authenticate");

  const revoke = await request(
    workerUrl,
    `/v1/portal/tenants/${medparkTenantId}/credentials/${rotated.credential.id}`,
    portalAuth(medparkOwnerToken),
    { method: "DELETE" },
  );
  expect(revoke.status === 200, `Credential revocation returned HTTP ${revoke.status}`);
  expect(revoke.body?.status === "revoked", "Credential revocation did not return revoked status");

  const afterRevoke = await request(
    workerUrl,
    `/v1/server/tenants/${medparkTenantId}/context`,
    serverAuth(rotated.secret),
  );
  expect(afterRevoke.status === 401, "Revoked server secret still authenticates");

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      "",
      "### P3 real server-credential acceptance",
      "",
      "- MedPark owner credential issuance: passed",
      "- Second-tenant owner issuing MedPark credential: 403 FORBIDDEN",
      "- Server-secret tenant resolution: passed",
      "- Cross-tenant server context: 403 FORBIDDEN",
      "- Modified secret: 401",
      "- Allowed-domain normalization: passed",
      "- Rotation: new key accepted, old key denied",
      "- Revocation: revoked key denied",
      "- Plaintext secrets: masked and not persisted in P3 state",
    ].join("\n");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, "utf8");
  }

  console.log("P3 live server-credential acceptance passed.");
}

const command = process.argv[2];
if (command === "verify") await verify();
else throw new Error("Expected command: verify");
