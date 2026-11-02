-- Operations: hourly counters (server errors and similar) and when each kind of alert email was last sent, so alerts are rate limited.
CREATE TABLE ops_counters (
  hour TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, name)
);

CREATE TABLE ops_alerts (
  name TEXT PRIMARY KEY,
  last_sent INTEGER NOT NULL
);
