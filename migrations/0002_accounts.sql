-- Optional accounts (FEATURE_ACCOUNTS). Secrets are stored only as SHA-256 hashes: session cookies, magic link tokens and API tokens.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- Lower-case; null for accounts created with a passkey only or with a provider that shared no verified email.
  email TEXT UNIQUE,
  name TEXT,
  created_at INTEGER NOT NULL
);

-- One row per way of logging in: provider is "email", "github" or "google"; subject is the email address or the provider's user id.
CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE passkeys (
  -- WebAuthn credential id, base64url.
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  -- HMAC of the requester's IP, for per-source rate limits.
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX magic_links_email ON magic_links(email, created_at);
CREATE INDEX magic_links_source ON magic_links(source, created_at);
CREATE INDEX magic_links_created ON magic_links(created_at);

-- Short-lived WebAuthn challenges, referenced by an HttpOnly cookie.
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  -- First characters of the token, so people can tell their tokens apart.
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- Which uploads and albums belong to which account.
CREATE TABLE user_files (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_key)
);
CREATE INDEX user_files_key ON user_files(file_key);

CREATE TABLE user_albums (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, album_id)
);
CREATE INDEX user_albums_album ON user_albums(album_id);
