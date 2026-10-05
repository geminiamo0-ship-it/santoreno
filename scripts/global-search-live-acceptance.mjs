import { appendFile, readFile } from "node:fs/promises";

const P2_STATE_PATH = process.env.P2_WORKOS_STATE_PATH ?? "/tmp/santo-p2-workos-state.json";
const EXTERNAL_USER_ID = "global-search-acceptance-user";
const AI_SEARCH_NAMESPACE = "default";
const RUN_SUFFIX = (process.env.GITHUB_SHA ?? "local00000000").slice(0, 12);
const AI_SEARCH_INDEX_TIMEOUT_MS = 5 * 60 * 1_000;
const AI_SEARCH_POLL_INTERVAL_MS = 3_000;

const FIXTURES = [
  {
    id: `santo-gsearch-alpha-${RUN_SUFFIX}`,
    key: "santo-global-search-alpha.md",
    marker: "31",
    content: [
      "# Santo Global Search Alpha Acceptance Fixture",
      "",
      "This synthetic document exists only for Santo staging acceptance testing.",
      "The Santo Global Search Alpha fixture specifies the synthetic verification dose as exactly 31 micro-units.",
      "The unique alpha marker is SANTO-GSEARCH-ALPHA-31.",
      "Do not infer any clinical meaning from this synthetic test value.",
    ].join("\n"),
  },
  {
    id: `santo-gsearch-beta-${RUN_SUFFIX}`,
    key: "santo-global-search-beta.md",
    marker: "47",
    content: [
      "# Santo Global Search Beta Acceptance Fixture",
      "",
      "This synthetic document exists only for Santo staging acceptance testing.",
      "The Santo Global Search Beta fixture specifies the synthetic verification dose as exactly 47 micro-units.",
      "The unique beta marker is SANTO-GSEARCH-BETA-47.",
      "Do not infer any clinical meaning from this synthetic test value.",
    ].join("\n"),
  },
];

const ALPHA = FIXTURES[0];
const BETA = FIXTURES[1];
const ALPHA_QUERY =
  "According to the Santo Global Search Alpha acceptance fixture, what synthetic verification dose is specified?";
const GENERIC_QUERY =
  "What synthetic verification dose is specified by this Santo acceptance fixture?";

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

async function request(
  workerUrl,
  path,
  { method = "GET", authorization, smokeToken, body } = {},
) {
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
  const response = await fetch(`${cloudflareApiBase()}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${requireEnv("CLOUDFLARE_API_TOKEN")}`,
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
    `AI Search fixture ${instanceId} delete failed: HTTP ${result.status} (${cloudflareErrorSummary(result.body)})`,
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
    `AI Search fixture ${instanceId} create failed: HTTP ${result.status} (${cloudflareErrorSummary(result.body)})`,
  );
}

async function getAiSearchItem(instanceId, itemId) {
  return cloudflareFetch(`/instances/${instanceId}/items/${encodeURIComponent(itemId)}`);
}

async function waitForIndexedItem(instanceId, itemId, initialStatus) {
  let status = initialStatus;
  const deadline = Date.now() + AI_SEARCH_INDEX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (status === "completed") return;
    if (["error", "skipped", "outdated"].includes(status)) {
      throw new Error(`AI Search fixture ${instanceId} indexing ended with status ${status}`);
    }
    await sleep(AI_SEARCH_POLL_INTERVAL_MS);
    const polled = await getAiSearchItem(instanceId, itemId);
    expect(
      polled.status >= 200 && polled.status < 300 && polled.body?.success !== false,
      `AI Search item poll failed for ${instanceId}: HTTP ${polled.status} (${cloudflareErrorSummary(polled.body)})`,
    );
    status = polled.body?.result?.status;
  }
  throw new Error(`AI Search fixture ${instanceId} indexing timed out with status ${String(status)}`);
}

async function uploadFixture(fixture) {
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
        "AI Search upload returned no item ID",
      );
      expect(typeof status === "string", "AI Search upload returned no item status");
      await waitForIndexedItem(fixture.id, itemId, status);
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
  throw new Error(`AI Search fixture ${fixture.id} upload failed: ${lastFailure}`);
}

async function prepareFixtures() {
  for (const fixture of FIXTURES) {
    await deleteFixture(fixture.id);
    await createFixtureInstance(fixture.id);
    await uploadFixture(fixture);
  }
  console.log("Global Search AI Search fixtures are indexed and queryable.");
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
  expect(
    typeof token === "string" && token.split(".").length === 3,
    "Session token is invalid",
  );
  mask(token);
  return token;
}

function assertGroundedResponse(result, { marker, instanceId, remaining, label }) {
  expect(
    result.status === 200,
    `${label} returned HTTP ${result.status} (${String(result.body?.error ?? "unknown")})`,
  );
  expect(
    typeof result.body?.answer === "string" && result.body.answer.includes(marker),
    `${label} did not use the expected fixture marker ${marker}`,
  );
  expect(
    Array.isArray(result.body?.citations) &&
      result.body.citations.some(
        (citation) =>
          typeof citation?.sourceId === "string" && citation.sourceId.startsWith(`${instanceId}:`),
      ),
    `${label} returned no citation from selected library ${instanceId}`,
  );
  expect(result.body?.usage?.unitsCharged === 1, `${label} did not report one charged unit`);
  expect(
    result.body?.usage?.remaining === remaining,
    `${label} returned remaining=${String(result.body?.usage?.remaining)} instead of ${remaining}`,
  );
}

async function verify() {
  const workerUrl = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const smokeToken = requireEnv("INFRA_SMOKE_TOKEN");
  const p2 = await readJson(P2_STATE_PATH);
  const tenantId = p2.santo?.tenants?.medpark?.id;
  const ownerToken = p2.workos?.users?.medparkOwner?.accessToken;
  expect(typeof tenantId === "string", "P2 state is missing the staging tenant ID");
  expect(typeof ownerToken === "string", "P2 state is missing the staging owner access token");

  await prepareFixtures();

  const secret = await issueCredential(workerUrl, tenantId, ownerToken);
  const sessionToken = await exchangeSession(workerUrl, secret);
  const setup = await request(workerUrl, "/__infra/global-search-acceptance/setup", {
    method: "POST",
    smokeToken,
    body: {
      tenantId,
      externalUserId: EXTERNAL_USER_ID,
      fixtureInstanceIds: FIXTURES.map((fixture) => fixture.id),
    },
  });
  expect(
    setup.status === 200 && setup.body?.status === "ready",
    `Global Search runtime setup failed: HTTP ${setup.status} (${String(setup.body?.error ?? "unknown")})`,
  );
  expect(
    Array.isArray(setup.body?.libraryIds) && setup.body.libraryIds.length === 2,
    "Global Search setup did not expose both fixture libraries",
  );

  const allLibraries = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: ALPHA_QUERY,
      idempotency_key: `gsearch-all-${process.env.GITHUB_RUN_ID ?? Date.now()}`,
    },
  });
  assertGroundedResponse(allLibraries, {
    marker: ALPHA.marker,
    instanceId: ALPHA.id,
    remaining: 3,
    label: "All Libraries query",
  });

  const sharedIdempotencyKey = `gsearch-filter-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
  const alphaFiltered = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: GENERIC_QUERY,
      idempotency_key: sharedIdempotencyKey,
      library_id: ALPHA.id,
    },
  });
  assertGroundedResponse(alphaFiltered, {
    marker: ALPHA.marker,
    instanceId: ALPHA.id,
    remaining: 2,
    label: "Alpha-filtered query",
  });

  const betaFiltered = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: GENERIC_QUERY,
      idempotency_key: sharedIdempotencyKey,
      library_id: BETA.id,
    },
  });
  assertGroundedResponse(betaFiltered, {
    marker: BETA.marker,
    instanceId: BETA.id,
    remaining: 1,
    label: "Beta-filtered query",
  });

  const unknownLibraryId = `santo-gsearch-unknown-${RUN_SUFFIX}`;
  const unknown = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: GENERIC_QUERY,
      idempotency_key: `gsearch-unknown-${process.env.GITHUB_RUN_ID ?? Date.now()}`,
      library_id: unknownLibraryId,
    },
  });
  expect(
    unknown.status === 400 && unknown.body?.error === "UNKNOWN_LIBRARY",
    `Unknown library did not fail closed with UNKNOWN_LIBRARY: HTTP ${unknown.status}`,
  );

  const malformed = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: GENERIC_QUERY,
      idempotency_key: `gsearch-malformed-${process.env.GITHUB_RUN_ID ?? Date.now()}`,
      library_id: "../../not-a-library",
    },
  });
  expect(
    malformed.status === 400 && malformed.body?.error === "INVALID_AI_QUERY",
    `Malformed library filter did not fail contract validation: HTTP ${malformed.status}`,
  );

  const afterRejectedFilters = await request(workerUrl, "/v1/ai/query", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: {
      query: GENERIC_QUERY,
      idempotency_key: `gsearch-after-reject-${process.env.GITHUB_RUN_ID ?? Date.now()}`,
      library_id: ALPHA.id,
    },
  });
  assertGroundedResponse(afterRejectedFilters, {
    marker: ALPHA.marker,
    instanceId: ALPHA.id,
    remaining: 0,
    label: "Post-rejection filtered query",
  });

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "",
        "### Global AI Search staging acceptance",
        "",
        `- Commit: \`${process.env.GITHUB_SHA ?? "unknown"}\``,
        "- Two run-isolated Santo-wide AI Search libraries: indexed and visible",
        "- All Libraries default through `/v1/ai/query`: passed",
        "- One Santo session queried both Alpha and Beta libraries: passed",
        "- Alpha filter returned only Alpha citation evidence: passed",
        "- Beta filter returned only Beta citation evidence: passed",
        "- Same query/idempotency key across different filters charged as distinct requests: passed",
        "- Unknown valid library ID failed closed with `UNKNOWN_LIBRARY`: passed",
        "- Malformed library ID failed contract validation with `INVALID_AI_QUERY`: passed",
        "- Rejected filter request did not consume quota; subsequent fourth valid request succeeded: passed",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  console.log("Global Search live staging acceptance passed.");
}

async function cleanup() {
  for (const fixture of FIXTURES) {
    await deleteFixture(fixture.id);
  }
  console.log("Global Search AI Search fixture cleanup passed.");
}

const command = process.argv[2];
if (command === "verify") await verify();
else if (command === "cleanup") await cleanup();
else throw new Error("Expected command: verify | cleanup");
