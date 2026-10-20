import type { SessionContextResponse } from "@santo/contracts";
import type { GroundedAiQueryRequest, GroundedAiQueryResponse } from "@santo/contracts/ai";
import { TrustedSourceMetadataSchema } from "@santo/contracts/source";

import { QuotaServiceError } from "../quota/service";
import type { QuotaService } from "../quota/types";
import type { SourceSnapshotWriter } from "../sources/store";
import { validateGroundedCitations } from "./citations";
import { AI_STAGE_TIMEOUTS, withAiDeadline } from "./deadline";
import { GroundedAiError } from "./errors";
import { buildGeneralMedicalPrompt } from "./prompt";
import { buildBudgetedResearchPrompt } from "./research-budget";
import type { AiTelemetryPort, ModelPort, RetrievalPort } from "./types";

function quotaDenial(reason: string | null): GroundedAiError {
  switch (reason) {
    case "TENANT_SUSPENDED":
      return new GroundedAiError(403, "TENANT_SUSPENDED", "Tenant AI access is suspended");
    case "USER_SUSPENDED":
      return new GroundedAiError(403, "USER_SUSPENDED", "User AI access is suspended");
    case "QUOTA_EXPIRED":
      return new GroundedAiError(403, "QUOTA_EXPIRED", "User AI entitlement has expired");
    case "TENANT_EXHAUSTED":
      return new GroundedAiError(429, "TENANT_QUOTA_EXHAUSTED", "Tenant quota is exhausted");
    case "USER_EXHAUSTED":
      return new GroundedAiError(429, "USER_QUOTA_EXHAUSTED", "User quota is exhausted");
    default:
      return new GroundedAiError(503, "QUOTA_UNAVAILABLE", "Quota reservation was denied");
  }
}

function errorCode(error: unknown): string {
  if (error instanceof GroundedAiError || error instanceof QuotaServiceError) {
    return error.code;
  }
  return "INTERNAL_ERROR";
}

async function deriveQuotaIdempotencyKey(
  externalUserId: string,
  clientKey: string,
  query: string,
  libraryId: string | null,
  sourceMode: "libraries" | "research",
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${externalUserId}\u0000${clientKey}\u0000${sourceMode}\u0000${libraryId ?? ""}\u0000${query}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ai:${hex}`;
}

export class GroundedAiService {
  constructor(
    private readonly quota: QuotaService,
    private readonly retrieval: RetrievalPort,
    private readonly model: ModelPort,
    private readonly telemetry: AiTelemetryPort,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly timeouts: { retrievalMs: number; modelMs: number } = AI_STAGE_TIMEOUTS,
    private readonly sourceStore?: SourceSnapshotWriter | null,
    private readonly generalFallbackEnabled = false,
  ) {}

  async query(
    session: SessionContextResponse,
    input: GroundedAiQueryRequest,
    signal?: AbortSignal,
  ): Promise<GroundedAiQueryResponse> {
    const startedAt = this.nowMs();
    const requestId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const libraryId = input.library_id ?? null;
    const sourceMode = input.source_mode ?? "libraries";
    if (sourceMode === "research" && libraryId !== null) {
      throw new GroundedAiError(
        400,
        "INVALID_SOURCE_MODE",
        "Research mode cannot use a library filter",
      );
    }
    const quotaIdempotencyKey = await deriveQuotaIdempotencyKey(
      session.externalUserId,
      input.idempotency_key,
      input.query,
      libraryId,
      sourceMode,
    );

    if (signal?.aborted) {
      const error = new GroundedAiError(499, "REQUEST_CANCELLED", "Request was cancelled");
      this.recordFailure(requestId, session, startedAt, error.code);
      throw error;
    }

    let reservation;
    try {
      reservation = await this.quota.reserve({
        tenantId: session.tenantId,
        externalUserId: session.externalUserId,
        idempotencyKey: quotaIdempotencyKey,
        units: 1,
      });
    } catch {
      const error = new GroundedAiError(503, "QUOTA_UNAVAILABLE", "Quota service is unavailable");
      this.recordFailure(requestId, session, startedAt, error.code);
      throw error;
    }

    if (!reservation.allowed) {
      const error = quotaDenial(reservation.denialReason);
      this.recordFailure(requestId, session, startedAt, error.code);
      throw error;
    }

    const alreadyFinalized = reservation.reservationStatus === "finalized";

    let answer: string;
    let citations: GroundedAiQueryResponse["citations"];
    let responseMode: "santo" | "general" = "santo";
    try {
      const evidence = await withAiDeadline(
        () =>
          this.retrieval.retrieve({
            query: input.query,
            libraryId,
            ...(sourceMode === "research" ? { sourceMode, signal } : {}),
          }),
        signal,
        this.timeouts.retrievalMs,
        "SEARCH_TIMEOUT",
      );
      // A genuinely empty result is different from SEARCH_FAILED / SEARCH_TIMEOUT:
      // infrastructure outages still fail closed, never silently become "general".
      let groundingMode: "santo" | "general" = "santo";
      if (evidence.length === 0 && (sourceMode === "research" || !this.generalFallbackEnabled)) {
        throw new GroundedAiError(
          422,
          "INSUFFICIENT_EVIDENCE",
          "No sufficient Santo evidence was retrieved",
        );
      }
      if (evidence.length === 0) groundingMode = "general";
      let draft = await withAiDeadline(
        () =>
          this.model.generate(
            groundingMode === "general"
              ? buildGeneralMedicalPrompt(input.query)
              : buildBudgetedResearchPrompt(input.query, evidence),
          ),
        signal,
        this.timeouts.modelMs,
        "MODEL_TIMEOUT",
      );

      // If evidence existed but even the grounded model declined to rely on it,
      // retry once as explicitly uncited medical education, under the SAME quota.
      if (
        draft.answer === "INSUFFICIENT_EVIDENCE" &&
        groundingMode === "santo" &&
        this.generalFallbackEnabled &&
        sourceMode !== "research"
      ) {
        groundingMode = "general";
        draft = await withAiDeadline(
          () => this.model.generate(buildGeneralMedicalPrompt(input.query)),
          signal,
          this.timeouts.modelMs,
          "MODEL_TIMEOUT",
        );
      }
      if (draft.answer === "INSUFFICIENT_EVIDENCE") {
        throw new GroundedAiError(
          422,
          "INSUFFICIENT_EVIDENCE",
          "No responsible medical answer available",
        );
      }

      answer = draft.answer;
      responseMode = groundingMode;
      if (groundingMode === "general") {
        // A provider-supplied citation in general mode is never trusted.
        if (draft.citationIds.length !== 0) {
          throw new GroundedAiError(
            502,
            "CITATION_INVALID",
            "General medical answer cannot cite Santo",
          );
        }
        citations = [];
      } else {
        citations = validateGroundedCitations(draft, evidence);
      }
      if (this.sourceStore && groundingMode === "santo") {
        const sources = citations.map((citation) => {
          const matching = evidence.filter((item) => item.sourceId === citation.sourceId);
          if (matching.length !== 1) {
            throw new GroundedAiError(502, "CITATION_INVALID", "Ambiguous retrieved citation");
          }
          const item = matching[0]!;
          const parsed = TrustedSourceMetadataSchema.safeParse({
            sourceId: item.sourceId,
            libraryId: item.libraryId,
            instanceId: item.instanceId,
            itemKey: item.itemKey,
            title: item.title,
            page: item.page,
            section: item.section,
          });
          if (!parsed.success) {
            throw new GroundedAiError(502, "CITATION_INVALID", "Invalid source metadata");
          }
          return parsed.data;
        });
        try {
          await this.sourceStore.save(
            {
              tenantId: session.tenantId,
              externalUserId: session.externalUserId,
              messageId,
            },
            sources,
          );
        } catch {
          throw new GroundedAiError(
            503,
            "SOURCE_SNAPSHOT_FAILED",
            "Could not save verified sources",
          );
        }
      }
    } catch (error) {
      if (!alreadyFinalized) {
        await this.releaseAfterFailure(session, quotaIdempotencyKey, error);
      }
      const mapped = alreadyFinalized
        ? new GroundedAiError(
            503,
            "CHARGED_GENERATION_RETRY_FAILED",
            "A charged request could not be regenerated; retry with the same key",
          )
        : error instanceof GroundedAiError
          ? error
          : new GroundedAiError(502, "MODEL_FAILED", "Grounded AI request failed");
      this.recordFailure(requestId, session, startedAt, mapped.code);
      throw mapped;
    }

    let finalized;
    try {
      finalized = await this.quota.finalize({
        tenantId: session.tenantId,
        idempotencyKey: quotaIdempotencyKey,
      });
    } catch {
      const error = new GroundedAiError(
        503,
        "QUOTA_FINALIZE_FAILED",
        "Quota finalization failed; retry with the same idempotency key",
      );
      this.recordFailure(requestId, session, startedAt, error.code);
      throw error;
    }

    const remaining = Math.min(
      finalized.snapshot.tenant.remaining,
      finalized.snapshot.user.remaining,
    );
    this.telemetry.record({
      requestId,
      tenantId: session.tenantId,
      externalUserId: session.externalUserId,
      status: "success",
      latencyMs: Math.max(0, this.nowMs() - startedAt),
      errorCode: null,
    });

    return {
      requestId,
      messageId,
      answer,
      citations,
      ...(responseMode === "general" ? { groundingMode: "general" as const } : {}),
      usage: {
        unitsCharged: 1,
        remaining,
      },
    };
  }

  private async releaseAfterFailure(
    session: SessionContextResponse,
    idempotencyKey: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.quota.release({
        tenantId: session.tenantId,
        idempotencyKey,
      });
    } catch (releaseError) {
      if (
        releaseError instanceof QuotaServiceError &&
        releaseError.code === "RESERVATION_ALREADY_FINALIZED"
      ) {
        return;
      }

      throw new GroundedAiError(
        503,
        "QUOTA_RELEASE_FAILED",
        `Could not release quota after ${errorCode(originalError)}`,
      );
    }
  }

  private recordFailure(
    requestId: string,
    session: SessionContextResponse,
    startedAt: number,
    code: string,
  ): void {
    this.telemetry.record({
      requestId,
      tenantId: session.tenantId,
      externalUserId: session.externalUserId,
      status: "failure",
      latencyMs: Math.max(0, this.nowMs() - startedAt),
      errorCode: code,
    });
  }
}
