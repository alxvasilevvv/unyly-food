// Partner users: an Ari user (opaque external id) maps to one Unyly user row. Unyly never sees the
// partner's credentials for that user; the partner's signed request is the authentication.
import { randomUUID } from 'node:crypto';
import type { Actor, Ctx } from '../context.js';
import { audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { isLocaleCode, Locale } from '../domain/locales.js';
import { DomainError } from '../domain/errors.js';
import { REGION_CODES } from '../domain/regions.js';
import { deleteAccount } from '../services/users.js';
import type { PartnerConfig } from './config.js';

export const EXT_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

export interface PartnerUser {
  user_id: string;
  partner_id: string;
  external_user_id: string;
  display_name: string | null;
  locale: Locale;
  region: string;
  mode: 'demo' | 'handoff' | 'live';
  created: boolean;
}

export function partnerActor(p: PartnerConfig, userId: string): Actor {
  return { userId, via: 'partner', clientId: p.id, scopes: ['orders:read', 'orders:prepare', 'orders:submit', 'orders:cancel'] };
}

export function checkExternalId(ext: string) {
  if (!EXT_ID_RE.test(ext)) throw new DomainError('VALIDATION_FAILED', 'user id must be 1 to 128 characters of letters, digits and . _ : @ -');
}

/** Find the Unyly user for (partner, external id), creating it on first use. */
export async function upsertPartnerUser(
  ctx: Ctx, p: PartnerConfig, ext: string, input: { locale?: unknown; region?: unknown; display_name?: unknown } = {},
  opts: { q?: Queryable; guestIpHash?: string } = {},
): Promise<PartnerUser> {
  checkExternalId(ext);
  const locale: Locale | undefined = isLocaleCode(input.locale) ? input.locale : undefined;
  if (input.locale !== undefined && !locale) throw new DomainError('VALIDATION_FAILED', 'Unsupported locale');
  const region = typeof input.region === 'string' ? input.region.toUpperCase() : undefined;
  if (region !== undefined && !(REGION_CODES as readonly string[]).includes(region)) throw new DomainError('VALIDATION_FAILED', 'Unsupported region');
  const displayName = typeof input.display_name === 'string' ? input.display_name.trim().slice(0, 60) || null : undefined;
  const run = async (q: Queryable): Promise<PartnerUser> => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`partner:${p.id}:${ext}`]);
    const found = (await q.query(
      `SELECT pu.user_id, pu.display_name, u.locale, u.region, u.mode FROM partner_users pu JOIN users u ON u.id = pu.user_id
        WHERE pu.partner_id = $1 AND pu.external_user_id = $2 AND u.deleted_at IS NULL`,
      [p.id, ext],
    )).rows[0];
    if (found) {
      await q.query(
        `UPDATE partner_users SET last_seen_at = now(), display_name = COALESCE($3, display_name) WHERE partner_id = $1 AND external_user_id = $2`,
        [p.id, ext, displayName ?? null],
      );
      if (locale || region) await q.query('UPDATE users SET locale = COALESCE($2, locale), region = COALESCE($3, region) WHERE id = $1', [found.user_id, locale ?? null, region ?? null]);
      return {
        user_id: found.user_id, partner_id: p.id, external_user_id: ext, display_name: displayName ?? found.display_name,
        locale: locale ?? found.locale, region: region ?? found.region, mode: found.mode, created: false,
      };
    }
    // Users rows need an email; partner users get a non-routable placeholder (never mailed).
    const u = (await q.query(
      `INSERT INTO users (email, locale, region, mode, onboarded_at, partner_id, is_guest, guest_ip_hash) VALUES ($1,$2,$3,$4, now(), $5, $6, $7) RETURNING id`,
      [`${p.id}-${randomUUID()}@partner.unyly.invalid`, locale ?? 'en', region ?? 'TH', p.mode, p.id, !!opts.guestIpHash, opts.guestIpHash ?? null],
    )).rows[0];
    await q.query('INSERT INTO partner_users (partner_id, external_user_id, user_id, display_name) VALUES ($1,$2,$3,$4)', [p.id, ext, u.id, displayName ?? null]);
    await q.query('INSERT INTO preferences (user_id, default_party_size) VALUES ($1, 2) ON CONFLICT DO NOTHING', [u.id]);
    await q.query(`INSERT INTO provider_connections (user_id, provider, mode, status) VALUES ($1,'demo','demo','connected') ON CONFLICT DO NOTHING`, [u.id]);
    if (p.mode !== 'demo') {
      await q.query(`INSERT INTO provider_connections (user_id, provider, mode, status) VALUES ($1,'grab',$2,'connected') ON CONFLICT DO NOTHING`, [u.id, p.mode]);
    }
    await audit(q, { userId: u.id, actor: `partner:${p.id}`, action: 'user.partner_created', mode: p.mode });
    return { user_id: u.id, partner_id: p.id, external_user_id: ext, display_name: displayName ?? null, locale: locale ?? 'en', region: region ?? 'TH', mode: p.mode, created: true };
  };
  return opts.q ? run(opts.q) : ctx.db.tx(run);
}

/** Existing user only (every route except PUT /users/{id} requires the user to exist). */
export async function loadPartnerUser(ctx: Ctx, p: PartnerConfig, ext: string): Promise<PartnerUser> {
  checkExternalId(ext);
  const r = (await ctx.db.query(
    `SELECT pu.user_id, pu.display_name, u.locale, u.region, u.mode FROM partner_users pu JOIN users u ON u.id = pu.user_id
      WHERE pu.partner_id = $1 AND pu.external_user_id = $2 AND u.deleted_at IS NULL`,
    [p.id, ext],
  )).rows[0];
  if (!r) throw new DomainError('NOT_FOUND', 'Unknown user. Create it first with PUT /partner/v1/users/{user_id}.');
  return { user_id: r.user_id, partner_id: p.id, external_user_id: ext, display_name: r.display_name, locale: r.locale, region: r.region, mode: r.mode, created: false };
}

export async function deletePartnerUser(ctx: Ctx, p: PartnerConfig, ext: string) {
  const u = await loadPartnerUser(ctx, p, ext);
  await deleteAccount(ctx, u.user_id);
}
