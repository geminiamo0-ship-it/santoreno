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

async function exchangeSession(workerUrl, secret, userId = EXTERNAL_USER_ID) {
  const result = await request(workerUrl, "/v1/session/exchange", {
    method: "POST",
    authorization: `Santo ${secret}`,
    body: { external_user_id: userId },
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

async function verifyP7ValidatedStream(workerUrl, sessionToken, sharedKey) {
  const response = await fetch(workerUrl + "/v1/ai/query", {
    method: "POST",
    headers: {
      authorization: "Bearer " + sessionToken,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      query: SHARED_FILTER_QUERY,
      idempotency_key: sharedKey,
      library_id: MRCP_INSTANCE_ID,
    }),
  });
  expect(response.status === 200, "P7 streamed request did not succeed");
  expect(
    response.headers.get("content-type")?.includes("text/event-stream"),
    "P7 response did not negotiate SSE",
  );
  const blocks = (await response.text()).trim().split("\n\n");
  const frames = blocks.map((block) => {
    const [eventLine, dataLine] = block.split("\n");
    expect(eventLine?.startsWith("event: "), "Missing P7 SSE event");
    expect(dataLine?.startsWith("data: "), "Missing P7 SSE data");
    const event = JSON.parse(dataLine.slice(6));
    expect(event.type === eventLine.slice(7), "SSE event name/type mismatch");
    return event;
  });
  expect(frames.length >= 2, "P7 SSE has no delta and completion frames");
  const completed = frames.at(-1);
  expect(completed?.type === "complete", "P7 SSE has no complete frame");
  const deltas = frames.slice(0, -1);
  expect(
    deltas.every(
      (delta, index) =>
        delta.type === "delta" &&
        delta.index === index &&
        typeof delta.text === "string" &&
        delta.text.length > 0 &&
        !("citations" in delta),
    ),
    "P7 SSE had malformed or citation-bearing early deltas",
  );
  expect(
    deltas.map((delta) => delta.text).join("") === completed.response?.answer,
    "P7 streamed text differs from validated response",
  );
  expectSuccessfulAnswer(
    { status: response.status, body: completed.response },
    "23",
    [MRCP_INSTANCE_ID],
    1,
  );

  const invalid = await fetch(workerUrl + "/v1/ai/query", {
    method: "POST",
    headers: {
      authorization: "Bearer " + sessionToken,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      query: SHARED_FILTER_QUERY,
      idempotency_key: sharedKey + "-stream-invalid",
      library_id: INVALID_INSTANCE_ID,
    }),
  });
  const invalidBody = await invalid.json();
  expect(
    invalid.status === 400 && invalidBody?.error === "INVALID_LIBRARY_FILTER",
    "P7 streamed invalid-library request did not fail closed",
  );
  expect(
    invalid.headers.get("content-type")?.includes("application/json"),
    "P7 streamed hard failure unexpectedly exposed SSE content",
  );
  console.log("P7 real authenticated validated SSE, quota replay and fail-closed checks passed.");
}

async function verifyP8Sources(
  workerUrl,
  smokeToken,
  sessionToken,
  isolationToken,
  tenantId,
  answer,
) {
  const messageId = answer?.messageId;
  const sourceId = answer?.citations?.[0]?.sourceId;
  const instanceId = MRCP_INSTANCE_ID;
  expect(typeof messageId === "string", "P8: verified message ID missing");
  expect(typeof sourceId === "string", "P8: verified citation ID missing");

  const lookup = { messageId, sourceId };
  const first = await request(workerUrl, "/v1/sources/detail", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: lookup,
  });
  expect(first.status === 200, "P8: authenticated source lookup failed");
  expect(first.body?.source?.sourceId === sourceId, "P8: wrong source ID");
  expect(first.body?.source?.libraryId === instanceId, "P8: wrong library");
  expect(first.body?.source?.instanceId === instanceId, "P8: wrong instance");
  expect(Array.isArray(first.body?.images), "P8: malformed media list");

  const forged = await request(workerUrl, "/v1/sources/detail", {
    method: "POST",
    authorization: `Bearer ${sessionToken}`,
    body: { messageId, sourceId: `${instanceId}:not-cited` },
  });
  expect(forged.status === 404, "P8: forged citation must fail closed");

  const wrongTenant = await request(workerUrl, "/v1/sources/detail", {
    method: "POST",
    authorization: `Bearer ${isolationToken}`,
    body: lookup,
  });
  expect(wrongTenant.status === 404, "P8: cross-tenant source access was not denied");

  const fixture = { tenantId, messageId, sourceId, instanceId };
  let started = false;
  try {
    started = true;
    const setup = await request(workerUrl, "/__infra/p8-source-acceptance/setup", {
      method: "POST",
      smokeToken,
      body: fixture,
    });
    expect(setup.status === 200 && setup.body?.status === "ready", "P8: real R2 setup failed");
    const assetId = setup.body?.assetId;
    expect(typeof assetId === "string", "P8: setup returned no asset id");

    const afterSetup = await request(workerUrl, "/v1/sources/detail", {
      method: "POST",
      authorization: `Bearer ${sessionToken}`,
      body: lookup,
    });
    expect(afterSetup.status === 200, "P8: mapped source detail failed");
    expect(afterSetup.body?.images?.length === 1, "P8: missing mapped image");
    expect(afterSetup.body.images[0].assetId === assetId, "P8: wrong mapped asset");
    expect(!JSON.stringify(afterSetup.body).includes("source-media/"), "P8: leaked R2 key");

    const imagePath = `/v1/sources/${messageId}/${encodeURIComponent(sourceId)}/images/${assetId}`;
    const imageResponse = await fetch(workerUrl + imagePath, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(imageResponse.status === 200, "P8: R2 media delivery failed");
    expect(imageResponse.headers.get("content-type") === "image/png", "P8: bad media type");
    expect(
      imageResponse.headers.get("x-content-type-options") === "nosniff",
      "P8: missing nosniff",
    );
    expect(imageResponse.headers.get("cache-control")?.includes("no-store"), "P8: unsafe caching");
    const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
    expect(imageBytes.length >= 8 && imageBytes[0] === 137, "P8: invalid real R2 image");

    const unauthenticated = await fetch(workerUrl + imagePath);
    expect(unauthenticated.status === 401, "P8: image allowed unauthenticated access");
    const missingImage = await fetch(workerUrl + imagePath.replace(`/${assetId}`, "/not-mapped"), {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(missingImage.status === 404, "P8: unlisted image was accessible");
    const otherTenantImage = await fetch(workerUrl + imagePath, {
      headers: { authorization: `Bearer ${isolationToken}` },
    });
    expect(otherTenantImage.status === 404, "P8: cross-tenant image access was not denied");
    console.log("P8 verified sources and authenticated real R2 media passed.");
  } finally {
    if (started) {
      const cleanup = await request(workerUrl, "/__infra/p8-source-acceptance/cleanup", {
        method: "POST",
        smokeToken,
        body: fixture,
      });
      expect(cleanup.status === 200, "P8: media fixture cleanup failed");
    }
  }
}

async function requestGroundedTurnWithRetry(workerUrl, path, authorization, body) {
  let response = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await request(workerUrl, path, { method: "POST", authorization, body });
    if (response.status !== 422 || response.body?.error !== "INSUFFICIENT_EVIDENCE") {
      return response;
    }
    await sleep(500);
  }
  return response;
}

async function verifyP9GroundedFollowups(workerUrl, smokeToken, secret, tenantId) {
  const userId = "p9-grounded-followup-user";
  const setup = await request(workerUrl, "/__infra/p33-global-search-acceptance/setup", {
    method: "POST",
    smokeToken,
    body: { tenantId, externalUserId: userId, fixtureInstanceIds: FIXTURES.map((f) => f.id) },
  });
  expect(setup.status === 200 && setup.body?.status === "ready", "P9 quota setup failed");
  const token = await exchangeSession(workerUrl, secret, userId);
  const outsider = await exchangeSession(workerUrl, secret, "p9-outsider");
  const authorization = `Bearer ${token}`;
  const id = crypto.randomUUID();
  const base = `/v1/conversations/${id}`;
  const initial = await request(workerUrl, "/v1/conversations", {
    method: "POST",
    authorization,
    body: { conversationId: id, idempotencyKey: "p9-create", title: "P9 verified follow-up" },
  });
  expect(initial.status === 201, "P9 create failed");
  try {
    const question = SHARED_FILTER_QUERY;
    const firstInput = {
      idempotencyKey: "p9-first",
      expectedSequence: 0,
      text: question,
      libraryId: MRCP_INSTANCE_ID,
    };
    const first = await requestGroundedTurnWithRetry(
      workerUrl, base + "/ask", authorization, firstInput,
    );
    expectSuccessfulAnswer(first, "23", [MRCP_INSTANCE_ID], 3);
    const replay = await request(workerUrl, base + "/ask", {
      method: "POST",
      authorization,
      body: firstInput,
    });
    expect(
      replay.status === 200 && JSON.stringify(replay.body) === JSON.stringify(first.body),
      "P9 completed retry changed answer or repeated work",
    );
    const conflicting = await request(workerUrl, base + "/ask", {
      method: "POST",
      authorization,
      body: { ...firstInput, text: "Changed query" },
    });
    expect(conflicting.status === 409, "P9 changed-key-content was not rejected");

    const outsiders = await request(workerUrl, base + "/turns", {
      authorization: `Bearer ${outsider}`,
    });
    expect(outsiders.status === 404, "P9 another user accessed verified answer");

    const firstRead = await request(workerUrl, base + "/turns", { authorization });
    expect(
      firstRead.status === 200 && firstRead.body?.turns?.length === 1,
      "P9 first persisted turn is missing",
    );
    expect(
      firstRead.body.turns[0]?.response?.messageId === first.body?.messageId,
      "P9 persisted response message ID drift",
    );

    const followupInput = {
      idempotencyKey: "p9-followup",
      expectedSequence: 1,
      text: SHARED_FILTER_QUERY + " Explain the context in a follow-up.",
      libraryId: MRCP_INSTANCE_ID,
    };
    let stream = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      stream = await fetch(workerUrl + base + "/ask", {
        method: "POST",
        headers: { authorization, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(followupInput),
      });
      if (stream.status !== 422) break;
      const rejected = await stream.json();
      if (rejected?.error !== "INSUFFICIENT_EVIDENCE") {
        throw new Error(`P9 follow-up stream rejected: ${String(rejected?.error)}`);
      }
      await sleep(500);
    }
    expect(
      stream?.status === 200 && stream.headers.get("content-type")?.includes("text/event-stream"),
      "P9 verified SSE failed",
    );
    const frames = (await stream.text())
      .trim()
      .split("\n\n")
      .map((part) => {
        const line = part.split("\n").find((v) => v.startsWith("data: "));
        expect(Boolean(line), "P9 invalid SSE frame");
        return JSON.parse(line.slice(6));
      });
    expect(frames.at(-1)?.type === "complete", "P9 SSE emitted no complete frame");
    const completed = frames.at(-1).response;
    expectSuccessfulAnswer({ status: stream.status, body: completed }, "23", [MRCP_INSTANCE_ID], 2);
    expect(
      frames
        .slice(0, -1)
        .map((x) => x.text)
        .join("") === completed.answer,
      "P9 buffered SSE content mismatch",
    );
    const secondReplay = await request(workerUrl, base + "/ask", {
      method: "POST",
      authorization,
      body: followupInput,
    });
    expect(
      secondReplay.status === 200 && secondReplay.body?.messageId === completed.messageId,
      "P9 SSE retry repeated a billed generation",
    );
    const turns = await request(workerUrl, base + "/turns", { authorization });
    expect(
      turns.status === 200 && turns.body?.turns?.length === 2,
      "P9 follow-up history incomplete",
    );
    expect(
      turns.body.turns.every((x) => x.status === "completed" && x.response?.citations?.length),
      "P9 saved unverified assistant turn",
    );

    const sourceId = first.body.citations[0].sourceId;
    const source = await request(workerUrl, "/v1/sources/detail", {
      method: "POST",
      authorization,
      body: { messageId: first.body.messageId, sourceId },
    });
    expect(
      source.status === 200 && source.body?.source?.sourceId === sourceId,
      "P9 saved source provenance could not be resolved",
    );

    const invalid = await request(workerUrl, base + "/ask", {
      method: "POST",
      authorization,
      body: {
        idempotencyKey: "p9-invalid",
        expectedSequence: 2,
        text: question,
        libraryId: INVALID_INSTANCE_ID,
      },
    });
    expect(
      invalid.status === 400 && invalid.body?.error === "INVALID_LIBRARY_FILTER",
      "P9 invalid library did not fail closed",
    );
    const afterFailure = await request(workerUrl, base + "/turns", { authorization });
    expect(
      afterFailure.body.turns.at(-1)?.status === "retryable",
      "P9 model failure did not preserve retryable turn",
    );

    const originalRetry = await request(workerUrl, base + "/ask", {
      method: "POST",
      authorization,
      body: {
        idempotencyKey: "p9-invalid",
        expectedSequence: 2,
        text: question,
        libraryId: INVALID_INSTANCE_ID,
      },
    });
    expect(
      originalRetry.status === 400 && originalRetry.body?.error === "INVALID_LIBRARY_FILTER",
      "P9 released quota could not be safely retried",
    );
    console.log("P9 live grounded followups, cached replay, quota, citations and SSE passed.");
  } finally {
    const removed = await request(workerUrl, base, { method: "DELETE", authorization });
    expect(
      removed.status === 200 && removed.body?.deleted === true,
      "P9 conversation fixture cleanup failed",
    );
  }
}

async function verify() {
  const workerUrl = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const smokeToken = requireEnv("INFRA_SMOKE_TOKEN");
  const p2 = await readJson(P2_STATE_PATH);
  const tenantId = p2.santo?.tenants?.medpark?.id;
  const ownerToken = p2.workos?.users?.medparkOwner?.accessToken;
  expect(typeof tenantId === "string", "P2 state is missing the MedPark tenant ID");
  expect(typeof ownerToken === "string", "P2 state is missing the MedPark owner access token");

  // Issue the persistent Santo credential while the short-lived WorkOS owner token is still fresh.
  // Fixture indexing can take several minutes; session exchange happens afterwards from this credential.
  const secret = await issueCredential(workerUrl, tenantId, ownerToken);
  let isolationSecret = null;
  if (process.env.P8_SOURCE_ACCEPTANCE === "1") {
    const isolationTenantId = p2.santo?.tenants?.isolation?.id;
    const isolationOwnerToken = p2.workos?.users?.isolationOwner?.accessToken;
    expect(typeof isolationTenantId === "string", "P8: isolation tenant missing");
    expect(typeof isolationOwnerToken === "string", "P8: isolation owner token missing");
    isolationSecret = await issueCredential(workerUrl, isolationTenantId, isolationOwnerToken);
  }

  await prepareFixtures(workerUrl, smokeToken);

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

  if (process.env.P9_FOLLOWUP_ACCEPTANCE === "1") {
    await verifyP9GroundedFollowups(workerUrl, smokeToken, secret, tenantId);
    return;
  }

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
  if (process.env.P8_SOURCE_ACCEPTANCE === "1") {
    expect(isolationSecret !== null, "P8: missing isolation credential");
    const isolationToken = await exchangeSession(workerUrl, isolationSecret);
    await verifyP8Sources(workerUrl, smokeToken, sessionToken, isolationToken, tenantId, mrcp.body);
  }

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

  if (process.env.P7_STREAM_ACCEPTANCE === "1") {
    await verifyP7ValidatedStream(workerUrl, sessionToken, sharedKey);
  }

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
