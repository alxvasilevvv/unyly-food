// Events for partner apps: stored in partner_webhooks (outbox), delivered by the job worker with
// retries, and also readable by polling GET /partner/v1/users/{id}/events. Each event carries a
// localized `notify` hint so the app can show a push, update a Live Activity or have Ari call the user.
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/db.js';
import type { Locale } from '../domain/locales.js';
import { statusLabel } from '../domain/labels.js';
import type { Service } from '../domain/regions.js';
import type { FulfillmentStatus } from '../providers/types.js';
import { tr } from '../web/messages.js';
import { signedHeaders } from './auth.js';
import { findPartner } from './config.js';

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
  const what = trip ? `${o.items[0]?.name ?? ''}`.trim() : o.restaurant_name;
  const eta = o.eta_at ? new Date(o.eta_at).toISOString() : null;
  let body = what;
  let level: Notify['level'] = 'info';
  let suggestCall = false;
  if (status === 'accepted') level = 'important';
  if (status === 'preparing' && o.service === 'ride') {
    level = 'urgent';
    suggestCall = true;
    body = tr(l, { en: 'Your driver is on the way to the pickup point.', ru: 'Водитель уже едет к точке посадки.', th: 'คนขับกำลังไปยังจุดรับ' });
  }
  if (status === 'picked_up' && !trip) {
    level = 'important';
    body = tr(l, { en: `${what}: the courier is on the way to you.`, ru: `${what}: курьер едет к вам.`, th: `${what}: ไรเดอร์กำลังไปหาคุณ` });
  }
  if (status === 'delivered') {
    level = 'important';
    body = o.service === 'ride'
      ? tr(l, { en: 'You have arrived. Thank you for riding.', ru: 'Вы на месте. Хорошего дня!', th: 'ถึงที่หมายแล้ว ขอบคุณที่ใช้บริการ' })
      : tr(l, { en: `${what} has been delivered.`, ru: `${what}: доставлено.`, th: `${what}: ส่งถึงแล้ว` });
  }
  if (status === 'cancelled' || status === 'failed') {
    level = 'important';
    body = tr(l, { en: `${what}: ${label.toLowerCase()}. Nothing more will happen with this order.`, ru: `${what}: ${label.toLowerCase()}.`, th: `${what}: ${label}` });
  }
  return { title: label, body, level, suggest_call: suggestCall || undefined, live_activity: { state: status, progress: PROGRESS[status], eta_at: eta } };
}

/** Partner and locale of a user, or null for regular (non-partner) users. */
async function partnerOf(q: Queryable, userId: string): Promise<{ partner_id: string; external_user_id: string; locale: Locale } | null> {
  const r = (await q.query(
    `SELECT pu.partner_id, pu.external_user_id, u.locale FROM partner_users pu JOIN users u ON u.id = pu.user_id WHERE pu.user_id = $1`,
    [userId],
  )).rows[0];
  return r ?? null;
}

export async function enqueuePartnerEvent(
  q: Queryable, userId: string, type: PartnerEventType, data: Record<string, unknown>, opts: { dedupeKey?: string; notify?: (l: Locale) => Notify } = {},
): Promise<boolean> {
  const pu = await partnerOf(q, userId);
  if (!pu) return false;
  const payload = {
    type,
    partner_id: pu.partner_id,
    user_id: pu.external_user_id,
    created_at: new Date().toISOString(),
    data,
    ...(opts.notify ? { notify: opts.notify(pu.locale) } : {}),
  };
  await q.query(
    `INSERT INTO partner_webhooks (partner_id, user_id, event_type, dedupe_key, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [pu.partner_id, userId, type, opts.dedupeKey ?? null, JSON.stringify(payload)],
  );
  return true;
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
  created_at: string;
  data: unknown;
  notify?: Notify;
}

export async function listPartnerEvents(ctx: Ctx, userId: string, after = 0, limit = 50): Promise<StoredEvent[]> {
  const r = await ctx.db.query(
    `SELECT id, event_id, event_type, payload, created_at FROM partner_webhooks WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [userId, after, Math.min(Math.max(limit, 1), 100)],
  );
  return r.rows.map((x) => ({
    event_id: x.event_id, seq: Number(x.id), type: x.event_type, created_at: new Date(x.created_at).toISOString(), data: x.payload.data, notify: x.payload.notify,
  }));
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
    const body = JSON.stringify({ event_id: r.event_id, ...r.payload });
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
