-- An index of the stored files for the admin dashboard (src/fileindex.ts): R2 lists keys only in name order, so "newest uploads", filters and file name search need a table. Rows are written when a file is stored or restored and removed when it is deleted, expires or is taken down; the cron also walks the bucket page by page and repairs any difference, which is how files from before this table get in. key is the R2 key (f/<id>, t/<id> or a legacy <16 hex>.<ext>); type is the MIME type; times are milliseconds. Ownership stays in user_files.
CREATE TABLE file_index (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  type TEXT,
  name TEXT,
  source TEXT,
  sha256 TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE INDEX file_index_created ON file_index(created_at);
CREATE INDEX file_index_source ON file_index(source, created_at);
CREATE INDEX file_index_sha256 ON file_index(sha256);
CREATE INDEX file_index_size ON file_index(size);
