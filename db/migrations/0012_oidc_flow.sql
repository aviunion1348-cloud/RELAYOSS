-- ---------------------------------------------------------------------------
-- 0012 — OIDC authorization-code flow state (R5, R6).
--
-- The exchange endpoint already verified a token, but a browser redirect flow
-- needs two things a bearer exchange does not: a one-time, server-stored
-- authorisation request (so `state` cannot be replayed or forged) and a `nonce`
-- bound to that request (so an ID token minted for a different session cannot be
-- substituted). Both live here, keyed by state, single-use.
-- ---------------------------------------------------------------------------
CREATE TABLE oidc_flows (
  state           TEXT PRIMARY KEY,
  nonce           TEXT NOT NULL,
  code_verifier   TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  return_to       TEXT NOT NULL DEFAULT '/',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  failed_reason   TEXT NOT NULL DEFAULT '',
  ip              TEXT NOT NULL DEFAULT '',
  user_agent      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_oidc_flows_expiry ON oidc_flows(expires_at);

-- Tokens are never stored; only the fact that a flow completed, for the audit.
CREATE TABLE oidc_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  state       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('authorize','callback_ok','callback_failed','logout')),
  subject     TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_oidc_audit_state ON oidc_audit(state);
