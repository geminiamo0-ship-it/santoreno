import type { AiSearchNamespaceLike, R2BucketLike } from "../runtime/bindings";
import type { MedicalImageCandidate } from "./medical-images";

/** The gallery is visual teaching material, never a sixth clinical citation. */
export interface GalleryImageRetriever {
  retrieve(query: string): Promise<MedicalImageCandidate[]>;
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

function getRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Isolated sixth search runs in parallel to the five clinical indexes.
 * Returns zero on no match; caller owns bounded failure fallback.
 * Search item identifiers are NEVER taken from model-generated text.
 */
export class CloudflareGalleryImageRetrieval implements GalleryImageRetriever {
  constructor(
    private readonly namespace: AiSearchNamespaceLike,
    private readonly bucket: R2BucketLike,
  ) {}

  async retrieve(query: string): Promise<MedicalImageCandidate[]> {
    const response = getRecord(
      await this.namespace.search({
        query,
        ai_search_options: {
          instance_ids: [GALLERY_ID],
          retrieval: {
            retrieval_type: "hybrid",
            match_threshold: 0.4,
            max_num_results: 12,
            return_on_failure: true,
            fusion_method: "rrf",
          },
          query_rewrite: { enabled: false },
        },
      }),
    );
    if (!Array.isArray(response?.chunks)) return [];
    const ranked: { id: string; score: number }[] = [];
    const seen = new Set<string>();
    for (const raw of response.chunks) {
      const chunk = getRecord(raw);
      const item = getRecord(chunk?.item);
      const key = item?.key;
      const score = chunk?.score;
      const match = typeof key === "string" ? /(?:^|\/)(img_\d{6})\.json$/.exec(key) : null;
      if (!match || typeof score !== "number" || !Number.isFinite(score) || score < 0.4) continue;
      if (chunk?.instance_id !== GALLERY_ID && chunk?.instance_id !== undefined) continue;
      const id = match[1]!;
      if (seen.has(id)) continue;
      seen.add(id);
      ranked.push({ id, score });
    }
    if (!ranked.length) return [];
    ranked.sort((a, b) => b.score - a.score);
    const manifest = await loadManifest(this.bucket);
    return ranked.slice(0, MAX_GALLERY_IMAGES).flatMap((entry, index) => {
      const item = manifest[entry.id];
      if (!item) return [];
      return [
        {
          // Existing article-image IDs never exceed IMG_080.
          id: "IMG_" + String(81 + index).padStart(3, "0"),
          sourceId: "", // Gallery figures cannot become trusted medical citations.
          src: item.image_url,
          articleTitle: item.source_name,
          section: item.primary_system || "Medical image gallery",
          originalId: null,
          alt: item.title,
          caption: item.visual_caption,
          before: "",
          after: "",
        },
      ];
    });
  }
}
