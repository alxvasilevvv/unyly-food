// Passkeys (WebAuthn): the primary sign-in method. Works without any email provider.
// Registration creates an account bound to a discoverable credential; sign-in needs no username.
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import { audit } from '../context.js';
import { UUID_RE } from '../domain/crypto.js';
import { isLocaleCode } from '../domain/locales.js';
import { DomainError } from '../domain/errors.js';
import { findOrCreateUserByEmail } from '../services/users.js';
import { createSession } from './session.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const REGISTER_REFUSED = 'Could not create an account with this email. If you already have one, sign in with your passkey or an email code, then add a new passkey.';
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const rp = (ctx: Ctx) => ({ id: new URL(ctx.cfg.webOrigin).hostname, origin: ctx.cfg.webOrigin, name: 'Unyly' });

async function storeChallenge(
  ctx: Ctx, purpose: 'register' | 'add' | 'login' | 'step_up', challenge: string,
  extra: { email?: string; userId?: string; userHandle?: string; checkoutId?: string; ttlMs?: number } = {},
) {
  const r = await ctx.db.query(
    'INSERT INTO webauthn_challenges (purpose, challenge, email, user_id, user_handle, checkout_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [purpose, challenge, extra.email ?? null, extra.userId ?? null, extra.userHandle ?? null, extra.checkoutId ?? null, new Date(Date.now() + (extra.ttlMs ?? CHALLENGE_TTL_MS))],
  );
  return r.rows[0].id as string;
}

/**
 * Single-use challenge: consumed atomically, so a replayed response fails. The email is cleared in
 * the same statement (the row keeps no personal data once used); the old value is returned.
 */
async function consumeChallenge(ctx: Ctx, id: unknown, purpose: string[]) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new DomainError('VALIDATION_FAILED', 'Invalid challenge');
  const r = await ctx.db.query(
    `WITH c AS (
       SELECT * FROM webauthn_challenges WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() AND purpose = ANY($2) FOR UPDATE
     )
     UPDATE webauthn_challenges w SET consumed_at = now(), email = NULL FROM c WHERE w.id = c.id
     RETURNING c.id, c.purpose, c.challenge, c.email, c.user_id, c.user_handle, c.checkout_id`,
    [id, purpose],
  );
  if (!r.rows[0]) throw new DomainError('AUTH_REQUIRED', 'The passkey request expired. Try again.');
  return r.rows[0];
}

/** New account (email is a contact label) or, with a session, an extra passkey for the signed-in user. */
export async function registrationOptions(ctx: Ctx, args: { email?: string; sessionUserId?: string; sessionEmail?: string }) {
  let email: string;
  let userId: string | undefined;
  let exclude: { id: string; transports?: string[] }[] = [];
  if (args.sessionUserId) {
    userId = args.sessionUserId;
    email = args.sessionEmail!;
    const creds = await ctx.db.query('SELECT id, transports FROM webauthn_credentials WHERE user_id = $1', [userId]);
    exclude = creds.rows.map((c) => ({ id: c.id, transports: c.transports }));
  } else {
    email = String(args.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new DomainError('VALIDATION_FAILED', 'Enter a valid email');
    // No lookup here: answering differently for an existing email would let anyone enumerate
    // accounts. Existing accounts are refused in verifyRegistration, after a full WebAuthn ceremony.
  }
  const userHandle = randomBytes(32);
  const options = await generateRegistrationOptions({
    rpName: rp(ctx).name,
    rpID: rp(ctx).id,
    userName: email,
    userDisplayName: email,
    userID: userHandle,
    attestationType: 'none',
    excludeCredentials: exclude,
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = await storeChallenge(ctx, userId ? 'add' : 'register', options.challenge, { email, userId, userHandle: userHandle.toString('base64url') });
  return { challenge_id: challengeId, options };
}

export async function verifyRegistration(ctx: Ctx, body: any, sessionUserId?: string) {
  const ch = await consumeChallenge(ctx, body?.challenge_id, ['register', 'add']);
  if (ch.purpose === 'add' && ch.user_id !== sessionUserId) throw new DomainError('AUTH_REQUIRED', 'Sign in again to add a passkey');
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: body?.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp(ctx).origin,
      expectedRPID: rp(ctx).id,
      requireUserVerification: false,
    });
  } catch (e: any) {
    throw new DomainError('AUTH_REQUIRED', `Passkey verification failed: ${e.message}`);
  }
  if (!v.verified) throw new DomainError('AUTH_REQUIRED', 'Passkey verification failed');
  const info = v.registrationInfo;
  return ctx.db.tx(async (q) => {
    let userId = ch.user_id as string | null;
    if (ch.purpose === 'register') {
      // Never attach a passkey to an existing account without signing in first. The message is the
      // same generic one whatever the reason, and only reachable after a real authenticator ceremony.
      if (!ch.email) throw new DomainError('AUTH_REQUIRED', 'The passkey request expired. Try again.');
      const taken = await q.query('SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [ch.email]);
      if (taken.rowCount) throw new DomainError('VALIDATION_FAILED', REGISTER_REFUSED);
      // Created unverified: a passkey proves nothing about the email. The first email-code sign-in
      // verifies it and revokes whatever was attached before (see verifyLoginCode).
      userId = (await findOrCreateUserByEmail(q, ch.email, isLocaleCode(body?.locale) ? body.locale : 'ru', { verified: false })).id;
    }
    await q.query(
      `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [info.credential.id, userId, Buffer.from(info.credential.publicKey), info.credential.counter, info.credential.transports ?? [], info.credentialDeviceType, info.credentialBackedUp, String(body?.label ?? '').slice(0, 60) || null],
    );
    await audit(q, { userId, actor: 'web', action: ch.purpose === 'register' ? 'user.passkey_registered' : 'user.passkey_added' });
    const token = ch.purpose === 'register' ? await createSession(q, userId!) : null;
    return { userId: userId!, token, isNew: ch.purpose === 'register' };
  });
}

export async function authenticationOptions(ctx: Ctx) {
  const options = await generateAuthenticationOptions({ rpID: rp(ctx).id, userVerification: 'preferred' });
  const challengeId = await storeChallenge(ctx, 'login', options.challenge);
  return { challenge_id: challengeId, options };
}

export async function verifyAuthentication(ctx: Ctx, body: any) {
  const ch = await consumeChallenge(ctx, body?.challenge_id, ['login']);
  const credId = String(body?.response?.id ?? '');
  const c = (await ctx.db.query(
    `SELECT w.* FROM webauthn_credentials w JOIN users u ON u.id = w.user_id WHERE w.id = $1 AND u.deleted_at IS NULL`,
    [credId],
  )).rows[0];
  if (!c) throw new DomainError('AUTH_REQUIRED', 'This passkey is not registered with Unyly');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp(ctx).origin,
      expectedRPID: rp(ctx).id,
      credential: { id: c.id, publicKey: new Uint8Array(c.public_key), counter: Number(c.counter), transports: c.transports },
      requireUserVerification: false,
    });
  } catch (e: any) {
    throw new DomainError('AUTH_REQUIRED', `Passkey verification failed: ${e.message}`);
  }
  if (!v.verified) throw new DomainError('AUTH_REQUIRED', 'Passkey verification failed');
  return ctx.db.tx(async (q) => {
    // Counter regression means a cloned authenticator (the library already rejects it when both are non-zero).
    await q.query('UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1', [c.id, v.authenticationInfo.newCounter]);
    await audit(q, { userId: c.user_id, actor: 'web', action: 'user.login', details: { method: 'passkey' } });
    return { userId: c.user_id as string, token: await createSession(q, c.user_id) };
  });
}

export async function listPasskeys(ctx: Ctx, userId: string) {
  return (await ctx.db.query('SELECT id, label, device_type, backed_up, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
}

export async function deletePasskey(ctx: Ctx, userId: string, credId: string) {
  await ctx.db.tx(async (q) => {
    const n = (await q.query('SELECT count(*)::int n FROM webauthn_credentials WHERE user_id = $1', [userId])).rows[0].n;
    if (n <= 1) throw new DomainError('VALIDATION_FAILED', 'Keep at least one passkey, otherwise you cannot sign in.');
    await q.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [credId, userId]);
    await audit(q, { userId, actor: 'web', action: 'user.passkey_deleted' });
  });
}

// ---------------- Step-up for large orders ----------------
/** A step-up challenge lives 2 minutes: long enough for one device prompt, short enough not to be stockpiled. */
export const STEP_UP_TTL_MS = 2 * 60_000;

export async function hasPasskey(ctx: Ctx, userId: string): Promise<boolean> {
  return (await ctx.db.query('SELECT 1 FROM webauthn_credentials WHERE user_id = $1 LIMIT 1', [userId])).rowCount! > 0;
}

const stepUpError = (reason: 'missing' | 'expired' | 'mismatch' | 'failed', message: string) =>
  new DomainError('STEP_UP_REQUIRED', message, { reason }, 'Ask the user to press Confirm again and approve with their passkey.');

/**
 * Options for a passkey assertion that approves one checkout. The challenge is stored server side,
 * bound to (user, checkout), single use, and valid for STEP_UP_TTL_MS. User verification is required.
 */
export async function stepUpOptions(ctx: Ctx, userId: string, checkoutId: string) {
  const creds = await ctx.db.query('SELECT id, transports FROM webauthn_credentials WHERE user_id = $1', [userId]);
  if (!creds.rowCount) throw new DomainError('VALIDATION_FAILED', 'No passkey is registered for this account');
  const options = await generateAuthenticationOptions({
    rpID: rp(ctx).id,
    userVerification: 'required',
    timeout: STEP_UP_TTL_MS,
    allowCredentials: creds.rows.map((c) => ({ id: c.id, transports: c.transports })),
  });
  const challengeId = await storeChallenge(ctx, 'step_up', options.challenge, { userId, checkoutId, ttlMs: STEP_UP_TTL_MS });
  return { challenge_id: challengeId, options };
}

/**
 * Verifies the assertion posted with the confirmation form (JSON: { challenge_id, response }).
 * The challenge is consumed first, so a failed or replayed attempt cannot be retried with it, and it must
 * have been issued for this user and this checkout. The credential must belong to this user.
 */
export async function verifyStepUp(ctx: Ctx, userId: string, checkoutId: string, raw: unknown): Promise<{ credentialId: string }> {
  let body: any = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) body = null;
    else {
      try {
        body = JSON.parse(raw);
      } catch {
        throw stepUpError('failed', 'The passkey response could not be read. Try again.');
      }
    }
  }
  if (!body || typeof body !== 'object' || !body.challenge_id || !body.response) {
    throw stepUpError('missing', 'This order needs your passkey. Press Confirm and approve on your device.');
  }
  let ch;
  try {
    ch = await consumeChallenge(ctx, body.challenge_id, ['step_up']);
  } catch {
    throw stepUpError('expired', 'The passkey request expired. Press Confirm to try again.');
  }
  if (ch.user_id !== userId || ch.checkout_id !== checkoutId) throw stepUpError('mismatch', 'This passkey approval was issued for a different order.');
  const credId = String(body.response?.id ?? '');
  const c = (await ctx.db.query('SELECT * FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [credId, userId])).rows[0];
  if (!c) throw stepUpError('failed', 'This passkey is not registered to your account.');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp(ctx).origin,
      expectedRPID: rp(ctx).id,
      credential: { id: c.id, publicKey: new Uint8Array(c.public_key), counter: Number(c.counter), transports: c.transports },
      requireUserVerification: true,
    });
  } catch {
    throw stepUpError('failed', 'Passkey verification failed.');
  }
  if (!v.verified) throw stepUpError('failed', 'Passkey verification failed.');
  await ctx.db.query('UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1', [c.id, v.authenticationInfo.newCounter]);
  return { credentialId: c.id };
}
