import type {
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  SantoBindings,
} from "../runtime/bindings";

interface OperationBody {
  allowed?: boolean;
  reservationStatus?: string;
  denialReason?: string | null;
  snapshot?: {
    cycleStartAt?: string;
    tenant?: { used?: number; reserved?: number; remaining?: number };
    user?: { used?: number; reserved?: number; remaining?: number };
  };
  error?: string;
}

interface CallResult {
  status: number;
  body: OperationBody;
}

const USER = "p5-acceptance-user";
const TENANTS = {
  race: "11111111-1111-4111-8111-111111111111",
  release: "22222222-2222-4222-8222-222222222222",
  cap: "33333333-3333-4333-8333-333333333333",
  suspended: "44444444-4444-4444-8444-444444444444",
  expired: "55555555-5555-4555-8555-555555555555",
  isolationA: "66666666-6666-4666-8666-666666666666",
  isolationB: "77777777-7777-4777-8777-777777777777",
  cycle: "88888888-8888-4888-8888-888888888888",
} as const;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stubFor(namespace: DurableObjectNamespaceLike, tenantId: string): DurableObjectStubLike {
  return namespace.get(namespace.idFromName(tenantId));
}

async function call(stub: DurableObjectStubLike, path: string, body: unknown): Promise<CallResult> {
  const response = await stub.fetch(
    new Request(`https://santo.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const payload = (await response.json()) as OperationBody;
  return { status: response.status, body: payload };
}

async function configure(
  stub: DurableObjectStubLike,
  tenantId: string,
  options: {
    tenantStatus?: "active" | "suspended";
    userStatus?: "active" | "suspended";
    tenantLimit: number;
    userLimit: number;
    bonus?: number;
    expiresAt?: string | null;
    cycleStartAt?: string;
    cycleEndAt?: string;
  },
): Promise<void> {
  const now = Date.now();
  const result = await call(stub, "/configure", {
    tenantId,
    tenantStatus: options.tenantStatus ?? "active",
    monthlyAllowance: options.tenantLimit,
    cycleStartAt: options.cycleStartAt ?? new Date(now - 1_000).toISOString(),
    cycleEndAt: options.cycleEndAt ?? new Date(now + 3_600_000).toISOString(),
    user: {
      externalUserId: USER,
      status: options.userStatus ?? "active",
      baseQuota: options.userLimit,
      bonusQuota: options.bonus ?? 0,
      expiresAt: options.expiresAt ?? null,
    },
  });
  expect(result.status === 200, `Quota configure failed with HTTP ${result.status}`);
}

async function reserve(
  stub: DurableObjectStubLike,
  tenantId: string,
  idempotencyKey: string,
  units = 1,
): Promise<CallResult> {
  return call(stub, "/reserve", {
    tenantId,
    externalUserId: USER,
    idempotencyKey,
    units,
  });
}

async function verifyRace(namespace: DurableObjectNamespaceLike) {
  const tenantId = TENANTS.race;
  const stub = stubFor(namespace, tenantId);
  await configure(stub, tenantId, { tenantLimit: 1, userLimit: 1 });

  const keys = Array.from({ length: 100 }, () => crypto.randomUUID());
  const results = await Promise.all(keys.map((key) => reserve(stub, tenantId, key)));
  const allowedIndexes = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === 200 && result.body.allowed === true);
  const denied = results.filter((result) => result.status === 200 && result.body.allowed === false);
  expect(
    allowedIndexes.length === 1,
    `Expected 1 allowed reservation, got ${allowedIndexes.length}`,
  );
  expect(denied.length === 99, `Expected 99 denied reservations, got ${denied.length}`);
  expect(
    denied.every((result) => result.body.denialReason === "TENANT_EXHAUSTED"),
    "Race denials were not consistently TENANT_EXHAUSTED",
  );

  const winnerKey = keys[allowedIndexes[0]!.index]!;
  const replay = await reserve(stub, tenantId, winnerKey);
  expect(replay.body.allowed === true, "Reserve replay was not idempotently allowed");
  expect(
    replay.body.snapshot?.tenant?.reserved === 1,
    "Reserve replay double-reserved tenant quota",
  );
  expect(replay.body.snapshot?.user?.reserved === 1, "Reserve replay double-reserved user quota");

  const conflict = await reserve(stub, tenantId, winnerKey, 2);
  expect(
    conflict.status === 409 && conflict.body.error === "IDEMPOTENCY_CONFLICT",
    "Idempotency key conflict was not rejected",
  );

  const finalized = await call(stub, "/finalize", { tenantId, idempotencyKey: winnerKey });
  expect(finalized.status === 200, "Winning reservation did not finalize");
  expect(
    finalized.body.snapshot?.tenant?.used === 1,
    "Finalize did not charge tenant exactly once",
  );
  expect(finalized.body.snapshot?.user?.used === 1, "Finalize did not charge user exactly once");
  expect(finalized.body.snapshot?.tenant?.reserved === 0, "Finalize left tenant reservation open");

  const finalizeReplay = await call(stub, "/finalize", { tenantId, idempotencyKey: winnerKey });
  expect(finalizeReplay.status === 200, "Finalize replay was not idempotent");
  expect(finalizeReplay.body.snapshot?.tenant?.used === 1, "Finalize replay double-charged tenant");
  expect(finalizeReplay.body.snapshot?.user?.used === 1, "Finalize replay double-charged user");

  const refundFinalized = await call(stub, "/release", { tenantId, idempotencyKey: winnerKey });
  expect(
    refundFinalized.status === 409 &&
      refundFinalized.body.error === "RESERVATION_ALREADY_FINALIZED",
    "Finalized reservation was refundable through replay",
  );

  return { allowed: allowedIndexes.length, denied: denied.length };
}

async function verifyRelease(namespace: DurableObjectNamespaceLike) {
  const tenantId = TENANTS.release;
  const stub = stubFor(namespace, tenantId);
  await configure(stub, tenantId, { tenantLimit: 2, userLimit: 2 });
  const key = crypto.randomUUID();

  const first = await reserve(stub, tenantId, key);
  expect(first.body.allowed === true, "Release scenario could not reserve quota");
  const released = await call(stub, "/release", { tenantId, idempotencyKey: key });
  expect(released.status === 200, "Reservation release failed");
  expect(
    released.body.snapshot?.tenant?.remaining === 2,
    "Release did not restore tenant capacity",
  );
  expect(released.body.snapshot?.user?.remaining === 2, "Release did not restore user capacity");

  const replay = await call(stub, "/release", { tenantId, idempotencyKey: key });
  expect(replay.status === 200, "Release replay was not idempotent");
  expect(
    replay.body.snapshot?.tenant?.remaining === 2,
    "Release replay over-refunded tenant capacity",
  );
  expect(replay.body.snapshot?.user?.remaining === 2, "Release replay over-refunded user capacity");

  return { remaining: replay.body.snapshot?.tenant?.remaining ?? -1 };
}

async function verifyTenantCap(namespace: DurableObjectNamespaceLike) {
  const tenantId = TENANTS.cap;
  const stub = stubFor(namespace, tenantId);
  await configure(stub, tenantId, { tenantLimit: 1, userLimit: 100, bonus: 100 });

  const first = await reserve(stub, tenantId, crypto.randomUUID());
  const second = await reserve(stub, tenantId, crypto.randomUUID());
  expect(first.body.allowed === true, "Tenant-cap scenario first reservation failed");
  expect(
    second.body.allowed === false && second.body.denialReason === "TENANT_EXHAUSTED",
    "Oversized user quota bypassed tenant allowance",
  );
  return { denialReason: second.body.denialReason };
}

async function verifySuspensionAndExpiry(namespace: DurableObjectNamespaceLike) {
  const tenantId = TENANTS.suspended;
  const stub = stubFor(namespace, tenantId);
  await configure(stub, tenantId, {
    tenantLimit: 10,
    userLimit: 10,
    tenantStatus: "suspended",
  });
  const tenantDenied = await reserve(stub, tenantId, crypto.randomUUID());
  expect(tenantDenied.body.denialReason === "TENANT_SUSPENDED", "Suspended tenant was not denied");

  await configure(stub, tenantId, {
    tenantLimit: 10,
    userLimit: 10,
    tenantStatus: "active",
    userStatus: "suspended",
  });
  const userDenied = await reserve(stub, tenantId, crypto.randomUUID());
  expect(userDenied.body.denialReason === "USER_SUSPENDED", "Suspended user was not denied");

  const expiredTenantId = TENANTS.expired;
  const expiredStub = stubFor(namespace, expiredTenantId);
  await configure(expiredStub, expiredTenantId, {
    tenantLimit: 10,
    userLimit: 10,
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const expired = await reserve(expiredStub, expiredTenantId, crypto.randomUUID());
  expect(expired.body.denialReason === "QUOTA_EXPIRED", "Expired quota was not denied");

  return {
    tenant: tenantDenied.body.denialReason,
    user: userDenied.body.denialReason,
    expired: expired.body.denialReason,
  };
}

async function verifyIsolation(namespace: DurableObjectNamespaceLike) {
  const a = TENANTS.isolationA;
  const b = TENANTS.isolationB;
  const stubA = stubFor(namespace, a);
  const stubB = stubFor(namespace, b);
  await configure(stubA, a, { tenantLimit: 1, userLimit: 1 });
  await configure(stubB, b, { tenantLimit: 1, userLimit: 1 });

  const reservedA = await reserve(stubA, a, crypto.randomUUID());
  expect(reservedA.body.allowed === true, "Isolation tenant A reservation failed");
  const stateB = await call(stubB, "/state", { tenantId: b, externalUserId: USER });
  expect(
    stateB.body.snapshot?.tenant?.remaining === undefined,
    "Unexpected operation envelope on state read",
  );
  const rawStateB = stateB.body as OperationBody & {
    tenant?: { remaining?: number };
    user?: { remaining?: number };
  };
  expect(rawStateB.tenant?.remaining === 1, "Tenant A quota mutation leaked into tenant B");
  expect(rawStateB.user?.remaining === 1, "Tenant A user quota mutation leaked into tenant B");

  return { isolated: true };
}

async function verifyCycleReset(namespace: DurableObjectNamespaceLike) {
  const tenantId = TENANTS.cycle;
  const stub = stubFor(namespace, tenantId);
  const now = Date.now();
  const start = new Date(now - 7_200_000).toISOString();
  const end = new Date(now - 3_600_000).toISOString();
  await configure(stub, tenantId, {
    tenantLimit: 1,
    userLimit: 1,
    cycleStartAt: start,
    cycleEndAt: end,
  });

  const state = await call(stub, "/state", { tenantId, externalUserId: USER });
  const raw = state.body as OperationBody & { cycleStartAt?: string };
  expect(state.status === 200, "Cycle state read failed");
  expect(raw.cycleStartAt !== start, "Expired quota cycle did not advance");
  return { advanced: true };
}

export async function handleP5QuotaAcceptance(
  request: Request,
  env: SantoBindings,
): Promise<Response> {
  if (env.SANTO_ENV === "production") {
    return new Response("Not Found", { status: 404 });
  }
  const expectedToken = env.INFRA_SMOKE_TOKEN;
  const providedToken = request.headers.get("x-santo-infra-smoke-token");
  if (!expectedToken || providedToken !== expectedToken) {
    return new Response("Not Found", { status: 404 });
  }
  if (!env.TENANT_METER) {
    return Response.json(
      { status: "failed", error: "TENANT_METER_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  try {
    const race = await verifyRace(env.TENANT_METER);
    const release = await verifyRelease(env.TENANT_METER);
    const tenantCap = await verifyTenantCap(env.TENANT_METER);
    const suspension = await verifySuspensionAndExpiry(env.TENANT_METER);
    const isolation = await verifyIsolation(env.TENANT_METER);
    const cycleReset = await verifyCycleReset(env.TENANT_METER);

    return Response.json({
      status: "passed",
      race,
      idempotency: { reserveReplay: true, finalizeReplay: true, conflictDenied: true },
      release,
      tenantCap,
      suspension,
      isolation,
      cycleReset,
    });
  } catch (error) {
    console.error("P5 quota acceptance failed", error instanceof Error ? error.message : "unknown");
    return Response.json({ status: "failed" }, { status: 500 });
  }
}
