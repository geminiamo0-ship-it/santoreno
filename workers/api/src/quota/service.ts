import {
  ApiErrorResponseSchema,
  QuotaOperationResponseSchema,
  QuotaSnapshotSchema,
  type QuotaConfigureRequest,
  type QuotaFinalizeRequest,
  type QuotaOperationResponse,
  type QuotaReadRequest,
  type QuotaReleaseRequest,
  type QuotaReserveRequest,
  type QuotaSnapshot,
} from "@santo/contracts";

import type { DurableObjectNamespaceLike, DurableObjectStubLike } from "../runtime/bindings";
import type { QuotaService } from "./types";

export class QuotaServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuotaServiceError";
  }
}

function requestFor(path: string, body: unknown): Request {
  return new Request(`https://santo.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export class DurableObjectQuotaService implements QuotaService {
  constructor(private readonly namespace: DurableObjectNamespaceLike) {}

  private stub(tenantId: string): DurableObjectStubLike {
    return this.namespace.get(this.namespace.idFromName(tenantId));
  }

  private async call<T>(
    tenantId: string,
    path: string,
    body: unknown,
    parse: (input: unknown) => T,
  ): Promise<T> {
    const response = await this.stub(tenantId).fetch(requestFor(path, body));
    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(payload);
      const code = parsed.success ? parsed.data.error : "QUOTA_OPERATION_FAILED";
      throw new QuotaServiceError(response.status, code, `Quota operation failed: ${code}`);
    }

    return parse(payload);
  }

  configure(request: QuotaConfigureRequest): Promise<QuotaSnapshot> {
    return this.call(request.tenantId, "/configure", request, (payload) =>
      QuotaSnapshotSchema.parse(payload),
    );
  }

  read(request: QuotaReadRequest): Promise<QuotaSnapshot> {
    return this.call(request.tenantId, "/state", request, (payload) =>
      QuotaSnapshotSchema.parse(payload),
    );
  }

  reserve(request: QuotaReserveRequest): Promise<QuotaOperationResponse> {
    return this.call(request.tenantId, "/reserve", request, (payload) =>
      QuotaOperationResponseSchema.parse(payload),
    );
  }

  finalize(request: QuotaFinalizeRequest): Promise<QuotaOperationResponse> {
    return this.call(request.tenantId, "/finalize", request, (payload) =>
      QuotaOperationResponseSchema.parse(payload),
    );
  }

  release(request: QuotaReleaseRequest): Promise<QuotaOperationResponse> {
    return this.call(request.tenantId, "/release", request, (payload) =>
      QuotaOperationResponseSchema.parse(payload),
    );
  }
}
