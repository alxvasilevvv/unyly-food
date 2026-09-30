-- Personal access tokens: for AI clients that accept a bearer token but not OAuth
-- (e.g. Mistral Le Chat, Copilot Studio, Perplexity, API integrations). Shown once, stored hashed.
CREATE TABLE IF NOT EXISTS personal_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  scopes       text[] NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS personal_tokens_user ON personal_tokens (user_id, created_at DESC);
