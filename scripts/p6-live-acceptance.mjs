import { readFile } from "node:fs/promises";

const P2_STATE_PATH = process.env.P2_WORKOS_STATE_PATH ?? "/tmp/santo-p2-workos-state.json";
const EXTERNAL_USER_ID = "p6-grounded-user";

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

async function request(workerUrl, path, { method = "GET", authorization, smokeToken, body } = {}) {
  const response = await fetch(`${workerUrl}${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(smokeToken ? { "x-santo-infra-smoke-token": smokeToken } : {}),
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

async function issueCredential(workerUrl, tenantId, ownerToken) {
  const result = await request(workerUrl, `/v1/portal/tenants/${tenantId}/credentials`, {
    method: "POST",
    authorization: `Bearer ${ownerToken}`,
  });
  expect(result.status === 201, `Credential issuance returned HTTP ${result.status}`);
  const secret = result.body?.secret;
  expect(
    typeof secret === "string" && /^santo_sk_[0-9a-f]{12}_[0-9a-f]{64}$/.test(secret),
    "Credential issuance did not return a valid one-time secret",
  );
  mask(secret);
  return secret;
}

async function exchangeSession(workerUrl, secret) {
  const result = await request(workerUrl, "/v1/session/exchange", {
    method: "POST",
    authorization: `Santo ${secret}`,
    body: { external_user_id: EXTERNAL_USER_ID },
  });
  expect(result.status === 200, `Session exchange returned HTTP ${result.status}`);
  const token = result.body?.accessToken;
  expect(typeof token === "string" && token.split(".").length === 3, "Session token is invalid");
  mask(token);
  return token;
}

async function verify() {
  const workerUrl = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const smokeToken = requireEnv("INFRA_SMOKE_TOKEN");
  const p2 = await readJson(P2_STATE_PATH);
  const tenantId = p2.santo?.tenants?.medpark?.id;
  const ownerToken = p2.workos?.users?.medparkOwner?.accessToken;
  expect(typeof tenantId === "string", "P2 state is missing the MedPark tenant ID");
  expect(typeof ownerToken === "string", "P2 state is missing the MedPark owner access token");

  const secret = await issueCredential(workerUrl, tenantId, ownerToken);
  const sessionToken = await exchangeSession(workerUrl, secret);

  const setup = await request(workerUrl, "/__infra/p6-grounded-ai-acceptance/setup", {
    method: "POST",
    smokeToken,
    body: { tenantId, externalUserId: EXTERNAL_USER_ID },
  });
  const setupStage =
    typeof setup.body?.stage === "string"
      ? setup.body.stage
      : typeof setup.body?.error === "string"
        ? setup.body.error
        : "unknown";
  expect(
    setup.status === 200,
    `P6 acceptance setup returned HTTP ${setup.status} at ${setupStage}`,
  );
  expect(setup.body?.status === "ready", "P6 acceptance setup did not become ready");
  expect(typeof setup.body?.instanceId === "string", "P6 setup is missing the fixture instance ID");
  expect(typeof setup.body?.query === "string", "P6 setup is missing the fixture query");

  const invalidSession = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: "Bearer invalid-session-token",
    body: { query: setup.body.query, idempotency_key: "p6-invalid-session" },
  });
  expect(
    invalidSession.status === 401 && invalidSession.body?.error === "INVALID_SESSION_TOKEN",
    `Invalid Santo session was not denied before AI work: HTTP ${invalidSession.status}`,
  );

  const idempotencyKey = `p6-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
  const queryBody = { query: setup.body.query, idempotency_key: idempotencyKey };
  const first = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: queryBody,
  });
  expect(first.status === 200, `Grounded AI request returned HTTP ${first.status}`);
  expect(
    typeof first.body?.answer === "string" && first.body.answer.length > 0,
    "AI answer is empty",
  );
  expect(
    first.body.answer.includes("17"),
    "AI answer did not use the deterministic fixture evidence",
  );
  expect(
    Array.isArray(first.body?.citations) && first.body.citations.length > 0,
    "AI response has no citations",
  );
  expect(
    first.body.citations.some(
      (citation) =>
        typeof citation?.sourceId === "string" &&
        citation.sourceId.startsWith(`${setup.body.instanceId}:`),
    ),
    "No returned citation resolved to the temporary AI Search fixture",
  );
  expect(
    first.body?.usage?.unitsCharged === 1,
    "Successful grounded answer did not charge one unit",
  );
  expect(
    first.body?.usage?.remaining === 0,
    "Successful grounded answer did not consume the user quota",
  );

  const replay = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: queryBody,
  });
  expect(replay.status === 200, `Identical idempotent replay returned HTTP ${replay.status}`);
  expect(replay.body?.usage?.unitsCharged === 1, "Replay returned an invalid charge shape");
  expect(replay.body?.usage?.remaining === 0, "Identical replay double-charged quota");

  const exhausted = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: { query: setup.body.query, idempotency_key: `${idempotencyKey}-new` },
  });
  expect(
    exhausted.status === 429 && exhausted.body?.error === "USER_QUOTA_EXHAUSTED",
    `Exhausted user quota was not denied before expensive work: HTTP ${exhausted.status}`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "",
        "### P6 grounded AI live acceptance",
        "",
        "- Real MedPark server credential + Santo session exchange: passed",
        "- Invalid Santo session: denied with 401 before quota/search/model",
        "- Real TenantMeterDO reservation before AI work: passed",
        "- Temporary AI Search fixture indexed with built-in storage: passed",
        "- Real namespace retrieval + Workers AI model call: passed",
        "- Answer contained deterministic fixture value `17`: passed",
        "- Returned citation resolved to the retrieved fixture instance: passed",
        "- Successful request charged exactly one unit: passed",
        "- Identical retry with same idempotency key did not double-charge: passed",
        "- New request after user quota exhaustion: denied with 429",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  console.log("P6 live grounded AI acceptance passed.");
}

async function cleanup() {
  const workerUrl = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const smokeToken = requireEnv("INFRA_SMOKE_TOKEN");
  const result = await request(workerUrl, "/__infra/p6-grounded-ai-acceptance", {
    method: "DELETE",
    smokeToken,
  });
  expect(result.status === 200, `P6 AI Search fixture cleanup returned HTTP ${result.status}`);
  expect(result.body?.status === "clean", "P6 AI Search fixture cleanup did not report clean");
  console.log("P6 AI Search fixture cleanup passed.");
}

const command = process.argv[2];
if (command === "verify") await verify();
else if (command === "cleanup") await cleanup();
else throw new Error("Expected command: verify | cleanup");
