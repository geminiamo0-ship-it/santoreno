# Quota boundary

`TenantMeterDO` is the single authoritative hot-path quota implementation for Santo.

HTTP handlers and future AI services must call the tenant-scoped Durable Object through a narrow client/service boundary. They must not duplicate quota counters or reservation logic in D1, browser code, or route handlers.
