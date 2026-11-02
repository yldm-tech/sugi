-- Backup copies whose original was deleted (not taken down): kept for a grace period from `since`, then removed from the backup bucket (src/backup.ts).
CREATE TABLE backup_gone (
  key TEXT PRIMARY KEY,
  since INTEGER NOT NULL
);
