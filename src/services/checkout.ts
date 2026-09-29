import type { Actor, Ctx } from '../context.js';
import { actorLabel, audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { DomainError } from '../domain/errors.js';
import { money } from '../domain/money.js';
import { ProviderOutcomeUnknownError, ProviderUnavailableError, SubmitResult } from '../providers/types.js';
import { loadCart, QuoteRow } from './carts.js';
import { requireCapability, submissionsEnabled, withTimeout } from './common.js';
import { addressFingerprint, getAddress, maskedAddress, toDeliveryAddress } from './users.js';

export const CHECKOUT_MAX_TTL_MS = 10 * 60 * 1000;

export interface CheckoutRow {
  id: string;
  user_id: string;
  cart_id: string;
  cart_version: number;
  quote_id: string;
  mode: 'demo' | 'handoff' | 'live';
  address_fingerprint: string;
  total_minor: number;
  currency: string;
  payment_method_label: string;
  cancellation_terms: string;
  status: 'awaiting_user' | 'approved' | 'consumed' | 'expired' | 'invalidated' | 'declined';
  invalid_reason: string | null;
  expires_at: string;
  approved_at: string | null;
  approved_via: string | null;
  consumed_at: string | null;
  created_by: string;
  created_at: string;
}

export interface AttemptRow {
  id: string;
  checkout_id: string;
  user_id: string;
  mode: string;
  idempotency_key: string;
  status: 'in_flight' | 'accepted' | 'rejected' | 'unknown';
  provider_order_ref: string | null;
  error_code: string | null;
  error_detail: string | null;
  reconcile_attempts: number;
  next_reconcile_at: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * A cart may reach the provider at most once while an earlier submission is pending or accepted.
 * Different checkouts carry different idempotency keys, so this cart-level guard is what stops a
 * second real order after an unknown outcome.
 */
async function cartSubmissionBlock(q: Queryable, cartId: string, exceptCheckoutId?: string): Promise<DomainError | null> {
  const r = await q.query<{ status: string }>(
    `SELECT a.status FROM submission_attempts a JOIN checkouts c ON c.id = a.checkout_id
     WHERE c.cart_id = $1 AND a.status IN ('in_flight','unknown','accepted') AND ($2::uuid IS NULL OR c.id <> $2) LIMIT 1`,
    [cartId, exceptCheckoutId ?? null],
  );
  const s = r.rows[0]?.status;
  if (!s) return null;
  if (s === 'accepted') return new DomainError('CART_NOT_OPEN', 'This cart has already been ordered. Create a new cart to order again.');
  return new DomainError('SUBMISSION_UNKNOWN', 'An earlier order for this cart is still being confirmed with the provider. Do not order again until it resolves.', undefined,
    'Call get_checkout_status on the earlier checkout, or list_orders, and wait.');
}

export const confirmUrl = (ctx: Ctx, id: string) => `${ctx.cfg.webOrigin}/confirm/${id}`;

async function loadCheckout(q: Queryable, userId: string, id: string, lock = false): Promise<CheckoutRow> {
  const r = await q.query<CheckoutRow>(`SELECT * FROM checkouts WHERE id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, userId]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Checkout not found');
  return r.rows[0];
}

/**
 * Checks that everything the human approved is still exactly true: same cart version, same address
 * content, same quote, not expired. Returns the reason code when something changed.
 */
async function validityProblem(ctx: Ctx, q: Queryable, c: CheckoutRow): Promise<string | null> {
  if (new Date(c.expires_at).getTime() <= ctx.clock.now().getTime()) return 'EXPIRED';
  const cart = await loadCart(q, c.user_id, c.cart_id);
  if (cart.status !== 'open') return 'CART_NOT_OPEN';
  if (cart.version !== c.cart_version) return 'CART_CHANGED';
  if (!cart.address_id) return 'ADDRESS_CHANGED';
  const addr = await getAddress(q, c.user_id, cart.address_id).catch(() => null);
  if (!addr || addressFingerprint(addr) !== c.address_fingerprint) return 'ADDRESS_CHANGED';
  return null;
}

async function markInvalid(q: Queryable, id: string, reason: string) {
  const status = reason === 'EXPIRED' ? 'expired' : 'invalidated';
  await q.query(`UPDATE checkouts SET status = $2, invalid_reason = $3 WHERE id = $1 AND status IN ('awaiting_user','approved')`, [id, status, reason]);
}

function reasonToError(reason: string): DomainError {
  if (reason === 'EXPIRED') return new DomainError('CONFIRMATION_EXPIRED', 'The confirmation expired. Quote the cart again and prepare a new checkout.');
  if (reason === 'PRICE_CHANGED') return new DomainError('PRICE_CHANGED', 'The price changed. Quote the cart again and ask the user to confirm the new total.');
  return new DomainError('CONFIRMATION_INVALIDATED', `The confirmation is no longer valid (${reason}). Quote again and prepare a new checkout.`, { reason });
}

export async function prepareCheckout(ctx: Ctx, actor: Actor, args: { cart_id: string; quote_id: string }) {
  const cart = await loadCart(ctx.db, actor.userId, args.cart_id);
  requireCapability(ctx, cart.mode, 'checkout');
  if (!(await submissionsEnabled(ctx, ctx.db, cart.mode))) {
    throw new DomainError('SUBMISSIONS_PAUSED', 'New orders are temporarily paused. Order status and history remain available.');
  }
  return ctx.db.tx(async (q) => {
    const locked = await loadCart(q, actor.userId, args.cart_id, true);
    const blocked = await cartSubmissionBlock(q, locked.id);
    if (blocked) throw blocked;
    const qr = (await q.query<QuoteRow>('SELECT * FROM quotes WHERE id = $1 AND user_id = $2 AND cart_id = $3', [args.quote_id, actor.userId, args.cart_id])).rows[0];
    if (!qr) throw new DomainError('NOT_FOUND', 'Quote not found for this cart');
    if (locked.status !== 'open') throw new DomainError('CART_NOT_OPEN', `Cart is ${locked.status}`);
    if (qr.cart_version !== locked.version) throw new DomainError('QUOTE_EXPIRED', 'The cart changed after this quote; call quote_cart again');
    const now = ctx.clock.now();
    if (new Date(qr.expires_at).getTime() <= now.getTime()) throw new DomainError('QUOTE_EXPIRED', 'Quote expired; call quote_cart again');
    if (!qr.checkout_allowed) {
      const first = qr.issues[0];
      throw new DomainError((first?.code as any) ?? 'VALIDATION_FAILED', first?.message ?? 'Quote has blocking issues', { issues: qr.issues });
    }
    const addr = locked.address_id ? await getAddress(q, actor.userId, locked.address_id).catch(() => null) : null;
    if (!addr || addressFingerprint(addr) !== qr.address_fingerprint) throw new DomainError('QUOTE_EXPIRED', 'Delivery address changed; quote again');
    // Only one pending confirmation per cart.
    await q.query(`UPDATE checkouts SET status='invalidated', invalid_reason='SUPERSEDED' WHERE cart_id = $1 AND status IN ('awaiting_user','approved')`, [locked.id]);
    const expires = new Date(Math.min(new Date(qr.expires_at).getTime(), now.getTime() + CHECKOUT_MAX_TTL_MS));
    const r = await q.query<CheckoutRow>(
      `INSERT INTO checkouts (user_id, cart_id, cart_version, quote_id, mode, address_fingerprint, total_minor, currency, payment_method_label, cancellation_terms, status, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting_user',$11,$12) RETURNING *`,
      [actor.userId, locked.id, locked.version, qr.id, locked.mode, qr.address_fingerprint, qr.total_minor, qr.currency, qr.payment_method_label, qr.cancellation_terms, expires, actorLabel(actor)],
    );
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'checkout.prepared', mode: locked.mode, entity: 'checkout', entityId: r.rows[0].id, details: { total: qr.total_minor } });
    return r.rows[0];
  });
}

/** Full, human-readable view of what is being approved. Used by the confirmation page and get_checkout_status. */
export async function checkoutView(ctx: Ctx, userId: string, id: string, locale: 'ru' | 'en' = 'en') {
  let c = await loadCheckout(ctx.db, userId, id);
  if ((c.status === 'awaiting_user' || c.status === 'approved') && new Date(c.expires_at).getTime() <= ctx.clock.now().getTime()) {
    await markInvalid(ctx.db, c.id, 'EXPIRED');
    c = await loadCheckout(ctx.db, userId, id);
  }
  const qr = (await ctx.db.query<QuoteRow>('SELECT * FROM quotes WHERE id = $1', [c.quote_id])).rows[0];
  const cart = await loadCart(ctx.db, userId, c.cart_id);
  const v = (await ctx.db.query('SELECT items, address_id FROM cart_versions WHERE cart_id = $1 AND version = $2', [c.cart_id, c.cart_version])).rows[0];
  const addr = v.address_id ? await ctx.db.query('SELECT * FROM addresses WHERE id = $1', [v.address_id]).then((r) => r.rows[0]) : null;
  const attempt = (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE checkout_id = $1', [c.id])).rows[0];
  const order = (await ctx.db.query('SELECT id, fulfillment_status FROM orders WHERE checkout_id = $1', [c.id])).rows[0];
  const m = (n: number) => money(n, c.currency, locale);
  return {
    checkout: c,
    restaurant_name: cart.restaurant_name,
    lines: qr.lines,
    address: addr,
    breakdown: {
      items_subtotal: m(qr.subtotal_minor), delivery_fee: m(qr.delivery_fee_minor), service_fee: m(qr.service_fee_minor),
      small_order_fee: m(qr.small_order_fee_minor), discount: m(-qr.discount_minor), total: m(qr.total_minor),
    },
    eta: { min: qr.eta_min_minutes, max: qr.eta_max_minutes },
    price_source: qr.price_source,
    quote_fetched_at: qr.fetched_at,
    attempt: attempt ?? null,
    order: order ?? null,
    items_snapshot: v.items,
  };
}

export async function checkoutStatus(ctx: Ctx, actor: Actor, id: string) {
  const v = await checkoutView(ctx, actor.userId, id);
  const c = v.checkout;
  return {
    checkout_id: c.id,
    mode: c.mode,
    status: c.status,
    invalid_reason: c.invalid_reason,
    total: money(c.total_minor, c.currency),
    expires_at: new Date(c.expires_at).toISOString(),
    approved_at: c.approved_at ? new Date(c.approved_at).toISOString() : null,
    confirm_url: c.status === 'awaiting_user' ? confirmUrl(ctx, c.id) : null,
    submission: v.attempt ? describeAttempt(v.attempt) : null,
    order_id: v.order?.id ?? null,
  };
}

/** Human approval. Only callable from an authenticated web session (never from MCP). */
export async function approveCheckout(ctx: Ctx, userId: string, id: string) {
  const out = await ctx.db.tx(async (q) => {
    const c = await loadCheckout(q, userId, id, true);
    if (c.status === 'approved' || c.status === 'consumed') return c; // double click
    if (c.status !== 'awaiting_user') throw reasonToError(c.invalid_reason ?? c.status.toUpperCase());
    const problem = await validityProblem(ctx, q, c);
    if (problem) {
      await markInvalid(q, c.id, problem); // committed, then reported
      return reasonToError(problem);
    }
    const r = await q.query<CheckoutRow>(`UPDATE checkouts SET status='approved', approved_at=$2, approved_via='web' WHERE id=$1 RETURNING *`, [c.id, ctx.clock.now()]);
    await audit(q, { userId, actor: 'web', action: 'checkout.approved', mode: c.mode, entity: 'checkout', entityId: c.id });
    return r.rows[0];
  });
  if (out instanceof DomainError) throw out;
  return out;
}

export async function declineCheckout(ctx: Ctx, userId: string, id: string) {
  await ctx.db.tx(async (q) => {
    const c = await loadCheckout(q, userId, id, true);
    if (c.status === 'awaiting_user' || c.status === 'approved') {
      await q.query(`UPDATE checkouts SET status='declined' WHERE id=$1`, [c.id]);
      await audit(q, { userId, actor: 'web', action: 'checkout.declined', mode: c.mode, entity: 'checkout', entityId: c.id });
    }
  });
}

export function describeAttempt(a: AttemptRow) {
  const messages: Record<AttemptRow['status'], string> = {
    in_flight: 'The order is being sent to the provider. Check again shortly. Do not place the order again.',
    accepted: 'The provider accepted the order.',
    rejected: 'The provider did not accept the order. Nothing was ordered.',
    unknown:
      'We could not confirm whether the provider received the order. Unyly is checking with the provider and will not resend it automatically. ' +
      'Do not order the same food elsewhere until the status is resolved.',
  };
  const message =
    a.status === 'rejected' && a.error_code === 'NOT_RECEIVED_BY_PROVIDER'
      ? 'The provider has no record of this order, so it was most likely not placed. Unyly keeps checking for 24 hours and will show the order if it appears.'
      : messages[a.status];
  return {
    submission_id: a.id,
    status: a.status,
    provider_order_ref: a.provider_order_ref,
    error_code: a.error_code,
    message,
    started_at: new Date(a.started_at).toISOString(),
    finished_at: a.finished_at ? new Date(a.finished_at).toISOString() : null,
  };
}

/**
 * Sends an approved checkout to the provider, at most once per checkout.
 * Safe to call repeatedly and concurrently: the checkout row lock plus the UNIQUE(checkout_id)
 * constraint on submission_attempts guarantee a single provider call from Unyly's side.
 */
export async function submitOrder(ctx: Ctx, actor: Actor, checkoutId: string) {
  const pre = await loadCheckout(ctx.db, actor.userId, checkoutId);
  requireCapability(ctx, pre.mode, 'submit_order');
  const prepared = await ctx.db.tx(async (q) => {
    // Lock order: cart, then checkout (same as prepareCheckout) to serialize all submissions of a cart.
    await loadCart(q, actor.userId, pre.cart_id, true);
    const c = await loadCheckout(q, actor.userId, checkoutId, true);
    const existing = (await q.query<AttemptRow>('SELECT * FROM submission_attempts WHERE checkout_id = $1', [c.id])).rows[0];
    if (existing) return { replay: existing };
    const blocked = await cartSubmissionBlock(q, c.cart_id, c.id);
    if (blocked) return { invalid: blocked };
    if (c.status === 'awaiting_user') {
      throw new DomainError('CONFIRMATION_REQUIRED', 'The user must confirm this order on the Unyly confirmation page first.', { confirm_url: confirmUrl(ctx, c.id) },
        'Ask the user to open confirm_url, review the order and press Confirm. Then call get_checkout_status.');
    }
    if (c.status !== 'approved') throw reasonToError(c.invalid_reason ?? c.status.toUpperCase());
    if (!(await submissionsEnabled(ctx, q, c.mode))) {
      throw new DomainError('SUBMISSIONS_PAUSED', 'New orders are temporarily paused. Your confirmation stays valid until it expires.');
    }
    const problem = await validityProblem(ctx, q, c);
    if (problem) {
      await markInvalid(q, c.id, problem); // committed, then reported
      return { invalid: reasonToError(problem) };
    }
    const now = ctx.clock.now();
    await q.query(`UPDATE checkouts SET status='consumed', consumed_at=$2 WHERE id=$1`, [c.id, now]);
    const a = await q.query<AttemptRow>(
      `INSERT INTO submission_attempts (checkout_id, user_id, mode, idempotency_key, status, next_reconcile_at, started_at)
       VALUES ($1,$2,$3,$4,'in_flight',$5,$6) RETURNING *`,
      [c.id, actor.userId, c.mode, `unyly-${c.id}`, new Date(now.getTime() + ctx.cfg.providerTimeoutMs + 5000), now],
    );
    const cart = await loadCart(q, actor.userId, c.cart_id);
    const addr = await getAddress(q, actor.userId, cart.address_id!);
    await audit(q, { userId: actor.userId, actor: actorLabel(actor), action: 'submission.started', mode: c.mode, entity: 'checkout', entityId: c.id });
    return { attempt: a.rows[0], checkout: c, cart, addr };
  });
  if ('invalid' in prepared) throw prepared.invalid;
  if ('replay' in prepared) return describeAttempt(prepared.replay!);

  const { attempt, checkout, cart, addr } = prepared;
  const provider = ctx.provider(checkout.mode);
  let result: SubmitResult;
  try {
    result = await withTimeout(
      provider.submitOrder({
        idempotency_key: attempt.idempotency_key,
        restaurant_id: cart.restaurant_id!,
        lines: cart.items,
        address: toDeliveryAddress(addr),
        expected_total_minor: checkout.total_minor,
        currency: checkout.currency,
      }),
      ctx.cfg.providerTimeoutMs,
      () => new ProviderOutcomeUnknownError('Provider timeout'),
    );
  } catch (e) {
    if (e instanceof ProviderUnavailableError) {
      // Definitely not processed by the provider: close the attempt; a new checkout is required.
      const a = await finishAttempt(ctx, attempt.id, 'rejected', { code: 'PROVIDER_UNAVAILABLE', detail: e.message });
      await audit(ctx.db, { userId: actor.userId, actor: actorLabel(actor), action: 'submission.rejected', mode: checkout.mode, entity: 'submission', entityId: attempt.id, details: { code: 'PROVIDER_UNAVAILABLE' } });
      throw new DomainError('PROVIDER_UNAVAILABLE', 'The provider is unavailable; the order was not sent. Try again later with a new confirmation.', { submission: describeAttempt(a) });
    }
    // Outcome unknown: record it and try to reconcile once, never resend blindly.
    await markUnknown(ctx, attempt.id, e instanceof Error ? e.message : String(e));
    await reconcileAttempt(ctx, attempt.id);
    const a = (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE id = $1', [attempt.id])).rows[0];
    if (a.status === 'unknown') {
      throw new DomainError('SUBMISSION_UNKNOWN', describeAttempt(a).message, { submission: describeAttempt(a) },
        'Call get_checkout_status later. Do not create a new order for the same food until this resolves.');
    }
    return describeAttempt(a);
  }

  if (result.outcome === 'accepted') {
    await recordAccepted(ctx, attempt.id, result.provider_order_ref, result.status, result.payment_status, result.eta_at);
  } else {
    await finishAttempt(ctx, attempt.id, 'rejected', { code: result.code, detail: result.message });
    await audit(ctx.db, { userId: actor.userId, actor: actorLabel(actor), action: 'submission.rejected', mode: checkout.mode, entity: 'submission', entityId: attempt.id, details: { code: result.code } });
    const code = result.code === 'PROVIDER_REJECTED' ? 'PROVIDER_REJECTED' : result.code;
    throw new DomainError(code, `Not ordered: ${result.message}`, { submission_id: attempt.id }, 'Quote the cart again and ask the user to confirm the new details.');
  }
  const a = (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE id = $1', [attempt.id])).rows[0];
  return describeAttempt(a);
}

async function finishAttempt(ctx: Ctx, id: string, status: 'rejected', err: { code: string; detail: string }) {
  const r = await ctx.db.query<AttemptRow>(
    `UPDATE submission_attempts SET status=$2, error_code=$3, error_detail=$4, finished_at=$5, next_reconcile_at=NULL WHERE id=$1 AND status IN ('in_flight','unknown') RETURNING *`,
    [id, status, err.code, err.detail.slice(0, 500), ctx.clock.now()],
  );
  return r.rows[0] ?? (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE id=$1', [id])).rows[0];
}

async function markUnknown(ctx: Ctx, id: string, detail: string) {
  await ctx.db.query(
    `UPDATE submission_attempts SET status='unknown', error_code='SUBMISSION_UNKNOWN', error_detail=$2, next_reconcile_at=$3 WHERE id=$1 AND status='in_flight'`,
    [id, detail.slice(0, 500), ctx.clock.now()],
  );
  const a = (await ctx.db.query('SELECT user_id, mode FROM submission_attempts WHERE id=$1', [id])).rows[0];
  await audit(ctx.db, { userId: a.user_id, actor: 'system', action: 'submission.unknown', mode: a.mode, entity: 'submission', entityId: id });
}

/** Persist an accepted order. Idempotent: the order row is unique per checkout and per provider ref. */
export async function recordAccepted(ctx: Ctx, attemptId: string, ref: string, status: string, paymentStatus: string, etaAt?: string) {
  await ctx.db.tx(async (q) => {
    const a = (await q.query<AttemptRow>('SELECT * FROM submission_attempts WHERE id = $1 FOR UPDATE', [attemptId])).rows[0];
    // A provider-side rejection is final. Only "not received" may later turn out to be accepted.
    if (a.status === 'rejected' && a.error_code !== 'NOT_RECEIVED_BY_PROVIDER') return;
    await q.query(
      `UPDATE submission_attempts SET status='accepted', provider_order_ref=$2, finished_at=COALESCE(finished_at,$3), next_reconcile_at=NULL, error_code=NULL WHERE id=$1`,
      [attemptId, ref, ctx.clock.now()],
    );
    const c = (await q.query<CheckoutRow>('SELECT * FROM checkouts WHERE id = $1', [a.checkout_id])).rows[0];
    const cart = await loadCart(q, a.user_id, c.cart_id);
    const qr = (await q.query<QuoteRow>('SELECT * FROM quotes WHERE id = $1', [c.quote_id])).rows[0];
    const addr = (await q.query('SELECT * FROM addresses WHERE id = $1', [cart.address_id])).rows[0];
    const ins = await q.query(
      `INSERT INTO orders (user_id, checkout_id, submission_id, cart_id, mode, provider, provider_order_ref, restaurant_id, restaurant_name, items, address_label,
         total_minor, currency, fulfillment_status, payment_status, status_version, eta_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$16) ON CONFLICT DO NOTHING RETURNING id`,
      [a.user_id, c.id, a.id, cart.id, c.mode, ctx.provider(c.mode).providerName, ref, cart.restaurant_id, cart.restaurant_name,
        JSON.stringify(qr.lines.map((l: any) => ({ item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers: l.modifiers_desc, line_total_minor: l.line_total_minor }))),
        maskedAddress(addr)?.label ?? 'address', c.total_minor, c.currency, status, paymentStatus, etaAt ?? null],
    );
    await q.query(`UPDATE carts SET status='ordered', updated_at=now() WHERE id=$1`, [cart.id]);
    if (ins.rowCount) {
      await audit(q, { userId: a.user_id, actor: 'system', action: 'order.accepted', mode: c.mode, entity: 'order', entityId: ins.rows[0].id, details: { total: c.total_minor } });
    }
  });
}

const MAX_NOT_FOUND = 3;
const LATE_CHECK_WINDOW_MS = 24 * 3600_000;
const LATE_CHECK_EVERY_MS = 10 * 60_000;

/**
 * Reconcile one attempt by asking the provider (by idempotency key). Never resubmits.
 * - in_flight/unknown: found → accepted; "not found" counts only once the original call can no longer
 *   be running (3× the provider timeout, min 60 s); after 3 such answers → rejected NOT_RECEIVED_BY_PROVIDER.
 * - rejected NOT_RECEIVED_BY_PROVIDER: re-checked every 10 min for 24 h in case the provider created it late.
 * All state changes are guarded by the expected current status, so concurrent runs cannot regress a result.
 */
export async function reconcileAttempt(ctx: Ctx, attemptId: string) {
  const a = (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE id = $1', [attemptId])).rows[0];
  if (!a) return undefined;
  const lateCheck = a.status === 'rejected' && a.error_code === 'NOT_RECEIVED_BY_PROVIDER';
  if (a.status !== 'unknown' && a.status !== 'in_flight' && !lateCheck) return a.status;
  const now = ctx.clock.now().getTime();
  const provider = ctx.provider(a.mode as any);
  let r;
  try {
    r = await withTimeout(provider.lookupByIdempotencyKey(a.idempotency_key), ctx.cfg.providerTimeoutMs, () => new ProviderOutcomeUnknownError('lookup timeout'));
  } catch {
    if (lateCheck) {
      await ctx.db.query(`UPDATE submission_attempts SET next_reconcile_at=$2 WHERE id=$1 AND status='rejected'`, [a.id, new Date(now + LATE_CHECK_EVERY_MS)]);
      return 'rejected';
    }
    // Lookup failures do not count as "not found". Back off proportionally to how long this has been open.
    const delay = Math.min(Math.max(now - new Date(a.started_at).getTime(), 30_000), 30 * 60_000);
    await ctx.db.query(
      `UPDATE submission_attempts SET status='unknown', error_code='SUBMISSION_UNKNOWN', next_reconcile_at=$2 WHERE id=$1 AND status IN ('in_flight','unknown')`,
      [a.id, new Date(now + delay)],
    );
    return 'unknown';
  }
  if (r.found) {
    await recordAccepted(ctx, a.id, r.provider_order_ref, r.status, r.payment_status);
    if (lateCheck) await audit(ctx.db, { userId: a.user_id, actor: 'system', action: 'submission.found_late', mode: a.mode, entity: 'submission', entityId: a.id });
    return 'accepted';
  }
  if (lateCheck) {
    const expired = now - new Date(a.finished_at ?? a.started_at).getTime() > LATE_CHECK_WINDOW_MS;
    await ctx.db.query(`UPDATE submission_attempts SET next_reconcile_at=$2 WHERE id=$1 AND status='rejected'`, [a.id, expired ? null : new Date(now + LATE_CHECK_EVERY_MS)]);
    return 'rejected';
  }
  const settleMs = Math.max(3 * ctx.cfg.providerTimeoutMs, 60_000);
  const counts = now - new Date(a.started_at).getTime() >= settleMs;
  const n = a.reconcile_attempts + (counts ? 1 : 0);
  if (n >= MAX_NOT_FOUND) {
    const u = await ctx.db.query(
      `UPDATE submission_attempts SET status='rejected', error_code='NOT_RECEIVED_BY_PROVIDER', error_detail=$2, finished_at=$3, reconcile_attempts=$4, next_reconcile_at=$5
       WHERE id=$1 AND status IN ('in_flight','unknown')`,
      [a.id, `Provider reported no order for this key ${n} times`, new Date(now), n, new Date(now + LATE_CHECK_EVERY_MS)],
    );
    if (u.rowCount) await audit(ctx.db, { userId: a.user_id, actor: 'system', action: 'submission.rejected', mode: a.mode, entity: 'submission', entityId: a.id, details: { code: 'NOT_RECEIVED_BY_PROVIDER' } });
    return 'rejected';
  }
  const next = counts ? Math.min(30_000 * 2 ** n, 30 * 60_000) : settleMs - (now - new Date(a.started_at).getTime()) + 1000;
  await ctx.db.query(
    `UPDATE submission_attempts SET status='unknown', reconcile_attempts=$2, next_reconcile_at=$3 WHERE id=$1 AND status IN ('in_flight','unknown')`,
    [a.id, n, new Date(now + next)],
  );
  return 'unknown';
}
