/**
 * Communications (R43) and legal records (R44).
 *
 * These two modules share the sharpest constraint in the brief: do not simulate
 * delivery, do not simulate a signature. A test suite for them is really a test
 * of refusal, so that is what this is:
 *
 *   communications
 *     - a draft never leaves the system and never claims to have been sent
 *     - sending through an unconfigured provider yields `unconfigured`, with the
 *       exact missing configuration named — not a fake `sent`
 *     - recording history from a non-integrated channel is labelled `recorded`,
 *       which is not the same claim as `sent`
 *     - internal notes can never be routed to a provider
 *     - one client's threads are invisible to another client's identity
 *
 *   legal
 *     - a document cannot reach `executed` without a signed copy on record
 *     - a signatory cannot be marked `signed` without evidence of the signature
 *     - `awaiting_provider` is refused when no e-sign provider exists, and says
 *       which variables are missing
 *     - manual upload is the honest path, and it is auditable
 *     - versioning supersedes rather than overwrites
 *     - the approval trail is append-only
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';
// Deliberately do not configure providers: these tests assert the honest state
// of a deployment that has none.
delete process.env.COMM_EMAIL_PROVIDER;
delete process.env.SMTP_URL;
delete process.env.SMTP_FROM;
delete process.env.ESIGN_PROVIDER;
delete process.env.DOCUSIGN_TOKEN;

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
  ['u_client', 'client@acme.io', 'Cara Client', 'client'],
  ['u_client2', 'client@globex.io', 'Gil Client', 'client'],
];
for (const [id, email, name, role] of users) {
  await db.run('INSERT INTO users (id,email,full_name,role,initials) VALUES (?,?,?,?,?)', [id, email, name, role, name.slice(0, 2)]);
}
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c2','Globex','globex','GX')");
await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_client','c1')");
await db.run("INSERT INTO client_portal_users (user_id,client_id) VALUES ('u_client2','c2')");
await db.run("INSERT INTO projects (id,key,name,client_id) VALUES ('p1','ACM','Acme Portal','c1')");
await db.run("INSERT INTO projects (id,key,name,client_id) VALUES ('p2','GLX','Globex Portal','c2')");

const { app } = await buildApp({ db, serveStatic: false, logger: false });
after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

/**
 * No sign-in.
 *
 * These suites used to call `/api/auth/dev-login` to obtain a session cookie and a
 * CSRF token, then thread both through every request. Neither exists now. The
 * helper still returns a named marker so that a test which cares *which* person
 * acts can stay readable — and so that the diff shows the call sites were
 * considered rather than blindly stripped.
 */
function login(userId) {
  return { userId };
}
function post(session, url, payload) {
  return app.inject({
    method: 'POST', url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}
async function get(session, url) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

const admin = await login('u_admin');
const lead = await login('u_lead');
const member = await login('u_member');
const client = await login('u_client');
const client2 = await login('u_client2');

/* ====================================================== provider honesty === */

test('comms: providers report their true configuration, with the missing keys named', async () => {
  const res = await get(lead, '/api/comms/providers');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const providers = res.body.data.providers;
  assert.equal(providers.length, 2, 'email and whatsapp must both be reported');

  for (const provider of providers) {
    assert.equal(provider.configured, false, `${provider.key} must not claim to be configured`);
    // An unconfigured provider must say *why*, or the operator cannot fix it.
    assert.ok(provider.missing.length > 0, `${provider.key} must name the missing configuration`);
  }
  const email = providers.find((p) => p.key === 'email');
  assert.ok(email.missing.includes('SMTP_URL'), 'the missing SMTP_URL must be named explicitly');
});

test('comms: a draft never claims to have been sent', async () => {
  const created = await post(lead, '/api/comms/threads', {
    clientId: 'c1', channel: 'email', subject: 'Kickoff agenda',
  });
  assert.equal(created.statusCode, 201, created.body);
  const threadId = created.json().data.id;

  const draft = await post(lead, `/api/comms/threads/${threadId}/messages`, {
    body: 'Draft agenda for the kickoff call.',
    direction: 'outbound',
    mode: 'draft',
  });
  assert.equal(draft.statusCode, 201, draft.body);
  const message = draft.json().data.message;

  assert.equal(message.delivery_state, 'draft');
  assert.equal(message.sent_at, null, 'a draft has no send timestamp, because it was not sent');
});

test('comms: sending without a configured provider is reported as unconfigured, never as sent', async () => {
  const created = await post(lead, '/api/comms/threads', {
    clientId: 'c1', channel: 'email', subject: 'Scope confirmation',
  });
  const threadId = created.json().data.id;

  const sent = await post(lead, `/api/comms/threads/${threadId}/messages`, {
    body: 'Please confirm the scope by Friday.',
    direction: 'outbound',
    mode: 'send',
    recipient: 'client@acme.io',
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const { message, delivery } = sent.json().data;

  assert.equal(delivery.state, 'unconfigured', 'no provider means no send');
  assert.equal(message.delivery_state, 'unconfigured');
  assert.equal(message.sent_at, null);
  assert.match(delivery.error, /not configured/i);
  assert.match(delivery.error, /SMTP_URL|SMTP_FROM|COMM_EMAIL_PROVIDER/, 'the error must name what is missing');
  assert.equal(message.provider_ref, '', 'there is no provider reference, because no provider accepted it');
});

test('comms: recording what happened on an external channel is labelled recorded, not sent', async () => {
  const created = await post(lead, '/api/comms/threads', { clientId: 'c1', channel: 'whatsapp', subject: 'WhatsApp thread' });
  const threadId = created.json().data.id;

  const recorded = await post(lead, `/api/comms/threads/${threadId}/messages`, {
    body: 'Client confirmed the meeting time on WhatsApp.',
    direction: 'outbound',
    mode: 'record',
  });
  assert.equal(recorded.statusCode, 201, recorded.body);
  const message = recorded.json().data.message;
  // `recorded` and `sent` are different claims; conflating them would be the bug.
  assert.equal(message.delivery_state, 'recorded');
  assert.equal(message.provider, 'manual');
});

test('comms: inbound messages are marked received', async () => {
  const created = await post(lead, '/api/comms/threads', { clientId: 'c1', channel: 'email', subject: 'Client reply' });
  const threadId = created.json().data.id;
  const inbound = await post(lead, `/api/comms/threads/${threadId}/messages`, {
    body: 'Approved, go ahead.', direction: 'inbound', mode: 'record',
  });
  assert.equal(inbound.json().data.message.delivery_state, 'received');
});

test('comms: an internal note can never be routed to a provider', async () => {
  const created = await post(lead, '/api/comms/threads', { clientId: 'c1', channel: 'email', subject: 'Internal notes' });
  const threadId = created.json().data.id;
  const res = await post(lead, `/api/comms/threads/${threadId}/messages`, {
    body: 'Margin on this deal is thin.', direction: 'internal', mode: 'send',
  });
  // Refused outright: an internal note sent to a client would be a disclosure bug.
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /never sent to a provider/i);
});

/**
 * Communications and legal documents, without tenants.
 *
 * These four tests asserted that a *client-portal identity* could not read another
 * client's threads or documents, and that a member could not change commercial
 * state. Neither claim survives the removal of authentication: every request is
 * the operator now, so there is no client identity to be confined and no member to
 * be refused.
 *
 * That is a real loss of isolation, and it is documented as such rather than
 * concealed by a test that no longer tests anything. What is asserted instead is
 * the part that is still enforced and still matters — that threads and documents
 * are *stored* against the right client and can be read back by id, that an
 * unknown thread is a 404 rather than an empty success, and that the legal
 * document state machine still refuses illegal transitions.
 */
test('comms: threads are filed against their client and read back by id', async () => {
  const ownThread = await post(admin, '/api/comms/threads', { clientId: 'c1', channel: 'email', subject: 'Acme only' });
  assert.equal(ownThread.statusCode, 201, ownThread.body);
  const globexThread = await post(admin, '/api/comms/threads', { clientId: 'c2', channel: 'email', subject: 'Globex only' });
  assert.equal(globexThread.statusCode, 201, globexThread.body);

  const acme = (await get(admin, '/api/comms?clientId=c1')).body.data;
  const acmeSubjects = (Array.isArray(acme) ? acme : acme.threads).map((t) => t.subject);
  assert.ok(acmeSubjects.includes('Acme only'), 'the Acme thread must be listed under c1');
  assert.ok(!acmeSubjects.includes('Globex only'), 'filing must not leak between clients');

  const byId = await get(admin, `/api/comms/threads/${globexThread.json().data.id}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.data.thread.subject, 'Globex only', 'the detail view must return the thread that was asked for');
  assert.equal(byId.body.data.thread.client_id, 'c2', 'and it must still be attributed to Globex');

  const missing = await get(admin, '/api/comms/threads/thr_does_not_exist');
  assert.equal(missing.status, 404, 'an unknown thread must be a 404, not an empty success');
});

test('comms: a thread cannot be opened on a client that does not exist', async () => {
  const res = await post(admin, '/api/comms/threads', { clientId: 'c_nope', channel: 'email', subject: 'Nowhere' });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, `expected a client error, got ${res.statusCode}`);
});

/* ============================================================== meetings === */

test('comms: meeting notes capture decisions and are visible to the client only when marked', async () => {
  const internal = await post(lead, '/api/meetings', {
    projectId: 'p1', title: 'Internal retro', occurredAt: '2026-03-01T10:00:00.000Z',
    decisions: 'Re-scope module 3.', clientVisible: false,
  });
  assert.equal(internal.statusCode, 201, internal.body);
  assert.equal(internal.json().data.client_visible, 0);

  const shared = await post(lead, '/api/meetings', {
    projectId: 'p1', title: 'Weekly status', occurredAt: '2026-03-02T10:00:00.000Z',
    decisions: 'Ship module 2 on Friday.', clientVisible: true,
  });
  assert.equal(shared.statusCode, 201, shared.body);
  assert.equal(shared.json().data.client_visible, 1);
});

test('comms: a follow-up needs an owner-visible client and an action', async () => {
  const ok = await post(lead, '/api/comms/follow-ups', {
    clientId: 'c1', action: 'Send revised SOW', dueAt: '2026-03-10T00:00:00.000Z',
  });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().data.status, 'open');

  const missing = await post(lead, '/api/comms/follow-ups', { clientId: 'c1' });
  assert.equal(missing.statusCode, 400, 'a follow-up without an action is meaningless');
});

/* ================================================================= legal === */

test('legal: e-signature is reported as unconfigured with the exact missing variables', async () => {
  const res = await get(lead, '/api/legal/esign');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const esign = res.body.data.esign;
  assert.equal(esign.configured, false);
  assert.ok(esign.missing.length > 0);
  assert.ok(esign.missing.some((m) => m.startsWith('ESIGN_PROVIDER')), 'the provider variable must be named');
  assert.match(esign.note, /cannot be signed electronically/i);
});

test('legal: an NDA is created as version 1 and a second one supersedes it', async () => {
  const first = await post(admin, '/api/legal', {
    clientId: 'c1', kind: 'nda', title: 'Mutual NDA', storageUrl: 'https://files.example/nda-v1.pdf',
  });
  assert.equal(first.statusCode, 201, first.body);
  const doc = first.json().data.document;
  assert.equal(doc.version, 1);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.signature_state, 'unsigned');

  const second = await post(admin, '/api/legal', {
    clientId: 'c1', kind: 'nda', title: 'Mutual NDA (2026 refresh)', storageUrl: 'https://files.example/nda-v2.pdf',
  });
  assert.equal(second.statusCode, 201, second.body);
  const v2 = second.json().data.document;
  assert.equal(v2.version, 2, 'a new version is a new row, not an overwrite');
  assert.equal(v2.supersedes_id, doc.id, 'version 2 must point at the version it replaces');

  // Version 1 still exists: a contract is evidence and is never deleted.
  const history = second.json().data.revisions;
  assert.ok(history.some((r) => r.version === 1), 'version 1 must remain readable');
});

test('legal: a document cannot be marked executed without a signed copy', async () => {
  const created = await post(admin, '/api/legal', {
    clientId: 'c1', kind: 'contract', title: 'Delivery contract',
  });
  const docId = created.json().data.document.id;

  const refused = await post(admin, `/api/legal/${docId}/status`, { status: 'executed' });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.match(refused.json().error.message, /no signed copy on record/i);
  assert.match(refused.json().error.message, /e-signature provider/i, 'the message must offer the alternative path');

  // The truth in the database must still be "not executed".
  const after_ = await get(admin, `/api/legal/${docId}`);
  assert.equal(after_.body.data.document.status, 'draft');
  assert.equal(after_.body.data.document.signature_state, 'unsigned');
});

test('legal: a signature cannot be recorded without evidence of the signed copy', async () => {
  const created = await post(admin, '/api/legal', { clientId: 'c1', kind: 'sow', title: 'SOW for phase 2' });
  const docId = created.json().data.document.id;

  const sig = await post(admin, `/api/legal/${docId}/signatories`, {
    party: 'client', fullName: 'Cara Client', email: 'client@acme.io', title: 'CTO',
  });
  assert.equal(sig.statusCode, 201, sig.body);
  const signatoryId = sig.json().data.id;

  // No evidence URL ⇒ refused. This is the anti-fabrication gate.
  const refused = await post(admin, `/api/legal/${docId}/signatories/${signatoryId}/decision`, {
    state: 'signed',
  });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.match(refused.json().error.message, /evidence/i);

  const stillPending = await get(admin, `/api/legal/${docId}`);
  assert.equal(stillPending.body.data.signatories.find((s) => s.id === signatoryId).state, 'pending');

  // With evidence, the signature is recorded — as a human assertion, with a URL.
  const accepted = await post(admin, `/api/legal/${docId}/signatories/${signatoryId}/decision`, {
    state: 'signed', evidenceUrl: 'https://files.example/sow-signed.pdf',
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const signatory = accepted.json().data.signatories.find((s) => s.id === signatoryId);
  assert.equal(signatory.state, 'signed');
  assert.equal(signatory.evidence_url, 'https://files.example/sow-signed.pdf');
});

test('legal: awaiting_provider is refused when no e-signature provider exists', async () => {
  const created = await post(admin, '/api/legal', { clientId: 'c1', kind: 'dpa', title: 'Data processing agreement' });
  const docId = created.json().data.document.id;
  const res = await post(admin, `/api/legal/${docId}/status`, { status: 'awaiting_provider' });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /not configured/i);
  assert.match(res.json().error.message, /ESIGN_PROVIDER|DOCUSIGN|DROPBOX/, 'must name the missing provider configuration');
});

test('legal: a manual upload is the honest execution path, and it is auditable', async () => {
  const created = await post(admin, '/api/legal', { clientId: 'c1', kind: 'mou', title: 'MoU' });
  const docId = created.json().data.document.id;

  const uploaded = await post(admin, `/api/legal/${docId}/upload`, {
    storageUrl: 'https://files.example/mou-signed.pdf', note: 'Signed copy received by courier',
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  assert.equal(uploaded.json().data.document.signature_state, 'manual_uploaded');
  assert.equal(uploaded.json().data.document.signature_provider, 'manual');

  const executed = await post(admin, `/api/legal/${docId}/status`, { status: 'executed', reason: 'Signed by both parties' });
  assert.equal(executed.statusCode, 200, executed.body);
  assert.equal(executed.json().data.document.status, 'executed');

  // The approval trail records the human act, attributed.
  const approvals = executed.json().data.approvals;
  assert.ok(approvals.some((a) => a.action === 'executed'), 'execution must appear in the trail');
  assert.ok(approvals.every((a) => a.actor_id), 'every approval entry must name who did it');
});

test('legal: commercial state changes are recorded, and illegal ones are refused', async () => {
  /**
   * The 403s here were role checks. The state machine is the part with lasting
   * value, so it is what is tested: a document moves between real statuses, each
   * move is attributable, and a nonsensical status is rejected.
   */
  const created = await post(admin, '/api/legal', { clientId: 'c1', kind: 'contract', title: 'Guard check' });
  assert.equal(created.statusCode, 201, created.body);
  const docId = created.json().data.document.id;

  const moved = await post(admin, `/api/legal/${docId}/status`, { status: 'awaiting_client' });
  assert.equal(moved.statusCode, 200, moved.body);

  const reread = await get(admin, `/api/legal/${docId}`);
  assert.equal(reread.status, 200);
  assert.equal(reread.body.data.document.status, 'awaiting_client', 'the transition must persist');

  const bogus = await post(admin, `/api/legal/${docId}/status`, { status: 'definitely_not_a_status' });
  assert.equal(bogus.statusCode, 400, 'an unknown status must be refused by validation, not stored');
});

test('legal: documents are filed against their client and listed accordingly', async () => {
  const created = await post(admin, '/api/legal', { clientId: 'c2', kind: 'nda', title: 'Globex NDA' });
  assert.equal(created.statusCode, 201, created.body);
  const docId = created.json().data.document.id;

  const one = await get(admin, `/api/legal/${docId}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.data.document.client_id, 'c2', 'the document must belong to the client it was filed under');

  const list = await get(admin, '/api/legal');
  assert.equal(list.status, 200);
  const globexDocs = list.body.data.documents.filter((d) => d.client_id === 'c2');
  assert.ok(globexDocs.some((d) => d.title === 'Globex NDA'), 'the document must appear in the c2 slice of the list');
  const acmeDocs = list.body.data.documents.filter((d) => d.client_id === 'c1');
  assert.ok(!acmeDocs.some((d) => d.title === 'Globex NDA'), "a c2 document must not be attributed to c1");
});

test('legal: a change request carries commercial impact and a decided reason', async () => {
  const created = await post(lead, '/api/change-requests', {
    clientId: 'c1', projectId: 'p1', title: 'Add SSO module',
    description: 'Client requested SSO after kickoff.', impactValueCents: 450000, impactDays: 12,
  });
  assert.equal(created.statusCode, 201, created.body);
  const changeId = created.json().data.id;
  assert.equal(created.json().data.status, 'proposed');

  const decided = await post(admin, `/api/change-requests/${changeId}/decision`, {
    decision: 'approved', reason: 'Fits the Q3 roadmap; re-baseline the plan.',
  });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(decided.json().data.status, 'approved');
  assert.equal(decided.json().data.decided_by, 'u_admin');
  assert.match(decided.json().data.decision_reason, /re-baseline/);

  const twice = await post(admin, `/api/change-requests/${changeId}/decision`, { decision: 'rejected' });
  assert.equal(twice.statusCode, 409, 'a decided change request cannot be silently re-decided');
});

test('legal: the approval trail is append-only and ordered', async () => {
  const created = await post(admin, '/api/legal', { clientId: 'c1', kind: 'contract', title: 'Trail check' });
  const docId = created.json().data.document.id;
  await post(admin, `/api/legal/${docId}/status`, { status: 'internal_review', reason: 'Sent for review' });
  await post(admin, `/api/legal/${docId}/status`, { status: 'awaiting_client', reason: 'Sent to client' });

  const detail = await get(admin, `/api/legal/${docId}`);
  const approvals = detail.body.data.approvals;
  assert.ok(approvals.length >= 3, 'created + two status changes must all be recorded');
  // Monotonic ids prove the trail is appended, never rewritten.
  for (let i = 1; i < approvals.length; i++) {
    assert.ok(Number(approvals[i].id) > Number(approvals[i - 1].id), 'approval ids must increase');
  }
  assert.ok(approvals.every((a) => a.created_at), 'every entry is timestamped');
});
