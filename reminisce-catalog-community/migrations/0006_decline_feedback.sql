ALTER TABLE submissions ADD COLUMN decline_note TEXT NOT NULL DEFAULT '';

UPDATE submissions
SET decline_note = COALESCE((SELECT error FROM publish_jobs WHERE submission_id = submissions.id AND status = 'failed'), '')
WHERE status = 'declined'
  AND EXISTS (SELECT 1 FROM review_log WHERE submission_id = submissions.id AND action = 'auto-decline');
