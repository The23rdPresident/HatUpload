ALTER TABLE publish_jobs ADD COLUMN announcement_source TEXT NOT NULL DEFAULT 'game' CHECK(announcement_source IN ('game','worker'));

CREATE TABLE publish_webhooks (
  submission_id TEXT PRIMARY KEY REFERENCES publish_jobs(submission_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  universe_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','uncertain','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX publish_webhooks_due ON publish_webhooks(status,next_attempt,lease_until);
