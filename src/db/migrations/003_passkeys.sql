-- Passkeys (WebAuthn): primary sign-in method; email codes remain for recovery.
CREATE TABLE webauthn_credentials (
  id            text PRIMARY KEY,               -- credential ID, base64url
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  device_type   text,
  backed_up     boolean NOT NULL DEFAULT false,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials (user_id);

CREATE TABLE webauthn_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose     text NOT NULL CHECK (purpose IN ('register','add','login')),
  challenge   text NOT NULL,
  email       text,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  user_handle text,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
