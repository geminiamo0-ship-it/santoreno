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

export const ExternalUserStatusSchema = z.enum(["active", "suspended"]);
export type ExternalUserStatus = z.infer<typeof ExternalUserStatusSchema>;

export const ExternalUserSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  externalUserId: z.string().min(1).max(255),
  email: z.string().email().max(320).nullable(),
  displayName: z.string().min(1).max(120).nullable(),
  status: ExternalUserStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ExternalUser = z.infer<typeof ExternalUserSchema>;

export const SessionExchangeRequestSchema = z
  .object({
    external_user_id: z.string().trim().min(1).max(255),
    email: z.string().email().max(320).optional(),
    display_name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type SessionExchangeRequest = z.infer<typeof SessionExchangeRequestSchema>;

export const SantoSessionClaimsSchema = z.object({
  iss: z.literal("Santo"),
  aud: z.literal("santo-ai"),
  tenant: z.string().uuid(),
  sub: z.string().min(1).max(255),
  session_id: z.string().uuid(),
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type SantoSessionClaims = z.infer<typeof SantoSessionClaimsSchema>;

export const SessionExchangeResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().min(600).max(1200),
  expiresAt: z.string().datetime(),
  user: ExternalUserSchema,
});
export type SessionExchangeResponse = z.infer<typeof SessionExchangeResponseSchema>;

export const SessionContextResponseSchema = z.object({
  tenantId: z.string().uuid(),
  externalUserId: z.string().min(1).max(255),
  sessionId: z.string().uuid(),
  expiresAt: z.string().datetime(),
});
export type SessionContextResponse = z.infer<typeof SessionContextResponseSchema>;

export const QuotaStatusSchema = z.enum(["active", "suspended"]);
export type QuotaStatus = z.infer<typeof QuotaStatusSchema>;

export const QuotaReservationStatusSchema = z.enum(["reserved", "finalized", "released", "denied"]);
export type QuotaReservationStatus = z.infer<typeof QuotaReservationStatusSchema>;

export const QuotaDenialReasonSchema = z.enum([
  "TENANT_SUSPENDED",
  "USER_SUSPENDED",
  "QUOTA_EXPIRED",
  "TENANT_EXHAUSTED",
  "USER_EXHAUSTED",
  "RESERVATION_RELEASED",
]);
export type QuotaDenialReason = z.infer<typeof QuotaDenialReasonSchema>;

const QuotaExternalUserIdSchema = z.string().trim().min(1).max(255);
const QuotaIdempotencyKeySchema = z.string().trim().min(1).max(128);

export const QuotaConfigureRequestSchema = z
  .object({
    tenantId: z.string().uuid(),
    tenantStatus: QuotaStatusSchema,
    monthlyAllowance: z.number().int().nonnegative(),
    cycleStartAt: z.string().datetime(),
    cycleEndAt: z.string().datetime(),
    user: z
      .object({
        externalUserId: QuotaExternalUserIdSchema,
        status: QuotaStatusSchema,
        baseQuota: z.number().int().nonnegative(),
        bonusQuota: z.number().int().nonnegative(),
        expiresAt: z.string().datetime().nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.cycleStartAt) >= Date.parse(value.cycleEndAt)) {
      context.addIssue({
        code: "custom",
        message: "cycleEndAt must be later than cycleStartAt",
        path: ["cycleEndAt"],
      });
    }
  });
export type QuotaConfigureRequest = z.infer<typeof QuotaConfigureRequestSchema>;

export const QuotaReadRequestSchema = z
  .object({
    tenantId: z.string().uuid(),
    externalUserId: QuotaExternalUserIdSchema,
  })
  .strict();
export type QuotaReadRequest = z.infer<typeof QuotaReadRequestSchema>;

export const QuotaReserveRequestSchema = z
  .object({
    tenantId: z.string().uuid(),
    externalUserId: QuotaExternalUserIdSchema,
    idempotencyKey: QuotaIdempotencyKeySchema,
    units: z.number().int().positive().max(1000).default(1),
  })
  .strict();
export type QuotaReserveRequest = z.infer<typeof QuotaReserveRequestSchema>;

export const QuotaFinalizeRequestSchema = z
  .object({
    tenantId: z.string().uuid(),
    idempotencyKey: QuotaIdempotencyKeySchema,
  })
  .strict();
export type QuotaFinalizeRequest = z.infer<typeof QuotaFinalizeRequestSchema>;

export const QuotaReleaseRequestSchema = QuotaFinalizeRequestSchema;
export type QuotaReleaseRequest = z.infer<typeof QuotaReleaseRequestSchema>;

export const QuotaCounterSchema = z.object({
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export type QuotaCounter = z.infer<typeof QuotaCounterSchema>;

export const QuotaSnapshotSchema = z.object({
  tenantId: z.string().uuid(),
  externalUserId: QuotaExternalUserIdSchema,
  cycleStartAt: z.string().datetime(),
  cycleEndAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  tenantStatus: QuotaStatusSchema,
  userStatus: QuotaStatusSchema,
  tenant: QuotaCounterSchema,
  user: QuotaCounterSchema,
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

export const QuotaOperationResponseSchema = z.object({
  allowed: z.boolean(),
  reservationStatus: QuotaReservationStatusSchema,
  denialReason: QuotaDenialReasonSchema.nullable(),
  snapshot: QuotaSnapshotSchema,
});
export type QuotaOperationResponse = z.infer<typeof QuotaOperationResponseSchema>;

export const GroundedAiQueryRequestSchema = z
  .object({
    question: z.string().trim().min(3).max(4000),
  })
  .strict();
export type GroundedAiQueryRequest = z.infer<typeof GroundedAiQueryRequestSchema>;

export const GroundedAiCitationSchema = z.object({
  sourceId: z.string().min(1).max(255),
  instanceId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  page: z.number().int().positive().nullable(),
  score: z.number().min(0).max(1),
});
export type GroundedAiCitation = z.infer<typeof GroundedAiCitationSchema>;

export const GroundedAiUsageSchema = z.object({
  unitsCharged: z.literal(1),
  remaining: z.number().int().nonnegative(),
});
export type GroundedAiUsage = z.infer<typeof GroundedAiUsageSchema>;

export const GroundedAiQueryResponseSchema = z.object({
  requestId: z.string().uuid(),
  messageId: z.string().uuid(),
  answer: z.string().min(1),
  citations: z.array(GroundedAiCitationSchema).min(1).max(5),
  usage: GroundedAiUsageSchema,
});
export type GroundedAiQueryResponse = z.infer<typeof GroundedAiQueryResponseSchema>;

export const GroundedAiModelOutputSchema = z
  .object({
    answer: z.string().trim().min(1),
    citation_ids: z.array(z.string().min(1).max(255)).min(1).max(5),
  })
  .strict();
export type GroundedAiModelOutput = z.infer<typeof GroundedAiModelOutputSchema>;

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