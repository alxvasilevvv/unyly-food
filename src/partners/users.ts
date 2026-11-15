// Partner users: an Ari user (opaque external id) maps to one Unyly user row. Unyly never sees the
// partner's credentials for that user; the partner's signed request is the authentication.
import { randomUUID } from 'node:crypto';
import type { Actor, Ctx } from '../context.js';
import { audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { isLocaleCode, Locale } from '../domain/locales.js';
import { DomainError } from '../domain/errors.js';
import { REGION_CODES } from '../domain/regions.js';
import { deleteAccount, type UserRow } from '../services/users.js';
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
  /** The users row read together with the mapping, so a tool call in the same request does not read it again. Never serialized. */
  row?: UserRow;
}

/** Splits the joined row (users columns plus pu_display_name) into the PartnerUser and its users row. */
function fromJoined(p: PartnerConfig, ext: string, r: Record<string, any>, over: { locale?: Locale; region?: string; display_name?: string | null } = {}): PartnerUser {
  const { pu_display_name, ...user } = r;
  const row = { ...user, locale: over.locale ?? user.locale, region: over.region ?? user.region } as UserRow;
  return {
    user_id: row.id, partner_id: p.id, external_user_id: ext, display_name: over.display_name ?? pu_display_name ?? null,
    locale: row.locale, region: row.region, mode: row.mode as PartnerUser['mode'], created: false, row,
  };
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
  opts: { q?: Queryable; guestIpHash?: string; fresh?: boolean } = {},
): Promise<PartnerUser> {
  checkExternalId(ext);
  const locale: Locale | undefined = isLocaleCode(input.locale) ? input.locale : undefined;
  if (input.locale !== undefined && !locale) throw new DomainError('VALIDATION_FAILED', 'Unsupported locale');
  const region = typeof input.region === 'string' ? input.region.toUpperCase() : undefined;
  if (region !== undefined && !(REGION_CODES as readonly string[]).includes(region)) throw new DomainError('VALIDATION_FAILED', 'Unsupported region');
  const displayName = typeof input.display_name === 'string' ? input.display_name.trim().slice(0, 60) || null : undefined;
  // An existing user (the usual case) is refreshed in one statement. The final SELECT reads the statement
  // snapshot, so a new locale or region is applied to the returned row here.
  const touch = async (q: Queryable): Promise<PartnerUser | null> => {
    const found = (await q.query(
      `WITH pu AS (
         UPDATE partner_users x SET last_seen_at = now(), display_name = COALESCE($3, x.display_name)
           FROM users u WHERE x.partner_id = $1 AND x.external_user_id = $2 AND u.id = x.user_id AND u.deleted_at IS NULL
         RETURNING x.user_id, x.display_name),
       uu AS (
         UPDATE users u SET locale = COALESCE($4, u.locale), region = COALESCE($5, u.region) FROM pu
          WHERE u.id = pu.user_id AND ($4::text IS NOT NULL OR $5::text IS NOT NULL))
       SELECT pu.display_name AS pu_display_name, u.* FROM pu JOIN users u ON u.id = pu.user_id`,
      [p.id, ext, displayName ?? null, locale ?? null, region ?? null],
    )).rows[0];
    return found ? fromJoined(p, ext, found, { locale, region }) : null;
  };
  const run = async (q: Queryable): Promise<PartnerUser> => {
    if (!opts.fresh) {
      // Creation is serialized per (partner, external id); a parallel request that lost the race finds the row here.
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`partner:${p.id}:${ext}`]);
      const found = await touch(q);
      if (found) return found;
    }
    // Users rows need an email; partner users get a non-routable placeholder (never mailed).
    const row = (await q.query<UserRow>(
      `INSERT INTO users (email, locale, region, mode, onboarded_at, partner_id, is_guest, guest_ip_hash) VALUES ($1,$2,$3,$4, now(), $5, $6, $7) RETURNING *`,
      [`${p.id}-${randomUUID()}@partner.unyly.invalid`, locale ?? 'en', region ?? 'TH', p.mode, p.id, !!opts.guestIpHash, opts.guestIpHash ?? null],
    )).rows[0];
    // The mapping, default preferences, provider connections and the audit row in one statement.
    await q.query(
      `WITH pu AS (INSERT INTO partner_users (partner_id, external_user_id, user_id, display_name) VALUES ($1,$2,$3,$4)),
            pr AS (INSERT INTO preferences (user_id, default_party_size) VALUES ($3, 2) ON CONFLICT DO NOTHING),
            pc AS (INSERT INTO provider_connections (user_id, provider, mode, status)
                   SELECT $3::uuid, x.provider, x.mode, 'connected' FROM (VALUES ('demo','demo'), ('grab', $5::text)) AS x(provider, mode)
                    WHERE x.provider = 'demo' OR $5::text <> 'demo' ON CONFLICT DO NOTHING)
       INSERT INTO audit_log (user_id, actor, action, mode, entity, entity_id, details) VALUES ($3, $6, 'user.partner_created', $5, NULL, NULL, '{}'::jsonb)`,
      [p.id, ext, row.id, displayName ?? null, p.mode, `partner:${p.id}`],
    );
    return { user_id: row.id, partner_id: p.id, external_user_id: ext, display_name: displayName ?? null, locale: locale ?? 'en', region: region ?? 'TH', mode: p.mode, created: true, row };
  };
  if (opts.q) return run(opts.q);
  return (await touch(ctx.db)) ?? ctx.db.tx(run);
}

/** Existing user only (every route except PUT /users/{id} requires the user to exist). */
export async function loadPartnerUser(ctx: Ctx, p: PartnerConfig, ext: string): Promise<PartnerUser> {
  checkExternalId(ext);
  const r = (await ctx.db.query(
    `SELECT pu.display_name AS pu_display_name, u.* FROM partner_users pu JOIN users u ON u.id = pu.user_id
      WHERE pu.partner_id = $1 AND pu.external_user_id = $2 AND u.deleted_at IS NULL`,
    [p.id, ext],
  )).rows[0];
  if (!r) throw new DomainError('NOT_FOUND', 'Unknown user. Create it first with PUT /partner/v1/users/{user_id}.');
  return fromJoined(p, ext, r);
}

export async function deletePartnerUser(ctx: Ctx, p: PartnerConfig, ext: string) {
  const u = await loadPartnerUser(ctx, p, ext);
  await deleteAccount(ctx, u.user_id);
}
