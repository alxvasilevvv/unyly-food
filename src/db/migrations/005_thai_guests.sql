-- Thai UI locale, guest demo accounts, per-order demo speed.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('ru','en','th'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_guest_created ON users (created_at) WHERE is_guest;
ALTER TABLE demo_sim_orders ADD COLUMN IF NOT EXISTS speed real NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS guest_ip_hash text;
