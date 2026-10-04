import type {
  QuotaConfigureRequest,
  QuotaFinalizeRequest,
  QuotaOperationResponse,
  QuotaReadRequest,
  QuotaReleaseRequest,
  QuotaReserveRequest,
  QuotaSnapshot,
} from "@santo/contracts";

export interface QuotaService {
  configure(request: QuotaConfigureRequest): Promise<QuotaSnapshot>;
  read(request: QuotaReadRequest): Promise<QuotaSnapshot>;
  reserve(request: QuotaReserveRequest): Promise<QuotaOperationResponse>;
  finalize(request: QuotaFinalizeRequest): Promise<QuotaOperationResponse>;
  release(request: QuotaReleaseRequest): Promise<QuotaOperationResponse>;
}
