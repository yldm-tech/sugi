-- Moderation: takedown records, content and source blocklists, and an append-only admin audit log.

-- One row per removed file, legacy object or album. target is "file:<id>", "legacy:<key>" or "album:<id>". The bucket also keeps an empty marker object at a removed file's key, so the id is never handed out again and serving answers 451 without a database lookup.
CREATE TABLE tombstones (
  target TEXT PRIMARY KEY,
  reason TEXT,
  sha256 TEXT,
  source TEXT,
  created_at INTEGER NOT NULL
);

-- SHA-256 of removed content that must not be uploaded again.
CREATE TABLE blocked_hashes (
  sha256 TEXT PRIMARY KEY,
  target TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);

-- Source HMACs that may not upload; expires_at NULL means until lifted.
CREATE TABLE blocked_sources (
  source TEXT PRIMARY KEY,
  reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Every admin action, newest last. Never updated or deleted by the Worker.
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  reason TEXT,
  detail TEXT
);

CREATE INDEX tombstones_source ON tombstones(source);
