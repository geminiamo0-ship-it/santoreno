import type { SessionContextResponse } from "@santo/contracts";
import {
  TrustedSourceDetailResponseSchema,
  TrustedSourceDetailRequestSchema,
  TrustedImageAssetIdSchema,
  type TrustedSourceDetailRequest,
  type TrustedSourceDetailResponse,
  type TrustedSourceMediaManifestEntry,
} from "@santo/contracts/source";

import { R2VerifiedSourceStore, SourceResolutionError } from "./store";
import {
  PmcResearchFigureProvider,
  pmcidFromSavedSource,
  type ResearchFigureProvider,
} from "./research-figures";

export class TrustedSourceService {
  constructor(
    private readonly store: R2VerifiedSourceStore,
    private readonly figureProvider: ResearchFigureProvider = new PmcResearchFigureProvider(),
  ) {}

  private async resolve(
    session: SessionContextResponse,
    request: TrustedSourceDetailRequest,
  ): Promise<{
    source: TrustedSourceDetailResponse["source"];
    entries: readonly TrustedSourceMediaManifestEntry[];
  }> {
    const parsed = TrustedSourceDetailRequestSchema.safeParse(request);
    if (!parsed.success) throw new SourceResolutionError(400, "INVALID_SOURCE_REQUEST");
    const sources = await this.store.load({ ...session, messageId: parsed.data.messageId });
    const source = sources.find((item) => item.sourceId === parsed.data.sourceId);
    if (!source) throw new SourceResolutionError(404, "SOURCE_NOT_FOUND");
    const entries = await this.store.images(source);
    return { source, entries };
  }

  async detail(
    session: SessionContextResponse,
    request: TrustedSourceDetailRequest,
  ): Promise<TrustedSourceDetailResponse> {
    const { source, entries } = await this.resolve(session, request);
    const pmcid = pmcidFromSavedSource(source);
    const researchFigures = pmcid ? await this.figureProvider.find(pmcid) : [];
    return TrustedSourceDetailResponseSchema.parse({
      source,
      ...(pmcid ? { researchFigures } : {}),
      ...(source.instanceId === "pubmed" && /^pubmed:\d+$/.test(source.sourceId)
        ? { externalUrl: "https://pubmed.ncbi.nlm.nih.gov/" + source.sourceId.slice(7) + "/" }
        : {}),
      images: entries.map(({ assetId, altText, caption, contentType, width, height }) => ({
        assetId,
        altText,
        caption,
        contentType,
        width,
        height,
      })),
    });
  }

  async image(
    session: SessionContextResponse,
    request: TrustedSourceDetailRequest,
    assetId: string,
  ): Promise<{
    contentType: TrustedSourceMediaManifestEntry["contentType"];
    bytes: Uint8Array<ArrayBuffer>;
  }> {
    if (!TrustedImageAssetIdSchema.safeParse(assetId).success) {
      throw new SourceResolutionError(400, "INVALID_SOURCE_REQUEST");
    }
    const { entries } = await this.resolve(session, request);
    const entry = entries.find((candidate) => candidate.assetId === assetId);
    if (!entry) throw new SourceResolutionError(404, "SOURCE_NOT_FOUND");
    return { contentType: entry.contentType, bytes: await this.store.asset(entry) };
  }
}
