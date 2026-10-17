import type { R2BucketLike } from "../runtime/bindings";
import type { GallerySearchHit } from "./types";
import type { MedicalImageCandidate } from "./medical-images";

/** The gallery is visual teaching material, never a sixth clinical citation. */
export interface GalleryImageRetriever {
  hydrate(hits: readonly GallerySearchHit[]): Promise<MedicalImageCandidate[]>;
}

const GALLERY_ID = "santo-medical-images";
const MANIFEST_KEY = "gallery/v1/santo_image_manifest.json";
const IMAGE_HOST = "pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_GALLERY_IMAGES = 7;

interface GalleryRecord {
  image_url: string;
  title: string;
  visual_caption: string;
  primary_system: string;
  source_name: string;
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

/**
 * Hydrate IDs from the SAME namespace search response that supplied the
 * five clinical evidence libraries. This class NEVER performs AI Search.
 * Images are teaching illustrations only, not medical citation sources.
 */
export class CloudflareGalleryImageRetrieval implements GalleryImageRetriever {
  constructor(private readonly bucket: R2BucketLike) {}

  async hydrate(hits: readonly GallerySearchHit[]): Promise<MedicalImageCandidate[]> {
    if (!hits.length) return [];
    const manifest = await loadManifest(this.bucket);
    const seen = new Set<string>();
    const selected: MedicalImageCandidate[] = [];
    // Keep merged AI Search ranking order; drop missing manifest identities.
    for (const hit of hits) {
      if (!/^img_\d{6}$/.test(hit.imageId) || seen.has(hit.imageId) ||
          !Number.isFinite(hit.score) || hit.score < 0.4) continue;
      seen.add(hit.imageId);
      const item = manifest[hit.imageId];
      if (!item) continue;
      selected.push({
        // Article image IDs are IMG_001 through IMG_080.
        id: "IMG_" + String(81 + selected.length).padStart(3, "0"),
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
