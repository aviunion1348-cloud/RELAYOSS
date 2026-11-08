-- GENERATED from db/migrations/0011_comms_legal.sql — do not edit by hand.
-- Regenerate with: node scripts/gen-pg-migrations.mjs

-- ---------------------------------------------------------------------------
-- 0011 — Client communications (R43) and legal/commercial records (R44).
--
-- Both modules share a rule from the brief: never simulate delivery, and never
-- fabricate a legally binding signature. Provider-backed actions therefore have
-- an explicit `delivery_state` / `signature_state` that can only reach its
-- terminal value when a provider actually returned something. Without provider
-- configuration the record stays `unconfigured` or `manual`, and that is
-- displayed as such rather than dressed up as success.
-- ---------------------------------------------------------------------------

-- Communication threads: a conversation with a client, on one channel.
CREATE TABLE comm_threads (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL CHECK (channel IN ('email','whatsapp','call','meeting','portal')),
  subject      TEXT NOT NULL,
  external_ref TEXT NOT NULL DEFAULT '',
  owner_id     TEXT REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting_on_client','waiting_on_us','closed')),
  client_visible SMALLINT NOT NULL DEFAULT 1 CHECK (client_visible IN (0,1)),
  last_activity_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_comm_threads_client ON comm_threads(client_id, status);
CREATE INDEX idx_comm_threads_project ON comm_threads(project_id);

-- Individual messages. `delivery_state` is the truth about what actually
-- happened to the message, not what we hoped:
--   draft        — composed, not sent, never leaves the system
--   queued       — handed to a configured provider adapter
--   sent         — provider accepted it AND returned a message id
--   failed       — provider rejected it (error retained)
--   received     — inbound from the client
--   recorded     — logged after the fact from a channel we do not integrate
--   unconfigured — we wanted to send via a provider that is not configured
CREATE TABLE comm_messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES comm_threads(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('outbound','inbound','internal')),
  body            TEXT NOT NULL,
  author_id       TEXT REFERENCES users(id),
  author_name     TEXT NOT NULL DEFAULT '',
  delivery_state  TEXT NOT NULL DEFAULT 'draft'
                  CHECK (delivery_state IN ('draft','queued','sent','failed','received','recorded','unconfigured')),
  provider        TEXT NOT NULL DEFAULT '' CHECK (provider IN ('','smtp','whatsapp_cloud','manual')),
  provider_ref    TEXT NOT NULL DEFAULT '',
  provider_error  TEXT NOT NULL DEFAULT '',
  attachments     TEXT NOT NULL DEFAULT '',
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_comm_messages_thread ON comm_messages(thread_id, created_at);

-- Provider configuration is data, so the UI can say "unconfigured" truthfully
-- instead of guessing from environment presence.
CREATE TABLE comm_providers (
  key           TEXT PRIMARY KEY CHECK (key IN ('email','whatsapp')),
  label         TEXT NOT NULL,
  configured    INTEGER NOT NULL DEFAULT 0 CHECK (configured IN (0,1)),
  from_address  TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  configured_at TEXT,
  verified_at   TEXT
);

-- Follow-ups derived from communications and meetings.
CREATE TABLE comm_follow_ups (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  thread_id   TEXT REFERENCES comm_threads(id) ON DELETE CASCADE,
  note_id     TEXT,
  action      TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id),
  due_at      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_comm_followups_client ON comm_follow_ups(client_id, status);

-- ---------------------------------------------------------------------------
-- Legal / commercial
-- ---------------------------------------------------------------------------
CREATE TABLE legal_documents (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('nda','mou','contract','sow','dpa','change_request','entitlement')),
  title         TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','internal_review','awaiting_client','executed','expired','terminated')),
  -- Execution is never implied. `manual` means a signed copy was uploaded by a
  -- human; `esign` would require a real provider round-trip to reach `executed`.
  signature_state TEXT NOT NULL DEFAULT 'unsigned'
                CHECK (signature_state IN ('unsigned','manual_uploaded','awaiting_provider','signed','declined')),
  signature_provider TEXT NOT NULL DEFAULT '' CHECK (signature_provider IN ('','docusign','dropbox_sign','manual')),
  signature_ref TEXT NOT NULL DEFAULT '',
  storage_url   TEXT NOT NULL DEFAULT '',
  value_cents   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'INR',
  effective_at  TEXT,
  expires_at    TEXT,
  renewal_notice_days INTEGER NOT NULL DEFAULT 30,
  supersedes_id TEXT REFERENCES legal_documents(id),
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  updated_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  UNIQUE (client_id, kind, version)
);
CREATE INDEX idx_legal_client ON legal_documents(client_id, kind);

-- Signatories and their decisions. Append-only: a signature record is evidence.
CREATE TABLE legal_signatories (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
  party         TEXT NOT NULL CHECK (party IN ('agency','client')),
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','approved','signed','declined')),
  decided_at    TEXT,
  evidence_url  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_legal_signatories_doc ON legal_signatories(document_id);

-- Immutable approval trail for legal documents.
CREATE TABLE legal_approvals (
  id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('created','versioned','approved','rejected','sent_to_client','executed','terminated')),
  actor_id    TEXT REFERENCES users(id),
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_legal_approvals_doc ON legal_approvals(document_id, id);

-- Change requests and scope changes are legal records with commercial impact.
CREATE TABLE change_requests (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  document_id   TEXT REFERENCES legal_documents(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  impact_value_cents INTEGER NOT NULL DEFAULT 0,
  impact_days   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','under_review','approved','rejected','implemented')),
  requested_by  TEXT REFERENCES users(id),
  decided_by    TEXT REFERENCES users(id),
  decision_reason TEXT NOT NULL DEFAULT '',
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_change_requests_client ON change_requests(client_id, status);

-- Provider registry for signature + messaging, seeded so the UI can state the
-- truth about what is configured.
INSERT INTO comm_providers (key,label,configured,notes) VALUES
  ('email','Email (SMTP)',0,'Set SMTP_URL, SMTP_FROM and COMM_EMAIL_PROVIDER to enable delivery. Until then messages stay as drafts or recorded history.'),
  ('whatsapp','WhatsApp Cloud API',0,'Set WHATSAPP_TOKEN, WHATSAPP_PHONE_ID and COMM_WHATSAPP_PROVIDER to enable delivery. Until then messages stay as drafts or recorded history.');
