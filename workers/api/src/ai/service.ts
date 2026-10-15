import type { SessionContextResponse } from "@santo/contracts";
import type { GroundedAiQueryRequest, GroundedAiQueryResponse } from "@santo/contracts/ai";
import { TrustedSourceMetadataSchema } from "@santo/contracts/source";

import { QuotaServiceError } from "../quota/service";
import type { QuotaService } from "../quota/types";
import type { SourceSnapshotWriter } from "../sources/store";
import { validateGroundedCitations } from "./citations";
import { AI_STAGE_TIMEOUTS, withAiDeadline } from "./deadline";
import { GroundedAiError } from "./errors";
import { buildGeneralMedicalPrompt, buildGroundedPrompt } from "./prompt";
import type { AiTelemetryEvent, AiTelemetryPort, ModelPort, RetrievalPort } from "./types";

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

function failureStage(code: string): string {
  if (code.startsWith("MODEL_")) return "model_output";
  if (code.startsWith("CITATION_")) return "source_validation";
  if (code.startsWith("SEARCH_")) return "retrieval";
  if (code === "SOURCE_SNAPSHOT_FAILED") return "source_snapshot";
  if (code.startsWith("QUOTA_")) return "quota";
  return "request";
}

async function deriveQuotaIdempotencyKey(
  externalUserId: string,
  clientKey: string,
  query: string,
  libraryId: string | null,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${externalUserId}\u0000${clientKey}\u0000${libraryId ?? ""}\u0000${query}`,
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
    private readonly singlePassGeneration = false,
    private readonly markdownOutput = false,
  ) {}

  async query(
    session: SessionContextResponse,
    input: GroundedAiQueryRequest,
    signal?: AbortSignal,
    onProvisionalAnswer?: (text: string) => void,
  ): Promise<GroundedAiQueryResponse> {
    const startedAt = this.nowMs();
    const requestId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const libraryId = input.library_id ?? null;
    const quotaIdempotencyKey = await deriveQuotaIdempotencyKey(
      session.externalUserId,
      input.idempotency_key,
      input.query,
      libraryId,
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
    let citationMode: "related" | undefined;
    let retrievedSourceCount = 0;
    let validCitationCount = 0;
    let outputChars = 0;
    try {
      const evidence = await withAiDeadline(
        () => this.retrieval.retrieve({ query: input.query, libraryId }),
        signal,
        this.timeouts.retrievalMs,
        "SEARCH_TIMEOUT",
      );
      retrievedSourceCount = evidence.length;
      // A genuinely empty result is different from SEARCH_FAILED / SEARCH_TIMEOUT:
      // infrastructure outages still fail closed, never silently become "general".
      let groundingMode: "santo" | "general" = "santo";
      if (evidence.length === 0 && !this.generalFallbackEnabled) {
        throw new GroundedAiError(
          422,
          "INSUFFICIENT_EVIDENCE",
          "No sufficient Santo evidence was retrieved",
        );
      }
      if (evidence.length === 0) groundingMode = "general";
      const answerFormat = this.markdownOutput ? "markdown" : "json";
      let draft = await withAiDeadline(
        () =>
          this.model.generate(
            groundingMode === "general"
              ? buildGeneralMedicalPrompt(input.query, answerFormat)
              : buildGroundedPrompt(input.query, evidence, answerFormat),
            onProvisionalAnswer,
            groundingMode === "general" ? [] : evidence.map((item) => item.sourceId),
          ),
        signal,
        this.timeouts.modelMs,
        "MODEL_TIMEOUT",
      );

      // Legacy fallback can create a SECOND paid generation after a complete
      // grounded model response. The staging single-pass cost policy disables
      // that retry; a refusal becomes a clear 422 error (quota released), not
      // another silent provider call. Empty retrieval is handled *before*
      // generation and can still use one general-mode call.
      if (
        draft.answer === "INSUFFICIENT_EVIDENCE" &&
        groundingMode === "santo" &&
        this.generalFallbackEnabled &&
        !this.singlePassGeneration
      ) {
        groundingMode = "general";
        // Withdraw the previous grounded draft before changing its source policy.
        onProvisionalAnswer?.("");
        draft = await withAiDeadline(
          () =>
            this.model.generate(buildGeneralMedicalPrompt(input.query), onProvisionalAnswer, []),
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
      outputChars = answer.length;
      responseMode = groundingMode;
      // A complete Luna clarification/social answer has no medical claim to
      // cite. Never attach unrelated retrieval passages to it.
      if (this.markdownOutput && draft.sourcePresentation === "none") {
        responseMode = "general";
      }
      if (responseMode === "general") {
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
        // Missing/invalid model markers do not erase a completed teaching answer.
        // Only existing retrieved evidence is included, as a separately labeled
        // related-article list rather than invented inline provenance.
        const selected =
          this.markdownOutput && draft.sourcePresentation === "related"
            ? { ...draft, citationIds: evidence.slice(0, 5).map((item) => item.sourceId) }
            : draft;
        citations = validateGroundedCitations(selected, evidence);
        if (selected !== draft) citationMode = "related";
      }
      validCitationCount = citations.length;
      if (this.sourceStore && responseMode === "santo") {
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
      this.recordFailure(requestId, session, startedAt, mapped.code, {
        failureStage: failureStage(mapped.code),
        responseFormat: this.markdownOutput ? "markdown" : "json",
        retrievedSourceCount,
        validCitationCount,
        outputChars,
      });
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
      responseFormat: this.markdownOutput ? "markdown" : "json",
      retrievedSourceCount,
      validCitationCount,
      outputChars,
      sourcePresentation: citationMode ?? "inline",
    });

    return {
      requestId,
      messageId,
      answer,
      citations,
      ...(citationMode ? { citationMode } : {}),
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
    diagnostic: Partial<AiTelemetryEvent> = {},
  ): void {
    this.telemetry.record({
      requestId,
      tenantId: session.tenantId,
      externalUserId: session.externalUserId,
      status: "failure",
      latencyMs: Math.max(0, this.nowMs() - startedAt),
      errorCode: code,
      ...diagnostic,
    });
  }
}
