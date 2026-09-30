-- Step-up confirmation for large orders: a passkey assertion bound to one checkout.
-- Reuses webauthn_challenges (single use, server side, shared by every app instance).
ALTER TABLE webauthn_challenges DROP CONSTRAINT IF EXISTS webauthn_challenges_purpose_check;
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_purpose_check CHECK (purpose IN ('register','add','login','step_up'));
ALTER TABLE webauthn_challenges ADD COLUMN IF NOT EXISTS checkout_id uuid REFERENCES checkouts(id) ON DELETE CASCADE;
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_step_up_bound CHECK (purpose <> 'step_up' OR (user_id IS NOT NULL AND checkout_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS webauthn_challenges_checkout ON webauthn_challenges (checkout_id) WHERE checkout_id IS NOT NULL;
