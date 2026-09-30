import type { Actor, Ctx } from '../context.js';
import { actorLabel, audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { DomainError } from '../domain/errors.js';
import { money } from '../domain/money.js';
import { ProviderEvent, ProviderOutcomeUnknownError, ProviderUnavailableError, STATUS_RANK, TERMINAL, FulfillmentStatus } from '../providers/types.js';
import { statusLabel } from '../domain/labels.js';
import { isTripService, Service } from '../domain/regions.js';
import { createCart, loadCart } from './carts.js';
import { callProvider, requireCapability, withTimeout } from './common.js';

export interface OrderRow {
  id: string;
  user_id: string;
  checkout_id: string;
  submission_id: string;
  cart_id: string;
  mode: 'demo' | 'handoff' | 'live';
  service: Service;
  provider: string;
  provider_order_ref: string;
  restaurant_id: string | null;
  restaurant_name: string;
  items: any[];
  address_label: string;
  total_minor: number;
  currency: string;
  fulfillment_status: FulfillmentStatus;
  payment_status: string;
  status_version: number;
  status_updated_at: string;
  eta_at: string | null;
  created_at: string;
}

export async function loadOrder(q: Queryable, userId: string, id: string): Promise<OrderRow> {
  const r = await q.query<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Order not found');
  return r.rows[0];
}

export function describeOrder(o: OrderRow, locale: 'ru' | 'en' | 'th' = 'en') {
  return {
    order_id: o.id,
    mode: o.mode,
    provider_order_ref: o.provider_order_ref,
    service: o.service,
    title: isTripService(o.service) ? `${o.items[0]?.name ?? 'Trip'}: ${o.address_label}` : o.restaurant_name,
    store: isTripService(o.service) ? undefined : o.restaurant_name,
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, modifiers: i.modifiers })),
    delivery_to: isTripService(o.service) ? undefined : o.address_label,
    trip: isTripService(o.service) ? o.address_label : undefined,
    total: money(o.total_minor, o.currency, locale),
    fulfillment_status: o.fulfillment_status,
    status_label: statusLabel(o.service, o.fulfillment_status, locale),
    payment_status: o.payment_status,
    is_final: TERMINAL.includes(o.fulfillment_status),
    status_updated_at: new Date(o.status_updated_at).toISOString(),
    eta_estimate_at: o.eta_at ? new Date(o.eta_at).toISOString() : null,
    placed_at: new Date(o.created_at).toISOString(),
  };
}

/**
 * Apply a provider status event. Out-of-order and duplicate events are ignored by comparing the
 * provider sequence; terminal states are never left.
 */
export async function applyEvent(q: Queryable, provider: string, ev: ProviderEvent): Promise<'applied' | 'stale' | 'order_unknown'> {
  const o = (await q.query<OrderRow>('SELECT * FROM orders WHERE provider = $1 AND provider_order_ref = $2 FOR UPDATE', [provider, ev.order_ref])).rows[0];
  if (!o) return 'order_unknown';
  if (ev.sequence <= o.status_version) return 'stale';
  if (TERMINAL.includes(o.fulfillment_status) && ev.status !== o.fulfillment_status) return 'stale';
  if (STATUS_RANK[ev.status] === undefined) return 'stale';
  await q.query(
    `UPDATE orders SET fulfillment_status=$2, payment_status=$3, status_version=$4, status_updated_at=$5, eta_at=COALESCE($6, eta_at) WHERE id=$1`,
    [o.id, ev.status, ev.payment_status, ev.sequence, ev.occurred_at, ev.eta_at ?? null],
  );
  await audit(q, { userId: o.user_id, actor: `provider:${provider}`, action: 'order.status_changed', mode: o.mode, entity: 'order', entityId: o.id, details: { status: ev.status, seq: ev.sequence } });
  return 'applied';
}

/** Persist first, then process. Duplicates are dropped by UNIQUE(provider, event_id). */
export async function ingestEvents(ctx: Ctx, provider: string, events: ProviderEvent[]) {
  let inserted = 0;
  for (const ev of events) {
    const r = await ctx.db.query(
      `INSERT INTO provider_events (provider, event_id, order_ref, sequence, type, payload, occurred_at, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [provider, ev.event_id, ev.order_ref, ev.sequence, ev.type, JSON.stringify(ev), ev.occurred_at, ctx.clock.now()],
    );
    inserted += r.rowCount;
  }
  const processed = await processPendingEvents(ctx);
  return { received: events.length, new: inserted, duplicates: events.length - inserted, processed };
}

export async function processPendingEvents(ctx: Ctx, limit = 100) {
  // Events waiting for their order row are retried with backoff so they cannot starve newer events.
  const pending = await ctx.db.query(
    'SELECT id FROM provider_events WHERE processed_at IS NULL AND (next_try_at IS NULL OR next_try_at <= $2) ORDER BY id LIMIT $1',
    [limit, ctx.clock.now()],
  );
  let n = 0;
  for (const { id } of pending.rows) {
    await ctx.db.tx(async (q) => {
      const ev = (await q.query('SELECT * FROM provider_events WHERE id = $1 AND processed_at IS NULL FOR UPDATE SKIP LOCKED', [id])).rows[0];
      if (!ev) return;
      const outcome = await applyEvent(q, ev.provider, ev.payload);
      if (outcome === 'order_unknown') {
        // The webhook may arrive before we stored the order. Retry for 24h, then park it.
        const ageMs = ctx.clock.now().getTime() - new Date(ev.received_at).getTime();
        if (ageMs < 24 * 3600_000) {
          const delay = Math.min(15_000 * 2 ** ev.tries, 30 * 60_000);
          await q.query('UPDATE provider_events SET tries = tries + 1, next_try_at = $2 WHERE id = $1', [id, new Date(ctx.clock.now().getTime() + delay)]);
          return;
        }
        await q.query(`UPDATE provider_events SET processed_at = now(), outcome = 'orphaned' WHERE id = $1`, [id]);
        return;
      }
      await q.query('UPDATE provider_events SET processed_at = now(), outcome = $2 WHERE id = $1', [id, outcome]);
      n++;
    });
  }
  return n;
}

export async function ingestWebhook(ctx: Ctx, providerKey: 'demo', rawBody: string, headers: Record<string, string | string[] | undefined>) {
  const provider = ctx.providers[providerKey];
  let events: ProviderEvent[];
  try {
    events = provider.verifyWebhook(rawBody, headers);
  } catch (e: any) {
    throw new DomainError('AUTH_REQUIRED', `Webhook rejected: ${e.message}`);
  }
  return ingestEvents(ctx, provider.providerName, events);
}

/** Refresh one order from the provider when stale. On provider failure, return stored data with a notice. */
export async function getOrderStatus(ctx: Ctx, actor: Actor, orderId: string) {
  let o = await loadOrder(ctx.db, actor.userId, orderId);
  const notices: string[] = [];
  let dataAsOf = new Date(o.status_updated_at).toISOString();
  if (!TERMINAL.includes(o.fulfillment_status)) {
    try {
      const provider = ctx.provider(o.mode);
      const s = await withTimeout(provider.getOrderStatus(o.provider_order_ref), ctx.cfg.providerTimeoutMs, () => new ProviderOutcomeUnknownError('timeout'));
      await ctx.db.tx((q) =>
        applyEvent(q, provider.providerName, {
          event_id: `poll:${s.provider_order_ref}:${s.sequence}`, order_ref: s.provider_order_ref, sequence: s.sequence, type: 'order.status_changed',
          status: s.status, payment_status: s.payment_status, occurred_at: ctx.clock.now().toISOString(), eta_at: s.eta_at,
        }),
      );
      o = await loadOrder(ctx.db, actor.userId, orderId);
      dataAsOf = ctx.clock.now().toISOString();
    } catch (e) {
      if (!(e instanceof ProviderUnavailableError || e instanceof ProviderOutcomeUnknownError)) throw e;
      notices.push(`PROVIDER_UNAVAILABLE: showing the last known status from ${dataAsOf}. This is real stored data, not demo data.`);
    }
  }
  return { order: describeOrder(o), data_as_of: dataAsOf, notices };
}

export async function listOrders(ctx: Ctx, actor: Actor, args: { limit?: number; before?: string }) {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const r = await ctx.db.query<OrderRow>(
    `SELECT * FROM orders WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT $3`,
    [actor.userId, args.before ?? null, limit + 1],
  );
  const rows = r.rows.slice(0, limit);
  const handoffs = await ctx.db.query(
    `SELECT h.id, h.created_at, c.restaurant_name, c.service FROM handoffs h JOIN carts c ON c.id = h.cart_id WHERE h.user_id = $1 ORDER BY h.created_at DESC LIMIT 10`,
    [actor.userId],
  );
  return {
    orders: rows.map((o) => describeOrder(o)),
    next_before: r.rows.length > limit ? new Date(rows[rows.length - 1].created_at).toISOString() : null,
    handoffs: handoffs.rows.map((h) => ({
      handoff_id: h.id, service: h.service, store: h.restaurant_name, created_at: new Date(h.created_at).toISOString(),
      note: 'Handoff only: Unyly does not know whether you completed this order in Grab.',
    })),
  };
}

/** Repeat an order: always a NEW draft cart, re-validated against the current menu and prices. */
export async function reorder(ctx: Ctx, actor: Actor, orderId: string) {
  const o = await loadOrder(ctx.db, actor.userId, orderId);
  const oldCart = await loadCart(ctx.db, actor.userId, o.cart_id);
  const cart = await createCart(ctx, actor, {
    service: oldCart.service,
    reuse_trip: oldCart.trip,
    restaurant_id: oldCart.restaurant_id ?? undefined,
    restaurant_name: oldCart.restaurant_name,
    items: oldCart.items.map((l) => ({ item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers: l.modifiers, note: l.note })),
  });
  await ctx.db.query('UPDATE carts SET source_order_id = $2 WHERE id = $1', [cart.id, o.id]);
  return cart;
}

// ---------------- Cancellation ----------------
export interface CancellationRow {
  id: string;
  user_id: string;
  order_id: string;
  fee_minor: number;
  currency: string;
  terms: string;
  status: 'awaiting_user' | 'approved' | 'executing' | 'executed' | 'rejected' | 'expired' | 'unknown' | 'invalidated';
  expires_at: string;
  approved_at: string | null;
  executed_at: string | null;
  error_code: string | null;
}
export const cancelConfirmUrl = (ctx: Ctx, id: string) => `${ctx.cfg.webOrigin}/confirm-cancel/${id}`;
const CANCEL_TTL_MS = 5 * 60_000;

export async function prepareCancellation(ctx: Ctx, actor: Actor, orderId: string) {
  const o = await loadOrder(ctx.db, actor.userId, orderId);
  requireCapability(ctx, o.mode, 'cancel_order');
  if (TERMINAL.includes(o.fulfillment_status)) throw new DomainError('CANCELLATION_NOT_ALLOWED', `Order is already ${o.fulfillment_status}`);
  const terms = await callProvider(() => ctx.provider(o.mode).getCancellationTerms(o.provider_order_ref));
  if (!terms.allowed) throw new DomainError('CANCELLATION_NOT_ALLOWED', terms.terms);
  return ctx.db.tx(async (q) => {
    await q.query(`UPDATE cancellation_requests SET status='invalidated' WHERE order_id=$1 AND status='awaiting_user'`, [o.id]);
    const r = await q.query<CancellationRow>(
      `INSERT INTO cancellation_requests (user_id, order_id, fee_minor, currency, terms, status, expires_at) VALUES ($1,$2,$3,$4,$5,'awaiting_user',$6) RETURNING *`,
      [actor.userId, o.id, terms.fee_minor, terms.currency, terms.terms, new Date(ctx.clock.now().getTime() + CANCEL_TTL_MS)],
    );
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'cancellation.prepared', mode: o.mode, entity: 'order', entityId: o.id, details: { fee: terms.fee_minor } });
    return r.rows[0];
  });
}

export async function loadCancellation(q: Queryable, userId: string, id: string, lock = false) {
  const r = await q.query<CancellationRow>(`SELECT * FROM cancellation_requests WHERE id=$1 AND user_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, userId]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Cancellation request not found');
  return r.rows[0];
}

/** Human approval from the web page. Re-checks the fee: if it changed, the request is invalidated. */
export async function approveCancellation(ctx: Ctx, userId: string, id: string) {
  const c = await loadCancellation(ctx.db, userId, id);
  if (c.status !== 'awaiting_user') {
    if (['approved', 'executing', 'executed'].includes(c.status)) return c;
    throw new DomainError('CONFIRMATION_INVALIDATED', `Cancellation request is ${c.status}`);
  }
  if (new Date(c.expires_at).getTime() <= ctx.clock.now().getTime()) {
    await ctx.db.query(`UPDATE cancellation_requests SET status='expired' WHERE id=$1 AND status='awaiting_user'`, [id]);
    throw new DomainError('CONFIRMATION_EXPIRED', 'Cancellation confirmation expired; prepare it again');
  }
  const o = await loadOrder(ctx.db, userId, c.order_id);
  const terms = await callProvider(() => ctx.provider(o.mode).getCancellationTerms(o.provider_order_ref));
  if (!terms.allowed || terms.fee_minor !== Number(c.fee_minor)) {
    await ctx.db.query(`UPDATE cancellation_requests SET status='invalidated' WHERE id=$1 AND status='awaiting_user'`, [id]);
    throw new DomainError('PRICE_CHANGED', `Cancellation terms changed: ${terms.terms}`);
  }
  try {
    return await ctx.db.tx(async (q) => {
      const locked = await loadCancellation(q, userId, id, true);
      if (locked.status !== 'awaiting_user') return locked;
      const r = await q.query<CancellationRow>(`UPDATE cancellation_requests SET status='approved', approved_at=$2 WHERE id=$1 RETURNING *`, [id, ctx.clock.now()]);
      await audit(q, { userId, actor: 'web', action: 'cancellation.approved', mode: o.mode, entity: 'order', entityId: o.id });
      return r.rows[0];
    });
  } catch (e: any) {
    if (e?.code === '23505') throw new DomainError('CANCELLATION_NOT_ALLOWED', 'Another cancellation for this order is already in progress.');
    throw e;
  }
}

export async function cancelOrder(ctx: Ctx, actor: Actor, cancellationId: string) {
  const pre = await loadCancellation(ctx.db, actor.userId, cancellationId);
  const o = await loadOrder(ctx.db, actor.userId, pre.order_id);
  requireCapability(ctx, o.mode, 'cancel_order');
  const claimed = await ctx.db.tx(async (q) => {
    const c = await loadCancellation(q, actor.userId, cancellationId, true);
    if (c.status === 'awaiting_user') {
      throw new DomainError('CONFIRMATION_REQUIRED', 'The user must confirm the cancellation (and any fee) on the Unyly page first.', { confirm_url: cancelConfirmUrl(ctx, c.id) });
    }
    if (c.status !== 'approved') return { done: c };
    await q.query(`UPDATE cancellation_requests SET status='executing', executing_at=$2 WHERE id=$1`, [c.id, ctx.clock.now()]);
    return { go: c };
  });
  if ('done' in claimed) return describeCancellation(claimed.done!);
  const c = claimed.go!;
  await executeCancellation(ctx, c, o, actorLabel(actor));
  await getOrderStatus(ctx, actor, o.id).catch(() => undefined);
  return describeCancellation(await loadCancellation(ctx.db, actor.userId, c.id));
}

export function describeCancellation(c: CancellationRow) {
  const msg: Record<CancellationRow['status'], string> = {
    awaiting_user: 'Waiting for the user to confirm on the Unyly page.',
    approved: 'Confirmed by the user; not yet executed.',
    executing: 'Cancellation is being sent to the provider.',
    executed: 'The provider cancelled the order.',
    rejected: 'The provider refused the cancellation. The order continues.',
    expired: 'The confirmation expired. Nothing was cancelled.',
    unknown: 'We could not confirm whether the cancellation went through. Check the order status; do not assume it was cancelled.',
    invalidated: 'Superseded, or the fee changed before execution. Nothing was cancelled; prepare the cancellation again to see the new terms.',
  };
  return {
    cancellation_id: c.id,
    order_id: c.order_id,
    status: c.status,
    fee: money(Number(c.fee_minor), c.currency),
    terms: c.terms,
    expires_at: new Date(c.expires_at).toISOString(),
    message: msg[c.status],
  };
}

async function executeCancellation(ctx: Ctx, c: CancellationRow, o: OrderRow, actor: string) {
  const provider = ctx.provider(o.mode);
  try {
    const r = await withTimeout(
      provider.cancelOrder(o.provider_order_ref, `unyly-cancel-${c.id}`, Number(c.fee_minor)),
      ctx.cfg.providerTimeoutMs,
      () => new ProviderOutcomeUnknownError('timeout'),
    );
    if (r.outcome === 'cancelled') {
      await ctx.db.query(`UPDATE cancellation_requests SET status='executed', executed_at=$2 WHERE id=$1 AND status IN ('executing','unknown')`, [c.id, ctx.clock.now()]);
      await audit(ctx.db, { userId: c.user_id, actor, action: 'order.cancelled', mode: o.mode, entity: 'order', entityId: o.id, details: { fee: r.fee_minor } });
    } else {
      const code = r.message.startsWith('FEE_CHANGED') ? 'FEE_CHANGED' : 'PROVIDER_REJECTED';
      // Leaves the "active" set, so the user can prepare a new cancellation with the new terms.
      await ctx.db.query(`UPDATE cancellation_requests SET status=$2, error_code=$3 WHERE id=$1 AND status IN ('executing','unknown')`, [c.id, code === 'FEE_CHANGED' ? 'invalidated' : 'rejected', code]);
    }
  } catch {
    await ctx.db.query(`UPDATE cancellation_requests SET status='unknown', error_code='CANCELLATION_UNKNOWN' WHERE id=$1 AND status='executing'`, [c.id]);
  }
}

/**
 * Background: resolve cancellations whose outcome is unknown or that were interrupted by a crash.
 * Reads the order status; if the order is still cancellable, re-sends the SAME idempotent request
 * with the fee cap the user approved (never a higher fee).
 */
export async function reconcileCancellations(ctx: Ctx) {
  const settle = new Date(ctx.clock.now().getTime() - Math.max(3 * ctx.cfg.providerTimeoutMs, 30_000));
  const r = await ctx.db.query<CancellationRow>(
    `SELECT * FROM cancellation_requests WHERE status IN ('unknown','executing','approved') AND COALESCE(executing_at, approved_at, created_at) < $1 LIMIT 50`,
    [settle],
  );
  for (const c of r.rows) {
    const o = (await ctx.db.query<OrderRow>('SELECT * FROM orders WHERE id=$1', [c.order_id])).rows[0];
    try {
      const s = await ctx.provider(o.mode).getOrderStatus(o.provider_order_ref);
      if (s.status === 'cancelled') {
        await ctx.db.query(`UPDATE cancellation_requests SET status='executed', executed_at=$2 WHERE id=$1 AND status IN ('unknown','executing','approved')`, [c.id, ctx.clock.now()]);
      } else if (TERMINAL.includes(s.status) || STATUS_RANK[s.status] >= STATUS_RANK.picked_up) {
        await ctx.db.query(`UPDATE cancellation_requests SET status='rejected', error_code='TOO_LATE' WHERE id=$1 AND status IN ('unknown','executing','approved')`, [c.id]);
      } else {
        await ctx.db.query(`UPDATE cancellation_requests SET status='executing', executing_at=$2 WHERE id=$1 AND status IN ('unknown','executing','approved')`, [c.id, ctx.clock.now()]);
        await executeCancellation(ctx, { ...c, status: 'executing' }, o, 'system');
      }
    } catch {
      /* provider unreachable: stays unknown and is retried next cycle */
    }
  }
}
