import type { AnalyticsEngineDatasetLike } from "../runtime/bindings";
import type { AiTelemetryEvent, AiTelemetryPort } from "./types";

export class AnalyticsEngineAiTelemetry implements AiTelemetryPort {
  constructor(private readonly dataset: AnalyticsEngineDatasetLike | undefined) {}

  record(event: AiTelemetryEvent): void {
    if (!this.dataset) {
      return;
    }

    try {
      this.dataset.writeDataPoint({
        blobs: [
          "ai.query",
          event.status,
          event.tenantId,
          event.externalUserId,
          event.requestId,
          event.errorCode ?? "",
        ],
        doubles: [event.latencyMs],
        indexes: [event.tenantId],
      });
    } catch {
      // Telemetry must never change request charging or response behavior.
    }
  }
}
