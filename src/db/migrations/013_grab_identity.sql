-- Login with Grab (GrabID, OpenID Connect).

-- 1. One GrabID per Unyly account and one Unyly account per GrabID. `sub` is partner scoped and the
--    only stable Grab user key (email can change), so it is the key; `issuer` keeps sandbox and
--    production identities apart. No Grab tokens are stored: the access token is used once for
--    userinfo during sign-in and discarded.
CREATE TABLE IF NOT EXISTS grab_identities (
  issuer        text NOT NULL,
  sub           text NOT NULL CHECK (length(sub) BETWEEN 1 AND 255),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  PRIMARY KEY (issuer, sub)
);
CREATE UNIQUE INDEX IF NOT EXISTS grab_identities_user ON grab_identities (user_id);

-- 2. Pending authorization requests (server side, single use, minutes long). The browser holds the
--    raw state in an HttpOnly cookie; only its hash is stored. `user_id` is set for a "connect"
--    request started by a signed-in user, NULL for a sign-in.
CREATE TABLE IF NOT EXISTS grab_auth_states (
  state_hash    text PRIMARY KEY,
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  next          text NOT NULL DEFAULT '/app',
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  locale        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS grab_auth_states_expires ON grab_auth_states (expires_at);
