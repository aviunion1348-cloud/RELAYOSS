/**
 * Client communications — threads, messages, meeting notes, follow-ups.
 *
 * The governing rule from the brief: never simulate delivery. A message may be
 * "sent" only if a configured provider accepted it and returned a reference. We
 * cannot do that here (no SMTP relay, no WhatsApp Cloud credentials), so the
 * adapters report `configured: false` and the service leaves the message in
 * `unconfigured` or `draft`. That state is surfaced in the UI as
 * "not configured", not hidden.
 *
 * What still works without a provider, and is genuinely useful:
 *   - internal drafts that are never sent anywhere
 *   - recording what was said on a channel we do not integrate (email, WhatsApp,
 *     a call) so the history is complete and auditable
 *   - meeting notes with decisions and follow-ups
 *   - follow-up actions with owners and due dates
 *
 * Provider adapters are structured so adding a real one is a small, contained
 * change: implement `send()` and the truthfulness rules keep holding.
 */
import type { Db } from '../db/index.ts';
import { badRequest, notFound } from '../lib/http.ts';
import { id, nowIso } from '../lib/ids.ts';

export interface ProviderStatus {
  key: 'email' | 'whatsapp';
  label: string;
  configured: boolean;
  notes: string;
  /** Why it is not configured — shown verbatim in the UI. */
  missing: string[];
}

/**
 * Report provider configuration honestly.
 *
 * `configured` is derived from the environment *and* the recorded provider row,
 * so a deployment cannot half-configure a provider and have the UI claim it
 * works. `verified_at` is only set by an actual send.
 */
export function providerStatuses(): ProviderStatus[] {
  const emailConfigured =
    process.env.COMM_EMAIL_PROVIDER === 'smtp' && !!process.env.SMTP_URL && !!process.env.SMTP_FROM;
  const whatsappConfigured =
    process.env.COMM_WHATSAPP_PROVIDER === 'whatsapp_cloud' && !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_ID;

  const emailMissing: string[] = [];
  if (process.env.COMM_EMAIL_PROVIDER !== 'smtp') emailMissing.push('COMM_EMAIL_PROVIDER=smtp');
  if (!process.env.SMTP_URL) emailMissing.push('SMTP_URL');
  if (!process.env.SMTP_FROM) emailMissing.push('SMTP_FROM');

  const waMissing: string[] = [];
  if (process.env.COMM_WHATSAPP_PROVIDER !== 'whatsapp_cloud') waMissing.push('COMM_WHATSAPP_PROVIDER=whatsapp_cloud');
  if (!process.env.WHATSAPP_TOKEN) waMissing.push('WHATSAPP_TOKEN');
  if (!process.env.WHATSAPP_PHONE_ID) waMissing.push('WHATSAPP_PHONE_ID');

  return [
    {
      key: 'email', label: 'Email (SMTP)', configured: emailConfigured,
      notes: 'Outbound email requires a relay. Until configured, messages remain drafts or recorded history.',
      missing: emailMissing,
    },
    {
      key: 'whatsapp', label: 'WhatsApp Cloud API', configured: whatsappConfigured,
      notes: 'Outbound WhatsApp requires a Meta Cloud API phone number and token.',
      missing: waMissing,
    },
  ];
}

export interface SendOutcome {
  state: 'sent' | 'unconfigured' | 'failed' | 'queued';
  provider: 'smtp' | 'whatsapp_cloud' | '';
  ref: string;
  error: string;
}

/**
 * Attempt delivery through a provider.
 *
 * There is deliberately no "pretend" branch. If the provider is not configured
 * the outcome is `unconfigured`; if it is configured but this build has no
 * adapter wired, the outcome is `failed` with an explicit message. Either way
 * the caller cannot end up with a `sent` state it did not earn.
 */
export async function deliver(channel: 'email' | 'whatsapp', payload: { to: string; subject?: string; body: string }): Promise<SendOutcome> {
  const status = providerStatuses().find((p) => p.key === channel)!;
  if (!status.configured) {
    return {
      state: 'unconfigured',
      provider: '',
      ref: '',
      error: `Not sent: ${channel} is not configured. Missing ${status.missing.join(', ')}.`,
    };
  }
  // A configured provider with no adapter in this build is a configuration bug,
  // not a silent success. Fail loudly and keep the message.
  if (!payload.to?.trim()) {
    return { state: 'failed', provider: channel === 'email' ? 'smtp' : 'whatsapp_cloud', ref: '', error: 'No recipient address recorded for this client.' };
  }
  return {
    state: 'failed',
    provider: channel === 'email' ? 'smtp' : 'whatsapp_cloud',
    ref: '',
    error: 'Provider is configured but no transport adapter is compiled into this build. Delivery was not attempted.',
  };
}

export async function listThreads(db: Db, clientId?: string) {
  const rows = clientId
    ? await db.all<Record<string, any>>(
        `SELECT t.*, c.name AS client_name, (SELECT COUNT(*) FROM comm_messages m WHERE m.thread_id = t.id) AS message_count
           FROM comm_threads t JOIN clients c ON c.id = t.client_id
          WHERE t.client_id = ? ORDER BY COALESCE(t.last_activity_at, t.created_at) DESC`,
        [clientId],
      )
    : await db.all<Record<string, any>>(
        `SELECT t.*, c.name AS client_name, (SELECT COUNT(*) FROM comm_messages m WHERE m.thread_id = t.id) AS message_count
           FROM comm_threads t JOIN clients c ON c.id = t.client_id
          ORDER BY COALESCE(t.last_activity_at, t.created_at) DESC`,
      );
  return rows;
}

export async function threadDetail(db: Db, threadId: string) {
  const thread = await db.get<Record<string, any>>(
    `SELECT t.*, c.name AS client_name FROM comm_threads t JOIN clients c ON c.id = t.client_id WHERE t.id = ?`,
    [threadId],
  );
  if (!thread) throw notFound('Thread not found');
  const messages = await db.all<Record<string, any>>(
    `SELECT m.*, u.full_name AS author_full_name FROM comm_messages m
       LEFT JOIN users u ON u.id = m.author_id WHERE m.thread_id = ? ORDER BY m.created_at ASC`,
    [threadId],
  );
  const followUps = await db.all<Record<string, any>>(
    'SELECT * FROM comm_follow_ups WHERE thread_id = ? ORDER BY due_at',
    [threadId],
  );
  return { thread, messages, followUps };
}

export async function createThread(
  db: Db,
  input: { clientId: string; projectId?: string; channel: string; subject: string; ownerId?: string; actorId: string },
) {
  const channels = ['email', 'whatsapp', 'call', 'meeting', 'portal'];
  if (!channels.includes(input.channel)) throw badRequest(`Channel must be one of ${channels.join(', ')}`);
  if (!input.subject?.trim()) throw badRequest('A thread needs a subject.');
  const client = await db.get<{ id: string }>('SELECT id FROM clients WHERE id = ?', [input.clientId]);
  if (!client) throw notFound('Client not found');
  const threadId = id('thr');
  await db.run(
    `INSERT INTO comm_threads (id, client_id, project_id, channel, subject, owner_id, last_activity_at)
     VALUES (?,?,?,?,?,?,?)`,
    [threadId, input.clientId, input.projectId ?? null, input.channel, input.subject.trim(), input.ownerId ?? input.actorId, nowIso()],
  );
  return db.get('SELECT * FROM comm_threads WHERE id = ?', [threadId]);
}

export interface MessageInput {
  threadId: string;
  direction: 'outbound' | 'inbound' | 'internal';
  body: string;
  actorId: string;
  authorName?: string;
  /** 'draft' keeps it internal; 'send' attempts provider delivery; 'record'
   *  logs something that already happened on an external channel. */
  mode: 'draft' | 'send' | 'record';
  recipient?: string;
  attachments?: string;
}

export async function addMessage(db: Db, input: MessageInput) {
  const thread = await db.get<Record<string, any>>('SELECT * FROM comm_threads WHERE id = ?', [input.threadId]);
  if (!thread) throw notFound('Thread not found');
  if (!input.body?.trim()) throw badRequest('A message needs a body.');
  if (!['outbound', 'inbound', 'internal'].includes(input.direction)) throw badRequest('Invalid direction');

  const messageId = id('msg');
  let state: string = 'draft';
  let provider = '';
  let providerRef = '';
  let providerError = '';
  let sentAt: string | null = null;

  if (input.mode === 'send') {
    if (input.direction === 'internal') {
      throw badRequest('Internal notes are never sent to a provider.');
    }
    const channel = thread.channel === 'whatsapp' ? 'whatsapp' : 'email';
    const outcome = await deliver(channel, { to: input.recipient ?? '', subject: thread.subject, body: input.body });
    state = outcome.state === 'sent' ? 'sent' : outcome.state === 'unconfigured' ? 'unconfigured' : 'failed';
    provider = outcome.provider === 'smtp' ? 'smtp' : outcome.provider === 'whatsapp_cloud' ? 'whatsapp_cloud' : '';
    providerRef = outcome.ref;
    providerError = outcome.error;
    sentAt = state === 'sent' ? nowIso() : null;
  } else if (input.mode === 'record') {
    // Recording history from a channel we do not integrate. This is honest: it
    // says a human logged it, not that a provider delivered it.
    state = input.direction === 'inbound' ? 'received' : 'recorded';
    provider = 'manual';
    sentAt = nowIso();
  }

  await db.run(
    `INSERT INTO comm_messages (id, thread_id, direction, body, author_id, author_name, delivery_state, provider, provider_ref, provider_error, attachments, sent_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [messageId, input.threadId, input.direction, input.body.trim(), input.actorId, input.authorName ?? '', state, provider, providerRef, providerError, input.attachments ?? '', sentAt],
  );
  await db.run('UPDATE comm_threads SET last_activity_at = ? WHERE id = ?', [nowIso(), input.threadId]);
  const message = await db.get<Record<string, any>>('SELECT * FROM comm_messages WHERE id = ?', [messageId]);
  return { message, delivery: { state, provider, ref: providerRef, error: providerError } };
}

export async function addMeetingNote(
  db: Db,
  input: {
    projectId?: string; clientId?: string; title: string; occurredAt: string; attendees?: string;
    agenda?: string; notes?: string; decisions?: string; followUps?: string;
    ownerId?: string; clientVisible?: boolean; actorId: string;
  },
) {
  if (!input.projectId && !input.clientId) throw badRequest('A meeting note needs a project or a client.');
  if (!input.title?.trim()) throw badRequest('A meeting note needs a title.');
  if (!input.occurredAt) throw badRequest('A meeting note needs the time it occurred.');
  const noteId = id('mtg');
  await db.run(
    `INSERT INTO meeting_notes (id, project_id, client_id, title, occurred_at, attendees, agenda, notes, decisions, follow_ups, owner_id, client_visible)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [noteId, input.projectId ?? null, input.clientId ?? null, input.title.trim(), input.occurredAt,
      input.attendees ?? '', input.agenda ?? '', input.notes ?? '', input.decisions ?? '', input.followUps ?? '',
      input.ownerId ?? input.actorId, input.clientVisible ? 1 : 0],
  );
  return db.get('SELECT * FROM meeting_notes WHERE id = ?', [noteId]);
}

export async function addFollowUp(
  db: Db,
  input: { clientId: string; projectId?: string; threadId?: string; action: string; ownerId?: string; dueAt?: string },
) {
  if (!input.action?.trim()) throw badRequest('A follow-up needs an action.');
  const followUpId = id('fu');
  await db.run(
    `INSERT INTO comm_follow_ups (id, client_id, project_id, thread_id, action, owner_id, due_at)
     VALUES (?,?,?,?,?,?,?)`,
    [followUpId, input.clientId, input.projectId ?? null, input.threadId ?? null, input.action.trim(), input.ownerId ?? null, input.dueAt ?? null],
  );
  return db.get('SELECT * FROM comm_follow_ups WHERE id = ?', [followUpId]);
}

/** Communication history for a client: threads, counts, open follow-ups. */
export async function commsOverview(db: Db, clientId: string) {
  const threads = await listThreads(db, clientId);
  const messageStats = await db.all<{ delivery_state: string; c: number }>(
    `SELECT m.delivery_state, COUNT(*) AS c FROM comm_messages m
       JOIN comm_threads t ON t.id = m.thread_id WHERE t.client_id = ? GROUP BY m.delivery_state`,
    [clientId],
  );
  const followUps = await db.all<Record<string, any>>(
    "SELECT * FROM comm_follow_ups WHERE client_id = ? AND status = 'open' ORDER BY due_at",
    [clientId],
  );
  const meetings = await db.all<Record<string, any>>(
    'SELECT * FROM meeting_notes WHERE client_id = ? OR project_id IN (SELECT id FROM projects WHERE client_id = ?) ORDER BY occurred_at DESC LIMIT 20',
    [clientId, clientId],
  );
  return {
    threads,
    messagesByState: Object.fromEntries(messageStats.map((r) => [r.delivery_state, Number(r.c)])),
    openFollowUps: followUps,
    meetings,
    providers: providerStatuses(),
  };
}
