-- Security fixes.

-- 1. Email ownership. Passkey registration never proves the email, so an account created that way
--    starts unverified; the first successful email-code sign-in verifies it (and, if it was
--    unverified, revokes every credential a possible squatter attached: see verifyLoginCode).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
-- Backfill: every account that did not come from a passkey registration was created by an
-- email-code sign-in (verified by construction); passkey accounts count as verified only if
-- their owner has signed in with an email code since.
UPDATE users u SET email_verified_at = u.created_at
 WHERE u.email_verified_at IS NULL
   AND (
     NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id = u.id AND a.action = 'user.passkey_registered')
     OR EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id = u.id AND a.action = 'user.login' AND a.details->>'method' = 'email_code')
   );

-- 8. Client ID Metadata Documents are re-fetched when older than 24 h.
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 10. Registration challenges must not keep the email once used (expired ones are purged by ops).
UPDATE webauthn_challenges SET email = NULL WHERE consumed_at IS NOT NULL AND email IS NOT NULL;
