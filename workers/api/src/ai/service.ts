import type { SessionContextResponse } from "@santo/contracts";
import type { GroundedAiQueryRequest, GroundedAiQueryResponse } from "@santo/contracts/ai";

import { QuotaServiceError } from "../quota/service";
import type { QuotaService } from "../quota/types";
import { validateGroundedCitations } from "./citations";
import { GroundedAiError } from "./errors";
import { buildGroundedPrompt } from "./prompt";
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
  ) {}

  async query(
    session: SessionContextResponse,
    input: GroundedAiQueryRequest,
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
    try {
      const evidence = await this.retrieval.retrieve({ query: input.query, libraryId });
      if (evidence.length === 0) {
        throw new GroundedAiError(
          422,
          "INSUFFICIENT_EVIDENCE",
          "No sufficient Santo evidence was retrieved",
        );
      }

      const draft = await this.model.generate(buildGroundedPrompt(input.query, evidence));
      if (draft.answer === "INSUFFICIENT_EVIDENCE") {
        throw new GroundedAiError(
          422,
          "INSUFFICIENT_EVIDENCE",
          "Retrieved evidence was insufficient for a grounded answer",
        );
      }

      answer = draft.answer;
      citations = validateGroundedCitations(draft, evidence);
    } catch (error) {
      if (!alreadyFinalized) {
        await this.releaseAfterFailure(session, quotaIdempotencyKey, error);
      }
      const mapped =
        error instanceof GroundedAiError
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
