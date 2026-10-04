import { randomBytes } from "node:crypto";
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";

const WORKOS_API_BASE = "https://api.workos.com";
const STATE_PATH = process.env.P2_WORKOS_STATE_PATH ?? "/tmp/santo-p2-workos-state.json";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function mask(value) {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

async function appendGithubFile(name, line) {
  const path = process.env[name];
  if (path) await appendFile(path, `${line}\n`, "utf8");
}

async function saveState(state) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await chmod(STATE_PATH, 0o600);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function responseMessage(body) {
  if (!body || typeof body !== "object") return "";
  return body.message ?? body.error_description ?? body.error ?? body.code ?? "";
}

async function requestJson(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const detail = responseMessage(body);
    throw new Error(
      `${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  return { status: response.status, body };
}

async function workosRequest(path, { method = "GET", body } = {}) {
  const apiKey = requireEnv("WORKOS_API_KEY");
  return requestJson(
    `${WORKOS_API_BASE}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    `WorkOS ${method} ${path}`,
  );
}

async function authenticate(email, password) {
  const clientId = requireEnv("WORKOS_CLIENT_ID");
  const apiKey = requireEnv("WORKOS_API_KEY");
  const { body } = await requestJson(
    `${WORKOS_API_BASE}/user_management/authenticate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: apiKey,
        grant_type: "password",
        email,
        password,
      }),
    },
    `WorkOS password authentication for ${email}`,
  );

  if (!body?.access_token || !body?.user?.id) {
    throw new Error("WorkOS authentication response is missing the user or access token");
  }

  mask(body.access_token);
  if (body.refresh_token) mask(body.refresh_token);
  return body;
}

function runTag() {
  const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  return `${runId}-${attempt}`.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
}

function password() {
  const value = `Santo-P2-${randomBytes(24).toString("hex")}`;
  mask(value);
  return value;
}

async function createOrganization(name, externalId) {
  const { body } = await workosRequest("/organizations", {
    method: "POST",
    body: { name, external_id: externalId },
  });
  if (!body?.id) {
    throw new Error(`WorkOS did not return an ID for organization ${name}`);
  }
  return body;
}

async function createUser(email, userPassword) {
  const { body } = await workosRequest("/user_management/users", {
    method: "POST",
    body: {
      email,
      password: userPassword,
      email_verified: true,
      first_name: "Santo",
      last_name: "P2 Acceptance",
    },
  });
  if (!body?.id) throw new Error(`WorkOS did not return an ID for user ${email}`);
  return body;
}

async function createMembership(userId, organizationId) {
  await workosRequest("/user_management/organization_memberships", {
    method: "POST",
    body: { user_id: userId, organization_id: organizationId },
  });
}

async function deleteIgnoringMissing(path) {
  const apiKey = requireEnv("WORKOS_API_KEY");
  const response = await fetch(`${WORKOS_API_BASE}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (response.ok || response.status === 404) return;
  const text = await response.text();
  throw new Error(
    `WorkOS cleanup failed for ${path} with HTTP ${response.status}: ${text}`,
  );
}

async function cleanupWorkos(state, { bestEffort = false } = {}) {
  if (!state?.workos) return;
  const errors = [];

  for (const user of Object.values(state.workos.users ?? {})) {
    if (!user?.id) continue;
    try {
      await deleteIgnoringMissing(
        `/user_management/users/${encodeURIComponent(user.id)}`,
      );
    } catch (error) {
      errors.push(error);
    }
  }

  for (const organization of Object.values(state.workos.organizations ?? {})) {
    if (!organization?.id) continue;
    try {
      await deleteIgnoringMissing(
        `/organizations/${encodeURIComponent(organization.id)}`,
      );
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0 && !bestEffort) {
    throw new AggregateError(
      errors,
      "One or more WorkOS staging fixtures could not be removed",
    );
  }
}

async function seed() {
  requireEnv("WORKOS_CLIENT_ID");
  requireEnv("WORKOS_API_KEY");

  const tag = runTag();
  const state = {
    runTag: tag,
    workos: {
      organizations: { medpark: null, isolation: null },
      users: { superAdmin: null, medparkOwner: null, isolationOwner: null },
    },
    santo: { tenants: { medpark: null, isolation: null } },
  };
  await saveState(state);

  const superPassword = password();
  const medparkPassword = password();
  const isolationPassword = password();

  try {
    state.workos.organizations.medpark = await createOrganization(
      "MedPark",
      `santo-p2-medpark-${tag}`,
    );
    await saveState(state);

    state.workos.organizations.isolation = await createOrganization(
      `Santo Isolation ${tag}`,
      `santo-p2-isolation-${tag}`,
    );
    await saveState(state);

    const superEmail = `santo-p2-super-${tag}@example.com`;
    const medparkEmail = `santo-p2-medpark-owner-${tag}@example.com`;
    const isolationEmail = `santo-p2-isolation-owner-${tag}@example.com`;

    const superUser = await createUser(superEmail, superPassword);
    state.workos.users.superAdmin = {
      id: superUser.id,
      email: superEmail,
      accessToken: null,
    };
    await saveState(state);

    const medparkUser = await createUser(medparkEmail, medparkPassword);
    state.workos.users.medparkOwner = {
      id: medparkUser.id,
      email: medparkEmail,
      accessToken: null,
    };
    await saveState(state);

    const isolationUser = await createUser(isolationEmail, isolationPassword);
    state.workos.users.isolationOwner = {
      id: isolationUser.id,
      email: isolationEmail,
      accessToken: null,
    };
    await saveState(state);

    await createMembership(
      medparkUser.id,
      state.workos.organizations.medpark.id,
    );
    await createMembership(
      isolationUser.id,
      state.workos.organizations.isolation.id,
    );

    const superAuth = await authenticate(superEmail, superPassword);
    const medparkAuth = await authenticate(medparkEmail, medparkPassword);
    const isolationAuth = await authenticate(isolationEmail, isolationPassword);

    if (superAuth.user.id !== superUser.id) {
      throw new Error(
        "Authenticated WorkOS Super Admin identity does not match the seeded user",
      );
    }
    if (
      medparkAuth.user.id !== medparkUser.id ||
      medparkAuth.organization_id !== state.workos.organizations.medpark.id
    ) {
      throw new Error(
        "MedPark owner authentication did not resolve the expected WorkOS organization",
      );
    }
    if (
      isolationAuth.user.id !== isolationUser.id ||
      isolationAuth.organization_id !== state.workos.organizations.isolation.id
    ) {
      throw new Error(
        "Isolation owner authentication did not resolve the expected WorkOS organization",
      );
    }

    state.workos.users.superAdmin.accessToken = superAuth.access_token;
    state.workos.users.medparkOwner.accessToken = medparkAuth.access_token;
    state.workos.users.isolationOwner.accessToken = isolationAuth.access_token;
    await saveState(state);

    await appendGithubFile(
      "GITHUB_ENV",
      `SANTO_SUPER_ADMIN_USER_IDS=${superUser.id}`,
    );
    console.log(
      "Real WorkOS staging identities were created and authenticated successfully.",
    );
  } catch (error) {
    await cleanupWorkos(state, { bestEffort: true });
    throw error;
  }
}

async function santoRequest(
  workerUrl,
  path,
  token,
  { method = "GET", body } = {},
) {
  const response = await fetch(`${workerUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function createSantoTenant(workerUrl, token, input) {
  const response = await santoRequest(workerUrl, "/v1/admin/tenants", token, {
    method: "POST",
    body: input,
  });
  expect(
    response.status === 201,
    `Tenant creation returned HTTP ${response.status}`,
  );
  expect(response.body?.id, "Tenant creation response is missing an ID");
  return response.body;
}

async function verify() {
  const workerUrl = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const state = await loadState();
  if (!state) throw new Error(`Missing P2 WorkOS state file at ${STATE_PATH}`);

  const superAdmin = state.workos.users.superAdmin;
  const medparkOwner = state.workos.users.medparkOwner;
  const isolationOwner = state.workos.users.isolationOwner;
  const medparkOrg = state.workos.organizations.medpark;
  const isolationOrg = state.workos.organizations.isolation;
  for (const value of [
    superAdmin,
    medparkOwner,
    isolationOwner,
    medparkOrg,
    isolationOrg,
  ]) {
    if (!value?.id) throw new Error("P2 WorkOS state is incomplete");
  }
  for (const user of [superAdmin, medparkOwner, isolationOwner]) {
    if (!user.accessToken) {
      throw new Error(
        "P2 WorkOS state is missing an authenticated access token",
      );
    }
  }

  const adminContext = await santoRequest(
    workerUrl,
    "/v1/portal/context",
    superAdmin.accessToken,
  );
  expect(
    adminContext.status === 200,
    `Super Admin context returned HTTP ${adminContext.status}`,
  );
  expect(
    adminContext.body?.role === "super_admin",
    "Super Admin role was not resolved server-side",
  );
  expect(
    adminContext.body?.tenant === null,
    "Super Admin must not inherit a tenant from browser input",
  );

  const medparkTenant = await createSantoTenant(
    workerUrl,
    superAdmin.accessToken,
    {
      slug: `medpark-${state.runTag}`,
      name: "MedPark",
      workosOrgId: medparkOrg.id,
      ownerWorkosUserId: medparkOwner.id,
    },
  );
  state.santo.tenants.medpark = { id: medparkTenant.id };
  await saveState(state);

  const isolationTenant = await createSantoTenant(
    workerUrl,
    superAdmin.accessToken,
    {
      slug: `isolation-${state.runTag}`,
      name: "Isolation Tenant",
      workosOrgId: isolationOrg.id,
      ownerWorkosUserId: isolationOwner.id,
    },
  );
  state.santo.tenants.isolation = { id: isolationTenant.id };
  await saveState(state);

  const medparkContext = await santoRequest(
    workerUrl,
    "/v1/portal/context",
    medparkOwner.accessToken,
  );
  expect(
    medparkContext.status === 200,
    `MedPark owner context returned HTTP ${medparkContext.status}`,
  );
  expect(
    medparkContext.body?.userId === medparkOwner.id,
    "MedPark owner user ID did not match WorkOS",
  );
  expect(
    medparkContext.body?.role === "owner",
    "MedPark owner role was not resolved from Santo membership",
  );
  expect(
    medparkContext.body?.tenant?.id === medparkTenant.id,
    "MedPark owner resolved the wrong tenant",
  );
  expect(
    medparkContext.body?.tenant?.name === "MedPark",
    "MedPark tenant name did not round-trip",
  );
  expect(
    medparkContext.body?.tenant?.workosOrgId === medparkOrg.id,
    "MedPark tenant did not map to the authenticated WorkOS organization",
  );

  const ownRead = await santoRequest(
    workerUrl,
    `/v1/portal/tenants/${medparkTenant.id}`,
    medparkOwner.accessToken,
  );
  expect(
    ownRead.status === 200,
    `MedPark owner self-tenant read returned HTTP ${ownRead.status}`,
  );

  const crossRead = await santoRequest(
    workerUrl,
    `/v1/portal/tenants/${isolationTenant.id}`,
    medparkOwner.accessToken,
  );
  expect(
    crossRead.status === 403,
    `Cross-tenant read returned HTTP ${crossRead.status}, expected 403`,
  );
  expect(
    crossRead.body?.error === "FORBIDDEN",
    "Cross-tenant read did not fail with FORBIDDEN",
  );

  const crossWrite = await santoRequest(
    workerUrl,
    `/v1/portal/tenants/${isolationTenant.id}`,
    medparkOwner.accessToken,
    { method: "PATCH", body: { name: "Compromised" } },
  );
  expect(
    crossWrite.status === 403,
    `Cross-tenant write returned HTTP ${crossWrite.status}, expected 403`,
  );
  expect(
    crossWrite.body?.error === "FORBIDDEN",
    "Cross-tenant write did not fail with FORBIDDEN",
  );

  const isolationContext = await santoRequest(
    workerUrl,
    "/v1/portal/context",
    isolationOwner.accessToken,
  );
  expect(
    isolationContext.status === 200 &&
      isolationContext.body?.tenant?.id === isolationTenant.id,
    "Isolation owner did not resolve the second tenant",
  );

  const isolationRead = await santoRequest(
    workerUrl,
    `/v1/portal/tenants/${isolationTenant.id}`,
    isolationOwner.accessToken,
  );
  expect(
    isolationRead.status === 200,
    "Isolation owner could not read its own tenant after denial test",
  );
  expect(
    isolationRead.body?.name === "Isolation Tenant",
    "Denied cross-tenant mutation changed the second tenant",
  );

  await appendGithubFile(
    "GITHUB_STEP_SUMMARY",
    [
      "",
      "### Real WorkOS AuthKit acceptance",
      "",
      "- Real WorkOS staging password authentication: passed",
      "- Santo Super Admin token verification: passed",
      "- MedPark tenant creation and owner context: passed",
      "- Second tenant creation: passed",
      "- MedPark owner cross-tenant read: 403 FORBIDDEN",
      "- MedPark owner cross-tenant write: 403 FORBIDDEN",
      "- Denied mutation left the second tenant unchanged",
    ].join("\n"),
  );

  console.log(
    "Real WorkOS staging auth and Santo cross-tenant isolation passed.",
  );
}

async function cleanupSql() {
  const state = await loadState();
  if (!state) return;
  const organizationIds = Object.values(state.workos?.organizations ?? {})
    .map((organization) => organization?.id)
    .filter(Boolean);
  if (organizationIds.length === 0) return;

  for (const organizationId of organizationIds) {
    if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) {
      throw new Error(
        `Unsafe WorkOS organization ID in cleanup state: ${organizationId}`,
      );
    }
  }

  const quoted = organizationIds.map((id) => `'${id}'`).join(", ");
  const memberCleanup =
    "DELETE FROM tenant_members WHERE tenant_id IN " +
    `(SELECT id FROM tenants WHERE workos_org_id IN (${quoted}));`;
  const tenantCleanup =
    `DELETE FROM tenants WHERE workos_org_id IN (${quoted});`;
  console.log(`${memberCleanup} ${tenantCleanup}`);
}

async function cleanup() {
  const state = await loadState();
  if (!state) {
    console.log("No WorkOS staging fixture state exists; cleanup is not required.");
    return;
  }
  await cleanupWorkos(state);
  console.log("WorkOS staging fixtures were removed.");
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "verify") await verify();
else if (command === "cleanup-sql") await cleanupSql();
else if (command === "cleanup-workos") await cleanup();
else throw new Error("Expected one of: seed, verify, cleanup-sql, cleanup-workos");
