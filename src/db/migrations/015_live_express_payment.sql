-- Cashless Live GrabExpress paid with GrabPay (src/services/live-payment.ts). Additive only.

-- The GrabPay payment behind an order (cashless Live GrabExpress). While set, the order's
-- payment_status mirrors the payment and provider status events no longer overwrite it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES payments(id) ON DELETE SET NULL;
-- First time the order reached picked_up or delivered. Decides whether a cancelled or failed
-- delivery is refunded automatically (never picked up) or handed to support (picked up).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_at timestamptz;
CREATE INDEX IF NOT EXISTS orders_payment ON orders (payment_id) WHERE payment_id IS NOT NULL;

-- Final decision about a captured payment of a Live order, at most one per payment:
--   kept             the delivery completed, the money stays with Unyly (Grab bills Unyly)
--   refund_requested a full refund was requested (payment_refunds holds its progress)
--   support          no automatic refund (picked up, refund refused by Grab): a person decides
-- Payments without a row are swept by the worker until a decision is recorded.
CREATE TABLE IF NOT EXISTS live_payment_settlements (
  payment_id   uuid PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  checkout_id  uuid REFERENCES checkouts(id) ON DELETE SET NULL,
  outcome      text NOT NULL CHECK (outcome IN ('kept','refund_requested','support')),
  reason       text NOT NULL CHECK (reason ~ '^[a-z0-9_.:-]{1,64}$'),
  refund_id    uuid REFERENCES payment_refunds(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_payment_settlements_support ON live_payment_settlements (created_at) WHERE outcome = 'support';
