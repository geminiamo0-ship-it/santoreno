import {
  QuotaConfigureRequestSchema,
  QuotaFinalizeRequestSchema,
  QuotaOperationResponseSchema,
  QuotaReadRequestSchema,
  QuotaReleaseRequestSchema,
  QuotaReserveRequestSchema,
  QuotaSnapshotSchema,
  type QuotaConfigureRequest,
  type QuotaDenialReason,
  type QuotaOperationResponse,
  type QuotaReservationStatus,
  type QuotaSnapshot,
} from "@santo/contracts";

interface SqlCursorLike<T> {
  toArray(): T[];
}

export interface SqlStorageLike {
  exec<T>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
}

export interface DurableObjectStorageLike {
  sql: SqlStorageLike;
  transactionSync<T>(callback: () => T): T;
}

interface TenantStateRow {
  tenant_id: string;
  status: "active" | "suspended";
  monthly_allowance: number;
  used_units: number;
  reserved_units: number;
  cycle_start_ms: number;
  cycle_end_ms: number;
}

interface UserQuotaRow {
  external_user_id: string;
  status: "active" | "suspended";
  base_quota: number;
  bonus_quota: number;
  used_units: number;
  reserved_units: number;
  expires_at_ms: number | null;
  cycle_start_ms: number;
}

interface ReservationRow {
  idempotency_key: string;
  external_user_id: string;
  units: number;
  status: QuotaReservationStatus;
  denial_reason: QuotaDenialReason | null;
}

export class QuotaStateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuotaStateError";
  }
}

const schema = `
CREATE TABLE IF NOT EXISTS tenant_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  tenant_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  monthly_allowance INTEGER NOT NULL CHECK (monthly_allowance >= 0),
  used_units INTEGER NOT NULL DEFAULT 0 CHECK (used_units >= 0),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  cycle_start_ms INTEGER NOT NULL,
  cycle_end_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_quota (
  external_user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  base_quota INTEGER NOT NULL CHECK (base_quota >= 0),
  bonus_quota INTEGER NOT NULL DEFAULT 0 CHECK (bonus_quota >= 0),
  used_units INTEGER NOT NULL DEFAULT 0 CHECK (used_units >= 0),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  expires_at_ms INTEGER,
  cycle_start_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_cycles (
  cycle_start_ms INTEGER PRIMARY KEY,
  cycle_end_ms INTEGER NOT NULL,
  finalized_units INTEGER NOT NULL DEFAULT 0 CHECK (finalized_units >= 0),
  closed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS reservations (
  idempotency_key TEXT PRIMARY KEY,
  external_user_id TEXT NOT NULL,
  cycle_start_ms INTEGER NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'finalized', 'released', 'denied')),
  denial_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER,
  released_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reservations_user
  ON reservations (external_user_id, cycle_start_ms, status);
`;

function first<T>(sql: SqlStorageLike, query: string, ...bindings: unknown[]): T | null {
  return sql.exec<T>(query, ...bindings).toArray()[0] ?? null;
}

function requireTenant(sql: SqlStorageLike): TenantStateRow {
  const tenant = first<TenantStateRow>(sql, "SELECT * FROM tenant_state WHERE singleton = 1");
  if (!tenant) {
    throw new QuotaStateError(409, "TENANT_QUOTA_NOT_CONFIGURED", "Tenant quota is not configured");
  }
  return tenant;
}

function requireUser(sql: SqlStorageLike, externalUserId: string): UserQuotaRow {
  const user = first<UserQuotaRow>(
    sql,
    "SELECT * FROM user_quota WHERE external_user_id = ? LIMIT 1",
    externalUserId,
  );
  if (!user) {
    throw new QuotaStateError(409, "USER_QUOTA_NOT_CONFIGURED", "User quota is not configured");
  }
  return user;
}

function assertTenantId(tenant: TenantStateRow, tenantId: string): void {
  if (tenant.tenant_id !== tenantId) {
    throw new QuotaStateError(403, "TENANT_QUOTA_MISMATCH", "Quota state belongs to another tenant");
  }
}

function remaining(limit: number, used: number, reserved: number): number {
  return Math.max(0, limit - used - reserved);
}

function toSnapshot(tenant: TenantStateRow, user: UserQuotaRow): QuotaSnapshot {
  const userLimit = user.base_quota + user.bonus_quota;
  return QuotaSnapshotSchema.parse({
    tenantId: tenant.tenant_id,
    externalUserId: user.external_user_id,
    cycleStartAt: new Date(tenant.cycle_start_ms).toISOString(),
    cycleEndAt: new Date(tenant.cycle_end_ms).toISOString(),
    expiresAt: user.expires_at_ms === null ? null : new Date(user.expires_at_ms).toISOString(),
    tenantStatus: tenant.status,
    userStatus: user.status,
    tenant: {
      limit: tenant.monthly_allowance,
      used: tenant.used_units,
      reserved: tenant.reserved_units,
      remaining: remaining(tenant.monthly_allowance, tenant.used_units, tenant.reserved_units),
    },
    user: {
      limit: userLimit,
      used: user.used_units,
      reserved: user.reserved_units,
      remaining: remaining(userLimit, user.used_units, user.reserved_units),
    },
  });
}

function markCurrentReservationsReleased(sql: SqlStorageLike, now: number): void {
  sql.exec(
    `UPDATE reservations
       SET status = 'released', released_at_ms = ?
     WHERE status = 'reserved'`,
    now,
  );
}

function resetCycle(
  sql: SqlStorageLike,
  tenant: TenantStateRow,
  cycleStartMs: number,
  cycleEndMs: number,
  now: number,
): TenantStateRow {
  markCurrentReservationsReleased(sql, now);
  sql.exec(
    "UPDATE usage_cycles SET closed_at_ms = COALESCE(closed_at_ms, ?) WHERE cycle_start_ms = ?",
    now,
    tenant.cycle_start_ms,
  );
  sql.exec(
    `UPDATE tenant_state
       SET used_units = 0, reserved_units = 0, cycle_start_ms = ?, cycle_end_ms = ?, updated_at_ms = ?
     WHERE singleton = 1`,
    cycleStartMs,
    cycleEndMs,
    now,
  );
  sql.exec(
    `UPDATE user_quota
       SET used_units = 0, reserved_units = 0, cycle_start_ms = ?, updated_at_ms = ?`,
    cycleStartMs,
    now,
  );
  sql.exec(
    `INSERT INTO usage_cycles (cycle_start_ms, cycle_end_ms, finalized_units, closed_at_ms)
     VALUES (?, ?, 0, NULL)
     ON CONFLICT(cycle_start_ms) DO UPDATE SET cycle_end_ms = excluded.cycle_end_ms, closed_at_ms = NULL`,
    cycleStartMs,
    cycleEndMs,
  );
  return requireTenant(sql);
}

function rolloverIfNeeded(sql: SqlStorageLike, tenant: TenantStateRow, now: number): TenantStateRow {
  if (now < tenant.cycle_end_ms) {
    return tenant;
  }

  const cycleLength = tenant.cycle_end_ms - tenant.cycle_start_ms;
  if (cycleLength <= 0) {
    throw new QuotaStateError(500, "INVALID_QUOTA_CYCLE", "Quota cycle is invalid");
  }

  let nextStart = tenant.cycle_start_ms;
  let nextEnd = tenant.cycle_end_ms;
  while (now >= nextEnd) {
    nextStart = nextEnd;
    nextEnd += cycleLength;
  }

  return resetCycle(sql, tenant, nextStart, nextEnd, now);
}

function reservationForKey(sql: SqlStorageLike, key: string): ReservationRow | null {
  return first<ReservationRow>(
    sql,
    "SELECT idempotency_key, external_user_id, units, status, denial_reason FROM reservations WHERE idempotency_key = ? LIMIT 1",
    key,
  );
}

function responseForExistingReservation(
  sql: SqlStorageLike,
  reservation: ReservationRow,
  expectedUserId: string,
  expectedUnits: number,
): QuotaOperationResponse {
  if (
    reservation.external_user_id !== expectedUserId ||
    reservation.units !== expectedUnits
  ) {
    throw new QuotaStateError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for another quota request",
    );
  }

  const tenant = requireTenant(sql);
  const user = requireUser(sql, reservation.external_user_id);
  const denialReason =
    reservation.status === "released"
      ? "RESERVATION_RELEASED"
      : reservation.denial_reason;

  return QuotaOperationResponseSchema.parse({
    allowed: reservation.status === "reserved" || reservation.status === "finalized",
    reservationStatus: reservation.status,
    denialReason,
    snapshot: toSnapshot(tenant, user),
  });
}

function denial(
  sql: SqlStorageLike,
  request: { externalUserId: string; idempotencyKey: string; units: number },
  tenant: TenantStateRow,
  user: UserQuotaRow,
  reason: QuotaDenialReason,
  now: number,
): QuotaOperationResponse {
  sql.exec(
    `INSERT INTO reservations
      (idempotency_key, external_user_id, cycle_start_ms, units, status, denial_reason, created_at_ms)
     VALUES (?, ?, ?, ?, 'denied', ?, ?)`,
    request.idempotencyKey,
    request.externalUserId,
    tenant.cycle_start_ms,
    request.units,
    reason,
    now,
  );

  return QuotaOperationResponseSchema.parse({
    allowed: false,
    reservationStatus: "denied",
    denialReason: reason,
    snapshot: toSnapshot(tenant, user),
  });
}

export class TenantMeterCore {
  constructor(
    private readonly storage: DurableObjectStorageLike,
    private readonly now: () => number = Date.now,
  ) {
    this.storage.sql.exec(schema);
  }

  configure(input: unknown): QuotaSnapshot {
    const request = QuotaConfigureRequestSchema.parse(input);
    const cycleStartMs = Date.parse(request.cycleStartAt);
    const cycleEndMs = Date.parse(request.cycleEndAt);
    const expiresAtMs = request.user.expiresAt ? Date.parse(request.user.expiresAt) : null;
    const now = this.now();

    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const existing = first<TenantStateRow>(sql, "SELECT * FROM tenant_state WHERE singleton = 1");
      if (existing && existing.tenant_id !== request.tenantId) {
        throw new QuotaStateError(403, "TENANT_QUOTA_MISMATCH", "Quota state belongs to another tenant");
      }

      if (!existing) {
        sql.exec(
          `INSERT INTO tenant_state
            (singleton, tenant_id, status, monthly_allowance, used_units, reserved_units, cycle_start_ms, cycle_end_ms, updated_at_ms)
           VALUES (1, ?, ?, ?, 0, 0, ?, ?, ?)`,
          request.tenantId,
          request.tenantStatus,
          request.monthlyAllowance,
          cycleStartMs,
          cycleEndMs,
          now,
        );
        sql.exec(
          `INSERT INTO usage_cycles (cycle_start_ms, cycle_end_ms, finalized_units, closed_at_ms)
           VALUES (?, ?, 0, NULL)`,
          cycleStartMs,
          cycleEndMs,
        );
      } else if (existing.cycle_start_ms !== cycleStartMs) {
        resetCycle(sql, existing, cycleStartMs, cycleEndMs, now);
        sql.exec(
          `UPDATE tenant_state
             SET status = ?, monthly_allowance = ?, cycle_end_ms = ?, updated_at_ms = ?
           WHERE singleton = 1`,
          request.tenantStatus,
          request.monthlyAllowance,
          cycleEndMs,
          now,
        );
      } else {
        sql.exec(
          `UPDATE tenant_state
             SET status = ?, monthly_allowance = ?, cycle_end_ms = ?, updated_at_ms = ?
           WHERE singleton = 1`,
          request.tenantStatus,
          request.monthlyAllowance,
          cycleEndMs,
          now,
        );
        sql.exec(
          "UPDATE usage_cycles SET cycle_end_ms = ? WHERE cycle_start_ms = ?",
          cycleEndMs,
          cycleStartMs,
        );
      }

      const existingUser = first<UserQuotaRow>(
        sql,
        "SELECT * FROM user_quota WHERE external_user_id = ? LIMIT 1",
        request.user.externalUserId,
      );
      if (!existingUser) {
        sql.exec(
          `INSERT INTO user_quota
            (external_user_id, status, base_quota, bonus_quota, used_units, reserved_units, expires_at_ms, cycle_start_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
          request.user.externalUserId,
          request.user.status,
          request.user.baseQuota,
          request.user.bonusQuota,
          expiresAtMs,
          cycleStartMs,
          now,
        );
      } else {
        sql.exec(
          `UPDATE user_quota
             SET status = ?, base_quota = ?, bonus_quota = ?, expires_at_ms = ?, updated_at_ms = ?
           WHERE external_user_id = ?`,
          request.user.status,
          request.user.baseQuota,
          request.user.bonusQuota,
          expiresAtMs,
          now,
          request.user.externalUserId,
        );
      }

      const tenant = requireTenant(sql);
      const user = requireUser(sql, request.user.externalUserId);
      return toSnapshot(tenant, user);
    });
  }

  read(input: unknown): QuotaSnapshot {
    const request = QuotaReadRequestSchema.parse(input);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      let tenant = requireTenant(sql);
      assertTenantId(tenant, request.tenantId);
      tenant = rolloverIfNeeded(sql, tenant, this.now());
      return toSnapshot(tenant, requireUser(sql, request.externalUserId));
    });
  }

  reserve(input: unknown): QuotaOperationResponse {
    const request = QuotaReserveRequestSchema.parse(input);
    const now = this.now();

    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      let tenant = requireTenant(sql);
      assertTenantId(tenant, request.tenantId);
      tenant = rolloverIfNeeded(sql, tenant, now);
      const user = requireUser(sql, request.externalUserId);

      const existingReservation = reservationForKey(sql, request.idempotencyKey);
      if (existingReservation) {
        return responseForExistingReservation(
          sql,
          existingReservation,
          request.externalUserId,
          request.units,
        );
      }

      if (tenant.status === "suspended") {
        return denial(sql, request, tenant, user, "TENANT_SUSPENDED", now);
      }
      if (user.status === "suspended") {
        return denial(sql, request, tenant, user, "USER_SUSPENDED", now);
      }
      if (user.expires_at_ms !== null && now >= user.expires_at_ms) {
        return denial(sql, request, tenant, user, "QUOTA_EXPIRED", now);
      }
      if (
        remaining(tenant.monthly_allowance, tenant.used_units, tenant.reserved_units) <
        request.units
      ) {
        return denial(sql, request, tenant, user, "TENANT_EXHAUSTED", now);
      }

      const userLimit = user.base_quota + user.bonus_quota;
      if (remaining(userLimit, user.used_units, user.reserved_units) < request.units) {
        return denial(sql, request, tenant, user, "USER_EXHAUSTED", now);
      }

      sql.exec(
        `INSERT INTO reservations
          (idempotency_key, external_user_id, cycle_start_ms, units, status, denial_reason, created_at_ms)
         VALUES (?, ?, ?, ?, 'reserved', NULL, ?)`,
        request.idempotencyKey,
        request.externalUserId,
        tenant.cycle_start_ms,
        request.units,
        now,
      );
      sql.exec(
        "UPDATE tenant_state SET reserved_units = reserved_units + ?, updated_at_ms = ? WHERE singleton = 1",
        request.units,
        now,
      );
      sql.exec(
        "UPDATE user_quota SET reserved_units = reserved_units + ?, updated_at_ms = ? WHERE external_user_id = ?",
        request.units,
        now,
        request.externalUserId,
      );

      return QuotaOperationResponseSchema.parse({
        allowed: true,
        reservationStatus: "reserved",
        denialReason: null,
        snapshot: toSnapshot(requireTenant(sql), requireUser(sql, request.externalUserId)),
      });
    });
  }

  finalize(input: unknown): QuotaOperationResponse {
    const request = QuotaFinalizeRequestSchema.parse(input);
    const now = this.now();

    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      let tenant = requireTenant(sql);
      assertTenantId(tenant, request.tenantId);
      tenant = rolloverIfNeeded(sql, tenant, now);
      const reservation = reservationForKey(sql, request.idempotencyKey);
      if (!reservation) {
        throw new QuotaStateError(404, "RESERVATION_NOT_FOUND", "Reservation was not found");
      }
      if (reservation.status === "finalized") {
        return responseForExistingReservation(
          sql,
          reservation,
          reservation.external_user_id,
          reservation.units,
        );
      }
      if (reservation.status === "released" || reservation.status === "denied") {
        throw new QuotaStateError(
          409,
          "RESERVATION_NOT_FINALIZABLE",
          "Reservation is already terminal and cannot be finalized",
        );
      }

      sql.exec(
        `UPDATE reservations
           SET status = 'finalized', finalized_at_ms = ?
         WHERE idempotency_key = ? AND status = 'reserved'`,
        now,
        request.idempotencyKey,
      );
      sql.exec(
        `UPDATE tenant_state
           SET reserved_units = reserved_units - ?, used_units = used_units + ?, updated_at_ms = ?
         WHERE singleton = 1`,
        reservation.units,
        reservation.units,
        now,
      );
      sql.exec(
        `UPDATE user_quota
           SET reserved_units = reserved_units - ?, used_units = used_units + ?, updated_at_ms = ?
         WHERE external_user_id = ?`,
        reservation.units,
        reservation.units,
        now,
        reservation.external_user_id,
      );
      sql.exec(
        "UPDATE usage_cycles SET finalized_units = finalized_units + ? WHERE cycle_start_ms = ?",
        reservation.units,
        tenant.cycle_start_ms,
      );

      return QuotaOperationResponseSchema.parse({
        allowed: true,
        reservationStatus: "finalized",
        denialReason: null,
        snapshot: toSnapshot(
          requireTenant(sql),
          requireUser(sql, reservation.external_user_id),
        ),
      });
    });
  }

  release(input: unknown): QuotaOperationResponse {
    const request = QuotaReleaseRequestSchema.parse(input);
    const now = this.now();

    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      let tenant = requireTenant(sql);
      assertTenantId(tenant, request.tenantId);
      tenant = rolloverIfNeeded(sql, tenant, now);
      const reservation = reservationForKey(sql, request.idempotencyKey);
      if (!reservation) {
        throw new QuotaStateError(404, "RESERVATION_NOT_FOUND", "Reservation was not found");
      }
      if (reservation.status === "released") {
        const user = requireUser(sql, reservation.external_user_id);
        return QuotaOperationResponseSchema.parse({
          allowed: false,
          reservationStatus: "released",
          denialReason: "RESERVATION_RELEASED",
          snapshot: toSnapshot(tenant, user),
        });
      }
      if (reservation.status === "finalized") {
        throw new QuotaStateError(
          409,
          "RESERVATION_ALREADY_FINALIZED",
          "Finalized usage cannot be released",
        );
      }
      if (reservation.status === "denied") {
        throw new QuotaStateError(409, "RESERVATION_NOT_RELEASABLE", "Denied request has no reservation");
      }

      sql.exec(
        `UPDATE reservations
           SET status = 'released', released_at_ms = ?
         WHERE idempotency_key = ? AND status = 'reserved'`,
        now,
        request.idempotencyKey,
      );
      sql.exec(
        "UPDATE tenant_state SET reserved_units = reserved_units - ?, updated_at_ms = ? WHERE singleton = 1",
        reservation.units,
        now,
      );
      sql.exec(
        `UPDATE user_quota
           SET reserved_units = reserved_units - ?, updated_at_ms = ?
         WHERE external_user_id = ?`,
        reservation.units,
        now,
        reservation.external_user_id,
      );

      return QuotaOperationResponseSchema.parse({
        allowed: false,
        reservationStatus: "released",
        denialReason: "RESERVATION_RELEASED",
        snapshot: toSnapshot(
          requireTenant(sql),
          requireUser(sql, reservation.external_user_id),
        ),
      });
    });
  }
}
