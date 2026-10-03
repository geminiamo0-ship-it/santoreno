import { HealthResponseSchema } from "@santo/contracts";
import { Hono } from "hono";

export const app = new Hono();

app.get("/", (context) => context.text("Santo API"));

app.get("/health", (context) => {
  const response = HealthResponseSchema.parse({
    service: "santo-api",
    status: "ok",
  });

  return context.json(response);
});
