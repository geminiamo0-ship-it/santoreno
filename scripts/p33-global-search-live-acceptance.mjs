import { appendFile, readFile } from "node:fs/promises";

const P2_STATE_PATH = process.env.P2_WORKOS_STATE_PATH ?? "/tmp/santo-p2-workos-state.json";
const EXTERNAL_USER_ID = "p33-global-search-user";
const AI_SEARCH_NAMESPACE = "default";
const RUN_SUFFIX = (process.env.GITHUB_SHA ?? "local").slice(0, 12);
const MRCP_INSTANCE_ID = `santo-p33-mrcp-${RUN_SUFFIX}`;
const USMLE_INSTANCE_ID = `santo-p33-usmle-${RUN_SUFFIX}`;
const INVALID_INSTANCE_ID = `santo-p33-unknown-${RUN_SUFFIX}`;
const AI_SEARCH_INDEX_TIMEOUT_MS = 5 * 60 * 1_000;
const AI_SEARCH_POLL_INTERVAL_MS = 3_000;
const SHARED_FILTER_QUERY =
  "According to the Santo P33 selected-library acceptance fixture, what synthetic verification dose is specified?";
const ALL_LIBRARIES_QUERY =
  "According to the Santo P33 all-libraries acceptance fixtures, what shared synthetic verification dose is specified?";

const FIXTURES = [
  {
    id: MRCP_INSTANCE_ID,
    key: "santo-p33-mrcp-fixture.md",
    marker: "SANTO-P33-MRCP-23",
    expectedValue: "23",
    content: [
      "# Santo P33 MRCP Search Acceptance Fixture",
      "",
      "This document exists only for Santo staging acceptance testing.",
      "According to the Santo P33 selected-library acceptance fixture, the synthetic verification dose specified is exactly 23 micro-units.",
      "According to the Santo P33 all-libraries acceptance fixtures, the shared synthetic verification dose specified is exactly 47 micro-units.",
      "Markers: SANTO-P33-MRCP-23 and SANTO-P33-COMMON-47.",
      "Do not infer any clinical meaning from these synthetic values.",
    ].join("\n"),
  },
  {
    id: USMLE_INSTANCE_ID,
    key: "santo-p33-usmle-fixture.md",
    marker: "SANTO-P33-USMLE-31",
    expectedValue: "31",
    content: [
      "# Santo P33 USMLE Search Acceptance Fixture",
      "",
      "This document exists only for Santo staging acceptance testing.",
      "According to the Santo P33 selected-library acceptance fixture, the synthetic verification dose specified is exactly 31 micro-units.",
      "According to the Santo P33 all-libraries acceptance fixtures, the shared synthetic verification dose specified is exactly 47 micro-units.",
      "Markers: SANTO-P33-USMLE-31 and SANTO-P33-COMMON-47.",
      "Do not infer any clinical meaning from these synthetic values.",
    ].join("\n"),
  },
];

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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function cloudflareApiBase() {
  const accountId = encodeURIComponent(requireEnv("CLOUDFLARE_ACCOUNT_ID"));
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/namespaces/${AI_SEARCH_NAMESPACE}`;
}

function cloudflareErrorSummary(payload) {
  if (!payload || typeof payload !== "object") return "unknown";
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  if (errors.length === 0) return "unknown";
  return errors
    .slice(0, 3)
    .map((entry) => {
      const code = entry && typeof entry === "object" ? entry.code : undefined;
      const message = entry && typeof entry === "object" ? entry.message : undefined;
      return `${String(code ?? "?")}:${String(message ?? "error")}`;
    })
    .join(", ");
}

async function cloudflareFetch(path, options = {}) {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const response = await fetch(`${cloudflareApiBase()}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...options.headers,
    },
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

async function deleteFixture(instanceId, { tolerateMissing = true } = {}) {
  const result = await cloudflareFetch(`/instances/${instanceId}`, { method: "DELETE" });
  if (result.status === 404 && tolerateMissing) return;
  if (result.status >= 200 && result.status < 300 && result.body?.success !== false) return;
  throw new Error(
    `AI Search fixture delete failed for ${instanceId}: HTTP ${result.status} (${cloudflareErrorSummary(result.body)})`,
  );
}

async function createFixtureInstance(instanceId) {
  const result = await cloudflareFetch("/instances", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: instanceId }),
  });
  expect(
    result.status >= 200 && result.status < 300 && result.body?.success !== false,
    `AI Search fixture create failed for ${instanceId}: HTTP ${result.status} (${cloudflareErrorSummary(result.body)})`,
  );
}

async function getAiSearchItem(instanceId, itemId) {
  return cloudflareFetch(`/instances/${instanceId}/items/${encodeURIComponent(itemId)}`);
}

async function probeFixture(workerUrl, smokeToken, fixture) {
  const result = await request(workerUrl, "/__infra/p33-global-search-acceptance/probe", {
    method: "POST",
    smokeToken,
    body: {
      fixtureInstanceId: fixture.id,
      marker: fixture.marker,
    },
  });
  expect(
    result.status === 200 && result.body?.status === "ok",
    `P33 search readiness probe failed for ${fixture.id}: HTTP ${result.status} (${String(result.body?.error ?? "unknown")})`,
  );
  return result.body?.searchable === true;
}

async function waitForSearchableFixture(workerUrl, smokeToken, fixture, itemId, initialStatus) {
  let status = initialStatus;
  const deadline = Date.now() + AI_SEARCH_INDEX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeFixture(workerUrl, smokeToken, fixture)) {
      return;
    }
    if (["error", "skipped", "outdated"].includes(status)) {
      throw new Error(`AI Search fixture ${fixture.id} indexing ended with status ${status}`);
    }

    await sleep(AI_SEARCH_POLL_INTERVAL_MS);
    const polled = await getAiSearchItem(fixture.id, itemId);
    expect(
      polled.status >= 200 && polled.status < 300 && polled.body?.success !== false,
      `AI Search item poll failed for ${fixture.id}: HTTP ${polled.status} (${cloudflareErrorSummary(polled.body)})`,
    );
    status = polled.body?.result?.status;
  }
  throw new Error(
    `AI Search fixture ${fixture.id} was not searchable before timeout; item status ${String(status)}`,
  );
}

async function uploadFixture(workerUrl, smokeToken, fixture) {
  let lastFailure = "unknown";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const form = new FormData();
    form.append("file", new Blob([fixture.content], { type: "text/markdown" }), fixture.key);
    form.append("wait_for_completion", "true");

    const result = await cloudflareFetch(`/instances/${fixture.id}/items`, {
      method: "POST",
      body: form,
    });
    if (result.status >= 200 && result.status < 300 && result.body?.success !== false) {
      const itemId = result.body?.result?.id;
      const status = result.body?.result?.status;
      expect(
        typeof itemId === "string" && itemId.length > 0,
        `AI Search upload returned no item ID for ${fixture.id}`,
      );
      expect(
        typeof status === "string",
        `AI Search upload returned no item status for ${fixture.id}`,
      );
      await waitForSearchableFixture(workerUrl, smokeToken, fixture, itemId, status);
      return;
    }

    lastFailure = `HTTP ${result.status} (${cloudflareErrorSummary(result.body)})`;
    const retryable =
      result.status === 404 ||
      result.status === 409 ||
      result.status === 429 ||
      result.status >= 500;
    if (!retryable || attempt === 8) break;
    await sleep(2_000);
  }
  throw new Error(`AI Search fixture upload failed for ${fixture.id}: ${lastFailure}`);
}

async function prepareFixtures(workerUrl, smokeToken) {
  for (const fixture of FIXTURES) {
    await deleteFixture(fixture.id);
    await createFixtureInstance(fixture.id);
    await uploadFixture(workerUrl, smokeToken, fixture);
  }
  console.log("P33 AI Search fixtures are searchable through the Worker binding.");
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

function expectSuccessfulAnswer(result, expectedValue, allowedInstanceIds, expectedRemaining) {
  expect(
    result.status === 200,
    `Grounded AI request returned HTTP ${result.status} (${String(result.body?.error ?? "unknown")})`,
  );
  expect(
    typeof result.body?.answer === "string" && result.body.answer.includes(expectedValue),
    `AI answer did not contain expected synthetic value ${expectedValue}`,
  );
  expect(
    Array.isArray(result.body?.citations) && result.body.citations.length > 0,
    "AI response has no citations",
  );
  expect(
    result.body.citations.every(
      (citation) =>
        typeof citation?.sourceId === "string" &&
        allowedInstanceIds.some((instanceId) => citation.sourceId.startsWith(`${instanceId}:`)),
    ),
    `AI response contained a citation outside expected instances: ${allowedInstanceIds.join(", ")}`,
  );
  expect(result.body?.usage?.unitsCharged === 1, "Successful answer did not charge one unit");
  expect(
    result.body?.usage?.remaining === expectedRemaining,
    `Unexpected remaining quota: expected ${expectedRemaining}, got ${String(result.body?.usage?.remaining)}`,
  );
}

async function verify() {
  const workerUrl = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const smokeToken = requireEnv("INFRA_SMOKE_TOKEN");
  const p2 = await readJson(P2_STATE_PATH);
  const tenantId = p2.santo?.tenants?.medpark?.id;
  const ownerToken = p2.workos?.users?.medparkOwner?.accessToken;
  expect(typeof tenantId === "string", "P2 state is missing the MedPark tenant ID");
  expect(typeof ownerToken === "string", "P2 state is missing the MedPark owner access token");

  await prepareFixtures(workerUrl, smokeToken);

  const secret = await issueCredential(workerUrl, tenantId, ownerToken);
  const sessionToken = await exchangeSession(workerUrl, secret);

  const setup = await request(workerUrl, "/__infra/p33-global-search-acceptance/setup", {
    method: "POST",
    smokeToken,
    body: {
      tenantId,
      externalUserId: EXTERNAL_USER_ID,
      fixtureInstanceIds: FIXTURES.map((fixture) => fixture.id),
    },
  });
  expect(
    setup.status === 200,
    `P33 runtime setup returned HTTP ${setup.status} (${String(setup.body?.error ?? "unknown")})`,
  );
  expect(setup.body?.status === "ready", "P33 runtime setup did not become ready");

  const sharedKey = `p33-scope-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
  const mrcp = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: SHARED_FILTER_QUERY,
      idempotency_key: sharedKey,
      library_id: MRCP_INSTANCE_ID,
    },
  });
  expectSuccessfulAnswer(mrcp, "23", [MRCP_INSTANCE_ID], 3);

  const usmle = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: SHARED_FILTER_QUERY,
      idempotency_key: sharedKey,
      library_id: USMLE_INSTANCE_ID,
    },
  });
  expectSuccessfulAnswer(usmle, "31", [USMLE_INSTANCE_ID], 2);

  const allLibraries = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: ALL_LIBRARIES_QUERY,
      idempotency_key: `${sharedKey}-all`,
    },
  });
  expectSuccessfulAnswer(allLibraries, "47", [MRCP_INSTANCE_ID, USMLE_INSTANCE_ID], 1);

  const invalid = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: SHARED_FILTER_QUERY,
      idempotency_key: `${sharedKey}-invalid`,
      library_id: INVALID_INSTANCE_ID,
    },
  });
  expect(
    invalid.status === 400 && invalid.body?.error === "INVALID_LIBRARY_FILTER",
    `Unknown library did not fail closed: HTTP ${invalid.status} (${String(invalid.body?.error ?? "unknown")})`,
  );

  const afterInvalid = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: SHARED_FILTER_QUERY,
      idempotency_key: `${sharedKey}-after-invalid`,
      library_id: MRCP_INSTANCE_ID,
    },
  });
  expectSuccessfulAnswer(afterInvalid, "23", [MRCP_INSTANCE_ID], 0);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "",
        "### P33 global AI Search live acceptance",
        "",
        "- Real WorkOS-backed tenant + Santo session: passed",
        "- Two run-isolated AI Search libraries became searchable through the Worker binding: passed",
        "- Same query/client key with MRCP filter returned only MRCP citations and charged one unit: passed",
        "- Same query/client key with USMLE filter returned only USMLE citations and charged a distinct unit: passed",
        "- All Libraries request returned shared synthetic value from a P33 fixture: passed",
        "- Unknown library filter returned structured INVALID_LIBRARY_FILTER: passed",
        "- Successful request after invalid filter proved reservation release: passed",
        "- Real Workers AI generation + server-side citation validation remained on runtime path: passed",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  console.log("P33 global AI Search live acceptance passed.");
}

async function cleanup() {
  for (const fixture of FIXTURES) {
    await deleteFixture(fixture.id);
  }
  console.log("P33 AI Search fixture cleanup passed.");
}

const command = process.argv[2];
if (command === "verify") await verify();
else if (command === "cleanup") await cleanup();
else throw new Error("Expected command: verify | cleanup");
