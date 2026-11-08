/**
 * Partner entitlements — the commercial limits a partner is actually held to.
 *
 * The partner console previously *displayed* `device_limit`, `seat_limit` and
 * `api_quota_month` and enforced none of them. A limit that is only rendered is a
 * suggestion; a partner with a 50-device allowance could register five hundred
 * and the console would faithfully report `devices: 500, limit: 50` without
 * complaint.
 *
 * Every check here answers the same way:
 *
 *   allowed  → the operation proceeds
 *   refused  → `conflict` (409) carrying the limit, the current count and the
 *              headroom, so the caller knows exactly what would have to change
 *
 * Two rules that make this trustworthy rather than decorative:
 *
 *  1. **The count and the insert happen under one transaction.** A check-then-act
 *     across two round trips lets two concurrent registrations both see 49/50
 *     and both succeed. The transaction is opened by the caller and the count is
 *     re-read inside it.
 *  2. **A suspended partner is refused outright.** Status is not a badge; a
 *     suspended tenant cannot register devices, invite users or consume quota.
 *
 * Deliberately not implemented here: billing integration, per-device pricing
 * tiers, and OTA delivery. Those need a device-management provider and a
 * commercial contract, and inventing them would be exactly the kind of fake the
 * brief forbids.
 */
import type { Db } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/http.ts';
import { id, nowIso } from '../lib/ids.ts';

export type EntitlementKind = 'devices' | 'seats' | 'api';

export interface EntitlementState {
  partnerId: string;
  partnerName: string;
  plan: string;
  status: 'active' | 'trial' | 'suspended';
  devices: { limit: number; used: number; remaining: number };
  seats: { limit: number; used: number; remaining: number };
  api: { quota: number; used: number; remaining: number; month: string };
}

/** The month key used for API quota accounting, in UTC. */
export function quotaMonth(at = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface PartnerRow {
  id: string;
  name: string;
  plan: string;
  status: 'active' | 'trial' | 'suspended';
  device_limit: number;
  seat_limit: number;
  api_quota_month: number;
}

async function loadPartner(db: Db, partnerId: string): Promise<PartnerRow> {
  const row = await db.get<PartnerRow>(
    'SELECT id, name, plan, status, device_limit, seat_limit, api_quota_month FROM partners WHERE id = ?',
    [partnerId],
  );
  if (!row) throw notFound(`Partner "${partnerId}" does not exist.`);
  return row;
}

/**
 * Count what is actually consumed.
 *
 * A licence is consumed by *registration*, not by activation. Counting only
 * `active` devices would make an unassigned registration free, and a partner could
 * register ten thousand spare handsets against a fifty-device allowance without
 * ever tripping it — found by the test that registered three devices against a
 * limit of two and watched all three succeed.
 *
 * A `revoked` device frees its slot, because a licence released by revocation must
 * be reusable: otherwise a replacement handset would require buying a new one.
 */
async function counts(db: Db, partnerId: string, month: string) {
  const devices = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM device_licenses WHERE partner_id = ? AND status != 'revoked'",
    [partnerId],
  );
  const seats = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM partner_iam_users WHERE partner_id = ? AND status != 'disabled'",
    [partnerId],
  );
  // Quota usage is the sum of the current month's recorded metrics, not of all
  // history — otherwise a long-lived partner would be permanently over quota.
  const api = await db.get<{ c: number }>(
    "SELECT COALESCE(SUM(api_calls), 0) AS c FROM usage_metrics WHERE partner_id = ? AND day LIKE ?",
    [partnerId, `${month}%`],
  );
  return {
    devices: Number(devices?.c ?? 0),
    seats: Number(seats?.c ?? 0),
    api: Number(api?.c ?? 0),
  };
}

/** Current entitlement position, for the console and for the checks below. */
export async function entitlementState(db: Db, partnerId: string, at = new Date()): Promise<EntitlementState> {
  const partner = await loadPartner(db, partnerId);
  const month = quotaMonth(at);
  const used = await counts(db, partnerId, month);
  return {
    partnerId: partner.id,
    partnerName: partner.name,
    plan: partner.plan,
    status: partner.status,
    devices: {
      limit: partner.device_limit,
      used: used.devices,
      remaining: Math.max(0, partner.device_limit - used.devices),
    },
    seats: {
      limit: partner.seat_limit,
      used: used.seats,
      remaining: Math.max(0, partner.seat_limit - used.seats),
    },
    api: {
      quota: partner.api_quota_month,
      used: used.api,
      remaining: Math.max(0, partner.api_quota_month - used.api),
      month,
    },
  };
}

/**
 * Assert that `amount` more of `kind` is within entitlement.
 *
 * Call this inside the same transaction that performs the write. It re-reads the
 * count every time rather than caching, because a cached count is the mechanism
 * by which over-limit registrations slip through.
 */
export async function assertWithinEntitlement(
  db: Db,
  partnerId: string,
  kind: EntitlementKind,
  amount = 1,
): Promise<EntitlementState> {
  const state = await entitlementState(db, partnerId);

  if (state.status === 'suspended') {
    throw conflict(
      `Partner "${state.partnerName}" is suspended; no new ${kind} may be provisioned until the account is reinstated.`,
      { partnerId, status: state.status, kind },
    );
  }

  const bucket =
    kind === 'devices' ? state.devices : kind === 'seats' ? state.seats : state.api;
  const limit = kind === 'api' ? (bucket as typeof state.api).quota : (bucket as { limit: number }).limit;

  if (state[kind].used + amount > limit) {
    const detail = {
      partnerId,
      partnerName: state.partnerName,
      plan: state.plan,
      kind,
      limit,
      used: state[kind].used,
      requested: amount,
      remaining: Math.max(0, limit - state[kind].used),
    };
    throw conflict(
      `Entitlement exceeded: ${state.partnerName} may use ${limit} ${kind} on the "${state.plan}" plan, ` +
        `${state[kind].used} are in use and ${amount} more were requested. ` +
        `${Math.max(0, limit - state[kind].used)} remain.`,
      detail,
    );
  }

  return state;
}

const PLATFORMS = ['android', 'ios', 'windows', 'linux', 'web'] as const;

/**
 * Register a device against a partner's allowance.
 *
 * Activation is a separate step: a registered device is not an activated one, and
 * counting them as the same thing would let a partner activate unlimited devices
 * by registering them as `unassigned`.
 */
export async function registerDevice(
  db: Db,
  partnerId: string,
  input: { deviceId?: string; deviceName?: string; platform?: string },
  actorId: string,
): Promise<Record<string, unknown>> {
  const deviceId = input.deviceId?.trim();
  const deviceName = input.deviceName?.trim();
  if (!deviceId) throw badRequest('deviceId is required.');
  if (!deviceName) throw badRequest('deviceName is required.');
  if (deviceId.length > 128) throw badRequest('deviceId must be 128 characters or fewer.');

  const platform = (input.platform ?? 'android').trim();
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    throw badRequest(`platform must be one of ${PLATFORMS.join(', ')}.`);
  }

  const partner = await loadPartner(db, partnerId);
  if (partner.status === 'suspended') {
    throw conflict(`Partner "${partner.name}" is suspended; devices cannot be registered.`, {
      partnerId,
      status: partner.status,
    });
  }

  // Re-registering a device that already exists is a conflict, not a second
  // licence. Without this, the allowance could be consumed by the same handset
  // registering repeatedly.
  const existing = await db.get<{ id: string; status: string }>(
    'SELECT id, status FROM device_licenses WHERE partner_id = ? AND device_id = ?',
    [partnerId, deviceId],
  );
  if (existing) {
    throw conflict(
      `Device "${deviceId}" is already registered with ${partner.name} (status: ${existing.status}).`,
      { partnerId, deviceId, deviceRowId: existing.id, status: existing.status },
    );
  }

  // Count and insert are inside one transaction, so two concurrent registrations
  // cannot both read the same pre-limit count and both succeed.
  return db.tx(async () => {
    const state = await assertWithinEntitlement(db, partnerId, 'devices', 1);
    const rowId = id('dev');
    await db.run(
      `INSERT INTO device_licenses (id, partner_id, device_id, device_name, platform, status, assigned_to)
       VALUES (?, ?, ?, ?, ?, 'unassigned', ?)`,
      [rowId, partnerId, deviceId, deviceName, platform, actorId],
    );
    return {
      id: rowId,
      partnerId,
      deviceId,
      deviceName,
      platform,
      status: 'unassigned',
      registeredBy: actorId,
      registeredAt: nowIso(),
      entitlement: state.devices,
    };
  });
}

/**
 * Activate a registered device. Only an `unassigned` device may be activated, and
 * activation re-checks the allowance because another device may have been
 * activated in between.
 */
export async function activateDevice(
  db: Db,
  partnerId: string,
  deviceRowId: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  const device = await db.get<{ id: string; device_id: string; status: string; partner_id: string }>(
    'SELECT id, device_id, status, partner_id FROM device_licenses WHERE id = ?',
    [deviceRowId],
  );
  // 404, not 403: another partner's device must be indistinguishable from one
  // that does not exist, or the endpoint becomes an enumeration oracle.
  if (!device || device.partner_id !== partnerId) {
    throw notFound(`Device "${deviceRowId}" does not exist for this partner.`);
  }
  if (device.status === 'active') {
    throw conflict(`Device "${device.device_id}" is already active.`, { deviceRowId, status: 'active' });
  }
  if (device.status === 'revoked') {
    throw conflict(`Device "${device.device_id}" was revoked and cannot be reactivated; register a replacement.`, {
      deviceRowId,
      status: 'revoked',
    });
  }

  return db.tx(async () => {
    // Activation does NOT consume a second licence: registration already did, and
    // counting activation again would charge a partner twice for one handset. The
    // entitlement is re-read so the caller gets the current position, and the
    // suspension check still applies.
    const state = await assertWithinEntitlement(db, partnerId, 'devices', 0);
    await db.run(
      "UPDATE device_licenses SET status = 'active', activated_at = ? WHERE id = ?",
      [nowIso(), deviceRowId],
    );
    return {
      id: deviceRowId,
      deviceId: device.device_id,
      status: 'active',
      activatedBy: actorId,
      activatedAt: nowIso(),
      entitlement: state.devices,
    };
  });
}

/** Revoke a device and free its allowance. */
export async function revokeDevice(
  db: Db,
  partnerId: string,
  deviceRowId: string,
  reason: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  if (!reason?.trim() || reason.trim().length < 8) {
    throw badRequest('A revocation requires a written reason of at least 8 characters.');
  }
  const device = await db.get<{ id: string; device_id: string; status: string; partner_id: string }>(
    'SELECT id, device_id, status, partner_id FROM device_licenses WHERE id = ?',
    [deviceRowId],
  );
  if (!device || device.partner_id !== partnerId) {
    throw notFound(`Device "${deviceRowId}" does not exist for this partner.`);
  }
  if (device.status === 'revoked') {
    throw conflict(`Device "${device.device_id}" is already revoked.`, { deviceRowId });
  }
  await db.run(
    "UPDATE device_licenses SET status = 'revoked', assigned_to = ? WHERE id = ?",
    [`revoked by ${actorId}: ${reason.trim()}`, deviceRowId],
  );
  const state = await entitlementState(db, partnerId);
  return {
    id: deviceRowId,
    deviceId: device.device_id,
    status: 'revoked',
    reason: reason.trim(),
    revokedBy: actorId,
    revokedAt: nowIso(),
    entitlement: state.devices,
  };
}

/**
 * Record API consumption for today and report whether the partner is now over
 * quota. Unlike device registration this does not refuse the call that tipped it
 * over — the call already happened — it reports the breach so the console and any
 * external rate limiter can act on it.
 */
export async function recordApiUsage(
  db: Db,
  partnerId: string,
  calls: number,
  at = new Date(),
): Promise<{ allowed: boolean; state: EntitlementState; overQuota: boolean }> {
  if (!Number.isFinite(calls) || calls < 0) throw badRequest('calls must be a non-negative number.');
  await loadPartner(db, partnerId);
  const month = quotaMonth(at);
  const day = `${month}-${String(at.getUTCDate()).padStart(2, '0')}`;

  const existing = await db.get<{ id: string; api_calls: number }>(
    'SELECT id, api_calls FROM usage_metrics WHERE partner_id = ? AND day = ?',
    [partnerId, day],
  );
  if (existing) {
    await db.run('UPDATE usage_metrics SET api_calls = api_calls + ? WHERE id = ?', [calls, existing.id]);
  } else {
    await db.run(
      'INSERT INTO usage_metrics (id, partner_id, day, api_calls, active_users, storage_mb, uptime_pct) VALUES (?, ?, ?, ?, 0, 0, 100)',
      [id('usage'), partnerId, day, calls],
    );
  }
  const state = await entitlementState(db, partnerId, at);
  return { allowed: state.api.used <= state.api.quota, state, overQuota: state.api.used > state.api.quota };
}
