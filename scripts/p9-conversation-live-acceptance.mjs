import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

const STATE_PATH = process.env.P2_WORKOS_STATE_PATH ?? "/tmp/santo-p2-workos-state.json";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function mask(value) {
  if (value && process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${value}`);
}

async function request(workerUrl, path, { method = "GET", authorization, body } = {}) {
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

async function credential(workerUrl, tenantId, ownerToken) {
  const response = await request(workerUrl, `/v1/portal/tenants/${tenantId}/credentials`, {
    method: "POST",
    authorization: `Bearer ${ownerToken}`,
  });
  expect(response.status === 201, `Credential issuance returned ${response.status}`);
  const secret = response.body?.secret;
  expect(typeof secret === "string", "Missing Santo server credential");
  mask(secret);
  return secret;
}

async function session(workerUrl, secret, externalUserId) {
  const response = await request(workerUrl, "/v1/session/exchange", {
    method: "POST",
    authorization: `Santo ${secret}`,
    body: { external_user_id: externalUserId },
  });
  expect(response.status === 200, `Session exchange returned ${response.status}`);
  const token = response.body?.accessToken;
  expect(typeof token === "string" && token.length > 20, "Invalid session token");
  mask(token);
  return `Bearer ${token}`;
}

async function verify() {
  const workerUrl = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  const tenantId = state.santo?.tenants?.medpark?.id;
  const tenantToken = state.workos?.users?.medparkOwner?.accessToken;
  const otherTenantId = state.santo?.tenants?.isolation?.id;
  const otherOwner = state.workos?.users?.isolationOwner?.accessToken;
  expect(tenantId && tenantToken && otherTenantId && otherOwner, "P2 tenant fixtures are absent");

  const ownSecret = await credential(workerUrl, tenantId, tenantToken);
  const otherSecret = await credential(workerUrl, otherTenantId, otherOwner);
  const authorization = await session(workerUrl, ownSecret, "p9-staging-student");
  const otherUser = await session(workerUrl, ownSecret, "p9-staging-other");
  const otherTenant = await session(workerUrl, otherSecret, "p9-staging-student");

  const conversationId = randomUUID();
  const conversationPath = `/v1/conversations/${conversationId}`;
  let created = false;
  try {
    const create = {
      conversationId,
      idempotencyKey: `p9-create-${conversationId}`,
      title: "Santo synthetic Phase 9",
    };
    const first = await request(workerUrl, "/v1/conversations", {
      method: "POST",
      authorization,
      body: create,
    });
    expect(first.status === 201, `Create returned ${first.status}: ${first.body?.error ?? ""}`);
    expect(first.body?.conversationId === conversationId, "Wrong conversation ID");
    created = true;

    const replay = await request(workerUrl, "/v1/conversations", {
      method: "POST",
      authorization,
      body: create,
    });
    expect(replay.status === 201 && replay.body?.createdAt === first.body?.createdAt, "Create replay failed");
    const conflict = await request(workerUrl, "/v1/conversations", {
      method: "POST",
      authorization,
      body: { ...create, idempotencyKey: "changed-key" },
    });
    expect(conflict.status === 409, "Create key collision did not fail closed");

    for (const other of [otherUser, otherTenant]) {
      const read = await request(workerUrl, conversationPath, { authorization: other });
      expect(read.status === 404, "Cross-user or tenant read was accessible");
      const forge = await request(workerUrl, "/v1/conversations", {
        method: "POST",
        authorization: other,
        body: create,
      });
      expect(forge.status === 404, "Cross-user or tenant create was accessible");
    }

    const tampered = await request(workerUrl, "/v1/conversations", {
      method: "POST",
      authorization,
      body: { ...create, tenantId: otherTenantId },
    });
    expect(tampered.status === 400, "Caller-supplied tenant was accepted");
    const unauthenticated = await request(workerUrl, conversationPath);
    expect(unauthenticated.status === 401, "Anonymous read was allowed");

    const attempts = 100;
    const raced = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        request(workerUrl, `${conversationPath}/messages`, {
          method: "POST",
          authorization,
          body: {
            idempotencyKey: `p9-race-${i}`,
            expectedSequence: 0,
            text: `Synthetic user question ${i}`,
          },
        }),
      ),
    );
    const winners = raced.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.status === 200);
    const conflicts = raced.filter((entry) => entry.status === 409);
    expect(winners.length === 1 && conflicts.length === attempts - 1,
      `Expected 1 success / 99 conflicts, got ${winners.length} / ${conflicts.length}; statuses: ${JSON.stringify(raced.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}))}`);

    const winner = winners[0];
    expect(winner.body?.message?.sequence === 0, "First message sequence mismatch");
    const retry = await request(workerUrl, `${conversationPath}/messages`, {
      method: "POST",
      authorization,
      body: {
        idempotencyKey: `p9-race-${winner.index}`,
        expectedSequence: 0,
        text: `Synthetic user question ${winner.index}`,
      },
    });
    expect(retry.status === 200 && retry.body?.replayed === true, "Append retry was not replayed");
    expect(retry.body?.message?.messageId === winner.body?.message?.messageId, "Retry generated a new message");
    const conflictingReplay = await request(workerUrl, `${conversationPath}/messages`, {
      method: "POST",
      authorization,
      body: {
        idempotencyKey: `p9-race-${winner.index}`,
        expectedSequence: 0,
        text: "Mutated question",
      },
    });
    expect(conflictingReplay.status === 409, "Mutated retry was accepted");

    const next = await request(workerUrl, `${conversationPath}/messages`, {
      method: "POST",
      authorization,
      body: { idempotencyKey: "p9-next-turn", expectedSequence: 1, text: "Synthetic follow-up" },
    });
    expect(next.status === 200 && next.body?.message?.sequence === 1, "Second ordered append failed");
    const read = await request(workerUrl, conversationPath, { authorization });
    expect(read.status === 200 && read.body?.totalMessages === 2, "Durable state did not survive calls");
    expect(read.body.messages.map((message) => message.sequence).join(",") === "0,1", "Message ordering is incorrect");

    for (const other of [otherUser, otherTenant]) {
      const deletion = await request(workerUrl, conversationPath, { method: "DELETE", authorization: other });
      expect(deletion.status === 404, "Another identity was allowed to erase a conversation");
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, [
        "### Phase 9 real ConversationDO acceptance",
        "",
        "- Real WorkOS-backed tenant/session exchange: passed",
        "- 100 overlapping writes: 1 success and 99 sequence conflicts",
        "- Stable idempotent replay and conflicting replay denial: passed",
        "- Cross-tenant and cross-user read/create/delete denial: passed",
        "- SQLite read ordering and strict request authority: passed",
        "- Authenticated owner deletion and cleanup: verified in finally",
        "",
      ].join("\n"), "utf8");
    }
    console.log("P9 conversation state acceptance passed.");
  } finally {
    if (created) {
      const removed = await request(workerUrl, conversationPath, { method: "DELETE", authorization });
      expect(removed.status === 200 && removed.body?.deleted === true,
        `Owner fixture cleanup failed: ${removed.status}`);
      const missing = await request(workerUrl, conversationPath, { authorization });
      expect(missing.status === 404, "Deleted conversation is still readable");
    }
  }
}

await verify();
