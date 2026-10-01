-- GrabPay One-time Charge (OTC v2): payments, refunds and an idempotent event log.
-- Card data is never seen nor stored: Grab hosts the checkout. Grab tokens and PKCE verifiers are
-- stored AES-256-GCM encrypted (src/payments/service.ts), the OAuth state only as a SHA-256 hash.
-- Payments are financial records: deleting an account unlinks them (user_id / checkout_id SET NULL)
-- instead of erasing them.

CREATE TABLE IF NOT EXISTS payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  checkout_id        uuid REFERENCES checkouts(id) ON DELETE SET NULL,
  provider           text NOT NULL DEFAULT 'grabpay' CHECK (provider IN ('grabpay')),
  -- 32 hex derived from id; partner_group_tx_id from the checkout id (receipt level).
  partner_tx_id      text NOT NULL UNIQUE CHECK (partner_tx_id ~ '^[a-zA-Z0-9_-]{1,32}$'),
  partner_group_tx_id text NOT NULL CHECK (partner_group_tx_id ~ '^[a-zA-Z0-9_-]{1,32}$'),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  currency           text NOT NULL CHECK (currency IN ('SGD','MYR','PHP','IDR','THB')),
  status             text NOT NULL CHECK (status IN ('created','authorizing','authorized','captured','failed','refunding','refunded','unknown')),
  -- Which call left the payment in 'unknown' (init | token | complete), so reconcile knows what to check.
  unknown_stage      text CHECK (unknown_stage IN ('init','token','complete')),
  refunded_minor     bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  grab_tx_id         text,
  payment_method     text,
  grab_reason        text,
  state_hash         text UNIQUE,
  auth_secrets_enc   text,
  access_token_enc   text,
  code_claimed_at    timestamptz,
  init_at            timestamptz,
  authorized_at      timestamptz,
  captured_at        timestamptz,
  failed_at          timestamptz,
  last_status_check_at timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Never two live payments for one checkout: only a failed one can be followed by a new attempt.
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_active ON payments (checkout_id) WHERE status <> 'failed' AND checkout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_user ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_open ON payments (status, updated_at) WHERE status IN ('created','authorizing','authorized','unknown','refunding');

CREATE TABLE IF NOT EXISTS payment_refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  idem_key       text NOT NULL,
  partner_tx_id  text NOT NULL UNIQUE CHECK (partner_tx_id ~ '^[a-zA-Z0-9_-]{1,32}$'),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  reason         text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','processing','success','failed','unknown')),
  grab_tx_id     text,
  grab_reason    text,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, idem_key)
);

-- Webhooks (deduplicated by event_key) and internal milestones such as the captured hook, which
-- runs at most once per payment thanks to the same uniqueness.
CREATE TABLE IF NOT EXISTS payment_events (
  id           bigserial PRIMARY KEY,
  payment_id   uuid REFERENCES payments(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('webhook','internal')),
  event_key    text NOT NULL UNIQUE,
  tx_type      text,
  tx_status    text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome      text,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_events_payment ON payment_events (payment_id, id);
