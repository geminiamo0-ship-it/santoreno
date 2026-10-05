import { DurableObjectQuotaService } from "../quota/service";
import type { AiSearchNamespaceLike, SantoBindings } from "../runtime/bindings";

const FIXTURE_INSTANCE_ID_PATTERN = /^santo-p33-(?:mrcp|usmle)-[0-9a-f]{12}$/;
const FIXTURE_MARKER_PATTERN = /^SANTO-P33-(?:MRCP-23|USMLE-31)$/;

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

async function visibleInstanceIds(namespace: AiSearchNamespaceLike): Promise<Set<string>> {
  const listed = asRecord(await namespace.list());
  if (!Array.isArray(listed?.result)) {
    throw new Error("AI Search namespace returned an invalid instance list");
  }

  return new Set(
    listed.result
      .map((entry) => asRecord(entry)?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

async function probe(request: Request, env: SantoBindings): Promise<Response> {
  if (!env.AI_SEARCH) {
    return Response.json(
      { status: "failed", error: "P33_ACCEPTANCE_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const payload = asRecord(await request.json().catch(() => null));
  const fixtureInstanceId = payload?.fixtureInstanceId;
  const marker = payload?.marker;
  if (
    typeof fixtureInstanceId !== "string" ||
    !FIXTURE_INSTANCE_ID_PATTERN.test(fixtureInstanceId) ||
    typeof marker !== "string" ||
    !FIXTURE_MARKER_PATTERN.test(marker)
  ) {
    return Response.json(
      { status: "failed", error: "INVALID_P33_ACCEPTANCE_PROBE" },
      { status: 400 },
    );
  }

  try {
    const result = asRecord(
      await env.AI_SEARCH.search({
        query: marker,
        ai_search_options: {
          instance_ids: [fixtureInstanceId],
          retrieval: {
            retrieval_type: "hybrid",
            match_threshold: 0.1,
            max_num_results: 3,
            return_on_failure: true,
          },
          query_rewrite: {
            enabled: false,
          },
        },
      }),
    );
    const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
    const searchable = chunks.some((chunk) => {
      const record = asRecord(chunk);
      return (
        record?.instance_id === fixtureInstanceId &&
        typeof record?.text === "string" &&
        record.text.includes(marker)
      );
    });

    return Response.json({ status: "ok", searchable });
  } catch {
    return Response.json({ status: "ok", searchable: false });
  }
}

async function setup(request: Request, env: SantoBindings): Promise<Response> {
  if (!env.AI_SEARCH || !env.TENANT_METER) {
    return Response.json(
      { status: "failed", error: "P33_ACCEPTANCE_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const payload = asRecord(await request.json().catch(() => null));
  const tenantId = payload?.tenantId;
  const externalUserId = payload?.externalUserId;
  const fixtureInstanceIds = payload?.fixtureInstanceIds;
  if (
    !isUuid(tenantId) ||
    typeof externalUserId !== "string" ||
    externalUserId.trim().length === 0 ||
    externalUserId.length > 255 ||
    !Array.isArray(fixtureInstanceIds) ||
    fixtureInstanceIds.length !== 2 ||
    fixtureInstanceIds.some(
      (id) => typeof id !== "string" || !FIXTURE_INSTANCE_ID_PATTERN.test(id),
    ) ||
    new Set(fixtureInstanceIds).size !== 2
  ) {
    return Response.json(
      { status: "failed", error: "INVALID_P33_ACCEPTANCE_SETUP" },
      { status: 400 },
    );
  }

  try {
    const visible = await visibleInstanceIds(env.AI_SEARCH);
    if (!fixtureInstanceIds.every((id) => visible.has(id))) {
      return Response.json(
        { status: "failed", error: "P33_ACCEPTANCE_FIXTURE_NOT_VISIBLE" },
        { status: 503 },
      );
    }

    const now = Date.now();
    await new DurableObjectQuotaService(env.TENANT_METER).configure({
      tenantId,
      tenantStatus: "active",
      monthlyAllowance: 8,
      cycleStartAt: new Date(now - 60_000).toISOString(),
      cycleEndAt: new Date(now + 3_600_000).toISOString(),
      user: {
        externalUserId: externalUserId.trim(),
        status: "active",
        baseQuota: 4,
        bonusQuota: 0,
        expiresAt: null,
      },
    });

    return Response.json({
      status: "ready",
      fixtureInstanceIds,
    });
  } catch (error) {
    console.error(
      "P33 global search runtime setup failed",
      error instanceof Error ? error.message : "unknown",
    );
    return Response.json(
      { status: "failed", error: "P33_ACCEPTANCE_RUNTIME_SETUP_FAILED" },
      { status: 500 },
    );
  }
}

export async function handleP33GlobalSearchAcceptance(
  request: Request,
  env: SantoBindings,
): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return new Response("Not Found", { status: 404 });
  }

  const pathname = new URL(request.url).pathname;
  if (request.method === "POST" && pathname.endsWith("/probe")) {
    return probe(request, env);
  }
  if (request.method === "POST" && pathname.endsWith("/setup")) {
    return setup(request, env);
  }

  return new Response("Not Found", { status: 404 });
}
