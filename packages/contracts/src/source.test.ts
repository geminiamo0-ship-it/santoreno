import { describe, expect, it } from "vitest";

import {
  TrustedSourceDetailRequestSchema,
  TrustedSourceDetailResponseSchema,
  TrustedSourceMediaManifestEntrySchema,
  TrustedSourceMetadataSchema,
  VerifiedSourceSnapshotSchema,
} from "./source";

const source = {
  sourceId: "instance-mrcp:chunk-1",
  libraryId: "mrcp",
  instanceId: "instance-mrcp",
  itemKey: "electrolytes.md",
  title: "Electrolytes",
  page: 12,
  section: "Sodium disorders",
};

const image = {
  assetId: "sodium-chart",
  altText: "Sodium correction flow chart",
  caption: "Sodium correction",
  contentType: "image/png" as const,
  width: 1024,
  height: 768,
};

describe("trusted source contracts", () => {
  it("persists fifteen authentic AMBOSS source references, never a sixteenth or forged source", () => {
    const sources = Array.from({ length: 15 }, (_, index) => ({
      ...source,
      sourceId: "amboss:r2-" + String(index).padStart(32, "0"),
      libraryId: "amboss",
      instanceId: "amboss",
      itemKey:
        "medical-search/v1/amboss/unnamed-2746/s-" + String(index + 15).padStart(4, "0") + ".md",
      page: null,
    }));
    const snapshot = {
      tenantId: "123e4567-e89b-42d3-a456-426614174000",
      externalUserId: "student-1",
      messageId: "123e4567-e89b-42d3-a456-426614174001",
      createdAt: 1,
      sources,
    };
    expect(VerifiedSourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      VerifiedSourceSnapshotSchema.safeParse({
        ...snapshot,
        sources: [...sources, { ...sources[0], sourceId: "amboss:r2-other" }],
      }).success,
    ).toBe(false);
    expect(
      VerifiedSourceSnapshotSchema.safeParse({
        ...snapshot,
        sources: [...sources.slice(0, 14), { ...sources[14], sourceId: "usmle:forged" }],
      }).success,
    ).toBe(false);
  });

  it("accepts stable metadata from a verified search citation", () => {
    expect(TrustedSourceMetadataSchema.parse(source)).toEqual(source);
    expect(TrustedSourceDetailResponseSchema.parse({ source, images: [image] }).images).toEqual([
      image,
    ]);
  });

  it("rejects ambiguous cross-instance citations", () => {
    const forged = { ...source, sourceId: "instance-usmle:chunk-1" };
    expect(TrustedSourceMetadataSchema.safeParse(forged).success).toBe(false);
  });

  it("requires a message-scoped lookup and rejects arbitrary tenant selectors", () => {
    const valid = {
      messageId: "123e4567-e89b-42d3-a456-426614174000",
      sourceId: source.sourceId,
    };
    expect(TrustedSourceDetailRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      TrustedSourceDetailRequestSchema.safeParse({
        ...valid,
        tenantId: "123e4567-e89b-42d3-a456-426614174000",
      }).success,
    ).toBe(false);
  });

  it("does not allow raw URLs or R2 keys in a client-facing response", () => {
    const forgedAsset = {
      ...image,
      url: "https://attacker.invalid/medical-image.png",
      objectKey: "source-media/mrcp/private.png",
    };
    expect(
      TrustedSourceDetailResponseSchema.safeParse({
        source,
        images: [forgedAsset],
      }).success,
    ).toBe(false);
    expect(
      TrustedSourceDetailResponseSchema.safeParse({
        source: { ...source, url: "https://attacker.invalid" },
        images: [],
      }).success,
    ).toBe(false);
  });

  it("binds canonical media records to source keys without URL/path injection", () => {
    const manifest = {
      sourceId: source.sourceId,
      libraryId: source.libraryId,
      instanceId: source.instanceId,
      itemKey: source.itemKey,
      ...image,
      objectKey: "source-media/mrcp/sodium-chart.png",
    };
    expect(TrustedSourceMediaManifestEntrySchema.safeParse(manifest).success).toBe(true);

    for (const objectKey of [
      "../private.png",
      "https://attacker.invalid/image.png",
      "source-media/mrcp/../private.png",
      "source-media/mrcp/%2e%2e/private.png",
    ]) {
      expect(
        TrustedSourceMediaManifestEntrySchema.safeParse({ ...manifest, objectKey }).success,
      ).toBe(false);
    }

    expect(
      TrustedSourceMediaManifestEntrySchema.safeParse({
        ...manifest,
        sourceId: "instance-usmle:chunk-1",
      }).success,
    ).toBe(false);
  });

  it("rejects unrecognized mime types and model-crafted source IDs", () => {
    expect(
      TrustedSourceDetailResponseSchema.safeParse({
        source,
        images: [{ ...image, contentType: "text/html" }],
      }).success,
    ).toBe(false);
    expect(
      TrustedSourceDetailRequestSchema.safeParse({
        messageId: "123e4567-e89b-42d3-a456-426614174000",
        sourceId: "https://attacker.invalid/citation",
      }).success,
    ).toBe(false);
  });
});
