-- GENERATED from db/migrations/0014_password_login.sql — do not edit by hand.
-- Regenerate with: node scripts/gen-pg-migrations.mjs

-- Shared-credential login (Argon2id) — the requested single internal login.
--
-- Previously there were two ways in: OIDC (correct, but needs an operator IdP) and
-- a development login that trusted a supplied user id. Neither matches the
-- requested access model, which is one shared username and password.
--
-- The credential is stored only as an Argon2id hash. The plaintext never appears
-- in the repository, the database, a log line or an API response. Argon2id's
-- encoded form carries its own cost parameters and salt, so it is stored verbatim.
CREATE TABLE local_credentials (
  id            TEXT PRIMARY KEY,
  -- The identity this credential authenticates. The shared login maps to one
  -- provisioned user with an explicit role, so the whole authorisation model
  -- (roles, project grants, client and partner scope) keeps working unchanged.
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  updated_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  -- Revoking the shared credential without destroying the audit trail.
  disabled_at   TEXT,
  last_used_at  TEXT,
  -- Bumped on every rotation. Sessions record the version they were minted with,
  -- so a password change invalidates every live session without needing to
  -- enumerate and delete rows.
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_local_credentials_user ON local_credentials(user_id);

-- Sessions must be able to say how they were authenticated. `password` is a
-- distinct method from `dev`: conflating them would let the boot guard's
-- production rules and the audit trail treat a real login as a demo one.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt. The
-- data is preserved; there is no default and no implicit re-authentication.
CREATE TABLE sessions_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method        TEXT NOT NULL DEFAULT 'oidc' CHECK (method IN ('oidc','dev','password')),
  token_hash    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  last_seen_at  TEXT,
  revoked_at    TEXT,
  user_agent    TEXT,
  ip            TEXT,
  -- The credential version in force when this session was created. NULL for OIDC
  -- and dev sessions, which are not governed by the shared credential.
  credential_version INTEGER
);

INSERT INTO sessions_new (id, user_id, method, token_hash, expires_at, created_at, last_seen_at, revoked_at, user_agent, ip)
  SELECT id, user_id, method, token_hash, expires_at, created_at, last_seen_at, revoked_at, user_agent, ip FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX idx_sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
