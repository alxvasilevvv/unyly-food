// Events for partner apps: stored in partner_webhooks (outbox), delivered by the job worker with
// retries, and also readable by polling GET /partner/v1/users/{id}/events. Each event carries a
// localized `notify` hint so the app can show a push, update a Live Activity or have Ari call the user.
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/db.js';
import { LOCALE_CODES, type Locale } from '../domain/locales.js';
import { statusLabel } from '../domain/labels.js';
import type { Service } from '../domain/regions.js';
import type { FulfillmentStatus } from '../providers/types.js';
import { tr } from '../web/messages.js';
import { signedHeaders } from './auth.js';
import { dataText, trf } from './cards.js';
import { findPartner, WEB_DEMO_PARTNER } from './config.js';

export type PartnerEventType = 'order.created' | 'order.status_changed' | 'checkout.confirmed' | 'cancellation.confirmed' | 'grab.linked' | 'grab.unlinked';

export interface Notify {
  title: string;
  body: string;
  /** info: silent update; important: push; urgent: push plus a suggested call from Ari. */
  level: 'info' | 'important' | 'urgent';
  live_activity?: { state: string; progress: number; eta_at: string | null };
  suggest_call?: boolean;
}

interface OrderLike {
  id: string;
  user_id: string;
  service: Service;
  restaurant_name: string;
  address_label: string;
  items: { name: string }[];
  eta_at: string | Date | null;
}

const PROGRESS: Record<FulfillmentStatus, number> = { submitted: 0.1, accepted: 0.3, preparing: 0.5, picked_up: 0.75, delivered: 1, cancelled: 1, failed: 1 };

export function orderNotify(o: OrderLike, status: FulfillmentStatus, l: Locale): Notify {
  const label = statusLabel(o.service, status, l);
  const trip = o.service === 'ride' || o.service === 'express';
  const what = trip ? dataText(`${o.items[0]?.name ?? ''}`.trim(), l) : o.restaurant_name;
  const eta = o.eta_at ? new Date(o.eta_at).toISOString() : null;
  let body = what;
  let level: Notify['level'] = 'info';
  let suggestCall = false;
  if (status === 'accepted') level = 'important';
  if (status === 'preparing' && o.service === 'ride') {
    level = 'urgent';
    suggestCall = true;
    body = tr(l, { en: 'Your driver is on the way to the pickup point.', ru: 'Водитель уже едет к точке посадки.', th: 'คนขับกำลังเดินทางไปยังจุดรับ' });
  }
  if (status === 'picked_up' && !trip) {
    level = 'important';
    body = trf(l, { en: '{what}: the courier is on the way to you.', ru: '{what}: курьер едет к вам.', th: '{what}: ไรเดอร์กำลังนำส่งถึงคุณ' }, { what });
  }
  if (status === 'delivered') {
    level = 'important';
    body = o.service === 'ride'
      ? tr(l, { en: 'You have arrived. Thank you for riding.', ru: 'Вы на месте. Хорошего дня!', th: 'ถึงที่หมายแล้ว ขอบคุณที่ใช้บริการ' })
      : trf(l, { en: '{what} has been delivered.', ru: '{what}: доставлено.', th: '{what}: ส่งถึงแล้ว' }, { what });
  }
  if (status === 'cancelled' || status === 'failed') {
    level = 'important';
    body = trf(l, { en: '{what}: {status}. Nothing more will happen with this order.', ru: '{what}: {status}.', th: '{what}: {status}' }, { what, status: label.toLowerCase() });
  }
  return { title: label, body, level, suggest_call: suggestCall || undefined, live_activity: { state: status, progress: PROGRESS[status], eta_at: eta } };
}

/** Number of statement parameters one event takes (see partnerEventParams). */
export const PARTNER_EVENT_PARAMS = 7;

type EventOpts = { dedupeKey?: string; notify?: (l: Locale) => Notify };

/**
 * The parameters of one event, in the order partnerEventCtes expects them. The notify hint is prepared for every
 * interface language and the row picks the user's: any of them for the website demo, English, Russian or Thai
 * for signed partners (other locales get English, as documented).
 */
export function partnerEventParams(userId: string, type: PartnerEventType, data: Record<string, unknown>, opts: EventOpts = {}): unknown[] {
  const make = opts.notify;
  const notify = make ? JSON.stringify(Object.fromEntries(LOCALE_CODES.map((l) => [l, make(l)]))) : null;
  return [userId, type, opts.dedupeKey ?? null, new Date().toISOString(), JSON.stringify(data), notify, WEB_DEMO_PARTNER.id];
}

/**
 * The event insert as two CTEs (`<name>_pu`, `<name>`), so it can also ride in the statement that makes the change it
 * reports. Its seven parameters start at $first. `when` is an extra SQL condition (it may read earlier CTEs of the
 * statement). Regular users match no partner row and store nothing.
 */
export function partnerEventCtes(name: string, first: number, when = 'true'): string {
  const p = (i: number) => `$${first + i}`;
  return `${name}_pu AS (SELECT pu.partner_id, pu.external_user_id, u.locale FROM partner_users pu JOIN users u ON u.id = pu.user_id WHERE pu.user_id = ${p(0)}::uuid AND (${when})),
          ${name} AS (
            INSERT INTO partner_webhooks (partner_id, user_id, event_type, dedupe_key, payload)
            SELECT pu.partner_id, ${p(0)}::uuid, ${p(1)}::text, ${p(2)}::text,
                   jsonb_build_object('type', ${p(1)}::text, 'partner_id', pu.partner_id, 'user_id', pu.external_user_id, 'created_at', ${p(3)}::text, 'data', ${p(4)}::jsonb)
                   || CASE WHEN ${p(5)}::jsonb IS NULL THEN '{}'::jsonb
                           ELSE jsonb_build_object('notify', COALESCE(${p(5)}::jsonb -> (CASE WHEN pu.locale IN ('ru','th') OR pu.partner_id = ${p(6)}::text THEN pu.locale::text ELSE 'en' END), ${p(5)}::jsonb -> 'en')) END
              FROM ${name}_pu pu
            ON CONFLICT DO NOTHING)`;
}

export async function enqueuePartnerEvent(
  q: Queryable, userId: string, type: PartnerEventType, data: Record<string, unknown>, opts: EventOpts = {},
): Promise<boolean> {
  // One statement: look the partner user up and store the event.
  const r = await q.query<{ n: number }>(
    `WITH ${partnerEventCtes('ev', 1)} SELECT count(*)::int AS n FROM ev_pu`,
    partnerEventParams(userId, type, data, opts),
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

/** The parameters of the order.status_changed event (see enqueueOrderStatus), for a statement that embeds partnerEventCtes. */
export function orderStatusEventParams(o: OrderLike, status: FulfillmentStatus, isFinal: boolean, labelLocale?: Locale): unknown[] {
  return partnerEventParams(o.user_id, 'order.status_changed', {
    order_id: o.id, service: o.service, status, is_final: isFinal, eta_at: o.eta_at ? new Date(o.eta_at).toISOString() : null,
    status_label: statusLabel(o.service, status, labelLocale ?? 'en'),
  }, { dedupeKey: `order:${o.id}:${status}`, notify: (l) => orderNotify(o, status, l) });
}

export async function enqueueOrderStatus(q: Queryable, o: OrderLike, status: FulfillmentStatus, isFinal: boolean, labelLocale?: Locale) {
  await enqueuePartnerEvent(q, o.user_id, 'order.status_changed', {
    order_id: o.id, service: o.service, status, is_final: isFinal, eta_at: o.eta_at ? new Date(o.eta_at).toISOString() : null,
    status_label: statusLabel(o.service, status, labelLocale ?? 'en'),
  }, { dedupeKey: `order:${o.id}:${status}`, notify: (l) => orderNotify(o, status, l) });
}

export interface StoredEvent {
  event_id: string;
  seq: number;
  type: string;
  partner_id: string;
  user_id: string;
  created_at: string;
  data: unknown;
  notify?: Notify;
}

/** Sequence number of the user's newest event (0 when there is none). */
export async function lastPartnerEventSeq(ctx: Ctx, userId: string): Promise<number> {
  const r = await ctx.db.query('SELECT max(id) AS seq FROM partner_webhooks WHERE user_id = $1', [userId]);
  return Number(r.rows[0]?.seq ?? 0);
}

/**
 * Events of a partner user by its external id, in one statement (the polling path: no separate user lookup).
 * Returns null when the user does not exist, an empty list when there is nothing after `after`.
 */
export async function listPartnerEventsFor(ctx: Ctx, partnerId: string, externalUserId: string, after = 0, limit = 50): Promise<StoredEvent[] | null> {
  const r = await ctx.db.query(
    `SELECT w.id, w.event_id, w.event_type, w.payload, w.created_at
       FROM partner_users pu JOIN users u ON u.id = pu.user_id AND u.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT id, event_id, event_type, payload, created_at FROM partner_webhooks WHERE user_id = pu.user_id AND id > $3 ORDER BY id LIMIT $4
       ) w ON true
      WHERE pu.partner_id = $1 AND pu.external_user_id = $2
      ORDER BY w.id`,
    [partnerId, externalUserId, after, Math.min(Math.max(limit, 1), 100)],
  );
  if (!r.rows.length) return null;
  return r.rows.filter((x) => x.id != null).map(storedEvent);
}

export async function listPartnerEvents(ctx: Ctx, userId: string, after = 0, limit = 50): Promise<StoredEvent[]> {
  const r = await ctx.db.query(
    `SELECT id, event_id, event_type, payload, created_at FROM partner_webhooks WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [userId, after, Math.min(Math.max(limit, 1), 100)],
  );
  return r.rows.map(storedEvent);
}

function storedEvent(x: any): StoredEvent {
  return ({
    // Same shape as the webhook body: event_id, seq, then the stored payload fields.
    event_id: x.event_id, seq: Number(x.id), type: x.event_type, partner_id: x.payload.partner_id, user_id: x.payload.user_id,
    created_at: x.payload.created_at ?? new Date(x.created_at).toISOString(), data: x.payload.data, notify: x.payload.notify,
  });
}

const MAX_ATTEMPTS = 12;

/** Delivers due webhooks. Returns how many were delivered in this run. */
export async function deliverPartnerWebhooks(ctx: Ctx, limit = 25, fetcher: typeof fetch = fetch): Promise<number> {
  const due = await ctx.db.query(
    `SELECT id FROM partner_webhooks WHERE status = 'pending' AND next_try_at <= $1 ORDER BY id LIMIT $2`,
    [ctx.clock.now(), limit],
  );
  let delivered = 0;
  // Time budget per run: a slow or dead partner endpoint must not hold up the other background jobs.
  const deadline = Date.now() + 12_000;
  for (const { id } of due.rows) {
    if (Date.now() > deadline) break;
    const row = await ctx.db.tx(async (q) => {
      const r = (await q.query(`SELECT * FROM partner_webhooks WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!r) return null;
      const p = findPartner(ctx.cfg.partners, r.partner_id);
      if (!p || !p.webhookUrl) {
        // Polling-only partner (or the website demo): keep the event readable, nothing to send.
        await q.query(`UPDATE partner_webhooks SET status = 'skipped' WHERE id = $1`, [id]);
        return null;
      }
      // Claim: push next_try_at forward so a crash mid-send retries later instead of immediately.
      await q.query(`UPDATE partner_webhooks SET attempts = attempts + 1, next_try_at = $2 WHERE id = $1`, [id, new Date(ctx.clock.now().getTime() + 60_000)]);
      return { r, p };
    });
    if (!row) continue;
    const { r, p } = row;
    // seq is the same number GET .../events returns, so a receiver can resume polling from the last webhook it saw.
    const body = JSON.stringify({ event_id: r.event_id, seq: Number(r.id), ...r.payload });
    const url = new URL(p.webhookUrl!);
    let ok = false;
    let err = '';
    try {
      const res = await fetcher(p.webhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-unyly-event': r.event_type, 'x-unyly-delivery': r.event_id, ...signedHeaders(p, p.webhookSecret, 'POST', url.pathname + url.search, body, ctx.clock.now().getTime()) },
        body,
        signal: AbortSignal.timeout(4000),
        redirect: 'manual',
      });
      ok = res.status >= 200 && res.status < 300;
      if (!ok) err = `HTTP ${res.status}`;
    } catch (e: any) {
      err = String(e?.message ?? e).slice(0, 200);
    }
    if (ok) {
      await ctx.db.query(`UPDATE partner_webhooks SET status = 'delivered', delivered_at = $2, last_error = NULL WHERE id = $1`, [r.id, ctx.clock.now()]);
      delivered++;
    } else {
      const attempts = Number(r.attempts) + 1;
      const final = attempts >= MAX_ATTEMPTS;
      const delay = Math.min(10_000 * 2 ** (attempts - 1), 3600_000);
      await ctx.db.query(
        `UPDATE partner_webhooks SET status = $2, next_try_at = $3, last_error = $4 WHERE id = $1`,
        [r.id, final ? 'failed' : 'pending', new Date(ctx.clock.now().getTime() + delay), err],
      );
    }
  }
  return delivered;
}
