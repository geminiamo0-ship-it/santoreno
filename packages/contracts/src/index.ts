import { z } from "zod";

export const HealthResponseSchema = z.object({
  service: z.literal("santo-api"),
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const SantoEnvironmentSchema = z.enum(["local", "staging", "production"]);
export type SantoEnvironment = z.infer<typeof SantoEnvironmentSchema>;

export const PortalRoleSchema = z.enum(["super_admin", "owner"]);
export type PortalRole = z.infer<typeof PortalRoleSchema>;

export const TenantStatusSchema = z.enum(["active", "suspended"]);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

const TenantSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const TenantSchema = z.object({
  id: z.string().uuid(),
  slug: TenantSlugSchema,
  name: z.string().min(1).max(120),
  status: TenantStatusSchema,
  workosOrgId: z.string().min(1).max(255),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const CreateTenantRequestSchema = z
  .object({
    slug: TenantSlugSchema,
    name: z.string().min(1).max(120),
    workosOrgId: z.string().min(1).max(255),
    ownerWorkosUserId: z.string().min(1).max(255),
  })
  .strict();
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

export const UpdateTenantRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
  })
  .strict();
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequestSchema>;

export const PortalContextResponseSchema = z.object({
  userId: z.string().min(1),
  role: PortalRoleSchema,
  tenant: TenantSchema.nullable(),
});
export type PortalContextResponse = z.infer<typeof PortalContextResponseSchema>;

export const ApiErrorResponseSchema = z.object({
  error: z.string().min(1),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const InfrastructureBindingStatusSchema = z.enum([
  "ok",
  "queued",
  "skipped",
  "missing",
  "error",
]);
export type InfrastructureBindingStatus = z.infer<typeof InfrastructureBindingStatusSchema>;

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

export type InfrastructureSmokeResponse = z.infer<typeof InfrastructureSmokeResponseSchema>;

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
