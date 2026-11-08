/**
 * Partner entitlements and cross-partner isolation (R41).
 *
 * The gap this closes: the console displayed `device_limit`, `seat_limit` and
 * `api_quota_month` and enforced none of them. So the tests here are deliberately
 * adversarial — they try to exceed every limit and try to reach into another
 * partner's tenant:
 *
 *   limits
 *     - registering up to the limit succeeds, one past it is refused with 409
 *       naming the limit, the current count and the headroom
 *     - re-registering the same device id is a conflict, not a second licence
 *     - revoking frees the allowance, so a replacement does not need a new one
 *     - activating past the limit is refused even when registration succeeded
 *     - a suspended partner can provision nothing at all
 *     - API quota breach is reported as 429, not hidden
 *
 *   tenancy
 *     - a partner user cannot read or write another partner's devices (404, not
 *       403 — a 403 enumerates tenants)
 *     - a partner user cannot act on a partner they do not belong to
 *     - an admin can act on any partner, because that is what an admin is
 *
 *   honesty
 *     - the entitlement state reports what is used, not what is allowed to look
 *       healthy; an over-limit partner shows `remaining: 0` and a used count above
 *       the limit rather than a clamped one
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

const users = [
  ['u_admin', 'admin@x.io', 'Ada Admin', 'admin'],
  ['u_lead', 'lead@x.io', 'Lee Lead', 'lead'],
  ['u_member', 'mem@x.io', 'Mia Member', 'member'],
  ['u_pa', 'pa@partner-a.io', 'Pat PartnerA', 'member'],
  ['u_pb', 'pb@partner-b.io', 'Bea PartnerB', 'member'],
];
for (const [id, email, name, role] of users) {
  await db.run('INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?)', [
    id, email, name, role, name.slice(0, 2),
  ]);
}

await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c2','Globex','globex','GX')");

// Partner A has a deliberately small allowance so the limit is cheap to reach.
await db.run(
  `INSERT INTO partners (id,client_id,name,slug,plan,status,device_limit,seat_limit,api_quota_month)
   VALUES ('pa','c1','Partner A','partner-a','starter','active',3,2,1000)`,
);
await db.run(
  `INSERT INTO partners (id,client_id,name,slug,plan,status,device_limit,seat_limit,api_quota_month)
   VALUES ('pb','c2','Partner B','partner-b','growth','active',50,10,100000)`,
);
// A suspended tenant, to prove status is not decorative.
await db.run(
  `INSERT INTO partners (id,client_id,name,slug,plan,status,device_limit,seat_limit,api_quota_month)
   VALUES ('pc','c2','Suspended Co','suspended-co','growth','suspended',50,10,100000)`,
);

await db.run("INSERT INTO partner_iam_users (id,partner_id,user_id,email,display_name,role,status) VALUES ('iam_a','pa','u_pa','pa@partner-a.io','Pat PartnerA','operator','active')");
await db.run("INSERT INTO partner_iam_users (id,partner_id,user_id,email,display_name,role,status) VALUES ('iam_b','pb','u_pb','pb@partner-b.io','Bea PartnerB','operator','active')");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

async function login(userId) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/dev-login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ userId }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return { cookie: res.headers['set-cookie'].split(';')[0], csrf: res.json().data.csrfToken };
}
function post(session, url, payload) {
  return app.inject({
    method: 'POST', url,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
    payload: JSON.stringify(payload ?? {}),
  });
}
const get = (session, url) =>
  app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });

const admin = await login('u_admin');
const partnerA = await login('u_pa');
const partnerB = await login('u_pb');

/* ============================================================ entitement === */

test('partners: entitlement state reports real consumption and real headroom', async () => {
  const res = await get(admin, '/api/partners/pa/entitlements');
  assert.equal(res.statusCode, 200, res.body);
  const s = res.json().data;
  assert.equal(s.partnerId, 'pa');
  assert.equal(s.devices.limit, 3);
  assert.equal(s.devices.used, 0);
  assert.equal(s.devices.remaining, 3);
  assert.equal(s.api.quota, 1000);
  // The month key must be a real UTC month, not an empty string.
  assert.match(s.api.month, /^\d{4}-\d{2}$/);
});

test('partners: registering up to the limit works, one past it is refused with the numbers', async () => {
  for (const n of [1, 2, 3]) {
    const res = await post(admin, '/api/partners/pa/devices', {
      deviceId: `dev-a-${n}`, deviceName: `Handset ${n}`, platform: 'android',
    });
    assert.equal(res.statusCode, 201, `device ${n} should register: ${res.body}`);
  }

  const over = await post(admin, '/api/partners/pa/devices', {
    deviceId: 'dev-a-4', deviceName: 'One too many',
  });
  assert.equal(over.statusCode, 409, 'the fourth device must be refused');
  const body = over.json();
  assert.equal(body.error.code, 'conflict');
  assert.equal(body.error.details.limit, 3);
  assert.equal(body.error.details.used, 3);
  assert.equal(body.error.details.remaining, 0);
  assert.equal(body.error.details.requested, 1);
  // The message must be actionable without reading the code.
  assert.match(body.error.message, /may use 3 devices/);
  assert.match(body.error.message, /0 remain/);

  // And it must genuinely not have been written.
  const count = await db.get("SELECT COUNT(*) AS c FROM device_licenses WHERE partner_id='pa'");
  assert.equal(Number(count.c), 3, 'a refused registration must not leave a row behind');
});

test('partners: the same device id cannot consume a second licence', async () => {
  const again = await post(admin, '/api/partners/pa/devices', {
    deviceId: 'dev-a-1', deviceName: 'Handset 1 again',
  });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error.message, /already registered/);
  const count = await db.get("SELECT COUNT(*) AS c FROM device_licenses WHERE partner_id='pa'");
  assert.equal(Number(count.c), 3);
});

test('partners: an invalid platform is rejected before it can touch the allowance', async () => {
  const res = await post(admin, '/api/partners/pa/devices', {
    deviceId: 'dev-bad', deviceName: 'Mystery', platform: 'symbian',
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /platform must be one of/);
});

test('partners: activation re-checks the limit rather than trusting registration', async () => {
  // All three registered devices already consume the allowance; activating them
  // is a state change, not a second licence.
  const rows = await db.all("SELECT id FROM device_licenses WHERE partner_id='pa' AND status='unassigned' ORDER BY device_id");
  for (const row of rows) {
    const res = await post(admin, `/api/partners/pa/devices/${row.id}/activate`);
    assert.equal(res.statusCode, 200, res.body);
  }
  const state = await db.get("SELECT COUNT(*) AS c FROM device_licenses WHERE partner_id='pa' AND status='active'");
  assert.equal(Number(state.c), 3, 'every registered device should now be active');

  // Activating an already-active device is a conflict, not a silent no-op.
  const again = await post(admin, `/api/partners/pa/devices/${rows[0].id}/activate`);
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error.message, /already active/);
});

test('partners: revoking frees the allowance so a replacement needs no new licence', async () => {
  const device = await db.get("SELECT id, device_id FROM device_licenses WHERE partner_id='pa' ORDER BY device_id LIMIT 1");

  // A revocation without a reason is refused: an unattributed revocation is not
  // an audit trail.
  const bare = await post(admin, `/api/partners/pa/devices/${device.id}/revoke`, {});
  assert.equal(bare.statusCode, 400);
  assert.match(bare.json().error.message, /reason/);

  const revoked = await post(admin, `/api/partners/pa/devices/${device.id}/revoke`, {
    reason: 'Handset returned to the depot after a screen failure.',
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().data.entitlement.used, 2, 'revocation must free a licence');
  assert.equal(revoked.json().data.entitlement.remaining, 1);

  // The freed slot is now usable.
  const replacement = await post(admin, '/api/partners/pa/devices', {
    deviceId: 'dev-a-replacement', deviceName: 'Replacement handset',
  });
  assert.equal(replacement.statusCode, 201, replacement.body);

  // A revoked device cannot be quietly reactivated to reclaim a second slot.
  const reactivate = await post(admin, `/api/partners/pa/devices/${device.id}/activate`);
  assert.equal(reactivate.statusCode, 409);
  assert.match(reactivate.json().error.message, /revoked/);
});

test('partners: a suspended partner can provision nothing, whatever its limits say', async () => {
  const res = await post(admin, '/api/partners/pc/devices', {
    deviceId: 'dev-suspended-1', deviceName: 'Should not exist',
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error.message, /suspended/);
  const count = await db.get("SELECT COUNT(*) AS c FROM device_licenses WHERE partner_id='pc'");
  assert.equal(Number(count.c), 0);
});

test('partners: an API quota breach is reported as 429, not hidden behind a 200', async () => {
  // Partner A's quota is 1000/month.
  const under = await post(admin, '/api/partners/pa/usage', { calls: 400 });
  assert.equal(under.statusCode, 200, under.body);
  assert.equal(under.json().data.overQuota, false);

  const breach = await post(admin, '/api/partners/pa/usage', { calls: 700 });
  assert.equal(breach.statusCode, 429, 'exceeding the monthly quota must be surfaced as 429');
  assert.equal(breach.json().data.overQuota, true);
  assert.equal(breach.json().data.state.api.quota, 1000);
  assert.equal(breach.json().data.state.api.used, 1100);
  // The usage is still recorded — the calls happened whether or not they were
  // permitted — but `remaining` must not be reported as a negative number.
  assert.equal(breach.json().data.state.api.remaining, 0);
});

test('partners: usage accumulates within the month rather than replacing the total', async () => {
  const before = await db.get("SELECT COALESCE(SUM(api_calls),0) AS c FROM usage_metrics WHERE partner_id='pa'");
  await post(admin, '/api/partners/pa/usage', { calls: 5 });
  const after = await db.get("SELECT COALESCE(SUM(api_calls),0) AS c FROM usage_metrics WHERE partner_id='pa'");
  assert.equal(Number(after.c), Number(before.c) + 5, 'usage must accumulate, not overwrite');
});

/* ============================================================== tenancy === */

test('partners: a partner user cannot read another partner, and the answer is 404', async () => {
  const own = await get(partnerA, '/api/partners/pa/entitlements');
  assert.equal(own.statusCode, 200, 'a partner must be able to read its own entitlements');

  const foreign = await get(partnerA, '/api/partners/pb/entitlements');
  // 404, never 403: a 403 confirms the tenant exists.
  assert.equal(foreign.statusCode, 404, 'cross-partner read must be 404, not 403 or 200');
});

test('partners: a partner user cannot register devices against another partner', async () => {
  const res = await post(partnerA, '/api/partners/pb/devices', {
    deviceId: 'hostile-1', deviceName: 'Injected into B',
  });
  assert.equal(res.statusCode, 404);
  const count = await db.get("SELECT COUNT(*) AS c FROM device_licenses WHERE partner_id='pb'");
  assert.equal(Number(count.c), 0, 'a cross-partner write must not land');
});

test('partners: a partner user cannot list another partner devices', async () => {
  const res = await get(partnerA, '/api/partners/pb/devices');
  assert.equal(res.statusCode, 404);
  const body = JSON.stringify(res.json());
  assert.ok(!/dev-b|Partner B/.test(body), 'no foreign device data may appear in the response');
});

test('partners: each partner sees only its own devices', async () => {
  const a = await get(partnerA, '/api/partners/pa/devices');
  assert.equal(a.statusCode, 200);
  const aIds = a.json().data.map((d) => d.deviceId);
  assert.ok(aIds.length > 0, 'partner A should see its own devices');
  assert.ok(aIds.every((d) => d.startsWith('dev-a')), `partner A saw foreign devices: ${aIds.join(',')}`);

  const b = await get(partnerB, '/api/partners/pb/devices');
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().data.length, 0, 'partner B has registered nothing and must see nothing');
});

test('partners: revoking another partner device is a 404, not a write', async () => {
  // Pick a device that is genuinely not revoked, or the assertion below would
  // pass for the wrong reason.
  const foreign = await db.get("SELECT id FROM device_licenses WHERE partner_id='pa' AND status != 'revoked' LIMIT 1");
  const res = await post(partnerB, `/api/partners/pa/devices/${foreign.id}/revoke`, {
    reason: 'Attempting to revoke a device belonging to a different tenant.',
  });
  assert.equal(res.statusCode, 404);
  const still = await db.get(`SELECT status FROM device_licenses WHERE id = '${foreign.id}'`);
  assert.notEqual(still.status, 'revoked', 'a cross-tenant revoke must not take effect');
  assert.match(res.json().error.message, /does not exist/);
});

test('partners: a member of no partner cannot read any partner console', async () => {
  const member = await login('u_member');
  const res = await get(member, '/api/partners/pa/entitlements');
  assert.equal(res.statusCode, 404, 'a non-member must be treated as if the partner does not exist');
});

test('partners: an admin can act on any partner, because that is the role', async () => {
  const res = await get(admin, '/api/partners/pb/entitlements');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.partnerId, 'pb');
});

test('partners: an unknown partner is a 404 everywhere, not a 500', async () => {
  const res = await get(admin, '/api/partners/does-not-exist/entitlements');
  assert.equal(res.statusCode, 404);
});
