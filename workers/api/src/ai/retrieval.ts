import type { AiSearchNamespaceLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import {
  AiSearchNamespaceLibraryCatalog,
  type LibraryCatalogEntry,
  type LibraryCatalogPort,
} from "./library-catalog";
import type {
  CombinedSearchResult,
  GallerySearchHit,
  RetrievalPort,
  RetrievalRequest,
  RetrievedEvidence,
} from "./types";
import { focusedSearchQuery, focusedUserMessageQuery } from "./source-relevance";
import { rankMedicalCandidates, type RankedCandidate } from "./medical-ranking";
import type { WorkersAiLike } from "../runtime/bindings";
import { rewriteMedicalSearchQuery, routeMedicalRequest } from "./medical-query-rewrite";
import { exclusiveModeLibraries, isExclusiveMode, GALLERY_INSTANCE } from "./exclusive-source-modes";

const LIBRARIES = ["amboss", "usmle", "passmedicine", "pastest", "one-examination"] as const;
const MAX_RESULTS = 5;
const PER_LIBRARY_CANDIDATES = 3;
const V2_PER_LIBRARY_CANDIDATES = 24;
const V2_EXPANDED_CANDIDATES = 40;
// Single namespace request: return a broad Cloudflare-ranked pool, then send only five original articles to Luna.
const MERGED_SEARCH_CANDIDATES = 25;
const WITH_GALLERY_MERGED_CANDIDATES = 45;
// Sixth index participates in the SAME Cloudflare namespace-level search call.
const IMAGE_SEARCH_INSTANCE = "santo-medical-images";
// Separate licensed educational exam-memory index; never clinical citation evidence.
const ANKING_SEARCH_INSTANCE = "santo-anking-cardiology";
const ANKING_FULL_V12_INSTANCE = "santo-anking-step-v12";
const WITH_ANKING_MERGED_CANDIDATES = 50;
// Verified on real staging with 4 representative clinical queries: lower-latency
// first-pass RRF retrieval without expensive 50-result native reranking.
const STAGING_FAST_SEARCH_CANDIDATES = 30;
const MATCH_THRESHOLD = 0.4;
const MAX_CHUNK_CHARS = 5000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pageFromMetadata(metadata: Record<string, unknown> | null): number | null {
  for (const key of ["page", "page_number", "pageNumber"]) {
    const value = metadata?.[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function sectionFromMetadata(metadata: Record<string, unknown> | null): string | null {
  return (
    stringField(metadata, "section") ??
    stringField(metadata, "section_title") ??
    stringField(metadata, "sectionTitle")
  );
}

function titleFromItem(item: Record<string, unknown> | null): string {
  const metadata = asRecord(item?.metadata);
  return (
    stringField(metadata, "title") ??
    stringField(metadata, "name") ??
    stringField(item, "key") ??
    "Santo medical source"
  ).slice(0, 500);
}

/**
 * There are five fixed licensed medical libraries in this rollout. A global
 * search always considers EXACTLY those libraries, independent of the score
 * distribution returned by a combined namespace query.
 */
function selectLibraries(
  catalog: readonly LibraryCatalogEntry[],
  libraryId: string | null,
): readonly LibraryCatalogEntry[] {
  const supported = new Set<string>(LIBRARIES);
  if (libraryId !== null && !supported.has(libraryId)) {
    throw new GroundedAiError(400, "INVALID_LIBRARY_FILTER", "Unknown Santo library filter");
  }
  const selected = LIBRARIES.map((id) => catalog.find((entry) => entry.id === id));
  // Reject misconfigured/incomplete namespaces rather than silently searching
  // an unrelated index. For an explicit filter, require that index only.
  const required =
    libraryId === null ? selected : [catalog.find((entry) => entry.id === libraryId)];
  if (required.some((entry) => !entry)) {
    throw new GroundedAiError(
      503,
      "SEARCH_CONFIGURATION_ERROR",
      "Required medical library index unavailable",
    );
  }
  return required as LibraryCatalogEntry[];
}

function evidenceFromSearch(
  raw: unknown,
  selectedLibraries: readonly LibraryCatalogEntry[],
  maxResults = MAX_RESULTS,
  minScore = MATCH_THRESHOLD,
): RetrievedEvidence[] {
  const root = asRecord(raw);
  const chunks = root?.chunks;
  if (!Array.isArray(chunks)) {
    throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search returned an invalid response");
  }

  const libraryByInstanceId = new Map(
    selectedLibraries.map((entry) => [entry.instanceId, entry] as const),
  );
  const fallbackLibrary = selectedLibraries.length === 1 ? selectedLibraries[0] : null;
  const evidence: RetrievedEvidence[] = [];
  const seen = new Set<string>();

  for (const rawChunk of chunks) {
    const chunk = asRecord(rawChunk);
    const chunkId = stringField(chunk, "id");
    const text = stringField(chunk, "text");
    const score = numberField(chunk, "score");
    const item = asRecord(chunk?.item);
    const itemKey = stringField(item, "key");
    const instanceId = stringField(chunk, "instance_id") ?? fallbackLibrary?.instanceId ?? null;
    const library = instanceId ? libraryByInstanceId.get(instanceId) : undefined;

    if (
      !chunkId ||
      !text ||
      score === null ||
      score < minScore ||
      !itemKey ||
      !instanceId ||
      !library
    ) {
      continue;
    }

    const sourceId = `${instanceId}:${chunkId}`;
    if (seen.has(sourceId)) {
      continue;
    }
    seen.add(sourceId);

    const metadata = asRecord(item?.metadata);
    evidence.push({
      sourceId,
      libraryId: library.id,
      instanceId,
      itemKey,
      title: titleFromItem(item),
      page: pageFromMetadata(metadata),
      section: sectionFromMetadata(metadata),
      text: text.slice(0, MAX_CHUNK_CHARS),
      score,
    });

    if (evidence.length >= maxResults) {
      break;
    }
  }

  return evidence;
}

export class CloudflareAiSearchRetrieval implements RetrievalPort {
  private readonly catalog: LibraryCatalogPort;

  constructor(
    private readonly namespace: AiSearchNamespaceLike | undefined,
    catalog?: LibraryCatalogPort,
    private readonly medicalRetrievalV2 = false,
    private readonly medicalQueryRewriteV1 = false,
    private readonly smallQueryModel?: WorkersAiLike,
    private readonly intentRoutingV1 = false,
    private readonly singleMultiInstanceSearchV1 = false,
    private readonly ankingCardsV1 = false,
    private readonly ankingFullV12 = false,
    private readonly fastOneSearchV1 = false,
    private readonly exclusiveSourceModesV1 = false,
  ) {
    this.catalog = catalog ?? new AiSearchNamespaceLibraryCatalog(namespace);
  }

  async route(request: RetrievalRequest) {
    const userMessages = request.recentUserMessages?.slice(-5);
    const focused = userMessages?.length
      ? focusedUserMessageQuery(userMessages)
      : focusedSearchQuery(request.query);
    if (!this.intentRoutingV1) return { intent: "medical" as const, searchQuery: focused };
    return routeMedicalRequest(
      this.smallQueryModel,
      request.query,
      focused,
      request.onRouteDiagnostic,
      userMessages,
      request.recentQwenReplies,
    );
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievedEvidence[]> {
    return (await this.retrieveInternal(request, false)).evidence;
  }

  async retrieveWithGallery(request: RetrievalRequest): Promise<CombinedSearchResult> {
    return this.retrieveInternal(request, true);
  }

  private async retrieveInternal(
    request: RetrievalRequest,
    includeGallery: boolean,
  ): Promise<CombinedSearchResult> {
    if (!this.namespace) {
      throw new GroundedAiError(503, "AI_NOT_CONFIGURED", "AI Search binding is required");
    }

    try {
      // Begin catalog lookup before the model rewrite to overlap both network calls.
      const catalogStartedAt = performance.now();
      const catalogPromise = this.catalog.list().finally(() => {
        console.info("santo_search_phase_ms", {
          phase: "catalog",
          milliseconds: Math.round(performance.now() - catalogStartedAt),
        });
      });
      const currentTopicQuery = focusedSearchQuery(request.query);
      const queryPromise = request.preparedQuery
        ? Promise.resolve(request.preparedQuery)
        : this.medicalRetrievalV2 && this.medicalQueryRewriteV1
          ? rewriteMedicalSearchQuery(this.smallQueryModel, request.query, currentTopicQuery)
          : Promise.resolve(currentTopicQuery);
      const [catalog, searchQuery] = await Promise.all([catalogPromise, queryPromise]);
      // Chosen study mode has an explicit index allowlist and exactly ONE
      // Cloudflare search, regardless of the size of Qwen's search plan.
      // PubMed bypasses this adapter and remains unchanged.
      if (this.exclusiveSourceModesV1 && isExclusiveMode(request.libraryId)) {
        const selected = exclusiveModeLibraries(
          catalog,
          request.libraryId,
          this.ankingCardsV1 && this.ankingFullV12,
        );
        return this.retrieveExclusiveMode(selected, searchQuery, includeGallery);
      }
      const selectedLibraries = selectLibraries(catalog, request.libraryId);
      if (
        this.medicalRetrievalV2 &&
        this.singleMultiInstanceSearchV1 &&
        request.preparedQueries &&
        request.preparedQueries.length > 1
      ) {
        return this.retrievePlannedMultiInstance(
          currentTopicQuery,
          selectedLibraries,
          request.preparedQueries,
          includeGallery && request.libraryId === null,
          this.ankingCardsV1 && request.libraryId === null,
        );
      }
      if (this.medicalRetrievalV2) {
        if (this.singleMultiInstanceSearchV1)
          return this.retrieveSingleMultiInstance(
            currentTopicQuery,
            selectedLibraries,
            searchQuery,
            includeGallery && request.libraryId === null,
            this.ankingCardsV1 && request.libraryId === null,
          );
        return {
          evidence: await this.retrieveMedicalV2(currentTopicQuery, selectedLibraries, searchQuery),
          galleryHits: [],
        };
      }
      // Query each index concurrently. Asking a single global top-5 search
      // routinely hides smaller libraries, even when their evidence is relevant.
      // No Reranker or synthetic citation is involved. From each library we
      // retain at most one valid, relevant, Cloudflare-ranked source passage.
      const results = await Promise.all(
        selectedLibraries.map(async (entry) => {
          const search = await this.namespace!.search({
            query: currentTopicQuery,
            ai_search_options: {
              instance_ids: [entry.instanceId],
              retrieval: {
                retrieval_type: "hybrid",
                match_threshold: MATCH_THRESHOLD,
                max_num_results: PER_LIBRARY_CANDIDATES,
                return_on_failure: true,
              },
              query_rewrite: { enabled: false },
            },
          });
          // Do not force one result per library: a high semantic score can
          // still be for a DIFFERENT disease from a previous discussion.
          return evidenceFromSearch(search, [entry]).slice(0, 1);
        }),
      );
      return { evidence: results.flat().slice(0, MAX_RESULTS), galleryHits: [] };
    } catch (error) {
      if (error instanceof GroundedAiError) {
        throw error;
      }
      throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search request failed");
    }
  }

  /**
   * Staging opt-in: one Cloudflare namespace search, across the exact allowed indexes.
   * Do not retry, fan out, or treat partial per-index failures as empty evidence.
   * Cloudflare owns the merged reranking order; retain real source identities and
   * choose up to five distinct original articles for the unchanged Luna prompt.
   */
  private async retrieveSingleMultiInstance(
    query: string,
    libraries: readonly LibraryCatalogEntry[],
    searchQuery: string,
    includeGallery = false,
    includeAnking = false,
  ): Promise<CombinedSearchResult> {
    const searchStartedAt = performance.now();
    let response: unknown;
    try {
      response = await this.namespace!.search({
        query: searchQuery,
        ai_search_options: {
          instance_ids: [
            ...libraries.map((library) => library.instanceId),
            ...(includeGallery ? [IMAGE_SEARCH_INSTANCE] : []),
            ...(includeAnking
              ? [this.ankingFullV12 ? ANKING_FULL_V12_INSTANCE : ANKING_SEARCH_INSTANCE]
              : []),
          ],
          retrieval: {
            retrieval_type: "hybrid",
            match_threshold: MATCH_THRESHOLD,
            max_num_results: this.fastOneSearchV1
              ? STAGING_FAST_SEARCH_CANDIDATES
              : includeAnking
                ? WITH_ANKING_MERGED_CANDIDATES
                : includeGallery
                  ? WITH_GALLERY_MERGED_CANDIDATES
                  : MERGED_SEARCH_CANDIDATES,
            return_on_failure: true,
            fusion_method: "rrf",
          },
          reranking: {
            enabled: !this.fastOneSearchV1,
            ...(this.fastOneSearchV1 ? {} : { model: "@cf/baai/bge-reranker-base" }),
          },
          query_rewrite: { enabled: false },
        },
      });
    } finally {
      // Can finish after withAiDeadline has timed out: that distinction is
      // useful for diagnosing provider tail latency. Never log query text.
      console.info("santo_search_phase_ms", {
        phase: "namespace_search",
        milliseconds: Math.round(performance.now() - searchStartedAt),
        fast: this.fastOneSearchV1,
      });
    }
    const result = asRecord(response);
    if (Array.isArray(result?.errors) && result.errors.length > 0) {
      throw new GroundedAiError(502, "SEARCH_FAILED", "Multi-instance search partially failed");
    }
    const candidates = evidenceFromSearch(
      response,
      libraries,
      this.fastOneSearchV1
        ? STAGING_FAST_SEARCH_CANDIDATES
        : includeAnking
          ? WITH_ANKING_MERGED_CANDIDATES
          : includeGallery
            ? WITH_GALLERY_MERGED_CANDIDATES
            : MERGED_SEARCH_CANDIDATES,
    ).map((evidence, position) => ({ evidence, position }));
    const galleryHits: GallerySearchHit[] = [];
    if (includeGallery && Array.isArray(result?.chunks)) {
      const seen = new Set<string>();
      for (const raw of result.chunks) {
        const row = asRecord(raw);
        if (stringField(row, "instance_id") !== IMAGE_SEARCH_INSTANCE) continue;
        const item = asRecord(row?.item);
        const key = stringField(item, "key");
        const score = numberField(row, "score");
        const image = key ? /(?:^|\/)(img_\d{6})\.json$/.exec(key) : null;
        if (!image || score === null || score < MATCH_THRESHOLD) continue;
        const imageId = image[1]!;
        if (seen.has(imageId)) continue;
        seen.add(imageId);
        galleryHits.push({ imageId, score });
      }
    }
    // AnKing is a licensed scientific study source, not a flashcard-generation action.
    // Reuse ONLY the chunks already returned by this SAME namespace request.
    // Preserve the five clinical references; add at most one relevant original
    // AnKing excerpt with a canonical AI Search source identity for [[N]].
    const clinicalEvidence = rankMedicalCandidates(query, candidates, MAX_RESULTS);
    const ankingEvidence =
      includeAnking && this.ankingFullV12
        ? evidenceFromSearch(
            response,
            [{ id: "anking", instanceId: ANKING_FULL_V12_INSTANCE, title: "AnKing v12" }],
            10,
          ).filter((item) => /(?:^|\/)note_\d{10,16}\.json$/.test(item.itemKey))
        : [];
    const bestAnking = rankMedicalCandidates(
      query,
      ankingEvidence.map((evidence, position) => ({ evidence, position })),
      1,
    ).map((item) => ({
      ...item,
      title:
        "AnKing v12 — " + (item.title === "Untitled" ? "High-Yield Medical Notes" : item.title),
    }));
    return {
      evidence: [...clinicalEvidence, ...bestAnking],
      galleryHits,
      // Cards never hydrate on the Luna path. Find the Card owns a separate
      // authenticated R2-only endpoint with independent lifecycle and quota.
    };
  }

  /**
   * Selected library mode: one native namespace-level search, dedup only.
   * Selected evidence indexes are exclusive; gallery is a separate
   * non-citable image index included in the SAME provider call.
   */
  private async retrieveExclusiveMode(
    selectedLibraries: readonly LibraryCatalogEntry[],
    query: string,
    includeGallery: boolean,
  ): Promise<CombinedSearchResult> {
    const ids = [
      ...selectedLibraries.map((entry) => entry.instanceId),
      ...(includeGallery ? [GALLERY_INSTANCE] : []),
    ];
    const started = performance.now();
    const response = await this.namespace!.search({
      query,
      ai_search_options: {
        instance_ids: ids,
        retrieval: {
          retrieval_type: "hybrid",
          match_threshold: MATCH_THRESHOLD,
          max_num_results: 50,
          return_on_failure: true,
          fusion_method: "rrf",
        },
        reranking: { enabled: false },
        query_rewrite: { enabled: false },
      },
    });
    const root = asRecord(response);
    if (!Array.isArray(root?.chunks) ||
      (Array.isArray(root?.errors) && root.errors.length > 0)) {
      throw new GroundedAiError(502, "SEARCH_FAILED", "Selected study-mode search failed");
    }

    const evidence: RetrievedEvidence[] = [];
    const galleryHits: GallerySearchHit[] = [];
    const seenIds = new Set<string>();
    const seenText = new Set<string>();
    const seenImages = new Set<string>();
    const allowedEvidenceIds = new Set(selectedLibraries.map(entry => entry.instanceId));
    // Never use the single-library fallback for a namespace hit missing its
    // instance identity: this mode must not cite foreign/unattributed sources.
    const attributable = root.chunks.filter(raw => {
      const entry = asRecord(raw);
      return allowedEvidenceIds.has(stringField(entry, "instance_id") ?? "");
    });
    for (const candidate of evidenceFromSearch({ chunks: attributable }, selectedLibraries, 50)) {
      if (candidate.libraryId === "anking" &&
        !/(?:^|\\/)note_\\d{10,16}\\.json$/.test(candidate.itemKey)) continue;
      const normalized = candidate.text.replace(/\\s+/g, " ").trim();
      if (seenIds.has(candidate.sourceId) || seenText.has(normalized)) continue;
      seenIds.add(candidate.sourceId);
      seenText.add(normalized);
      evidence.push(candidate.libraryId === "anking"
        ? { ...candidate, title: "AnKing v12 — " + candidate.title }
        : candidate);
    }
    if (includeGallery) {
      for (const raw of root.chunks) {
        const hit = asRecord(raw);
        if (stringField(hit, "instance_id") !== GALLERY_INSTANCE) continue;
        const key = stringField(asRecord(hit?.item), "key");
        const match = key ? /(?:^|\\/)(img_\\d{6})\\.json$/.exec(key) : null;
        const score = numberField(hit, "score");
        if (!match || score === null || score < MATCH_THRESHOLD || seenImages.has(match[1]!))
          continue;
        seenImages.add(match[1]!);
        galleryHits.push({ imageId: match[1]!, score });
      }
    }
    console.info("santo_exclusive_mode_search", {
      selectedIndexes: selectedLibraries.length,
      gallery: includeGallery,
      providerHits: root.chunks.length,
      evidence: evidence.length,
      milliseconds: Math.round(performance.now() - started),
    });
    return { evidence, galleryHits };
  }

  /**
   * MEDICAL mode: Qwen plans queries, Cloudflare AI Search retrieves snippets.
   * Forward ALL original source excerpts from all successful searches, in
   * provider/query order. ONLY remove duplicate chunk IDs or identical text;
   * no application-side RRF, score sort, per-library quota, best-30 cut,
   * best-90 cut, per-article quota, or clinical relevance reranker.
   *
   * The Cloudflare provider itself retains hybrid/RRF relevance and threshold.
   * Up to four requests × 50 provider hits = 200 raw chunks across seven indexes.
   */
  private async retrievePlannedMultiInstance(
    _question: string,
    libraries: readonly LibraryCatalogEntry[],
    plan: readonly string[],
    includeGallery: boolean,
    includeAnking: boolean,
  ): Promise<CombinedSearchResult> {
    const queries = [
      ...new Set(
        plan
          .map((value) => value.trim())
          .filter((value) => value.length >= 3 && value.length <= 220 && !/[\r\n{}<>]/.test(value)),
      ),
    ].slice(0, 4);
    if (!queries.length)
      throw new GroundedAiError(502, "SEARCH_FAILED", "No valid medical search plan");
    const instanceIds = [
      ...libraries.map((library) => library.instanceId),
      ...(includeGallery ? [IMAGE_SEARCH_INSTANCE] : []),
      ...(includeAnking
        ? [this.ankingFullV12 ? ANKING_FULL_V12_INSTANCE : ANKING_SEARCH_INSTANCE]
        : []),
    ];
    const started = performance.now();
    const results = await Promise.allSettled(
      queries.map(async (query) => {
        const response = await this.namespace!.search({
          query,
          ai_search_options: {
            instance_ids: instanceIds,
            retrieval: {
              retrieval_type: "hybrid",
              match_threshold: MATCH_THRESHOLD,
              max_num_results: 50,
              return_on_failure: true,
              fusion_method: "rrf",
            },
            reranking: { enabled: false },
            query_rewrite: { enabled: false },
          },
        });
        const root = asRecord(response);
        if (!Array.isArray(root?.chunks) || (Array.isArray(root?.errors) && root.errors.length > 0))
          throw new GroundedAiError(502, "SEARCH_FAILED", "Medical search call failed");
        return response;
      }),
    );
    const successful = results.filter(
      (entry): entry is PromiseFulfilledResult<unknown> => entry.status === "fulfilled",
    );
    if (!successful.length)
      throw new GroundedAiError(502, "SEARCH_FAILED", "All medical search queries failed");

    // Stable insertion order is the provider's original order, then query order.
    // Never use a numerical score to select, re-rank or discard a valid result.
    const evidence: RetrievedEvidence[] = [];
    const gallery = new Map<string, GallerySearchHit>();
    const seenSources = new Set<string>();
    const seenText = new Set<string>();
    let duplicates = 0;
    let providerChunks = 0;
    const keep = (item: RetrievedEvidence): void => {
      const fingerprint = item.text.replace(/\s+/g, " ").trim();
      if (seenSources.has(item.sourceId) || seenText.has(fingerprint)) {
        duplicates++;
        return;
      }
      seenSources.add(item.sourceId);
      seenText.add(fingerprint);
      evidence.push(item);
    };
    for (const response of successful) {
      const source = response.value;
      const root = asRecord(source);
      providerChunks += Array.isArray(root?.chunks) ? root.chunks.length : 0;
      for (const item of evidenceFromSearch(source, libraries, 50)) keep(item);
      if (includeAnking && this.ankingFullV12) {
        const notes = evidenceFromSearch(
          source,
          [{ id: "anking", instanceId: ANKING_FULL_V12_INSTANCE, title: "AnKing v12" }],
          50,
        ).filter((item) => /(?:^|\/)note_\d{10,16}\.json$/.test(item.itemKey));
        for (const item of notes) keep({ ...item, title: "AnKing v12 — " + item.title });
      }
      if (includeGallery && Array.isArray(root?.chunks)) {
        for (const raw of root.chunks) {
          const chunk = asRecord(raw);
          if (stringField(chunk, "instance_id") !== IMAGE_SEARCH_INSTANCE) continue;
          const key = stringField(asRecord(chunk?.item), "key");
          const match = key ? /(?:^|\/)(img_\d{6})\.json$/.exec(key) : null;
          const score = numberField(chunk, "score");
          if (match && score !== null && score >= MATCH_THRESHOLD && !gallery.has(match[1]!))
            gallery.set(match[1]!, { imageId: match[1]!, score });
        }
      }
    }
    console.info("santo_medical_search_passthrough", {
      queries: queries.length,
      succeeded: successful.length,
      milliseconds: Math.round(performance.now() - started),
      providerChunks,
      uniqueEvidence: evidence.length,
      duplicates,
      gallery: gallery.size,
    });
    return {
      evidence,
      galleryHits: [...gallery.values()].slice(0, 15),
    };
  }

  /**
   * Quality-first staging rollout. The source *collection* is never passed
   * straight through to Luna. Relevance and source diversity are evaluated
   * after Cloudflare's native per-index reranking. Extra retrieval only runs
   * when insufficient relevant passages survive the first stage.
   */
  private async retrieveMedicalV2(
    query: string,
    libraries: readonly LibraryCatalogEntry[],
    searchQuery: string,
  ): Promise<RetrievedEvidence[]> {
    const searchStage = async (
      maxResults: number,
      minScore: number,
    ): Promise<RankedCandidate[]> => {
      const batches = await Promise.all(
        libraries.map(async (library) => {
          const response = await this.namespace!.search({
            query: searchQuery,
            ai_search_options: {
              instance_ids: [library.instanceId],
              retrieval: {
                retrieval_type: "hybrid",
                match_threshold: minScore,
                max_num_results: maxResults,
                return_on_failure: true,
                fusion_method: "rrf",
              },
              reranking: {
                enabled: true,
                model: "@cf/baai/bge-reranker-base",
              },
              query_rewrite: { enabled: false },
            },
          });
          return evidenceFromSearch(response, [library], maxResults, minScore).map(
            (evidence, position) => ({ evidence, position }),
          );
        }),
      );
      return batches.flat();
    };

    const first = await searchStage(V2_PER_LIBRARY_CANDIDATES, MATCH_THRESHOLD);
    let best = rankMedicalCandidates(query, first, MAX_RESULTS);
    // No speculative retries or new Luna generation. At most one extra
    // retrieval pass (10 AI Search operations for all five libraries).
    if (best.length < Math.min(3, libraries.length)) {
      const second = await searchStage(V2_EXPANDED_CANDIDATES, 0.25);
      best = rankMedicalCandidates(query, [...first, ...second], MAX_RESULTS);
    }
    return best;
  }
}
