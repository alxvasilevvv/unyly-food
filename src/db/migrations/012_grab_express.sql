-- Live mode: GrabExpress deliveries and Farefeed ride estimates (src/providers/grab/*).
-- Additive only.

-- Exact coordinates (stored with 6 decimals) and a contact for real couriers. Optional: Demo and Handoff
-- do not need them. Addresses stay immutable; deleting one scrubs these columns too.
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE addresses DROP CONSTRAINT IF EXISTS addresses_coordinates_check;
ALTER TABLE addresses ADD CONSTRAINT addresses_coordinates_check CHECK (
  (latitude IS NULL AND longitude IS NULL)
  OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
);

-- One row per create attempt, keyed by merchantOrderID (= submission_attempts.id). Written BEFORE the
-- create call (state 'sending'), so a crash or timeout leaves a record that forbids a second POST.
-- GrabExpress has no GET by merchantOrderID: deliveryID is stored as soon as the create response (or a
-- tracking webhook carrying merchantOrderID) arrives.
CREATE TABLE IF NOT EXISTS grab_deliveries (
  merchant_order_id text PRIMARY KEY,
  idempotency_key   text NOT NULL UNIQUE,
  submission_id     uuid REFERENCES submission_attempts(id) ON DELETE SET NULL,
  delivery_id       text UNIQUE,
  -- provider_order_ref given to Unyly's order (deliveryID, or 'merchant:<id>' for a delivery cancelled
  -- by merchantOrderID while its deliveryID was still unknown).
  order_ref         text,
  state             text NOT NULL CHECK (state IN ('sending','created','unknown','rejected','not_sent','not_found','cancelled_unresolved')),
  last_status       text,
  last_status_rank  int NOT NULL DEFAULT 0,
  currency          text,
  payment_method    text NOT NULL CHECK (payment_method IN ('CASH','CASHLESS')),
  error_detail      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grab_deliveries_unresolved ON grab_deliveries (created_at) WHERE delivery_id IS NULL AND state IN ('sending','unknown');

-- Tracking webhooks as received (minimal fields only: no names, phones, addresses or proof links).
-- Idempotency key (deliveryID, status, timestamp) as recommended by Grab; the order update itself is
-- deduplicated again by provider_events (provider 'grab', event_id '<deliveryID>:<status>:<timestamp>').
CREATE TABLE IF NOT EXISTS grab_webhook_events (
  id                bigserial PRIMARY KEY,
  delivery_id       text NOT NULL,
  merchant_order_id text,
  status            text NOT NULL,
  event_ts          bigint NOT NULL,
  failed_reason     text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, status, event_ts)
);
CREATE INDEX IF NOT EXISTS grab_webhook_events_received ON grab_webhook_events (received_at);
