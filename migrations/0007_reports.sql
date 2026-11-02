-- Reports sent with the report form on file and album pages (or POST /api/reports). target is "file:<id>", "legacy:<key>" or "album:<id>"; reason is one of csam, illegal, copyright, privacy, spam, other. source is an HMAC of the reporter's IP, used only for rate limiting and erased after 7 days. notified_at is when the report went out in an email digest to the abuse address; resolved_at, resolution ("removed" or "dismissed") and note are set by an admin. Resolved reports are deleted a year after they were resolved.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  contact TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  resolved_at INTEGER,
  resolution TEXT,
  note TEXT
);

CREATE INDEX reports_open ON reports(resolved_at, created_at);
CREATE INDEX reports_source ON reports(source, created_at);
CREATE INDEX reports_target ON reports(target);
CREATE INDEX reports_created ON reports(created_at);
