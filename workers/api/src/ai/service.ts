import { GroundedAiQueryResponseSchema } from "@santo/contracts";

import type { QuotaService } from "../quota/types";
import { CitationError, validateCitations } from "./citations";
import { ModelError } from "./model";
import { RetrievalError } from "./retrieval";
import type {
  GroundedAiQueryInput,
  GroundedAiResult,
  GroundedModel,
  GroundedRetrieval,
} from "./types";

export class GroundedAiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GroundedAiError";
  }
}

function quotaDenialStatus(reason: string | null): number {
  if (reason === "TENANT_EXHAUSTED" || reason === "USER_EXHAUSTED") {
    return 429;
  }
  if (reason === "TENANT_SUSPENDED" || reason === "USER_SUSPENDED" || reason === "QUOTA_EXPIRED") {
    return 403;
  }
  return 409;
}

export class GroundedAiQueryService {
  constructor(
    private readonly quota: QuotaService,
    private readonly retrieval: GroundedRetrieval,
    private readonly model: GroundedModel,
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {}

  private async releaseReservation(tenantId: string, idempotencyKey: string): Promise<void> {
    try {
      await this.quota.release({ tenantId, idempotencyKey });
    } catch {
      throw new GroundedAiError(
        503,
        "QUOTA_RELEASE_FAILED",
        "Reserved quota could not be released safely",
      );
    }
  }

  async query(input: GroundedAiQueryInput): Promise<GroundedAiResult> {
    let reservation;
    try {
      reservation = await this.quota.reserve({
        tenantId: input.session.tenantId,
        externalUserId: input.session.externalUserId,
        idempotencyKey: input.idempotencyKey,
        units: 1,
      });
    } catch {
      throw new GroundedAiError(503, "QUOTA_RESERVE_FAILED", "Quota reservation failed");
    }

    if (!reservation.allowed) {
      throw new GroundedAiError(
        quotaDenialStatus(reservation.denialReason),
        reservation.denialReason ?? "QUOTA_DENIED",
        "Quota reservation was denied",
      );
    }

    let evidence;
    try {
      evidence = await this.retrieval.retrieve(input.question);
    } catch (error) {
      await this.releaseReservation(input.session.tenantId, input.idempotencyKey);
      if (error instanceof RetrievalError) {
        throw new GroundedAiError(502, error.code, error.message);
      }
      throw new GroundedAiError(502, "SEARCH_FAILED", "AI Search failed");
    }

    if (evidence.length === 0) {
      await this.releaseReservation(input.session.tenantId, input.idempotencyKey);
      throw new GroundedAiError(
        422,
        "INSUFFICIENT_EVIDENCE",
        "No retrieved evidence supports a grounded medical answer",
      );
    }

    let modelOutput;
    try {
      modelOutput = await this.model.generate({ question: input.question, evidence });
    } catch (error) {
      await this.releaseReservation(input.session.tenantId, input.idempotencyKey);
      if (error instanceof ModelError) {
        throw new GroundedAiError(502, error.code, error.message);
      }
      throw new GroundedAiError(502, "MODEL_FAILED", "Model generation failed");
    }

    let citations;
    try {
      citations = validateCitations(modelOutput, evidence);
    } catch (error) {
      await this.releaseReservation(input.session.tenantId, input.idempotencyKey);
      if (error instanceof CitationError) {
        throw new GroundedAiError(502, error.code, error.message);
      }
      throw error;
    }

    let finalized;
    try {
      finalized = await this.quota.finalize({
        tenantId: input.session.tenantId,
        idempotencyKey: input.idempotencyKey,
      });
    } catch {
      // Never release here: finalize may have committed even if its response was lost.
      throw new GroundedAiError(
        503,
        "QUOTA_FINALIZE_FAILED",
        "Grounded answer completed but quota finalization could not be confirmed",
      );
    }

    if (!finalized.allowed || finalized.reservationStatus !== "finalized") {
      throw new GroundedAiError(
        503,
        "QUOTA_FINALIZE_FAILED",
        "Quota reservation did not reach finalized state",
      );
    }

    return GroundedAiQueryResponseSchema.parse({
      requestId: this.uuid(),
      messageId: this.uuid(),
      answer: modelOutput.answer,
      citations,
      usage: {
        unitsCharged: 1,
        remaining: Math.min(finalized.snapshot.tenant.remaining, finalized.snapshot.user.remaining),
      },
    });
  }
}
