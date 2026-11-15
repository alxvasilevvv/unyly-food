// Partner users: an Ari user (opaque external id) maps to one Unyly user row. Unyly never sees the
// partner's credentials for that user; the partner's signed request is the authentication.
import { randomUUID } from 'node:crypto';
import type { Actor, Ctx } from '../context.js';
import { audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { isLocaleCode, Locale } from '../domain/locales.js';
import { DomainError } from '../domain/errors.js';
import { REGION_CODES } from '../domain/regions.js';
import { deleteAccount, type AddressRow, type UserRow } from '../services/users.js';
import { addressesJsonSql } from '../services/carts.js';
import type { CheckoutWithQuoteExpiry } from '../services/checkout.js';
import type { OrderRow } from '../services/orders.js';
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
  /** The user's saved addresses (default first) when they were read together with the user in this request. Never serialized. */
  addresses?: AddressRow[];
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
    // The user, the mapping, default preferences, provider connections and the audit row in one statement
    // (the foreign keys to the new user are checked when the statement ends).
    const row = (await q.query<UserRow>(
      `WITH u AS (INSERT INTO users (email, locale, region, mode, onboarded_at, partner_id, is_guest, guest_ip_hash) VALUES ($1,$2,$3,$4, now(), $5, $6, $7) RETURNING *),
            pu AS (INSERT INTO partner_users (partner_id, external_user_id, user_id, display_name) SELECT $5, $8, u.id, $9 FROM u),
            pr AS (INSERT INTO preferences (user_id, default_party_size) SELECT u.id, 2 FROM u ON CONFLICT DO NOTHING),
            pc AS (INSERT INTO provider_connections (user_id, provider, mode, status)
                   SELECT u.id, x.provider, x.mode, 'connected' FROM u, (VALUES ('demo','demo'), ('grab', $4::text)) AS x(provider, mode)
                    WHERE x.provider = 'demo' OR $4::text <> 'demo' ON CONFLICT DO NOTHING),
            au AS (INSERT INTO audit_log (user_id, actor, action, mode, entity, entity_id, details) SELECT u.id, $10, 'user.partner_created', $4::text, NULL, NULL, '{}'::jsonb FROM u)
       SELECT * FROM u`,
      [`${p.id}-${randomUUID()}@partner.unyly.invalid`, locale ?? 'en', region ?? 'TH', p.mode, p.id, !!opts.guestIpHash, opts.guestIpHash ?? null,
        ext, displayName ?? null, `partner:${p.id}`],
    )).rows[0];
    return { user_id: row.id, partner_id: p.id, external_user_id: ext, display_name: displayName ?? null, locale: locale ?? 'en', region: region ?? 'TH', mode: p.mode, created: true, row };
  };
  if (opts.q) return run(opts.q);
  return (await touch(ctx.db)) ?? ctx.db.tx(run);
}

/**
 * What else to read in the same statement as the user (one round trip instead of two or three): every part is a
 * JSON sub-select scoped to that user, so nothing of another user can come back.
 */
export interface UserExtras {
  /** Saved addresses, default first (as listAddresses). */
  addresses?: boolean;
  /** Grab link status and the newest event sequence (the session call). */
  session?: boolean;
  /** This checkout with the expiry of its quote (as loadCheckoutWithQuoteExpiry), when it belongs to the user. */
  checkoutId?: string;
  /** This order and its demo simulator row, when it belongs to the user. */
  orderId?: string;
  /** With orderId or on its own: the user's events after this sequence number (at most 50, as the events poll). */
  eventsAfter?: number;
}

export interface UserExtrasResult {
  grab?: { external_ref: string | null; created_at: string } | null;
  lastEvent?: number;
  checkout?: CheckoutWithQuoteExpiry | null;
  order?: { order: OrderRow; sim: Record<string, any> | null } | null;
  events?: { id: number; event_id: string; event_type: string; payload: any; created_at: string }[];
}

/** Existing user only (every route except PUT /users/{id} requires the user to exist). */
export async function loadPartnerUser(ctx: Ctx, p: PartnerConfig, ext: string): Promise<PartnerUser> {
  return (await loadPartnerUserWith(ctx, p, ext, {})).user;
}

/** loadPartnerUser plus the rows named in `want`, in one statement. */
export async function loadPartnerUserWith(ctx: Ctx, p: PartnerConfig, ext: string, want: UserExtras): Promise<{ user: PartnerUser; extra: UserExtrasResult }> {
  checkExternalId(ext);
  const params: unknown[] = [p.id, ext];
  const arg = (v: unknown) => `$${params.push(v)}`;
  const cols: string[] = [];
  if (want.addresses) cols.push(`${addressesJsonSql('u.id')} AS x_addresses`);
  if (want.session) {
    cols.push(`(SELECT to_jsonb(g) FROM (SELECT external_ref, created_at FROM provider_connections WHERE user_id = u.id AND provider = 'grab_account' AND status = 'connected' ORDER BY created_at DESC LIMIT 1) g) AS x_grab`);
    cols.push('(SELECT max(id) FROM partner_webhooks WHERE user_id = u.id) AS x_last_event');
  }
  if (want.checkoutId) {
    cols.push(`(SELECT to_jsonb(k) FROM (SELECT c.*, (SELECT expires_at FROM quotes WHERE id = c.quote_id) AS quote_expires_at FROM checkouts c WHERE c.id = ${arg(want.checkoutId)}::uuid AND c.user_id = u.id) k) AS x_checkout`);
  }
  if (want.orderId) {
    cols.push(`(SELECT jsonb_build_object('order', to_jsonb(o), 'sim', to_jsonb(d)) FROM orders o LEFT JOIN demo_sim_orders d ON o.provider = 'demo' AND d.ref = o.provider_order_ref
                 WHERE o.id = ${arg(want.orderId)}::uuid AND o.user_id = u.id) AS x_order`);
  }
  if (want.eventsAfter !== undefined) {
    cols.push(`(SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.id), '[]'::jsonb)
                  FROM (SELECT id, event_id, event_type, payload, created_at FROM partner_webhooks WHERE user_id = u.id AND id > ${arg(want.eventsAfter)}::bigint ORDER BY id LIMIT 50) w) AS x_events`);
  }
  const r = (await ctx.db.query(
    `SELECT pu.display_name AS pu_display_name, u.*${cols.map((c) => `,\n            ${c}`).join('')}
       FROM partner_users pu JOIN users u ON u.id = pu.user_id
      WHERE pu.partner_id = $1 AND pu.external_user_id = $2 AND u.deleted_at IS NULL`,
    params,
  )).rows[0];
  if (!r) throw new DomainError('NOT_FOUND', 'Unknown user. Create it first with PUT /partner/v1/users/{uid}.');
  const { x_addresses, x_grab, x_last_event, x_checkout, x_order, x_events, ...joined } = r;
  const user = fromJoined(p, ext, joined);
  if (want.addresses) user.addresses = (x_addresses ?? []) as AddressRow[];
  const extra: UserExtrasResult = {};
  if (want.session) {
    extra.grab = x_grab ?? null;
    extra.lastEvent = Number(x_last_event ?? 0);
  }
  if (want.checkoutId) extra.checkout = x_checkout ?? null;
  if (want.orderId) extra.order = x_order?.order ? { order: x_order.order as OrderRow, sim: x_order.sim ?? null } : null;
  if (want.eventsAfter !== undefined) extra.events = x_events ?? [];
  return { user, extra };
}

export async function deletePartnerUser(ctx: Ctx, p: PartnerConfig, ext: string) {
  const u = await loadPartnerUser(ctx, p, ext);
  await deleteAccount(ctx, u.user_id);
}
