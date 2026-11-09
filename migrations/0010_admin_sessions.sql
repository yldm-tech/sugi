-- Sessions of the admin dashboard (src/admin). id_hash is the SHA-256 of the session cookie; token_hash is the SHA-256 of the admin token used to sign in, checked again on every request, so rotating ADMIN_TOKEN or revoking a personal admin token ends the sessions opened with it. label says which token that was (ADMIN_TOKEN, or the account and prefix of a personal token).
CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX admin_sessions_expires ON admin_sessions(expires_at);
