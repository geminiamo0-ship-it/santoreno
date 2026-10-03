import type {
  InfrastructureBindingStatus,
  InfrastructureSmokeResponse,
  SantoEnvironment,
} from "@santo/contracts";

import type { DurableObjectNamespaceLike, SantoBindings } from "../runtime/bindings";

async function checkDurableObject(
  namespace: DurableObjectNamespaceLike | undefined,
): Promise<InfrastructureBindingStatus> {
  if (!namespace) {
    return "missing";
  }

  try {
    const id = namespace.idFromName("infrastructure-smoke");
    const response = await namespace.get(id).fetch("https://santo.internal/health");
    return response.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

export async function runInfrastructureSmoke(
  env: SantoBindings,
): Promise<InfrastructureSmokeResponse> {
  const environment: SantoEnvironment = env.SANTO_ENV ?? "local";
  let eventId: string | null = null;

  const bindings: InfrastructureSmokeResponse["bindings"] = {
    controlDatabase: "missing",
    contentBucket: "missing",
    tenantMeterDo: "missing",
    conversationDo: "missing",
    eventQueue: "missing",
    analyticsEngine: "missing",
    aiSearch: environment === "local" ? "skipped" : "missing",
  };

  if (env.CONTROL_DB) {
    try {
      const row = await env.CONTROL_DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      bindings.controlDatabase = row?.ok === 1 ? "ok" : "error";
    } catch {
      bindings.controlDatabase = "error";
    }
  }

  if (env.CONTENT_BUCKET) {
    const key = `__infra/smoke/${crypto.randomUUID()}.json`;
    const expected = JSON.stringify({ status: "ok" });

    try {
      await env.CONTENT_BUCKET.put(key, expected);
      const object = await env.CONTENT_BUCKET.get(key);
      bindings.contentBucket = (await object?.text()) === expected ? "ok" : "error";
      await env.CONTENT_BUCKET.delete(key);
    } catch {
      bindings.contentBucket = "error";
    }
  }

  bindings.tenantMeterDo = await checkDurableObject(env.TENANT_METER);
  bindings.conversationDo = await checkDurableObject(env.CONVERSATION);

  if (env.EVENT_QUEUE) {
    eventId = crypto.randomUUID();
    try {
      await env.EVENT_QUEUE.send({
        type: "infra.smoke",
        eventId,
        createdAt: new Date().toISOString(),
      });
      bindings.eventQueue = "queued";
    } catch {
      bindings.eventQueue = "error";
      eventId = null;
    }
  }

  if (env.USAGE_ANALYTICS) {
    try {
      env.USAGE_ANALYTICS.writeDataPoint({
        blobs: ["infrastructure.smoke", environment],
        doubles: [1],
        indexes: ["santo-api"],
      });
      bindings.analyticsEngine = "ok";
    } catch {
      bindings.analyticsEngine = "error";
    }
  }

  if (env.AI_SEARCH) {
    try {
      await env.AI_SEARCH.list();
      bindings.aiSearch = "ok";
    } catch {
      bindings.aiSearch = "error";
    }
  }

  const requiredStatuses: InfrastructureBindingStatus[] = [
    bindings.controlDatabase,
    bindings.contentBucket,
    bindings.tenantMeterDo,
    bindings.conversationDo,
    bindings.eventQueue,
    bindings.analyticsEngine,
  ];

  if (environment !== "local") {
    requiredStatuses.push(bindings.aiSearch);
  }

  const status = requiredStatuses.every((value) => value === "ok" || value === "queued")
    ? "ok"
    : "degraded";

  return {
    environment,
    status,
    eventId,
    bindings,
  };
}

export async function wasQueueSmokeProcessed(
  env: SantoBindings,
  eventId: string,
): Promise<boolean> {
  if (!env.CONTROL_DB) {
    return false;
  }

  const row = await env.CONTROL_DB.prepare(
    "SELECT event_id FROM infra_smoke_events WHERE event_id = ? LIMIT 1",
  )
    .bind(eventId)
    .first<{ event_id: string }>();

  return row?.event_id === eventId;
}
