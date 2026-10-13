import { TrustedSourceMediaManifestEntrySchema } from "@santo/contracts/source";

import type { SantoBindings } from "../runtime/bindings";
import {
  R2VerifiedSourceStore,
  trustedSourceManifestKey,
  type SourceSnapshotIdentity,
} from "../sources/store";

const FIXTURE_INSTANCE_ID = /^santo-p33-mrcp-[0-9a-f]{12}$/;
const FIXTURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9pVjYAAAAASUVORK5CYII=";
const FIXTURE_IMAGE_BYTES = Uint8Array.from(atob(FIXTURE_PNG_BASE64), (char) => char.charCodeAt(0));
const FIXTURE_USER_ID = "p33-global-search-user";

function isAuthorized(request: Request, env: SantoBindings): boolean {
  return (
    env.SANTO_ENV === "staging" &&
    Boolean(env.INFRA_SMOKE_TOKEN) &&
    request.headers.get("x-santo-infra-smoke-token") === env.INFRA_SMOKE_TOKEN
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export async function handleP8SourceAcceptance(
  request: Request,
  env: SantoBindings,
): Promise<Response> {
  if (!isAuthorized(request, env)) return new Response("Not Found", { status: 404 });
  if (!env.CONTENT_BUCKET) {
    return Response.json({ error: "P8_ACCEPTANCE_NOT_CONFIGURED" }, { status: 503 });
  }
  const path = new URL(request.url).pathname;
  if (
    request.method !== "POST" ||
    (path !== "/__infra/p8-source-acceptance/setup" &&
      path !== "/__infra/p8-source-acceptance/cleanup")
  ) {
    return new Response("Not Found", { status: 404 });
  }

  const payload: unknown = await request.json().catch(() => null);
  const input = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
  const tenantId = input?.tenantId;
  const messageId = input?.messageId;
  const sourceId = input?.sourceId;
  const instanceId = input?.instanceId;
  if (
    !isUuid(tenantId) ||
    !isUuid(messageId) ||
    typeof sourceId !== "string" ||
    typeof instanceId !== "string" ||
    !FIXTURE_INSTANCE_ID.test(instanceId) ||
    !sourceId.startsWith(`${instanceId}:`)
  ) {
    return Response.json({ error: "INVALID_P8_ACCEPTANCE_FIXTURE" }, { status: 400 });
  }

  const identity: SourceSnapshotIdentity = {
    tenantId,
    externalUserId: FIXTURE_USER_ID,
    messageId,
  };
  const store = new R2VerifiedSourceStore(env.CONTENT_BUCKET);
  try {
    const sources = await store.load(identity);
    const source = sources.find((entry) => entry.sourceId === sourceId);
    if (!source || source.instanceId !== instanceId || source.libraryId !== instanceId) {
      return Response.json({ error: "P8_ACCEPTANCE_SOURCE_NOT_FOUND" }, { status: 404 });
    }

    const suffix = instanceId.slice(-12);
    const assetId = `p8-synthetic-${suffix}`;
    const objectKey = `source-media/p8-synthetic-${suffix}.png`;
    const manifestKey = await trustedSourceManifestKey(source);

    if (path.endsWith("/cleanup")) {
      await env.CONTENT_BUCKET.delete(manifestKey);
      await env.CONTENT_BUCKET.delete(objectKey);
      return Response.json({ status: "cleaned" });
    }

    const entry = TrustedSourceMediaManifestEntrySchema.parse({
      sourceId: source.sourceId,
      libraryId: source.libraryId,
      instanceId: source.instanceId,
      itemKey: source.itemKey,
      assetId,
      objectKey,
      contentType: "image/png",
      altText: "Synthetic Phase 8 test diagram",
      caption: null,
      width: 2,
      height: 2,
    });
    await env.CONTENT_BUCKET.put(objectKey, FIXTURE_IMAGE_BYTES);
    try {
      await env.CONTENT_BUCKET.put(manifestKey, JSON.stringify([entry]));
    } catch (error) {
      await env.CONTENT_BUCKET.delete(objectKey);
      throw error;
    }
    return Response.json({ status: "ready", assetId });
  } catch {
    return Response.json({ error: "P8_ACCEPTANCE_FAILED" }, { status: 503 });
  }
}
