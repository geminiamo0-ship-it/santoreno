import type {
  QuotaConfigureRequest,
  QuotaFinalizeRequest,
  QuotaOperationResponse,
  QuotaReadRequest,
  QuotaReleaseRequest,
  QuotaReserveRequest,
  QuotaSnapshot,
} from "@santo/contracts";
import { describe, expect, it, vi } from "vitest";

import type { QuotaService } from "../quota/types";
import { CitationError } from "./citations";
import { ModelError } from "./model";
import { RetrievalError } from "./retrieval";
import { GroundedAiError, GroundedAiQueryService } from "./service";
import type { GroundedModel, GroundedRetrieval, RetrievedEvidence } from "./types";

const tenantId = "fca2b199-7e22-45cc-96ec-3b509e7f0d95";
const session = {
  tenantId,
  externalUserId: "58392",
  sessionId: "23bdd2c5-d1a1-4c79-9e9c-366545996f41",
  expiresAt: "2026-10-04T18:00:00.000Z",
};

function snapshot(used = 0, reserved = 0): QuotaSnapshot {
  return {
    tenantId,
    externalUserId: "58392",
    cycleStartAt: "2026-10-01T00:00:00.000Z",
    cycleEndAt: "2026-11-01T00:00:00.000Z",
    expiresAt: null,
    tenantStatus: "active",
    userStatus: "active",
    tenant: { limit: 100, used, reserved, remaining: 100 - used - reserved },
    user: { limit: 10, used, reserved, remaining: 10 - used - reserved },
  };
}

function operation(
  reservationStatus: QuotaOperationResponse["reservationStatus"],
  options: {
    allowed?: boolean;
    denialReason?: QuotaOperationResponse["denialReason"];
    used?: number;
    reserved?: number;
  } = {},
): QuotaOperationResponse {
  return {
    allowed: options.allowed ?? true,
    reservationStatus,
    denialReason: options.denialReason ?? null,
    snapshot: snapshot(options.used ?? 0, options.reserved ?? 0),
  };
}

function quotaService(overrides: Partial<QuotaService> = {}): QuotaService {
  return {
    async configure(_request: QuotaConfigureRequest) {
      return snapshot();
    },
    async read(_request: QuotaReadRequest) {
      return snapshot();
    },
    async reserve(_request: QuotaReserveRequest) {
      return operation("reserved", { reserved: 1 });
    },
    async finalize(_request: QuotaFinalizeRequest) {
      return operation("finalized", { used: 1 });
    },
    async release(_request: QuotaReleaseRequest) {
      return operation("released", { allowed: false, denialReason: "RESERVATION_RELEASED" });
    },
    ...overrides,
  };
}

const evidence: RetrievedEvidence[] = [
  {
    sourceId: "src_1",
    instanceId: "medical-guidelines",
    title: "Guideline",
    page: 42,
    score: 0.91,
    text: "Evidence supports the answer.",
    key: "guideline.pdf",
  },
];

function retrieval(result: RetrievedEvidence[] = evidence): GroundedRetrieval {
  return { retrieve: vi.fn(async () => result) };
}

function model(citationIds = ["src_1"]): GroundedModel {
  return {
    generate: vi.fn(async () => ({
      answer: "A grounded answer.",
      citation_ids: citationIds,
    })),
  };
}

function queryInput(idempotencyKey = "req-1") {
  return { session, question: "What does the evidence show?", idempotencyKey };
}

describe("GroundedAiQueryService", () => {
  it("reserves before expensive work, validates citations, and finalizes exactly one unit", async () => {
    const events: string[] = [];
    const quota = quotaService({
      async reserve() {
        events.push("reserve");
        return operation("reserved", { reserved: 1 });
      },
      async finalize() {
        events.push("finalize");
        return operation("finalized", { used: 1 });
      },
    });
    const retriever: GroundedRetrieval = {
      async retrieve() {
        events.push("search");
        return evidence;
      },
    };
    const generator: GroundedModel = {
      async generate() {
        events.push("model");
        return { answer: "A grounded answer.", citation_ids: ["src_1"] };
      },
    };
    const ids = ["32dc0f35-78aa-4ee8-a245-9abb8b827ee0", "46014ad1-f5bc-4cd2-8317-24a26b0f4d48"];
    const service = new GroundedAiQueryService(quota, retriever, generator, () => ids.shift()!);

    const result = await service.query(queryInput());

    expect(events).toEqual(["reserve", "search", "model", "finalize"]);
    expect(result).toMatchObject({
      answer: "A grounded answer.",
      citations: [{ sourceId: "src_1", title: "Guideline", page: 42 }],
      usage: { unitsCharged: 1, remaining: 9 },
    });
  });

  it("denies exhausted quota before search or model work", async () => {
    const retriever = retrieval();
    const generator = model();
    const quota = quotaService({
      async reserve() {
        return operation("denied", {
          allowed: false,
          denialReason: "USER_EXHAUSTED",
          used: 10,
        });
      },
    });
    const service = new GroundedAiQueryService(quota, retriever, generator);

    await expect(service.query(queryInput())).rejects.toMatchObject<Partial<GroundedAiError>>({
      status: 429,
      code: "USER_EXHAUSTED",
    });
    expect(retriever.retrieve).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("releases reserved quota when retrieval returns no evidence", async () => {
    const release = vi.fn(async () =>
      operation("released", { allowed: false, denialReason: "RESERVATION_RELEASED" }),
    );
    const generator = model();
    const service = new GroundedAiQueryService(quotaService({ release }), retrieval([]), generator);

    await expect(service.query(queryInput())).rejects.toMatchObject<Partial<GroundedAiError>>({
      status: 422,
      code: "INSUFFICIENT_EVIDENCE",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("releases on search, model, and citation hard failures", async () => {
    for (const failure of ["search", "model", "citation"] as const) {
      const release = vi.fn(async () =>
        operation("released", { allowed: false, denialReason: "RESERVATION_RELEASED" }),
      );
      const retriever: GroundedRetrieval =
        failure === "search"
          ? {
              async retrieve() {
                throw new RetrievalError("SEARCH_FAILED", "search failed");
              },
            }
          : retrieval();
      const generator: GroundedModel =
        failure === "model"
          ? {
              async generate() {
                throw new ModelError("MODEL_FAILED", "model failed");
              },
            }
          : failure === "citation"
            ? model(["src_not_retrieved"])
            : model();
      const service = new GroundedAiQueryService(quotaService({ release }), retriever, generator);

      await expect(service.query(queryInput(`req-${failure}`))).rejects.toBeInstanceOf(
        GroundedAiError,
      );
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it("never releases after an uncertain finalize failure", async () => {
    const release = vi.fn(async () => operation("released"));
    const quota = quotaService({
      release,
      async finalize() {
        throw new Error("response lost");
      },
    });
    const service = new GroundedAiQueryService(quota, retrieval(), model());

    await expect(service.query(queryInput())).rejects.toMatchObject<Partial<GroundedAiError>>({
      status: 503,
      code: "QUOTA_FINALIZE_FAILED",
    });
    expect(release).not.toHaveBeenCalled();
  });

  it("reusing an idempotency key cannot double-charge", async () => {
    let charged = false;
    let chargeCount = 0;
    const quota = quotaService({
      async reserve() {
        return charged
          ? operation("finalized", { used: 1 })
          : operation("reserved", { reserved: 1 });
      },
      async finalize() {
        if (!charged) {
          charged = true;
          chargeCount += 1;
        }
        return operation("finalized", { used: 1 });
      },
    });
    const service = new GroundedAiQueryService(quota, retrieval(), model());

    await service.query(queryInput("same-request"));
    await service.query(queryInput("same-request"));

    expect(chargeCount).toBe(1);
  });

  it("exports stable typed failure classes for adapter boundaries", () => {
    expect(new RetrievalError("SEARCH_FAILED", "x").code).toBe("SEARCH_FAILED");
    expect(new ModelError("MODEL_FAILED", "x").code).toBe("MODEL_FAILED");
    expect(new CitationError("CITATION_INVALID", "x").code).toBe("CITATION_INVALID");
  });
});
