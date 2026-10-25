import type { R2BucketLike } from "../runtime/bindings";
import type { GallerySearchHit } from "./types";
import type { MedicalImageCandidate } from "./medical-images";

/** The gallery is visual teaching material, never a sixth clinical citation. */
export interface GalleryImageRetriever {
  hydrate(hits: readonly GallerySearchHit[]): Promise<MedicalImageCandidate[]>;
}

const MANIFEST_KEY = "gallery/v1/santo_image_manifest.json";
const USMLE_MANIFEST_KEY = "gallery/v1/usmle_image_manifest.json";
const IMAGE_HOST = "pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev";
const CACHE_TTL_MS = 5 * 60 * 1000;
// No local seven-image cutoff: use all original provider-matched gallery hits
// (the single AI Search request already caps its total at 50).
const MAX_GALLERY_IMAGES = 50;

interface GalleryRecord {
  image_url: string;
  title: string;
  visual_caption: string;
  primary_system: string;
  source_name: string;
  rights_status?: string;
  display_ready?: boolean;
}

type GalleryManifest = Record<string, GalleryRecord>;
type ManifestCache = { expires: number; value: GalleryManifest };
const cache = new WeakMap<R2BucketLike, ManifestCache>();
const inFlight = new WeakMap<R2BucketLike, Promise<GalleryManifest>>();

function safeImageUrl(src: string): boolean {
  try {
    const url = new URL(src);
    return (
      url.protocol === "https:" &&
      url.hostname === IMAGE_HOST &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith("/offline_media/") &&
      !url.pathname.includes("..")
    );
  } catch {
    return false;
  }
}

async function loadManifest(bucket: R2BucketLike): Promise<GalleryManifest> {
  const current = cache.get(bucket);
  if (current && current.expires > Date.now()) return current.value;
  const inflight = inFlight.get(bucket);
  if (inflight) return inflight;
  const promise = (async (): Promise<GalleryManifest> => {
    const object = await bucket.get(MANIFEST_KEY);
    if (!object) throw new Error("Gallery image manifest missing");
    const raw: unknown = JSON.parse(await object.text());
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid gallery image manifest");
    }
    const validated: GalleryManifest = {};
    for (const [id, value] of Object.entries(raw)) {
      if (!/^img_\d{6}$/.test(id) || !value || typeof value !== "object") continue;
      const row = value as Partial<GalleryRecord>;
      if (
        typeof row.image_url !== "string" ||
        typeof row.title !== "string" ||
        typeof row.visual_caption !== "string" ||
        !safeImageUrl(row.image_url)
      )
        continue;
      validated[id] = {
        image_url: row.image_url,
        title: row.title,
        visual_caption: row.visual_caption,
        primary_system: typeof row.primary_system === "string" ? row.primary_system : "",
        source_name: typeof row.source_name === "string" ? row.source_name : "Medical gallery",
      };
    }
    cache.set(bucket, { value: validated, expires: Date.now() + CACHE_TTL_MS });
    return validated;
  })();
  inFlight.set(bucket, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(bucket);
  }
}


/** Separate USMLE manifest preserves the original gallery and requires explicit
 * publication clearance per item. Missing manifest => no images. */
const usmleCache = new WeakMap<R2BucketLike, ManifestCache>();
async function loadUSMLEManifest(bucket: R2BucketLike): Promise<GalleryManifest> {
  const current = usmleCache.get(bucket);
  if (current && current.expires > Date.now()) return current.value;
  const object = await bucket.get(USMLE_MANIFEST_KEY);
  if (!object) return {};
  const raw: unknown = JSON.parse(await object.text());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const valid: GalleryManifest = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!/^usmle_[LUB]\d{1,9}$/.test(id) || !value || typeof value !== "object") continue;
    const item = value as Partial<GalleryRecord>;
    if (
      item.rights_status !== "approved" ||
      item.display_ready !== true ||
      typeof item.image_url !== "string" ||
      typeof item.title !== "string" ||
      typeof item.visual_caption !== "string" ||
      !safeImageUrl(item.image_url)
    ) continue;
    const matchingName = id.slice("usmle_".length);
    const filenamePattern = new RegExp("^/offline_media/" + matchingName + "\\.(?:png|jpe?g|webp|gif)$", "i");
    if (!filenamePattern.test(new URL(item.image_url).pathname)) continue;
    valid[id] = {
      image_url: item.image_url,
      title: item.title.slice(0, 250),
      visual_caption: item.visual_caption.slice(0, 900),
      primary_system: typeof item.primary_system === "string" ? item.primary_system.slice(0, 120) : "",
      source_name: typeof item.source_name === "string" ? item.source_name.slice(0, 180) : "USMLE",
    };
  }
  usmleCache.set(bucket, { value: valid, expires: Date.now() + CACHE_TTL_MS });
  return valid;
}

/**
 * Hydrate IDs from the SAME namespace search response that supplied the
 * five clinical evidence libraries. This class NEVER performs AI Search.
 * Images are teaching illustrations only, not medical citation sources.
 */
export class CloudflareGalleryImageRetrieval implements GalleryImageRetriever {
  constructor(private readonly bucket: R2BucketLike, private readonly usmleEnabled = false) {}

  async hydrate(hits: readonly GallerySearchHit[]): Promise<MedicalImageCandidate[]> {
    if (!hits.length) return [];
    const legacyHits = hits.some((hit) => /^img_\d{6}$/.test(hit.imageId));
    const usmleHits = this.usmleEnabled && hits.some((hit) => /^usmle_[LUB]\d{1,9}$/.test(hit.imageId));
    if (!legacyHits && !usmleHits) return [];
    const manifest = legacyHits ? await loadManifest(this.bucket) : {};
    const usmleManifest = usmleHits ? await loadUSMLEManifest(this.bucket) : {};
    const seen = new Set<string>();
    const selected: MedicalImageCandidate[] = [];
    // Keep merged AI Search ranking order; drop missing manifest identities.
    for (const hit of hits) {
      if (
        !(/^img_\d{6}$/.test(hit.imageId) || (this.usmleEnabled && /^usmle_[LUB]\d{1,9}$/.test(hit.imageId))) ||
        seen.has(hit.imageId) ||
        !Number.isFinite(hit.score) ||
        hit.score < 0.4
      )
        continue;
      seen.add(hit.imageId);
      const item = manifest[hit.imageId] ?? usmleManifest[hit.imageId];
      if (!item) continue;
      selected.push({
        // Article image IDs reserve IMG_001 through IMG_300.
        id: "IMG_" + String(301 + selected.length).padStart(3, "0"),
        sourceId: "", // Gallery pictures cannot be medical citations.
        src: item.image_url,
        articleTitle: item.source_name,
        section: item.primary_system || "Medical image gallery",
        originalId: null,
        alt: item.title,
        caption: item.visual_caption,
        before: "",
        after: "",
      });
      if (selected.length >= MAX_GALLERY_IMAGES) break;
    }
    return selected;
  }
}
