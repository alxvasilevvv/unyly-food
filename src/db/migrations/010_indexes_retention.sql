-- 010: indexes for background job queries, retention deletes and FK cascades (account deletion).
-- Plain CREATE INDEX (not CONCURRENTLY) because each migration runs in a transaction; tables are small
-- at this stage. On a large production table, create the index CONCURRENTLY by hand first with the same
-- name; IF NOT EXISTS then makes this migration a no-op for it.

-- Job: expire stale confirmations.
CREATE INDEX IF NOT EXISTS checkouts_open_expiry ON checkouts (status, expires_at) WHERE status IN ('awaiting_user','approved');
-- Job: reconcile cancellations.
CREATE INDEX IF NOT EXISTS cancellation_requests_status ON cancellation_requests (status);
-- Retention.
CREATE INDEX IF NOT EXISTS web_sessions_expires ON web_sessions (expires_at);
CREATE INDEX IF NOT EXISTS oauth_tokens_expires ON oauth_tokens (expires_at);
CREATE INDEX IF NOT EXISTS login_codes_created ON login_codes (created_at);
-- webauthn_challenges has no created_at column (003); retention keys on expires_at.
CREATE INDEX IF NOT EXISTS webauthn_challenges_expires ON webauthn_challenges (expires_at);
CREATE INDEX IF NOT EXISTS provider_events_processed ON provider_events (processed_at) WHERE processed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_grants_client ON oauth_grants (client_id);
-- Demo simulator tick scans open orders only.
CREATE INDEX IF NOT EXISTS demo_sim_orders_open ON demo_sim_orders (ref) WHERE status NOT IN ('delivered','cancelled');
-- Orders by provider reference are already covered by UNIQUE (provider, provider_order_ref) from 001.

-- FK columns without an index (ON DELETE CASCADE / SET NULL would otherwise seq-scan the child table).
CREATE INDEX IF NOT EXISTS web_sessions_user ON web_sessions (user_id);
CREATE INDEX IF NOT EXISTS handoffs_user ON handoffs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS handoffs_cart ON handoffs (cart_id);
CREATE INDEX IF NOT EXISTS quotes_user ON quotes (user_id);
CREATE INDEX IF NOT EXISTS checkouts_user ON checkouts (user_id);
CREATE INDEX IF NOT EXISTS checkouts_quote ON checkouts (quote_id);
CREATE INDEX IF NOT EXISTS submission_attempts_user ON submission_attempts (user_id);
CREATE INDEX IF NOT EXISTS orders_cart ON orders (cart_id);
CREATE INDEX IF NOT EXISTS cancellation_requests_user ON cancellation_requests (user_id);
CREATE INDEX IF NOT EXISTS cancellation_requests_order ON cancellation_requests (order_id);
CREATE INDEX IF NOT EXISTS oauth_codes_grant ON oauth_codes (grant_id);
CREATE INDEX IF NOT EXISTS cart_versions_address ON cart_versions (address_id) WHERE address_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS webauthn_challenges_user ON webauthn_challenges (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_connections_user ON provider_connections (user_id);
