CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('official','reskin','owner')),
  username TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
  base_json TEXT NOT NULL CHECK(json_valid(base_json)),
  texture_json TEXT CHECK(texture_json IS NULL OR json_valid(texture_json)),
  owner_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  receipt_hash TEXT UNIQUE,
  fingerprint TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS submissions_status_created ON submissions(status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS submissions_duplicates ON submissions(fingerprint,ip_hash,created_at);
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_sessions_expiry ON owner_sessions(expires_at);
CREATE TABLE IF NOT EXISTS rate_windows (
  scope TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY(scope,window_start)
);
CREATE TABLE IF NOT EXISTS review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL,
  action TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  session_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_log_created ON review_log(created_at);
