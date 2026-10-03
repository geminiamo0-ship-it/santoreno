export class TenantMeterDO {
  fetch(): Response {
    return Response.json({
      service: "tenant-meter-do",
      status: "ok",
      storage: "sqlite",
    });
  }
}
