import {
  TrustedSourceMediaManifestEntrySchema,
  TrustedSourceMetadataSchema,
  type TrustedSourceMediaManifestEntry,
  type TrustedSourceMetadata,
} from "@santo/contracts/source";
import { z } from "zod";

import type { R2BucketLike } from "../runtime/bindings";

const MAX_SOURCES = 5;
const MAX_IMAGES = 50;
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const VerifiedSnapshotSchema = z
  .object({
    tenantId: z.string().uuid(),
    externalUserId: z.string().min(1).max(255),
    messageId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    sources: z.array(TrustedSourceMetadataSchema).min(1).max(MAX_SOURCES),
  })
  .strict();

type VerifiedSnapshot = z.infer<typeof VerifiedSnapshotSchema>;

export class SourceResolutionError extends Error {
  constructor(
    readonly status: 400 | 404 | 502 | 503,
    readonly code:
      | "INVALID_SOURCE_REQUEST"
      | "SOURCE_NOT_FOUND"
      | "SOURCE_MANIFEST_INVALID"
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_ASSET_INVALID",
  ) {
    super(code);
    this.name = "SourceResolutionError";
  }
}

export interface SourceSnapshotIdentity {
  tenantId: string;
  externalUserId: string;
  messageId: string;
}

export interface SourceSnapshotWriter {
  save(identity: SourceSnapshotIdentity, sources: readonly TrustedSourceMetadata[]): Promise<void>;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unavailable(): SourceResolutionError {
  return new SourceResolutionError(503, "SOURCE_UNAVAILABLE");
}

export class R2VerifiedSourceStore implements SourceSnapshotWriter {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  private async snapshotKey(identity: SourceSnapshotIdentity): Promise<string> {
    const owner = await sha256(`${identity.tenantId}\u0000${identity.externalUserId}`);
    return `verified-messages/v1/${owner}/${identity.messageId}.json`;
  }

  async save(
    identity: SourceSnapshotIdentity,
    sources: readonly TrustedSourceMetadata[],
  ): Promise<void> {
    const parsed = VerifiedSnapshotSchema.safeParse({
      ...identity,
      createdAt: this.nowMs(),
      sources,
    });
    if (!parsed.success || new Set(sources.map((item) => item.sourceId)).size !== sources.length) {
      throw new SourceResolutionError(502, "SOURCE_MANIFEST_INVALID");
    }
    try {
      await this.bucket.put(await this.snapshotKey(identity), JSON.stringify(parsed.data));
    } catch {
      throw unavailable();
    }
  }

  async load(identity: SourceSnapshotIdentity): Promise<readonly TrustedSourceMetadata[]> {
    let raw: string;
    try {
      const object = await this.bucket.get(await this.snapshotKey(identity));
      if (!object) throw new SourceResolutionError(404, "SOURCE_NOT_FOUND");
      raw = await object.text();
    } catch (error) {
      if (error instanceof SourceResolutionError) throw error;
      throw unavailable();
    }

    let parsed: ReturnType<typeof VerifiedSnapshotSchema.safeParse>;
    try {
      parsed = VerifiedSnapshotSchema.safeParse(JSON.parse(raw));
    } catch {
      throw new SourceResolutionError(502, "SOURCE_MANIFEST_INVALID");
    }
    if (!parsed.success) throw new SourceResolutionError(502, "SOURCE_MANIFEST_INVALID");
    const snapshot: VerifiedSnapshot = parsed.data;
    if (
      snapshot.tenantId !== identity.tenantId ||
      snapshot.externalUserId !== identity.externalUserId ||
      snapshot.messageId !== identity.messageId ||
      snapshot.createdAt > this.nowMs() ||
      this.nowMs() - snapshot.createdAt > SNAPSHOT_RETENTION_MS ||
      new Set(snapshot.sources.map((item) => item.sourceId)).size !== snapshot.sources.length
    ) {
      throw new SourceResolutionError(404, "SOURCE_NOT_FOUND");
    }
    return snapshot.sources;
  }

  private async manifestKey(source: TrustedSourceMetadata): Promise<string> {
    const documentId = await sha256(
      `${source.libraryId}\u0000${source.instanceId}\u0000${source.itemKey}`,
    );
    return `source-manifests/v1/${documentId}.json`;
  }

  async images(source: TrustedSourceMetadata): Promise<readonly TrustedSourceMediaManifestEntry[]> {
    let raw: string;
    try {
      const object = await this.bucket.get(await this.manifestKey(source));
      if (!object) return [];
      raw = await object.text();
    } catch {
      throw unavailable();
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(raw);
    } catch {
      throw new SourceResolutionError(502, "SOURCE_MANIFEST_INVALID");
    }
    const parsed = TrustedSourceMediaManifestEntrySchema.array()
      .max(MAX_IMAGES)
      .safeParse(manifest);
    if (!parsed.success) throw new SourceResolutionError(502, "SOURCE_MANIFEST_INVALID");

    const selected = parsed.data.filter((entry) => entry.sourceId === source.sourceId);
    if (
      selected.some(
        (entry) =>
          entry.libraryId !== source.libraryId ||
          entry.instanceId !== source.instanceId ||
          entry.itemKey !== source.itemKey,
      ) ||
      new Set(selected.map((entry) => entry.assetId)).size !== selected.length
    ) {
      throw new SourceResolutionError(502, "SOURCE_MANIFEST_INVALID");
    }
    return selected;
  }

  async asset(entry: TrustedSourceMediaManifestEntry): Promise<Uint8Array<ArrayBuffer>> {
    try {
      const object = await this.bucket.get(entry.objectKey);
      if (!object) throw new SourceResolutionError(404, "SOURCE_NOT_FOUND");
      if (!object.arrayBuffer) throw unavailable();
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength > 15 * 1024 * 1024 || !isSafeImage(bytes, entry.contentType)) {
        throw new SourceResolutionError(502, "SOURCE_ASSET_INVALID");
      }
      return bytes;
    } catch (error) {
      if (error instanceof SourceResolutionError) throw error;
      throw unavailable();
    }
  }
}

function isSafeImage(
  bytes: Uint8Array,
  contentType: TrustedSourceMediaManifestEntry["contentType"],
): boolean {
  if (contentType === "image/png") {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  }
  if (contentType === "image/webp") {
    const signature = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
    return bytes.length >= 12 && signature(0) === "RIFF" && signature(8) === "WEBP";
  }
  const brand = String.fromCharCode(...bytes.slice(4, 12));
  return bytes.length >= 12 && (brand === "ftypavif" || brand === "ftypavis");
}
