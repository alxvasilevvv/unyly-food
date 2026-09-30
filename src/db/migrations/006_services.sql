-- Multi-service: food, mart (groceries, flowers, pharmacy, cakes), ride and express (parcel).
-- A cart belongs to one service. Ride and express carts carry a trip (pickup/dropoff) instead of a
-- delivery address; the trip is versioned with the items so any change invalidates confirmations.
ALTER TABLE carts ADD COLUMN IF NOT EXISTS service text NOT NULL DEFAULT 'food';
ALTER TABLE carts DROP CONSTRAINT IF EXISTS carts_service_check;
ALTER TABLE carts ADD CONSTRAINT carts_service_check CHECK (service IN ('food','mart','ride','express'));
ALTER TABLE cart_versions ADD COLUMN IF NOT EXISTS trip jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service text NOT NULL DEFAULT 'food';
