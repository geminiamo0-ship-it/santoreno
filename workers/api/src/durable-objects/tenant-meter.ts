import { QuotaStateError, TenantMeterCore, type DurableObjectStorageLike } from "./tenant-meter-core";

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof QuotaStateError) {
    return json({ error: error.code }, error.status);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return json({ error: "INVALID_QUOTA_REQUEST" }, 400);
  }
  throw error;
}

export class TenantMeterDO {
  private readonly core: TenantMeterCore;

  constructor(state: DurableObjectStateLike) {
    this.core = new TenantMeterCore(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        service: "tenant-meter-do",
        status: "ok",
        storage: "sqlite",
      });
    }

    try {
      if (request.method === "POST" && url.pathname === "/configure") {
        return json(this.core.configure(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/state") {
        return json(this.core.read(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/reserve") {
        return json(this.core.reserve(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/finalize") {
        return json(this.core.finalize(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/release") {
        return json(this.core.release(await request.json()));
      }
      return json({ error: "NOT_FOUND" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }
}
