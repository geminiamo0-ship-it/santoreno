import { handleGroundedAiQuery } from "./ai/handler";
import { app } from "./app";
import { handleP33GlobalSearchAcceptance } from "./infrastructure/p33-global-search-acceptance";
import { handleP5QuotaAcceptance } from "./infrastructure/p5-quota-acceptance";
import { handleP6GroundedAiAcceptance } from "./infrastructure/p6-grounded-ai-acceptance";
import { handleInfrastructureQueue } from "./infrastructure/queue";
import type { SantoBindings } from "./runtime/bindings";

export { ConversationDO } from "./durable-objects/conversation";
export { TenantMeterDO } from "./durable-objects/tenant-meter";

const fetch: typeof app.fetch = async (request, env, executionContext) => {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/__infra/p5-quota-acceptance") {
    return handleP5QuotaAcceptance(request, env as SantoBindings);
  }
  if (url.pathname.startsWith("/__infra/p6-grounded-ai-acceptance")) {
    return handleP6GroundedAiAcceptance(request, env as SantoBindings);
  }
  if (url.pathname.startsWith("/__infra/p33-global-search-acceptance")) {
    return handleP33GlobalSearchAcceptance(request, env as SantoBindings);
  }
  if (url.pathname === "/v1/ai/query") {
    return handleGroundedAiQuery(request, env as SantoBindings);
  }
  return app.fetch(request, env, executionContext);
};

export default {
  fetch,
  queue: handleInfrastructureQueue,
};
