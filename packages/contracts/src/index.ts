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

export const ServerCredentialStatusSchema = z.enum(["active", "revoked"]);
export type ServerCredentialStatus = z.infer<typeof ServerCredentialStatusSchema>;

export const ServerCredentialMetadataSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  prefix: z.string().regex(/^[0-9a-f]{12}$/),
  status: ServerCredentialStatusSchema,
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  rotatedFromId: z.string().uuid().nullable(),
});
export type ServerCredentialMetadata = z.infer<typeof ServerCredentialMetadataSchema>;

export const CredentialIssueResponseSchema = z.object({
  credential: ServerCredentialMetadataSchema,
  secret: z.string().regex(/^santo_sk_[0-9a-f]{12}_[0-9a-f]{64}$/),
});
export type CredentialIssueResponse = z.infer<typeof CredentialIssueResponseSchema>;

export const AllowedDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i);
export type AllowedDomain = z.infer<typeof AllowedDomainSchema>;

export const UpdateAllowedDomainsRequestSchema = z
  .object({
    domains: z.array(AllowedDomainSchema).max(100),
  })
  .strict();
export type UpdateAllowedDomainsRequest = z.infer<typeof UpdateAllowedDomainsRequestSchema>;

export const AllowedDomainsResponseSchema = z.object({
  tenantId: z.string().uuid(),
  domains: z.array(AllowedDomainSchema),
});
export type AllowedDomainsResponse = z.infer<typeof AllowedDomainsResponseSchema>;

export const ServerContextResponseSchema = z.object({
  tenantId: z.string().uuid(),
  credentialId: z.string().uuid(),
});
export type ServerContextResponse = z.infer<typeof ServerContextResponseSchema>;

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
