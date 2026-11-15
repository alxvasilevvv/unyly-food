-- Partner apps (Ari and future assistants) call Unyly server to server on behalf of their own users.
-- Partner credentials live in the environment; these tables hold the per-user mapping, replay protection,
-- outbound webhooks and the confirmations a partner app collected from its user.

CREATE TABLE IF NOT EXISTS partner_users (
  partner_id       text NOT NULL,
  external_user_id text NOT NULL,
  user_id          uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, external_user_id),
  CHECK (length(external_user_id) BETWEEN 1 AND 128)
);

-- Signed requests carry a nonce; a nonce is accepted once within the timestamp window.
CREATE TABLE IF NOT EXISTS partner_nonces (
  partner_id text NOT NULL,
  nonce      text NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, nonce)
);
CREATE INDEX IF NOT EXISTS partner_nonces_seen ON partner_nonces (seen_at);

-- Events for the partner app (order status, courier, payment). Delivered by the job worker with retries.
CREATE TABLE IF NOT EXISTS partner_webhooks (
  id            bigserial PRIMARY KEY,
  partner_id    text NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  event_id      uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  event_type    text NOT NULL,
  dedupe_key    text,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','skipped')),
  attempts      int NOT NULL DEFAULT 0,
  next_try_at   timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_webhooks_dedupe ON partner_webhooks (partner_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS partner_webhooks_due ON partner_webhooks (next_try_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS partner_webhooks_user ON partner_webhooks (user_id, id DESC);

-- What the partner app reported about the user's confirmation (tap, Face ID) for one checkout or cancellation.
CREATE TABLE IF NOT EXISTS partner_confirmations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        text NOT NULL,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity            text NOT NULL CHECK (entity IN ('checkout','cancellation')),
  entity_id         uuid NOT NULL,
  confirm_hash      text NOT NULL,
  user_verification text NOT NULL CHECK (user_verification IN ('tap','biometric','passcode')),
  device_id         text,
  confirmed_at      timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity, entity_id)
);

-- Grab account link state for partner users when Login with Grab is simulated in demo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_id text;
CREATE INDEX IF NOT EXISTS users_partner ON users (partner_id) WHERE partner_id IS NOT NULL;
