// Login with Grab (GrabID, OAuth 2.0 / OpenID Connect). Spec: docs/grab-api-research.md section 3.
//
// Authorization code flow with PKCE S256 (mandatory at Grab), state and nonce. Grab is a confidential
// client (token_endpoint_auth_methods_supported: client_secret_post), so the code is exchanged on the
// backend with the client secret. The ID token is verified locally (RS256 against the discovery JWKS:
// iss, aud, exp, iat, nonce) and, when discovery advertises it, also with Grab's token_info endpoint,
// which Grab asks partners to call. No Grab token is stored: the access token is used once for userinfo.
//
// Account rules (security first, see docs/threat-model.md):
// - a known `sub` signs in its account;
// - an unknown `sub` with a signed-in user is linked only through the CSRF-protected "Connect" button;
// - an unknown `sub` without a session creates an account only from a verified email that no
//   Unyly account uses; an email that matches an existing account is never linked automatically
//   (pre-hijack protection): the owner signs in with their usual method first, then connects Grab.
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { safeEqual, sha256 } from '../domain/crypto.js';
import { DomainError } from '../domain/errors.js';
import type { Locale } from '../domain/locales.js';
import { createUserIfEmailFree, getUser, UserRow } from '../services/users.js';
import { createSession, safeNext } from './session.js';

export const GRABID_HOSTS = {
  sandbox: 'https://partner-api.stg-myteksi.com',
  production: 'https://partner-api.grab.com',
} as const;
export const GRABID_DISCOVERY_PATH = '/grabid/v1/oauth2/.well-known/openid-configuration';
/** Minimal scopes: `openid` for the ID token, `profile.read` for name and email. No `phone`. */
export const GRABID_SCOPES = ['openid', 'profile.read'] as const;
export const GRAB_STATE_COOKIE = 'unyly_grab_state';
const STATE_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 60 * 60_000;
const CLOCK_SKEW_SEC = 60;
const MAX_ID_TOKEN_AGE_SEC = 10 * 60;

export interface GrabIdConfig {
  enabled: boolean;
  env: 'sandbox' | 'production';
  clientId: string;
  /** Confidential client (client_secret_post). Inject from a secret manager, never commit. */
  clientSecret: string;
  redirectUri: string;
  /** Base URL that serves the discovery document. Defaults to the Grab host for `env`. */
  issuerBase: string;
  /** Also call Grab's id_token verification endpoint when discovery lists it (Grab requires it). */
  verifyRemotely: boolean;
}

function onOff(name: string, raw: string | undefined, d: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return d;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be on or off, got "${raw}"`);
}

const isLoopback = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

function parseUrl(name: string, v: string): URL {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${v}"`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u))) throw new Error(`${name} must be https (http only for localhost), got "${v}"`);
  if (u.hash) throw new Error(`${name} must not contain a fragment`);
  return u;
}

/** Reads and validates the GRABID_* variables. Off by default; when on, every required value must be set. */
export function loadGrabIdConfig(o: { env: string; webOrigin: string }, e: NodeJS.ProcessEnv = process.env): GrabIdConfig {
  const enabled = onOff('GRABID', e.GRABID, false);
  const envRaw = (e.GRABID_ENV || 'sandbox').trim().toLowerCase();
  if (envRaw !== 'sandbox' && envRaw !== 'production') throw new Error(`GRABID_ENV must be sandbox or production, got "${e.GRABID_ENV}"`);
  const env = envRaw as GrabIdConfig['env'];
  const cfg: GrabIdConfig = {
    enabled,
    env,
    clientId: (e.GRABID_CLIENT_ID ?? '').trim(),
    clientSecret: (e.GRABID_CLIENT_SECRET ?? '').trim(),
    redirectUri: (e.GRABID_REDIRECT_URI || `${o.webOrigin}/auth/grab/callback`).trim(),
    issuerBase: (e.GRABID_ISSUER || GRABID_HOSTS[env]).trim().replace(/\/$/, ''),
    verifyRemotely: onOff('GRABID_VERIFY_ENDPOINT', e.GRABID_VERIFY_ENDPOINT, true),
  };
  if (!enabled) return cfg;
  if (!cfg.clientId) throw new Error('GRABID_CLIENT_ID is required when GRABID=on');
  if (!cfg.clientSecret) throw new Error('GRABID_CLIENT_SECRET is required when GRABID=on (GrabID uses client_secret_post)');
  parseUrl('GRABID_REDIRECT_URI', cfg.redirectUri);
  const issuer = parseUrl('GRABID_ISSUER', cfg.issuerBase);
  if (o.env === 'production') {
    if (!cfg.redirectUri.startsWith('https://')) throw new Error('GRABID_REDIRECT_URI must be https in production');
    if (issuer.protocol !== 'https:') throw new Error('GRABID_ISSUER must be https in production');
  }
  return cfg;
}

// ---------------- Discovery and keys ----------------

const DiscoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  jwks_uri: z.string().min(1),
  userinfo_endpoint: z.string().optional(),
  id_token_verification_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
});

export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint?: string;
  idTokenVerificationEndpoint?: string;
}

interface Client {
  discovery?: { value: Discovery; at: number };
  pending?: Promise<Discovery>;
  jwks?: { uri: string; set: ReturnType<typeof createRemoteJWKSet> };
}
// One cache per config object: tests start several apps with different mock providers.
const clients = new WeakMap<GrabIdConfig, Client>();
const clientFor = (cfg: GrabIdConfig): Client => {
  let c = clients.get(cfg);
  if (!c) clients.set(cfg, (c = {}));
  return c;
};

/** Discovery paths may be absolute or relative to the Grab host. Absolute ones must stay https (or loopback http in dev). */
function endpoint(base: string, v: string | undefined, name: string): string | undefined {
  if (!v) return undefined;
  const u = new URL(v, `${base}/`);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u))) throw new Error(`GrabID discovery: ${name} is not https`);
  return u.toString();
}

async function fetchJson(ctx: Ctx, url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(ctx.cfg.providerTimeoutMs) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const unavailable = () => new DomainError('PROVIDER_UNAVAILABLE', 'Grab sign-in is temporarily unavailable. Try again later or use another sign-in method.');

export async function getDiscovery(ctx: Ctx): Promise<Discovery> {
  const cfg = ctx.cfg.grabId;
  const c = clientFor(cfg);
  if (c.discovery && Date.now() - c.discovery.at < DISCOVERY_TTL_MS) return c.discovery.value;
  if (!c.pending) {
    c.pending = (async () => {
      try {
        const r = await fetchJson(ctx, `${cfg.issuerBase}${GRABID_DISCOVERY_PATH}`, { headers: { accept: 'application/json' } });
        const p = DiscoverySchema.safeParse(r.body);
        if (r.status !== 200 || !p.success) throw new Error(`discovery ${r.status}`);
        const d = p.data;
        if (d.code_challenge_methods_supported && !d.code_challenge_methods_supported.includes('S256')) throw new Error('discovery: S256 not supported');
        if (d.id_token_signing_alg_values_supported && !d.id_token_signing_alg_values_supported.includes('RS256')) throw new Error('discovery: RS256 not supported');
        const value: Discovery = {
          issuer: d.issuer,
          authorizationEndpoint: endpoint(cfg.issuerBase, d.authorization_endpoint, 'authorization_endpoint')!,
          tokenEndpoint: endpoint(cfg.issuerBase, d.token_endpoint, 'token_endpoint')!,
          jwksUri: endpoint(cfg.issuerBase, d.jwks_uri, 'jwks_uri')!,
          userinfoEndpoint: endpoint(cfg.issuerBase, d.userinfo_endpoint, 'userinfo_endpoint'),
          idTokenVerificationEndpoint: endpoint(cfg.issuerBase, d.id_token_verification_endpoint, 'id_token_verification_endpoint'),
        };
        c.discovery = { value, at: Date.now() };
        return value;
      } catch (e: any) {
        console.error('[grabid] discovery failed:', e?.message ?? e);
        // A stale document is better than an outage; it is refreshed on the next success.
        if (c.discovery) return c.discovery.value;
        throw unavailable();
      } finally {
        c.pending = undefined;
      }
    })();
  }
  return c.pending;
}

/** JWKS with caching; an unknown `kid` triggers a refetch (key rotation), rate-limited by the cooldown. */
function jwksFor(ctx: Ctx, d: Discovery) {
  const c = clientFor(ctx.cfg.grabId);
  if (!c.jwks || c.jwks.uri !== d.jwksUri) {
    c.jwks = {
      uri: d.jwksUri,
      set: createRemoteJWKSet(new URL(d.jwksUri), { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000, timeoutDuration: ctx.cfg.providerTimeoutMs }),
    };
  }
  return c.jwks.set;
}

// ---------------- PKCE, authorization URL ----------------

const b64url = (b: Buffer) => b.toString('base64url');
/** 43 characters of [A-Za-z0-9-_], inside Grab's 43..128 range. */
export const newCodeVerifier = () => b64url(randomBytes(32));
export const codeChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export function authorizationUrl(cfg: GrabIdConfig, d: Discovery, p: { state: string; nonce: string; codeVerifier: string }): string {
  const u = new URL(d.authorizationEndpoint);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('scope', GRABID_SCOPES.join(' '));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('code_challenge', codeChallenge(p.codeVerifier));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  return u.toString();
}

/** Starts a sign-in (userId null) or a "connect" for the signed-in user. Returns the Grab URL and the raw state for the cookie. */
export async function startGrabAuth(ctx: Ctx, p: { next?: unknown; userId?: string | null; locale: Locale }): Promise<{ url: string; state: string }> {
  const d = await getDiscovery(ctx);
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(24));
  const codeVerifier = newCodeVerifier();
  await ctx.db.query(
    'INSERT INTO grab_auth_states (state_hash, nonce, code_verifier, next, user_id, locale, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [sha256(state), nonce, codeVerifier, safeNext(p.next), p.userId ?? null, p.locale, new Date(Date.now() + STATE_TTL_MS)],
  );
  return { url: authorizationUrl(ctx.cfg.grabId, d, { state, nonce, codeVerifier }), state };
}

// ---------------- Token exchange and ID token ----------------

const TokenSchema = z.object({ id_token: z.string().min(1), access_token: z.string().min(1).optional(), token_type: z.string().optional() });

export async function exchangeCode(ctx: Ctx, d: Discovery, code: string, codeVerifier: string) {
  const cfg = ctx.cfg.grabId;
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: cfg.clientId, client_secret: cfg.clientSecret,
    code, code_verifier: codeVerifier, redirect_uri: cfg.redirectUri,
  });
  let r;
  try {
    r = await fetchJson(ctx, d.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  } catch {
    throw unavailable();
  }
  const p = TokenSchema.safeParse(r.body);
  if (r.status !== 200 || !p.success) {
    // invalid_grant and friends: expired or replayed code, PKCE mismatch. Never echo Grab's text to the page.
    console.error('[grabid] token exchange failed:', r.status, typeof r.body?.error === 'string' ? r.body.error : '');
    throw new DomainError('AUTH_REQUIRED', 'Grab sign-in failed. Please try again.');
  }
  return p.data;
}

export interface GrabClaims {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

const badToken = () => new DomainError('AUTH_REQUIRED', 'Grab sign-in could not be verified. Please try again.');

/** RS256 signature (JWKS), iss, aud (+azp), exp, iat (not in the future, not too old), nbf, sub and nonce. */
export async function verifyIdToken(ctx: Ctx, d: Discovery, idToken: string, expectedNonce: string): Promise<JWTPayload & { sub: string }> {
  const cfg = ctx.cfg.grabId;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwksFor(ctx, d), {
      algorithms: ['RS256'],
      issuer: d.issuer,
      audience: cfg.clientId,
      clockTolerance: CLOCK_SKEW_SEC,
      maxTokenAge: MAX_ID_TOKEN_AGE_SEC,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
    }));
  } catch (e) {
    if (e instanceof joseErrors.JOSEError) {
      console.error('[grabid] id_token rejected:', e.code);
      throw badToken();
    }
    throw e;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number' || payload.iat > now + CLOCK_SKEW_SEC) throw badToken();
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== cfg.clientId) throw badToken();
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expectedNonce)) throw badToken();
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw badToken();
  if (cfg.verifyRemotely && d.idTokenVerificationEndpoint) await verifyRemotely(ctx, d.idTokenVerificationEndpoint, idToken, expectedNonce, payload.sub);
  return payload as JWTPayload & { sub: string };
}

/** Grab's token_info check: "you must call this and discard tokens if it fails". */
async function verifyRemotely(ctx: Ctx, url: string, idToken: string, nonce: string, sub: string) {
  const cfg = ctx.cfg.grabId;
  let r;
  try {
    r = await fetchJson(ctx, url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: cfg.clientId, id_token: idToken, nonce }),
    });
  } catch {
    throw unavailable();
  }
  if (r.status !== 200 || !r.body || (r.body.sub !== undefined && r.body.sub !== sub)) {
    console.error('[grabid] token_info rejected the id_token:', r.status);
    throw badToken();
  }
}

const UserinfoSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});

/** Optional profile lookup; failures are not fatal (the ID token already identifies the user). */
export async function fetchUserinfo(ctx: Ctx, d: Discovery, accessToken: string | undefined, sub: string) {
  if (!d.userinfoEndpoint || !accessToken) return null;
  try {
    const r = await fetchJson(ctx, d.userinfoEndpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    const p = UserinfoSchema.safeParse(r.body);
    if (r.status !== 200 || !p.success || p.data.sub !== sub) return null;
    return p.data;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/**
 * The email counts as verified only when the same source that returns it also says
 * `email_verified: true`. GrabID does not list email_verified in claims_supported today, so in
 * practice Grab sign-in creates no new accounts until Grab confirms it (see docs/operations.md).
 */
export function claimsFrom(idt: JWTPayload & { sub: string }, info: z.infer<typeof UserinfoSchema> | null): GrabClaims {
  const pick = (src: { email?: unknown; email_verified?: unknown } | null) =>
    src && typeof src.email === 'string' && EMAIL_RE.test(src.email.trim()) ? { email: src.email.trim().toLowerCase(), verified: src.email_verified === true } : null;
  const fromToken = pick(idt as any);
  const fromInfo = pick(info);
  const best = fromToken?.verified ? fromToken : fromInfo?.verified ? fromInfo : (fromToken ?? fromInfo);
  const name = typeof idt.name === 'string' ? idt.name : info?.name;
  return { sub: idt.sub, email: best?.email, emailVerified: !!best?.verified, name: name?.slice(0, 120) };
}

// ---------------- Callback: sign in or link ----------------

export type GrabRefusal =
  | 'cancelled' // the user declined at Grab (or Grab returned an error)
  | 'bad_state' // missing, foreign, replayed or expired state
  | 'session_changed' // a "connect" finished in a different session
  | 'linked_elsewhere' // this Grab account belongs to another Unyly account
  | 'already_has_grab' // this Unyly account already has another Grab account
  | 'email_exists' // the email belongs to an existing account: sign in first, then connect
  | 'no_verified_email'; // no verified email to create an account from

export type GrabOutcome =
  | { kind: 'login'; userId: string; token: string; next: string; isNew: boolean }
  | { kind: 'linked'; next: string; already: boolean }
  | { kind: 'refused'; reason: GrabRefusal; linkFlow: boolean };

interface StateRow {
  nonce: string;
  code_verifier: string;
  next: string;
  user_id: string | null;
  locale: string | null;
}

/** Single use: consumed atomically whatever happens next. */
async function consumeState(ctx: Ctx, state: string): Promise<StateRow | null> {
  const r = await ctx.db.query<StateRow>(
    `UPDATE grab_auth_states SET consumed_at = now()
      WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING nonce, code_verifier, next, user_id, locale`,
    [sha256(state)],
  );
  return r.rows[0] ?? null;
}

export async function completeGrabAuth(
  ctx: Ctx,
  p: { state: unknown; cookieState: unknown; code: unknown; error: unknown; session: { user: UserRow } | null; locale: Locale },
): Promise<GrabOutcome> {
  const state = typeof p.state === 'string' && p.state.length <= 200 ? p.state : '';
  const cookie = typeof p.cookieState === 'string' ? p.cookieState : '';
  // The state must come back to the same browser that started the flow (login CSRF defence).
  if (!state || !cookie || !safeEqual(state, cookie)) return { kind: 'refused', reason: 'bad_state', linkFlow: false };
  const row = await consumeState(ctx, state);
  if (!row) return { kind: 'refused', reason: 'bad_state', linkFlow: false };
  const linkFlow = !!row.user_id;
  if (p.error !== undefined || typeof p.code !== 'string' || !p.code || p.code.length > 2048) return { kind: 'refused', reason: 'cancelled', linkFlow };
  if (linkFlow && (!p.session || p.session.user.id !== row.user_id || p.session.user.is_guest)) return { kind: 'refused', reason: 'session_changed', linkFlow };

  const d = await getDiscovery(ctx);
  const tokens = await exchangeCode(ctx, d, p.code, row.code_verifier);
  const idt = await verifyIdToken(ctx, d, tokens.id_token, row.nonce);
  const info = await fetchUserinfo(ctx, d, tokens.access_token, idt.sub);
  const claims = claimsFrom(idt, info);
  const issuer = d.issuer;
  const next = safeNext(row.next);

  const out = await ctx.db.tx(async (q): Promise<GrabOutcome> => {
    const linked = await q.query<{ user_id: string }>('SELECT user_id FROM grab_identities WHERE issuer = $1 AND sub = $2 FOR UPDATE', [issuer, claims.sub]);
    const owner = linked.rows[0]?.user_id;

    if (linkFlow) {
      const userId = row.user_id!;
      if (owner === userId) return { kind: 'linked', next, already: true };
      if (owner) {
        await audit(q, { userId, actor: 'web', action: 'user.grab_link_refused', details: { reason: 'linked_elsewhere' } });
        return { kind: 'refused', reason: 'linked_elsewhere', linkFlow };
      }
      const ins = await q.query(
        `INSERT INTO grab_identities (issuer, sub, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id`,
        [issuer, claims.sub, userId],
      );
      if (!ins.rowCount) return { kind: 'refused', reason: 'already_has_grab', linkFlow };
      await audit(q, { userId, actor: 'web', action: 'user.grab_linked', details: { issuer } });
      return { kind: 'linked', next, already: false };
    }

    if (owner) {
      let user: UserRow;
      try {
        user = await getUser(q, owner);
      } catch {
        return { kind: 'refused', reason: 'bad_state', linkFlow };
      }
      await q.query('UPDATE grab_identities SET last_login_at = now() WHERE issuer = $1 AND sub = $2', [issuer, claims.sub]);
      const token = await createSession(q, user.id);
      await audit(q, { userId: user.id, actor: 'web', action: 'user.login', details: { method: 'grabid' } });
      return { kind: 'login', userId: user.id, token, next, isNew: false };
    }

    if (!claims.email || !claims.emailVerified) return { kind: 'refused', reason: 'no_verified_email', linkFlow };
    const created = await createUserIfEmailFree(q, claims.email, (row.locale as Locale) || p.locale, { verified: true });
    if (!created) {
      // Never attach a Grab account to an existing account by email. Tell the owner's audit log.
      const existing = await q.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [claims.email]);
      await audit(q, { userId: existing.rows[0]?.id ?? null, actor: 'web', action: 'user.grab_login_refused', details: { reason: 'email_exists' } });
      return { kind: 'refused', reason: 'email_exists', linkFlow };
    }
    const ins = await q.query('INSERT INTO grab_identities (issuer, sub, user_id, last_login_at) VALUES ($1,$2,$3, now()) ON CONFLICT DO NOTHING', [issuer, claims.sub, created.id]);
    // Lost a race with a parallel callback for the same sub: throwing rolls the new account back.
    if (!ins.rowCount) throw new DomainError('AUTH_REQUIRED', 'Grab sign-in failed. Please try again.');
    await audit(q, { userId: created.id, actor: 'web', action: 'user.grab_linked', details: { issuer, new_account: true } });
    const token = await createSession(q, created.id);
    await audit(q, { userId: created.id, actor: 'web', action: 'user.login', details: { method: 'grabid', new_account: true } });
    return { kind: 'login', userId: created.id, token, next, isNew: true };
  });
  return out;
}

// ---------------- Account page helpers ----------------

export async function getGrabIdentity(q: Queryable, userId: string): Promise<{ issuer: string; created_at: string; last_login_at: string | null } | null> {
  const r = await q.query('SELECT issuer, created_at, last_login_at FROM grab_identities WHERE user_id = $1', [userId]);
  return r.rows[0] ?? null;
}

/**
 * Removes the Grab sign-in. Refused when it would lock the user out: they need a passkey, or
 * email codes enabled on this server (the account email can always receive one).
 */
export async function unlinkGrab(ctx: Ctx, userId: string): Promise<boolean> {
  return ctx.db.tx(async (q) => {
    const has = await q.query('SELECT 1 FROM grab_identities WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!has.rowCount) return false;
    const pk = (await q.query('SELECT count(*)::int AS n FROM webauthn_credentials WHERE user_id = $1', [userId])).rows[0].n;
    if (pk === 0 && ctx.cfg.mail.mode === 'disabled') {
      throw new DomainError('VALIDATION_FAILED', 'Add a passkey first: without Grab you would have no way to sign in.');
    }
    await q.query('DELETE FROM grab_identities WHERE user_id = $1', [userId]);
    await audit(q, { userId, actor: 'web', action: 'user.grab_unlinked' });
    return true;
  });
}
