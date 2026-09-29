-- Review fixes (additive only).
ALTER TABLE cancellation_requests ADD COLUMN executing_at timestamptz;
ALTER TABLE provider_events ADD COLUMN tries int NOT NULL DEFAULT 0;
ALTER TABLE provider_events ADD COLUMN next_try_at timestamptz;
DROP INDEX IF EXISTS provider_events_unprocessed;
CREATE INDEX provider_events_unprocessed ON provider_events (id) WHERE processed_at IS NULL;
-- Attempts closed as NOT_RECEIVED are re-checked for 24h in case the provider created the order late.
CREATE INDEX submission_attempts_late_check ON submission_attempts (next_reconcile_at) WHERE status = 'rejected' AND error_code = 'NOT_RECEIVED_BY_PROVIDER';
