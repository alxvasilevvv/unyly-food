-- Unyly initial schema.
-- Conventions: all timestamps are timestamptz (stored UTC); money is BIGINT in minor units + ISO 4217 code.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  locale        text NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru','en')),
  region        text NOT NULL DEFAULT 'TH',
  mode          text NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo','handoff','live')),
  onboarded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX users_email_active ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE login_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    int  NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_email ON login_codes (lower(email), created_at DESC);

CREATE TABLE web_sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text NOT NULL,
  line1       text NOT NULL,
  district    text NOT NULL,
  city        text NOT NULL,
  country     text NOT NULL,
  instructions text,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX addresses_user ON addresses (user_id) WHERE deleted_at IS NULL;

CREATE TABLE preferences (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dietary     jsonb NOT NULL DEFAULT '[]',   -- lifestyle choices, e.g. ["vegetarian"]
  allergies   jsonb NOT NULL DEFAULT '[]',   -- safety-relevant, e.g. ["peanut","tree_nut"]
  default_party_size int NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_connections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text NOT NULL,            -- 'grab'
  mode        text NOT NULL CHECK (mode IN ('demo','handoff','live')),
  status      text NOT NULL CHECK (status IN ('connected','revoked')),
  external_ref text,                    -- live only; never a secret
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX provider_connections_active ON provider_connections (user_id, provider, mode) WHERE status = 'connected';

-- OAuth 2.1 authorization server state (Unyly is the AS for its own MCP resource).
CREATE TABLE oauth_clients (
  client_id     text PRIMARY KEY,
  client_name   text NOT NULL,
  redirect_uris jsonb NOT NULL,
  registration  text NOT NULL CHECK (registration IN ('dcr','cimd')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   text NOT NULL,
  client_name text NOT NULL,
  scopes      text[] NOT NULL,
  resource    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX oauth_grants_user ON oauth_grants (user_id);

CREATE TABLE oauth_codes (
  code_hash      text PRIMARY KEY,
  grant_id       uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id      text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz
);

CREATE TABLE oauth_tokens (
  token_hash  text PRIMARY KEY,
  grant_id    uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('access','refresh')),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,               -- refresh token rotation
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);

-- Carts. Items live in cart_versions; carts.version points at the current one.
CREATE TABLE carts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode          text NOT NULL CHECK (mode IN ('demo','handoff','live')),
  restaurant_id text,                   -- provider restaurant id (null in handoff)
  restaurant_name text NOT NULL,
  version       int  NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ordered','abandoned')),
  source_order_id uuid,                 -- set when created by "reorder"
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX carts_user ON carts (user_id, created_at DESC);

CREATE TABLE cart_versions (
  cart_id     uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  items       jsonb NOT NULL,           -- [{line_id,item_id,name,quantity,modifiers,note}]
  address_id  uuid REFERENCES addresses(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, version)
);

CREATE TABLE quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cart_id       uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  cart_version  int  NOT NULL,
  mode          text NOT NULL,
  currency      text NOT NULL,
  lines         jsonb NOT NULL,
  subtotal_minor      bigint NOT NULL,
  delivery_fee_minor  bigint NOT NULL,
  service_fee_minor   bigint NOT NULL,
  small_order_fee_minor bigint NOT NULL,
  discount_minor      bigint NOT NULL,
  total_minor         bigint NOT NULL,
  eta_min_minutes int,
  eta_max_minutes int,
  issues        jsonb NOT NULL DEFAULT '[]',
  checkout_allowed boolean NOT NULL,
  price_source  text NOT NULL,
  payment_method_label text NOT NULL,
  cancellation_terms text NOT NULL,
  address_fingerprint text NOT NULL,
  quote_hash    text NOT NULL,
  fetched_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_cart ON quotes (cart_id, created_at DESC);

-- A checkout is the human-approval object. It binds user, cart version, quote, address, amount, currency, expiry.
CREATE TABLE checkouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cart_id       uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  cart_version  int  NOT NULL,
  quote_id      uuid NOT NULL REFERENCES quotes(id),
  mode          text NOT NULL,
  address_fingerprint text NOT NULL,
  total_minor   bigint NOT NULL,
  currency      text NOT NULL,
  payment_method_label text NOT NULL,
  cancellation_terms text NOT NULL,
  status        text NOT NULL CHECK (status IN ('awaiting_user','approved','consumed','expired','invalidated','declined')),
  invalid_reason text,
  expires_at    timestamptz NOT NULL,
  approved_at   timestamptz,
  approved_via  text,
  consumed_at   timestamptz,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkouts_cart ON checkouts (cart_id);

-- One submission attempt per checkout, ever. This is the core double-order guard.
CREATE TABLE submission_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id     uuid NOT NULL UNIQUE REFERENCES checkouts(id),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode            text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN ('in_flight','accepted','rejected','unknown')),
  provider_order_ref text,
  error_code      text,
  error_detail    text,
  reconcile_attempts int NOT NULL DEFAULT 0,
  next_reconcile_at timestamptz,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX submission_attempts_reconcile ON submission_attempts (next_reconcile_at) WHERE status IN ('in_flight','unknown');

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkout_id     uuid NOT NULL UNIQUE REFERENCES checkouts(id),
  submission_id   uuid NOT NULL UNIQUE REFERENCES submission_attempts(id),
  cart_id         uuid NOT NULL REFERENCES carts(id),
  mode            text NOT NULL,
  provider        text NOT NULL,
  provider_order_ref text NOT NULL,
  restaurant_id   text,
  restaurant_name text NOT NULL,
  items           jsonb NOT NULL,
  address_label   text NOT NULL,
  total_minor     bigint NOT NULL,
  currency        text NOT NULL,
  fulfillment_status text NOT NULL,
  payment_status  text NOT NULL,
  status_version  int NOT NULL DEFAULT 0,       -- provider sequence of last applied event
  status_updated_at timestamptz NOT NULL DEFAULT now(),
  eta_at          timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_ref)
);
CREATE INDEX orders_user ON orders (user_id, created_at DESC);

CREATE TABLE cancellation_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  fee_minor     bigint NOT NULL,
  currency      text NOT NULL,
  terms         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('awaiting_user','approved','executing','executed','rejected','expired','unknown','invalidated')),
  expires_at    timestamptz NOT NULL,
  approved_at   timestamptz,
  executed_at   timestamptz,
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cancellation_one_active ON cancellation_requests (order_id) WHERE status IN ('approved','executing','executed');

CREATE TABLE handoffs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cart_id     uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  cart_version int NOT NULL,
  url         text NOT NULL,
  checklist   jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Provider events (webhooks or polled). Persisted before processing, deduplicated by (provider, event_id).
CREATE TABLE provider_events (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  event_id      text NOT NULL,
  order_ref     text NOT NULL,
  sequence      int  NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  outcome       text,
  UNIQUE (provider, event_id)
);
CREATE INDEX provider_events_unprocessed ON provider_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid,
  actor       text NOT NULL,            -- 'web', 'mcp:<client_id>', 'system', 'provider:<name>'
  action      text NOT NULL,
  mode        text,
  entity      text,
  entity_id   text,
  details     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_action ON audit_log (action, created_at DESC);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES ('submissions', '{"demo": true, "live": false}');

-- ---------------------------------------------------------------------------
-- Demo provider simulator state. This models the *remote* side of a provider
-- (it would live at Grab in Live mode). Kept in the same database for simplicity.
CREATE TABLE demo_sim_orders (
  ref              text PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE,
  payload          jsonb NOT NULL,
  total_minor      bigint NOT NULL,
  status           text NOT NULL,
  sequence         int NOT NULL DEFAULT 1,
  accepted_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  last_emitted_seq int NOT NULL DEFAULT 0
);
