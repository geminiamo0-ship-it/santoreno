import {
  HealthResponseSchema,
  InfrastructureSmokeResponseSchema,
  QueueSmokeStatusResponseSchema,
} from "@santo/contracts";
import { Hono } from "hono";

import { runInfrastructureSmoke, wasQueueSmokeProcessed } from "./infrastructure/smoke";
import type { SantoBindings } from "./runtime/bindings";

export const app = new Hono<{ Bindings: SantoBindings }>();

function isInfrastructureSmokeAuthorized(env: SantoBindings, providedToken?: string): boolean {
  if (env.SANTO_ENV === "production") {
    return false;
  }

  if (env.SANTO_ENV === "local" || env.SANTO_ENV === undefined) {
    return true;
  }

  const expectedToken = env.INFRA_SMOKE_TOKEN;
  return Boolean(expectedToken && providedToken && providedToken === expectedToken);
}

app.get("/", (context) => context.text("Santo API"));

app.get("/health", (context) => {
  const response = HealthResponseSchema.parse({
    service: "santo-api",
    status: "ok",
  });

  return context.json(response);
});

app.get("/__infra/smoke", async (context) => {
  if (
    !isInfrastructureSmokeAuthorized(
      context.env,
      context.req.header("x-santo-infra-smoke-token"),
    )
  ) {
    return context.notFound();
  }

  const response = InfrastructureSmokeResponseSchema.parse(
    await runInfrastructureSmoke(context.env),
  );

  return context.json(response, response.status === "ok" ? 200 : 503);
});

app.get("/__infra/queue-smoke/:eventId", async (context) => {
  if (
    !isInfrastructureSmokeAuthorized(
      context.env,
      context.req.header("x-santo-infra-smoke-token"),
    )
  ) {
    return context.notFound();
  }

  const eventId = context.req.param("eventId");
  const response = QueueSmokeStatusResponseSchema.safeParse({
    eventId,
    processed: await wasQueueSmokeProcessed(context.env, eventId),
  });

  if (!response.success) {
    return context.json({ error: "INVALID_SMOKE_EVENT_ID" }, 400);
  }

  return context.json(response.data);
});
