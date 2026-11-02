-- Daily upload totals for quotas and the ops report. scope is "global", "src:<source HMAC>" or "user:<account id>"; day is the UTC date (YYYY-MM-DD). Rows older than a few days are deleted by the cron.
CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);
