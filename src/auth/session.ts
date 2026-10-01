import type { Locale } from '../domain/locales.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomInt } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/db.js';
import { audit } from '../context.js';
import { randomToken, safeEqual, sha256 } from '../domain/crypto.js';
import { DomainError } from '../domain/errors.js';
import { lookup } from '../i18n/index.js';
import { findOrCreateUserByEmail, getUser, UserRow } from '../services/users.js';

export const SESSION_COOKIE = 'unyly_session';
const SESSION_TTL_MS = 14 * 24 * 3600_000;
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

// Sign-in email. English is the base text (and the i18n catalog key); ru and th are written here,
// the other languages come from the catalogs via lookup() and fall back to English.
// The code is never in the subject line: subjects end up in notification previews and logs.
const LOGIN_MAIL_EN = {
  subject: 'Your Unyly sign-in code',
  body: 'Your code: {code}\nIt is valid for 10 minutes. If you did not try to sign in, ignore this email.',
};
const LOGIN_MAIL: Partial<Record<Locale, typeof LOGIN_MAIL_EN>> = {
  ru: {
    subject: 'Код входа в Unyly',
    body: 'Ваш код: {code}\nОн действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.',
  },
  th: {
    subject: 'รหัสเข้าสู่ระบบ Unyly ของคุณ',
    body: 'รหัสของคุณ: {code}\nรหัสนี้ใช้ได้ 10 นาที หากคุณไม่ได้พยายามเข้าสู่ระบบ โปรดเพิกเฉยต่ออีเมลนี้',
  },
};

export function loginMail(locale: Locale, code: string): { subject: string; text: string } {
  const own = LOGIN_MAIL[locale];
  const subject = own?.subject ?? lookup(locale, LOGIN_MAIL_EN.subject) ?? LOGIN_MAIL_EN.subject;
  const body = own?.body ?? lookup(locale, LOGIN_MAIL_EN.body) ?? LOGIN_MAIL_EN.body;
  return { subject, text: body.replace('{code}', code) };
}

export async function requestLoginCode(ctx: Ctx, emailRaw: string, locale: Locale): Promise<{ devCode?: string }> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new DomainError('VALIDATION_FAILED', 'Invalid email');
  if (ctx.cfg.mail.mode === 'disabled') throw new DomainError('CAPABILITY_UNAVAILABLE', 'Email codes are not enabled on this server. Use a passkey.');
  const recent = await ctx.db.query(`SELECT count(*)::int AS n FROM login_codes WHERE lower(email) = $1 AND created_at > now() - interval '1 hour'`, [email]);
  if (recent.rows[0].n >= MAX_CODES_PER_HOUR) throw new DomainError('RATE_LIMITED', 'Too many codes requested. Try again later.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await ctx.db.query('INSERT INTO login_codes (email, code_hash, expires_at) VALUES ($1,$2,$3)', [email, sha256(`${email}:${code}`), new Date(Date.now() + CODE_TTL_MS)]);
  const mail = loginMail(locale, code);
  await ctx.mailer.send(email, mail.subject, mail.text);
  return ctx.cfg.devEchoLoginCode ? { devCode: code } : {};
}

/**
 * First proof of email ownership for an account that was created without one (passkey
 * registration). Whoever registered it may not own the mailbox (account pre-hijacking), so every
 * credential attached so far is revoked before the verified owner is signed in: passkeys, web
 * sessions, pending passkey challenges, OAuth grants with their codes and tokens, personal tokens.
 * Runs inside the sign-in transaction, before the new session is created.
 */
async function verifyEmailOwnership(q: Queryable, userId: string) {
  const first = await q.query('UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL RETURNING id', [userId]);
  if (!first.rowCount) return;
  const passkeys = (await q.query('DELETE FROM webauthn_credentials WHERE user_id = $1', [userId])).rowCount ?? 0;
  const sessions = (await q.query('DELETE FROM web_sessions WHERE user_id = $1', [userId])).rowCount ?? 0;
  await q.query('DELETE FROM webauthn_challenges WHERE user_id = $1', [userId]);
  const grants = (await q.query('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [userId])).rowCount ?? 0;
  await q.query('DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE user_id = $1)', [userId]);
  await q.query('DELETE FROM oauth_codes WHERE grant_id IN (SELECT id FROM oauth_grants WHERE user_id = $1)', [userId]);
  const pats = (await q.query('UPDATE personal_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rowCount ?? 0;
  // A Grab account connected by whoever registered the passkey is a credential like any other.
  const grab = (await q.query('DELETE FROM grab_identities WHERE user_id = $1', [userId])).rowCount ?? 0;
  await audit(q, { userId, actor: 'web', action: 'user.email_verified', details: { first_verification: true, revoked: { passkeys, sessions, oauth_grants: grants, personal_tokens: pats, grab_identities: grab } } });
}

export async function verifyLoginCode(ctx: Ctx, emailRaw: string, code: string, locale: Locale) {
  const email = emailRaw.trim().toLowerCase();
  const out = await ctx.db.tx(async (q) => {
    const r = await q.query(
      `SELECT * FROM login_codes WHERE lower(email) = $1 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email],
    );
    const row = r.rows[0];
    if (!row || row.attempts >= MAX_ATTEMPTS) throw new DomainError('AUTH_REQUIRED', 'Code expired or too many attempts. Request a new code.');
    if (!safeEqual(row.code_hash, sha256(`${email}:${code.trim()}`))) {
      // Must commit, so the error is returned (a throw would roll the counter back).
      await q.query('UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return new DomainError('AUTH_REQUIRED', 'Wrong code');
    }
    await q.query('UPDATE login_codes SET consumed_at = now() WHERE id = $1', [row.id]);
    const user = await findOrCreateUserByEmail(q, email, locale, { verified: true });
    if (!user.email_verified_at) await verifyEmailOwnership(q, user.id);
    const token = await createSession(q, user.id);
    await audit(q, { userId: user.id, actor: 'web', action: 'user.login', details: { method: 'email_code' } });
    return { user, token };
  });
  if (out instanceof DomainError) throw out;
  return out;
}

/** Creates a web session and returns the raw cookie token (only its hash is stored). */
export async function createSession(q: Queryable, userId: string): Promise<string> {
  const token = randomToken();
  await q.query('INSERT INTO web_sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4)', [sha256(token), userId, randomToken(24), new Date(Date.now() + SESSION_TTL_MS)]);
  return token;
}

/** Operator/support: issue a one-time sign-in code for an existing or new email (account recovery without SMTP). */
export async function issueLoginCode(q: Queryable, emailRaw: string): Promise<string> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new DomainError('VALIDATION_FAILED', 'Invalid email');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await q.query('INSERT INTO login_codes (email, code_hash, expires_at) VALUES ($1,$2,$3)', [email, sha256(`${email}:${code}`), new Date(Date.now() + CODE_TTL_MS)]);
  return code;
}

export interface WebSession {
  user: UserRow;
  csrf: string;
  tokenHash: string;
}

export async function loadSession(ctx: Ctx, req: FastifyRequest): Promise<WebSession | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const r = await ctx.db.query('SELECT * FROM web_sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(token)]);
  if (!r.rows[0]) return null;
  try {
    const user = await getUser(ctx.db, r.rows[0].user_id);
    return { user, csrf: r.rows[0].csrf_token, tokenHash: r.rows[0].token_hash };
  } catch {
    return null;
  }
}

export function setSessionCookie(ctx: Ctx, reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: ctx.cfg.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function logout(ctx: Ctx, reply: FastifyReply, s: WebSession | null) {
  if (s) await ctx.db.query('DELETE FROM web_sessions WHERE token_hash = $1', [s.tokenHash]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * CSRF defence for every state-changing web request: per-session token in the form
 * plus an Origin/Referer check. SameSite=Lax cookies add a third layer.
 */
export function checkCsrf(ctx: Ctx, req: FastifyRequest, s: WebSession) {
  const body = (req.body ?? {}) as Record<string, string>;
  const origin = (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined);
  let originOk = true;
  if (origin) {
    try {
      originOk = new URL(origin).origin === ctx.cfg.webOrigin;
    } catch {
      originOk = false;
    }
  }
  if (!originOk) throw new DomainError('AUTH_REQUIRED', 'Cross-site request blocked');
  if (!body._csrf || !safeEqual(String(body._csrf), s.csrf)) throw new DomainError('AUTH_REQUIRED', 'Invalid form token; reload the page');
}

/**
 * Same-origin check for state-changing requests that have no session yet (sign-in forms, passkey
 * endpoints): the Origin header, or the Referer when Origin is absent, must equal webOrigin.
 * `Origin: null` (sandboxed frames, some privacy modes) is rejected. `allowMissing` accepts requests
 * that carry neither header (non-browser clients cannot perform login CSRF: that needs a victim's browser).
 */
export function isSameOrigin(ctx: Ctx, req: FastifyRequest, opts: { allowMissing?: boolean } = {}): boolean {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const src = typeof origin === 'string' ? origin : typeof referer === 'string' ? referer : undefined;
  if (src === undefined) return !!opts.allowMissing;
  try {
    return new URL(src).origin === ctx.cfg.webOrigin;
  } catch {
    return false;
  }
}

/** Throwing variant for the sign-in forms (login CSRF defence). */
export function requireSameOrigin(ctx: Ctx, req: FastifyRequest, opts: { allowMissing?: boolean } = {}) {
  if (!isSameOrigin(ctx, req, opts)) throw new DomainError('AUTH_REQUIRED', 'Cross-site request blocked');
}

const SAFE_NEXT_BASE = 'https://unyly-next.invalid';

/**
 * Only allow same-origin relative redirects (prevents open redirects). The value is resolved
 * against a fixed base: anything that lands on another origin (protocol-relative, backslash or scheme URLs) or
 * contains whitespace, control characters or backslashes falls back. Returns path + query + hash.
 */
export function safeNext(next: unknown, fallback = '/app'): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.length > 4096) return fallback;
  if (/[\u0000-\u0020\u007f-\u009f\\\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(next)) return fallback;
  let u: URL;
  try {
    u = new URL(next, SAFE_NEXT_BASE);
  } catch {
    return fallback;
  }
  if (u.origin !== SAFE_NEXT_BASE) return fallback;
  const out = u.pathname + u.search + u.hash;
  // Dot segments can normalise "/.//evil.example" into a protocol-relative path.
  if (!out.startsWith('/') || out.startsWith('//')) return fallback;
  return out;
}
