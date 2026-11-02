-- Mail received at the single end-to-end test address (E2E_INBOX), so automated tests can complete an email login. Rows live at most an hour (cron) and the table is capped at 50 rows.
CREATE TABLE e2e_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  mail_from TEXT,
  subject TEXT,
  body TEXT NOT NULL
);
