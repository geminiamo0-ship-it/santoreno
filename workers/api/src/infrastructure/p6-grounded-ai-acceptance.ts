import { DurableObjectQuotaService } from "../quota/service";
import type { AiSearchNamespaceLike, SantoBindings } from "../runtime/bindings";

const FIXTURE_INSTANCE_ID = "santo-p6-grounding-acceptance";
const FIXTURE_ITEM_KEY = "santo-p6-grounding-fixture.md";
const FIXTURE_QUERY =
  "According to the Santo P6 grounding acceptance fixture, what synthetic verification dose is specified?";
const FIXTURE_CONTENT = [
  "# Santo P6 Grounding Acceptance Fixture",
  "",
  "This document exists only for Santo staging acceptance testing.",
  "The synthetic verification dose is exactly 17 micro-units.",
  "The verification marker is SANTO-P6-GROUNDING-17.",
  "Do not infer any clinical meaning from this synthetic test value.",
].join("\n");

function isAuthorized(request: Request, env: SantoBindings): boolean {
  if (env.SANTO_ENV === "production") {
    return false;
  }

  const expected = env.INFRA_SMOKE_TOKEN;
  const provided = request.headers.get("x-santo-infra-smoke-token");
  return Boolean(expected && provided && expected === provided);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

async function fixtureExists(namespace: AiSearchNamespaceLike): Promise<boolean> {
  const listed = asRecord(await namespace.list());
  if (!Array.isArray(listed?.result)) {
    throw new Error("AI Search namespace returned an invalid instance list");
  }

  return listed.result.some((entry) => asRecord(entry)?.id === FIXTURE_INSTANCE_ID);
}

async function removeFixture(namespace: AiSearchNamespaceLike): Promise<void> {
  if (!namespace.delete) {
    throw new Error("AI Search namespace delete() is not available");
  }
  if (await fixtureExists(namespace)) {
    await namespace.delete(FIXTURE_INSTANCE_ID);
  }
}

async function setup(request: Request, env: SantoBindings): Promise<Response> {
  if (!env.AI_SEARCH || !env.AI_SEARCH.create || !env.AI_SEARCH.delete || !env.TENANT_METER) {
    return Response.json({ status: "failed", error: "P6_ACCEPTANCE_NOT_CONFIGURED" }, { status: 503 });
  }

  const payload = asRecord(await request.json().catch(() => null));
  const tenantId = payload?.tenantId;
  const externalUserId = payload?.externalUserId;
  if (
    !isUuid(tenantId) ||
    typeof externalUserId !== "string" ||
    externalUserId.trim().length === 0 ||
    externalUserId.length > 255
  ) {
    return Response.json({ status: "failed", error: "INVALID_P6_ACCEPTANCE_SETUP" }, { status: 400 });
  }

  try {
    await removeFixture(env.AI_SEARCH);
    const instance = await env.AI_SEARCH.create({ id: FIXTURE_INSTANCE_ID });
    const uploaded = asRecord(
      await instance.items.uploadAndPoll(FIXTURE_ITEM_KEY, FIXTURE_CONTENT, {
        pollIntervalMs: 1_000,
        timeoutMs: 120_000,
      }),
    );
    if (uploaded?.status !== "completed") {
      throw new Error(`Acceptance fixture indexing ended with status ${String(uploaded?.status)}`);
    }

    const now = Date.now();
    await new DurableObjectQuotaService(env.TENANT_METER).configure({
      tenantId,
      tenantStatus: "active",
      monthlyAllowance: 2,
      cycleStartAt: new Date(now - 60_000).toISOString(),
      cycleEndAt: new Date(now + 3_600_000).toISOString(),
      user: {
        externalUserId: externalUserId.trim(),
        status: "active",
        baseQuota: 1,
        bonusQuota: 0,
        expiresAt: null,
      },
    });

    return Response.json({
      status: "ready",
      instanceId: FIXTURE_INSTANCE_ID,
      itemKey: FIXTURE_ITEM_KEY,
      query: FIXTURE_QUERY,
    });
  } catch (error) {
    try {
      await removeFixture(env.AI_SEARCH);
    } catch {
      // Preserve the original setup error. Cleanup is retried by the workflow.
    }
    console.error(
      "P6 grounded AI acceptance setup failed",
      error instanceof Error ? error.message : "unknown",
    );
    return Response.json({ status: "failed", error: "P6_ACCEPTANCE_SETUP_FAILED" }, { status: 500 });
  }
}

async function cleanup(env: SantoBindings): Promise<Response> {
  if (!env.AI_SEARCH || !env.AI_SEARCH.delete) {
    return Response.json({ status: "failed", error: "P6_ACCEPTANCE_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    await removeFixture(env.AI_SEARCH);
    return Response.json({ status: "clean" });
  } catch (error) {
    console.error(
      "P6 grounded AI acceptance cleanup failed",
      error instanceof Error ? error.message : "unknown",
    );
    return Response.json({ status: "failed", error: "P6_ACCEPTANCE_CLEANUP_FAILED" }, { status: 500 });
  }
}

export async function handleP6GroundedAiAcceptance(
  request: Request,
  env: SantoBindings,
): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return new Response("Not Found", { status: 404 });
  }

  const pathname = new URL(request.url).pathname;
  if (request.method === "POST" && pathname.endsWith("/setup")) {
    return setup(request, env);
  }
  if (request.method === "DELETE" && pathname === "/__infra/p6-grounded-ai-acceptance") {
    return cleanup(env);
  }

  return new Response("Not Found", { status: 404 });
}
