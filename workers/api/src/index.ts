import { app } from "./app";
import { handleInfrastructureQueue } from "./infrastructure/queue";

export { ConversationDO } from "./durable-objects/conversation";
export { TenantMeterDO } from "./durable-objects/tenant-meter";

export default {
  fetch: app.fetch,
  queue: handleInfrastructureQueue,
};
