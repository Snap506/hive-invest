-- Price history for pattern analysis: one row per series per day (t = unix seconds at 00:00 UTC).
CREATE TABLE IF NOT EXISTS bars (
  series TEXT NOT NULL,
  t      INTEGER NOT NULL,
  c      REAL NOT NULL,
  PRIMARY KEY (series, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hist_meta (
  series     TEXT PRIMARY KEY,
  source     TEXT,
  error      TEXT,
  updated_at INTEGER,
  cursor     INTEGER
);
