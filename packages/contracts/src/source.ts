import { z } from "zod";

import { GroundedAiLibraryIdSchema } from "./ai";

/**
 * A citation ID is an opaque AI Search instance/chunk pair, not an R2 path,
 * a URL, or an identifier supplied by the model.
 */
export const TrustedSourceIdSchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const TrustedImageAssetIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const TrustedImageContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

export const TrustedSourceMetadataSchema = z
  .object({
    sourceId: TrustedSourceIdSchema,
    libraryId: GroundedAiLibraryIdSchema,
    instanceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    itemKey: z.string().min(1).max(1024),
    title: z.string().min(1).max(500),
    page: z.number().int().positive().nullable(),
    section: z.string().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.sourceId.startsWith(`${value.instanceId}:`)) {
      context.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "sourceId must belong to the verified AI Search instance",
      });
    }
  });

export type TrustedSourceMetadata = z.infer<typeof TrustedSourceMetadataSchema>;

/**
 * Client-facing image metadata deliberately contains no user-provided URL,
 * R2 object key, or signed delivery credential.
 */
export const TrustedSourceImageSchema = z
  .object({
    assetId: TrustedImageAssetIdSchema,
    altText: z.string().min(1).max(500),
    caption: z.string().max(1000).nullable(),
    contentType: TrustedImageContentTypeSchema,
    width: z.number().int().positive().max(32768),
    height: z.number().int().positive().max(32768),
  })
  .strict();

export type TrustedSourceImage = z.infer<typeof TrustedSourceImageSchema>;

export const TrustedSourceDetailRequestSchema = z
  .object({
    messageId: z.string().uuid(),
    sourceId: TrustedSourceIdSchema,
  })
  .strict();

export type TrustedSourceDetailRequest = z.infer<typeof TrustedSourceDetailRequestSchema>;

export const TrustedSourceDetailResponseSchema = z
  .object({
    source: TrustedSourceMetadataSchema,
    images: z.array(TrustedSourceImageSchema).max(50),
    externalUrl: z.string().url().optional(),
  })
  .strict();

export type TrustedSourceDetailResponse = z.infer<typeof TrustedSourceDetailResponseSchema>;

/**
 * Internal canonical manifest entry only. The resolver must match every
 * source/asset field against a verified citation before reading R2.
 * Never send the objectKey to the browser.
 */
export const TrustedSourceMediaManifestEntrySchema = z
  .object({
    sourceId: TrustedSourceIdSchema,
    libraryId: GroundedAiLibraryIdSchema,
    instanceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    itemKey: z.string().min(1).max(1024),
    assetId: TrustedImageAssetIdSchema,
    objectKey: z
      .string()
      .min(18)
      .max(1024)
      .regex(/^source-media\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|avif)$/),
    contentType: TrustedImageContentTypeSchema,
    altText: z.string().min(1).max(500),
    caption: z.string().max(1000).nullable(),
    width: z.number().int().positive().max(32768),
    height: z.number().int().positive().max(32768),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.sourceId.startsWith(`${value.instanceId}:`)) {
      context.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "Manifest sourceId must match its AI Search instance",
      });
    }
  });

export type TrustedSourceMediaManifestEntry = z.infer<typeof TrustedSourceMediaManifestEntrySchema>;

/**
 * Internal, private R2 snapshot. The stored identity must be compared against
 * the authenticated Santo session before any citation is resolved.
 */
export const VerifiedSourceSnapshotSchema = z
  .object({
    tenantId: z.string().uuid(),
    externalUserId: z.string().min(1).max(255),
    messageId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    sources: z.array(TrustedSourceMetadataSchema).min(1).max(10),
  })
  .strict();

export type VerifiedSourceSnapshot = z.infer<typeof VerifiedSourceSnapshotSchema>;
