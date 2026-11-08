/**
 * Legal and commercial records — NDA, MoU, contracts, SOW, DPAs, change
 * requests and device entitlements.
 *
 * The governing rule from the brief: never simulate a legally binding
 * signature. There is no e-signature provider configured, so this service:
 *
 *   - lets a human upload a signed copy and mark it `manual_uploaded`, recording
 *     who did it and when (that is evidence, honestly described);
 *   - refuses to move a document to `executed` without either a manual upload or
 *     a real provider reference;
 *   - refuses `awaiting_provider` because no provider exists — attempting it
 *     returns the exact missing configuration;
 *   - keeps an append-only approval trail that no endpoint can rewrite.
 *
 * Versioning is explicit: a new version supersedes the old one rather than
 * overwriting it, because a contract is evidence.
 */
import type { Db } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/http.ts';
import { id, nowIso } from '../lib/ids.ts';

export const LEGAL_KINDS = ['nda', 'mou', 'contract', 'sow', 'dpa', 'change_request', 'entitlement'] as const;

export interface EsignStatus {
  provider: string;
  configured: boolean;
  missing: string[];
  note: string;
}

/**
 * E-signature provider status. Truthful by construction: absent credentials the
 * answer is "not configured" and the manual path is the only one that works.
 */
export function esignStatus(): EsignStatus {
  const provider = process.env.ESIGN_PROVIDER ?? '';
  const hasDocusign = provider === 'docusign' && !!process.env.DOCUSIGN_TOKEN && !!process.env.DOCUSIGN_ACCOUNT_ID;
  const hasDropbox = provider === 'dropbox_sign' && !!process.env.DROPBOX_SIGN_TOKEN;
  const configured = hasDocusign || hasDropbox;

  const missing: string[] = [];
  if (!provider) missing.push('ESIGN_PROVIDER=docusign|dropbox_sign');
  if (provider === 'docusign') {
    if (!process.env.DOCUSIGN_TOKEN) missing.push('DOCUSIGN_TOKEN');
    if (!process.env.DOCUSIGN_ACCOUNT_ID) missing.push('DOCUSIGN_ACCOUNT_ID');
  } else if (provider === 'dropbox_sign') {
    if (!process.env.DROPBOX_SIGN_TOKEN) missing.push('DROPBOX_SIGN_TOKEN');
  } else if (!provider) {
    missing.push('DOCUSIGN_TOKEN', 'DOCUSIGN_ACCOUNT_ID');
  }

  return {
    provider: provider || 'none',
    configured,
    missing,
    note: configured
      ? 'E-signature provider is configured. Provider round-trip still governs the `signed` state.'
      : 'No e-signature provider configured. Documents can be uploaded manually and approved internally; they cannot be signed electronically by this system.',
  };
}

async function logApproval(db: Db, documentId: string, action: string, actorId: string | null, reason = '') {
  await db.run(
    'INSERT INTO legal_approvals (document_id, action, actor_id, reason) VALUES (?,?,?,?)',
    [documentId, action, actorId, reason],
  );
}

export async function listDocuments(db: Db, filter: { clientId?: string; kind?: string } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.clientId) { where.push('d.client_id = ?'); params.push(filter.clientId); }
  if (filter.kind) { where.push('d.kind = ?'); params.push(filter.kind); }
  const sql = `SELECT d.*, c.name AS client_name,
                      (SELECT COUNT(*) FROM legal_signatories s WHERE s.document_id = d.id) AS signatory_count
                 FROM legal_documents d JOIN clients c ON c.id = d.client_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY d.kind, d.version DESC`;
  return db.all<Record<string, any>>(sql, params);
}

export async function documentDetail(db: Db, documentId: string) {
  const document = await db.get<Record<string, any>>(
    'SELECT d.*, c.name AS client_name FROM legal_documents d JOIN clients c ON c.id = d.client_id WHERE d.id = ?',
    [documentId],
  );
  if (!document) throw notFound('Document not found');
  const signatories = await db.all<Record<string, any>>('SELECT * FROM legal_signatories WHERE document_id = ? ORDER BY created_at', [documentId]);
  const approvals = await db.all<Record<string, any>>(
    `SELECT a.*, u.full_name AS actor_name FROM legal_approvals a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.document_id = ? ORDER BY a.id ASC`,
    [documentId],
  );
  const revisions = await db.all<Record<string, any>>(
    'SELECT id, version, status, signature_state, created_at FROM legal_documents WHERE client_id = ? AND kind = ? ORDER BY version DESC',
    [document.client_id, document.kind],
  );
  return { document, signatories, approvals, revisions, esign: esignStatus() };
}

export interface CreateDocumentInput {
  clientId: string;
  kind: string;
  title: string;
  storageUrl?: string;
  valueCents?: number;
  currency?: string;
  effectiveAt?: string;
  expiresAt?: string;
  renewalNoticeDays?: number;
  actorId: string;
  supersedesId?: string;
}

export async function createDocument(db: Db, input: CreateDocumentInput) {
  if (!(LEGAL_KINDS as readonly string[]).includes(input.kind)) {
    throw badRequest(`Document kind must be one of ${LEGAL_KINDS.join(', ')}`);
  }
  if (!input.title?.trim()) throw badRequest('A legal document needs a title.');
  const client = await db.get<{ id: string }>('SELECT id FROM clients WHERE id = ?', [input.clientId]);
  if (!client) throw notFound('Client not found');

  // Versioning: alongside any existing document of the same kind for the client.
  const prior = await db.get<{ version: number; id: string }>(
    'SELECT version, id FROM legal_documents WHERE client_id = ? AND kind = ? ORDER BY version DESC LIMIT 1',
    [input.clientId, input.kind],
  );
  const version = (prior?.version ?? 0) + 1;
  const documentId = id('doc');
  await db.run(
    `INSERT INTO legal_documents (id, client_id, kind, title, version, storage_url, value_cents, currency,
                                 effective_at, expires_at, renewal_notice_days, supersedes_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [documentId, input.clientId, input.kind, input.title.trim(), version, input.storageUrl ?? '',
      input.valueCents ?? 0, input.currency ?? 'INR', input.effectiveAt ?? null, input.expiresAt ?? null,
      input.renewalNoticeDays ?? 30, input.supersedesId ?? prior?.id ?? null, input.actorId],
  );
  await logApproval(db, documentId, 'created', input.actorId, version > 1 ? `Version ${version}` : 'Initial version');
  return documentDetail(db, documentId);
}

export async function addSignatory(
  db: Db,
  input: { documentId: string; party: 'agency' | 'client'; fullName: string; email?: string; title?: string; actorId: string },
) {
  const document = await db.get<Record<string, any>>('SELECT * FROM legal_documents WHERE id = ?', [input.documentId]);
  if (!document) throw notFound('Document not found');
  if (document.status === 'executed') throw conflict('An executed document cannot take new signatories; create a new version.');
  if (!input.fullName?.trim()) throw badRequest('A signatory needs a name.');
  const signatoryId = id('sig');
  await db.run(
    'INSERT INTO legal_signatories (id, document_id, party, full_name, email, title) VALUES (?,?,?,?,?,?)',
    [signatoryId, input.documentId, input.party, input.fullName.trim(), input.email ?? '', input.title ?? ''],
  );
  return db.get('SELECT * FROM legal_signatories WHERE id = ?', [signatoryId]);
}

/**
 * Record a signatory decision.
 *
 * `signed` is only reachable as `manual_uploaded` on the document with an
 * evidence URL — i.e. a human says "here is the signed copy". We never mark a
 * signatory "signed" because a button was clicked.
 */
export async function recordSignatoryDecision(
  db: Db,
  input: { documentId: string; signatoryId: string; state: 'approved' | 'declined' | 'signed'; evidenceUrl?: string; actorId: string; reason?: string },
) {
  const document = await db.get<Record<string, any>>('SELECT * FROM legal_documents WHERE id = ?', [input.documentId]);
  if (!document) throw notFound('Document not found');
  if (document.status === 'executed') throw conflict('An executed document is final; create a new version instead.');
  const signatory = await db.get<Record<string, any>>(
    'SELECT * FROM legal_signatories WHERE id = ? AND document_id = ?',
    [input.signatoryId, input.documentId],
  );
  if (!signatory) throw notFound('Signatory not found on this document');
  if (!['approved', 'declined', 'signed'].includes(input.state)) throw badRequest('Invalid signatory decision');

  if (input.state === 'signed' && !input.evidenceUrl?.trim()) {
    // This is the anti-fabrication gate. No evidence URL ⇒ no signature.
    throw badRequest(
      'A signature cannot be recorded without evidence of the signed copy. Upload the signed document and supply its URL, or configure an e-signature provider.',
    );
  }

  await db.run(
    'UPDATE legal_signatories SET state = ?, decided_at = ?, evidence_url = ? WHERE id = ?',
    [input.state, nowIso(), input.evidenceUrl ?? '', input.signatoryId],
  );
  await logApproval(db, input.documentId, input.state === 'declined' ? 'rejected' : 'approved', input.actorId, input.reason ?? '');
  return documentDetail(db, input.documentId);
}

export async function setDocumentStatus(
  db: Db,
  input: { documentId: string; status: string; actorId: string; reason?: string },
) {
  const document = await db.get<Record<string, any>>('SELECT * FROM legal_documents WHERE id = ?', [input.documentId]);
  if (!document) throw notFound('Document not found');
  const allowed = ['draft', 'internal_review', 'awaiting_client', 'executed', 'expired', 'terminated'];

  if (input.status === 'awaiting_provider') {
    const esign = esignStatus();
    throw badRequest(
      `E-signature is not configured, so a document cannot be sent to a provider. Missing: ${esign.missing.join(', ')}. Upload a signed copy instead.`,
    );
  }
  if (!allowed.includes(input.status)) throw badRequest(`Status must be one of ${allowed.join(', ')}`);

  if (input.status === 'executed') {
    // Two legitimate routes: a manual upload with evidence, or a real provider
    // reference. Everything else is refused.
    const uploaded = await db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM legal_signatories WHERE document_id = ? AND state = 'signed' AND evidence_url <> ''",
      [input.documentId],
    );
    const manual = document.signature_state === 'manual_uploaded' && !!document.storage_url;
    const providerSigned = document.signature_state === 'signed' && !!document.signature_ref;
    if (!manual && !providerSigned && Number(uploaded?.c ?? 0) === 0) {
      throw badRequest(
        'Cannot mark a document executed: there is no signed copy on record. Upload the signed document (storage_url) and record the signatory, or configure an e-signature provider.',
      );
    }
  }

  await db.run(
    'UPDATE legal_documents SET status = ?, updated_at = ? WHERE id = ?',
    [input.status, nowIso(), input.documentId],
  );
  await logApproval(db, input.documentId, input.status === 'executed' ? 'executed' : input.status === 'terminated' ? 'terminated' : 'approved', input.actorId, input.reason ?? '');
  return documentDetail(db, input.documentId);
}

/**
 * Attach a manually signed copy. This is the honest path when no e-sign
 * provider exists: a human states that the signed document is at `url`, and the
 * system records who said so and when.
 */
export async function uploadSignedCopy(
  db: Db,
  input: { documentId: string; storageUrl: string; actorId: string; note?: string },
) {
  if (!input.storageUrl?.trim()) throw badRequest('A signed copy needs a storage location.');
  const document = await db.get<Record<string, any>>('SELECT * FROM legal_documents WHERE id = ?', [input.documentId]);
  if (!document) throw notFound('Document not found');
  await db.run(
    "UPDATE legal_documents SET signature_state = 'manual_uploaded', signature_provider = 'manual', storage_url = ?, updated_at = ? WHERE id = ?",
    [input.storageUrl.trim(), nowIso(), input.documentId],
  );
  await logApproval(db, input.documentId, 'executed', input.actorId, input.note ?? 'Manually uploaded signed copy');
  return documentDetail(db, input.documentId);
}

export async function createChangeRequest(
  db: Db,
  input: {
    clientId: string; projectId?: string; documentId?: string; title: string; description?: string;
    impactValueCents?: number; impactDays?: number; actorId: string;
  },
) {
  if (!input.title?.trim()) throw badRequest('A change request needs a title.');
  const client = await db.get<{ id: string }>('SELECT id FROM clients WHERE id = ?', [input.clientId]);
  if (!client) throw notFound('Client not found');
  const changeId = id('chg');
  await db.run(
    `INSERT INTO change_requests (id, client_id, project_id, document_id, title, description, impact_value_cents, impact_days, requested_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [changeId, input.clientId, input.projectId ?? null, input.documentId ?? null, input.title.trim(),
      input.description ?? '', input.impactValueCents ?? 0, input.impactDays ?? 0, input.actorId],
  );
  return db.get('SELECT * FROM change_requests WHERE id = ?', [changeId]);
}

export async function decideChangeRequest(
  db: Db,
  input: { changeRequestId: string; decision: 'approved' | 'rejected'; reason?: string; actorId: string },
) {
  const change = await db.get<Record<string, any>>('SELECT * FROM change_requests WHERE id = ?', [input.changeRequestId]);
  if (!change) throw notFound('Change request not found');
  // A decision is final. Allowing an approved change to be flipped to rejected
  // would let a commercial commitment disappear without a trace, so every
  // decided state is closed to re-decision. A reversal is a new change request,
  // which keeps the original decision, its reason and its author as evidence.
  if (['approved', 'rejected', 'implemented'].includes(String(change.status))) {
    throw conflict(
      `This change request is already ${change.status}. Raise a new one to reverse it — the original decision stays on record.`,
    );
  }
  await db.run(
    `UPDATE change_requests SET status = ?, decided_by = ?, decision_reason = ?, decided_at = ? WHERE id = ?`,
    [input.decision, input.actorId, input.reason ?? '', nowIso(), input.changeRequestId],
  );
  if (change.document_id) {
    await logApproval(db, change.document_id, input.decision === 'approved' ? 'approved' : 'rejected', input.actorId, input.reason ?? `Change request ${change.title}`);
  }
  return db.get('SELECT * FROM change_requests WHERE id = ?', [input.changeRequestId]);
}

/** Documents approaching expiry — the renewal watchlist. */
export async function expiringDocuments(db: Db, withinDays = 60) {
  // Date arithmetic is done in JavaScript, not SQL: `julianday()` is SQLite-only
  // and `INTERVAL` is PostgreSQL-only, and one portable statement is worth more
  // than a faster index scan on a table this small.
  const rows = await db.all<Record<string, any>>(
    `SELECT d.*, c.name AS client_name
       FROM legal_documents d JOIN clients c ON c.id = d.client_id
      WHERE d.expires_at IS NOT NULL AND d.status IN ('executed','awaiting_client')
      ORDER BY d.expires_at ASC`,
  );
  const now = Date.now();
  const observed: Array<Record<string, any>> = [];
  for (const row of rows) {
    const expires = Date.parse(String(row.expires_at));
    if (Number.isNaN(expires)) continue;
    const daysLeft = Math.floor((expires - now) / 86_400_000);
    if (daysLeft > withinDays) continue;
    observed.push({
      ...row,
      days_left: daysLeft,
      // A document already past its expiry date is flagged, not silently shown
      // as "0 days left".
      overdue: daysLeft < 0,
      renewal_due: daysLeft <= Number(row.renewal_notice_days ?? 30),
    });
  }
  return observed;
}
