import { z } from "zod";

export const HealthResponseSchema = z.object({
  service: z.literal("santo-api"),
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const SantoEnvironmentSchema = z.enum(["local", "staging", "production"]);

export const InfrastructureBindingStatusSchema = z.enum([
  "ok",
  "queued",
  "skipped",
  "missing",
  "error",
]);

export const InfrastructureSmokeResponseSchema = z.object({
  environment: SantoEnvironmentSchema,
  status: z.enum(["ok", "degraded"]),
  eventId: z.string().uuid().nullable(),
  bindings: z.object({
    controlDatabase: InfrastructureBindingStatusSchema,
    contentBucket: InfrastructureBindingStatusSchema,
    tenantMeterDo: InfrastructureBindingStatusSchema,
    conversationDo: InfrastructureBindingStatusSchema,
    eventQueue: InfrastructureBindingStatusSchema,
    analyticsEngine: InfrastructureBindingStatusSchema,
    aiSearch: InfrastructureBindingStatusSchema,
  }),
});

export type InfrastructureSmokeResponse = z.infer<
  typeof InfrastructureSmokeResponseSchema
>;

export const InfraSmokeQueueEventSchema = z.object({
  type: z.literal("infra.smoke"),
  eventId: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export type InfraSmokeQueueEvent = z.infer<typeof InfraSmokeQueueEventSchema>;

export const QueueSmokeStatusResponseSchema = z.object({
  eventId: z.string().uuid(),
  processed: z.boolean(),
});
