CREATE TABLE IF NOT EXISTS publish_jobs (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
  job_id TEXT NOT NULL UNIQUE,
  record_version INTEGER NOT NULL,
  universe_id TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
  base_json TEXT NOT NULL CHECK(json_valid(base_json)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','publishing','published','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  published_at INTEGER,
  catalog_version INTEGER,
  notification TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS publish_jobs_due ON publish_jobs(status,next_attempt,lease_until);
