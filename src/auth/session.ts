import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomInt } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/db.js';
import { audit } from '../context.js';
import { randomToken, safeEqual, sha256 } from '../domain/crypto.js';
import { DomainError } from '../domain/errors.js';
import { findOrCreateUserByEmail, getUser, UserRow } from '../services/users.js';

export const SESSION_COOKIE = 'unyly_session';
const SESSION_TTL_MS = 14 * 24 * 3600_000;
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export async function requestLoginCode(ctx: Ctx, emailRaw: string, locale: 'ru' | 'en'): Promise<{ devCode?: string }> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new DomainError('VALIDATION_FAILED', 'Invalid email');
  if (ctx.cfg.mail.mode === 'disabled') throw new DomainError('CAPABILITY_UNAVAILABLE', 'Email codes are not enabled on this server. Use a passkey.');
  const recent = await ctx.db.query(`SELECT count(*)::int AS n FROM login_codes WHERE lower(email) = $1 AND created_at > now() - interval '1 hour'`, [email]);
  if (recent.rows[0].n >= MAX_CODES_PER_HOUR) throw new DomainError('RATE_LIMITED', 'Too many codes requested. Try again later.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await ctx.db.query('INSERT INTO login_codes (email, code_hash, expires_at) VALUES ($1,$2,$3)', [email, sha256(`${email}:${code}`), new Date(Date.now() + CODE_TTL_MS)]);
  const subject = locale === 'ru' ? `Код входа в Unyly: ${code}` : `Your Unyly sign-in code: ${code}`;
  const text =
    locale === 'ru'
      ? `Ваш код: ${code}\nОн действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.`
      : `Your code: ${code}\nIt is valid for 10 minutes. If you did not try to sign in, ignore this email.`;
  await ctx.mailer.send(email, subject, text);
  return ctx.cfg.devEchoLoginCode ? { devCode: code } : {};
}

export async function verifyLoginCode(ctx: Ctx, emailRaw: string, code: string, locale: 'ru' | 'en') {
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
    const user = await findOrCreateUserByEmail(q, email, locale);
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

/** Only allow same-site relative redirects (prevents open redirects). */
export function safeNext(next: unknown, fallback = '/app'): string {
  if (typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\r\n]/.test(next)) return fallback;
  return next.slice(0, 2000);
}
