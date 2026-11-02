-- Small pieces of state the Worker computes now and then and shows later, e.g. the bucket's size for the donate page (refreshed by the cron every few hours, since listing a large bucket is too slow for a page view). value is JSON.
CREATE TABLE ops_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at INTEGER NOT NULL
);
