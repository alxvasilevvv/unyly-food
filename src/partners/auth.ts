// Request signing for the Partner API (and for webhooks Unyly sends back to the partner).
//
//   canonical = "v1\n" + METHOD + "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(sha256(raw body))
//   X-Unyly-Signature: v1=<hex(HMAC-SHA256(secret, canonical))>
//
// Headers: X-Unyly-Partner (partner id), X-Unyly-Timestamp (unix seconds, within 300 s of Unyly's clock),
// X-Unyly-Nonce (16 to 64 chars of [A-Za-z0-9_-], single use), X-Unyly-Signature.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import { safeEqual } from '../domain/crypto.js';
import { DomainError } from '../domain/errors.js';
import { findPartner, PartnerConfig } from './config.js';

export const SIGNATURE_VERSION = 'v1';
export const MAX_SKEW_SEC = 300;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const bodyDigest = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

export function canonical(method: string, pathWithQuery: string, timestamp: string, nonce: string, rawBody: string): string {
  return [SIGNATURE_VERSION, method.toUpperCase(), pathWithQuery, timestamp, nonce, bodyDigest(rawBody)].join('\n');
}

export function sign(secret: string, method: string, pathWithQuery: string, timestamp: string, nonce: string, rawBody: string): string {
  return `${SIGNATURE_VERSION}=${createHmac('sha256', secret).update(canonical(method, pathWithQuery, timestamp, nonce, rawBody)).digest('hex')}`;
}

/** Headers for a signed request (used by tests, the sample client and outgoing webhooks). */
export function signedHeaders(p: Pick<PartnerConfig, 'id'>, secret: string, method: string, pathWithQuery: string, rawBody: string, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  const nonce = randomBytes(18).toString('base64url');
  return {
    'x-unyly-partner': p.id,
    'x-unyly-timestamp': ts,
    'x-unyly-nonce': nonce,
    'x-unyly-signature': sign(secret, method, pathWithQuery, ts, nonce, rawBody),
  };
}

const h1 = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/**
 * Verifies a signed partner request and burns its nonce. Every failure is the same 401 so a caller
 * cannot tell which part was wrong.
 */
export async function verifyPartnerRequest(
  ctx: Ctx,
  req: { method: string; url: string; headers: Record<string, string | string[] | undefined>; rawBody: string },
): Promise<PartnerConfig> {
  const fail = () => new DomainError('PARTNER_AUTH_FAILED', 'Partner signature missing or invalid.');
  const id = h1(req.headers['x-unyly-partner']).trim().toLowerCase();
  const ts = h1(req.headers['x-unyly-timestamp']).trim();
  const nonce = h1(req.headers['x-unyly-nonce']).trim();
  const sig = h1(req.headers['x-unyly-signature']).trim();
  const partner = findPartner(ctx.cfg.partners, id);
  if (!partner || partner.internal || !partner.secret) throw fail();
  if (!/^\d{9,11}$/.test(ts) || !NONCE_RE.test(nonce) || !sig.startsWith(`${SIGNATURE_VERSION}=`)) throw fail();
  const skew = Math.abs(ctx.clock.now().getTime() / 1000 - Number(ts));
  if (skew > MAX_SKEW_SEC) throw fail();
  const expected = sign(partner.secret, req.method, req.url, ts, nonce, req.rawBody);
  if (!safeEqual(expected, sig)) throw fail();
  // Replay protection: the nonce is single use within the skew window (rows older than that are pruned).
  const r = await ctx.db.query('INSERT INTO partner_nonces (partner_id, nonce) VALUES ($1,$2) ON CONFLICT DO NOTHING', [partner.id, nonce]);
  if (r.rowCount === 0) throw fail();
  return partner;
}

export async function pruneNonces(ctx: Ctx) {
  await ctx.db.query(`DELETE FROM partner_nonces WHERE seen_at < $1`, [new Date(ctx.clock.now().getTime() - 2 * MAX_SKEW_SEC * 1000)]);
}
