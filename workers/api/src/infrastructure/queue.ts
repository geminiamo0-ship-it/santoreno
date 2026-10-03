import { InfraSmokeQueueEventSchema } from "@santo/contracts";

import type { QueueBatchLike, SantoBindings } from "../runtime/bindings";

export async function handleInfrastructureQueue(
  batch: QueueBatchLike,
  env: SantoBindings,
): Promise<void> {
  for (const message of batch.messages) {
    const event = InfraSmokeQueueEventSchema.safeParse(message.body);

    if (!event.success) {
      message.ack();
      continue;
    }

    if (!env.CONTROL_DB) {
      message.retry();
      continue;
    }

    try {
      await env.CONTROL_DB.prepare(
        `INSERT INTO infra_smoke_events (event_id, processed_at)
         VALUES (?, ?)
         ON CONFLICT(event_id) DO UPDATE SET processed_at = excluded.processed_at`,
      )
        .bind(event.data.eventId, new Date().toISOString())
        .run();
      message.ack();
    } catch {
      message.retry();
    }
  }
}
