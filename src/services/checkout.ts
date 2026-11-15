import type { Locale } from '../domain/locales.js';
import type { Actor, Ctx } from '../context.js';
import { actorLabel, audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { DomainError } from '../domain/errors.js';
import { money } from '../domain/money.js';
import { FulfillmentStatus, ProviderOutcomeUnknownError, ProviderUnavailableError, SubmitResult } from '../providers/types.js';
import { addressesJsonSql, CartRow, CartState, describeTrip, loadCart, loadCartVersion, locationFingerprint, locationFingerprintFrom, quoteCart, QuoteRow, tripLabel } from './carts.js';
import { isTripService } from '../domain/regions.js';
import { enqueuePartnerEvent, orderNotify, partnerEventCtes, partnerEventParams } from '../partners/webhooks.js';
import { callProvider, requireCapability, withTimeout } from './common.js';
import { randomUUID } from 'node:crypto';
import { AddressRow, getAddress, toDeliveryAddress } from './users.js';
import type { OrderRow } from './orders.js';
import { hasPasskey, verifyStepUp } from '../auth/passkeys.js';
import { GrabLiveProvider } from '../providers/grab/provider.js';
import { orderPaymentStatus, PaymentRow } from '../payments/service.js';

/**
 * How long the human has to press Confirm. Deliberately independent of the provider's quote validity
 * (5 minutes in Demo): if the quote has gone stale by the time the user confirms, approveCheckout
 * re-prices the exact approved cart version and proceeds only if the total is unchanged.
 */
export const CHECKOUT_MAX_TTL_MS = 15 * 60 * 1000;

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
const blockError = (s: string | null | undefined): DomainError | null => {
  if (!s) return null;
  if (s === 'accepted') return new DomainError('CART_NOT_OPEN', 'This cart has already been ordered. Create a new cart to order again.');
  return new DomainError('SUBMISSION_UNKNOWN', 'An earlier order for this cart is still being confirmed with the provider. Do not order again until it resolves.', undefined,
    'Call get_checkout_status on the earlier checkout, or list_orders, and wait.');
};

/** cartSubmissionBlock as a sub-select (status of a blocking attempt or NULL). Only meaningful in a statement that runs under the cart row lock. */
const blockSql = (cartExpr: string, exceptExpr: string) =>
  `(SELECT a.status FROM submission_attempts a JOIN checkouts c2 ON c2.id = a.checkout_id
     WHERE c2.cart_id = ${cartExpr} AND a.status IN ('in_flight','unknown','accepted') AND (${exceptExpr} IS NULL OR c2.id <> ${exceptExpr}) LIMIT 1)`;

/** The cart row lock that serializes everything that prepares or submits a cart. Always the first statement of such a transaction. */
async function lockCart(q: Queryable, userId: string, cartId: string, lead?: { sql: string; params: unknown[] }): Promise<CartRow> {
  // `lead`: a data-modifying CTE that rides in the same round trip (its parameters come after $1 and $2).
  const r = await q.query<CartRow>(`${lead ? `WITH ${lead.sql} ` : ''}SELECT * FROM carts WHERE id = $1 AND user_id = $2 FOR UPDATE`, [cartId, userId, ...(lead?.params ?? [])]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Cart not found');
  return r.rows[0];
}

const submissionsOn = (ctx: Ctx, value: any, mode: string): boolean => ctx.cfg.submissionsEnabledEnv && Boolean(value?.[mode]);

export const confirmUrl = (ctx: Ctx, id: string) => `${ctx.cfg.webOrigin}/confirm/${id}`;

/**
 * Cashless Live GrabExpress: Grab bills Unyly for the delivery, so the user pays with GrabPay after
 * approving the order and before the delivery is created. Live mode only ever orders GrabExpress.
 */
export function paymentRequired(ctx: Ctx, c: Pick<CheckoutRow, 'mode'>): boolean {
  const live = ctx.providers.live;
  return c.mode === 'live' && live instanceof GrabLiveProvider && live.requiresPrepayment;
}

/** Latest payment of a checkout (a non-failed one first). */
export async function checkoutPayment(q: Queryable, checkoutId: string): Promise<PaymentRow | null> {
  const r = await q.query<PaymentRow>(`SELECT * FROM payments WHERE checkout_id = $1 ORDER BY (status <> 'failed') DESC, created_at DESC LIMIT 1`, [checkoutId]);
  return r.rows[0] ?? null;
}

/** Step-up threshold in minor units for this currency, or null when step-up is off or the currency has none. */
export function stepUpThreshold(ctx: Ctx, currency: string): number | null {
  if (!ctx.cfg.stepUp.enabled) return null;
  return ctx.cfg.stepUp.thresholds[currency] ?? null;
}

/**
 * Step-up policy for one checkout. `large`: the total is at or above the threshold. `required`: large and
 * the user has a passkey, so approval needs a fresh passkey assertion. Users without a passkey (including
 * demo guests) keep the plain confirmation and see a recommendation instead.
 */
export async function stepUpPolicy(ctx: Ctx, userId: string, c: Pick<CheckoutRow, 'total_minor' | 'currency'>) {
  const threshold = stepUpThreshold(ctx, c.currency);
  const large = threshold !== null && Number(c.total_minor) >= threshold;
  const required = large && (await hasPasskey(ctx, userId));
  return { large, required, threshold_minor: threshold };
}

export type CheckoutWithQuoteExpiry = CheckoutRow & { quote_expires_at: string | Date | null };

/** Unlocked read of a checkout together with the expiry of the provider quote behind it. */
export async function loadCheckoutWithQuoteExpiry(q: Queryable, userId: string, id: string): Promise<CheckoutWithQuoteExpiry> {
  const r = await q.query<CheckoutWithQuoteExpiry>(
    'SELECT c.*, (SELECT expires_at FROM quotes WHERE id = c.quote_id) AS quote_expires_at FROM checkouts c WHERE c.id = $1 AND c.user_id = $2',
    [id, userId],
  );
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Checkout not found');
  return r.rows[0];
}

export async function loadCheckout(q: Queryable, userId: string, id: string, lock = false): Promise<CheckoutRow> {
  const r = await q.query<CheckoutRow>(`SELECT * FROM checkouts WHERE id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, userId]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Checkout not found');
  return r.rows[0];
}

/**
 * Checks that everything the human approved is still exactly true: same cart version, same address
 * content, same quote, not expired. Returns the reason code when something changed.
 */
export async function validityProblem(ctx: Ctx, q: Queryable, c: CheckoutRow): Promise<string | null> {
  return (await checkValidity(ctx, q, c)).problem;
}

/**
 * validityProblem plus the cart it was checked against. With no problem, that cart is the open cart at
 * exactly the checkout's version, so its items, address and trip are what the human approved.
 */
async function checkValidity(ctx: Ctx, q: Queryable, c: CheckoutRow): Promise<{ problem: string | null; cart: CartState | null }> {
  if (new Date(c.expires_at).getTime() <= ctx.clock.now().getTime()) return { problem: 'EXPIRED', cart: null };
  // The payment method is part of what the user approved (cash at pickup versus GrabPay in advance).
  const live = ctx.providers.live;
  if (c.mode === 'live' && live instanceof GrabLiveProvider && c.payment_method_label !== live.paymentLabel()) return { problem: 'PAYMENT_METHOD_CHANGED', cart: null };
  const cart = await loadCart(q, c.user_id, c.cart_id);
  if (cart.status !== 'open') return { problem: 'CART_NOT_OPEN', cart };
  if (cart.version !== c.cart_version) return { problem: 'CART_CHANGED', cart };
  const fp = await locationFingerprint(q, c.user_id, cart);
  if (!fp || fp !== c.address_fingerprint) return { problem: 'ADDRESS_CHANGED', cart };
  return { problem: null, cart };
}

export async function markInvalid(q: Queryable, id: string, reason: string) {
  const status = reason === 'EXPIRED' ? 'expired' : 'invalidated';
  await q.query(`UPDATE checkouts SET status = $2, invalid_reason = $3 WHERE id = $1 AND status IN ('awaiting_user','approved')`, [id, status, reason]);
}

function reasonToError(reason: string): DomainError {
  if (reason === 'EXPIRED') return new DomainError('CONFIRMATION_EXPIRED', 'The confirmation expired. Quote the cart again and prepare a new checkout.');
  if (reason === 'PRICE_CHANGED') return new DomainError('PRICE_CHANGED', 'The price changed. Quote the cart again and ask the user to confirm the new total.');
  return new DomainError('CONFIRMATION_INVALIDATED', `The confirmation is no longer valid (${reason}). Quote again and prepare a new checkout.`, { reason });
}

export async function prepareCheckout(
  ctx: Ctx, actor: Actor, args: { cart_id: string; quote_id: string }, opts: { createdBy?: string; cart?: Pick<CartState, 'id' | 'user_id' | 'mode'> } = {},
): Promise<CheckoutRow & { step_up_required: boolean }> {
  // opts.cart: the cart this same call just quoted. Only its mode is used here; everything that matters is re-read under the lock below.
  const cart = opts.cart && opts.cart.id === args.cart_id && opts.cart.user_id === actor.userId ? opts.cart : await loadCart(ctx.db, actor.userId, args.cart_id);
  requireCapability(ctx, cart.mode, 'checkout');
  const row = await ctx.db.tx(async (q) => {
    const lockedRow = await lockCart(q, actor.userId, args.cart_id);
    // Everything else this step reads, in one statement that starts after the cart lock is held (so it sees what
    // the previous holder committed): the cart version the locked row points at, a pending or accepted submission
    // of this cart, the quote, the submissions switch and the user's addresses (for the location fingerprint).
    const rd = (await q.query<Record<string, any>>(
      `SELECT v.items, v.address_id, v.trip,
              ${blockSql('$1', 'NULL::uuid')} AS j_block,
              (SELECT to_jsonb(qt) FROM quotes qt WHERE qt.id = $4 AND qt.user_id = $2 AND qt.cart_id = $1) AS j_quote,
              (SELECT value FROM settings WHERE key = 'submissions') AS j_submissions,
              ${addressesJsonSql('$2')} AS j_addresses
         FROM cart_versions v WHERE v.cart_id = $1 AND v.version = $3`,
      [lockedRow.id, actor.userId, lockedRow.version, args.quote_id],
    )).rows[0];
    const locked: CartState = { ...lockedRow, items: rd.items, address_id: rd.address_id, trip: rd.trip ?? null };
    if (!submissionsOn(ctx, rd.j_submissions, cart.mode)) {
      throw new DomainError('SUBMISSIONS_PAUSED', 'New orders are temporarily paused. Order status and history remain available.');
    }
    const blocked = blockError(rd.j_block);
    if (blocked) throw blocked;
    const qr = rd.j_quote as QuoteRow | null;
    if (!qr) throw new DomainError('NOT_FOUND', 'Quote not found for this cart');
    if (locked.status !== 'open') throw new DomainError('CART_NOT_OPEN', `Cart is ${locked.status}`);
    if (qr.cart_version !== locked.version) throw new DomainError('QUOTE_EXPIRED', 'The cart changed after this quote; call quote_cart again');
    const now = ctx.clock.now();
    if (new Date(qr.expires_at).getTime() <= now.getTime()) throw new DomainError('QUOTE_EXPIRED', 'Quote expired; call quote_cart again');
    if (!qr.checkout_allowed) {
      const first = qr.issues[0];
      throw new DomainError((first?.code as any) ?? 'VALIDATION_FAILED', first?.message ?? 'Quote has blocking issues', { issues: qr.issues });
    }
    const fp = locationFingerprintFrom(locked, rd.j_addresses as AddressRow[]);
    if (!fp || fp !== qr.address_fingerprint) throw new DomainError('QUOTE_EXPIRED', 'Delivery address or trip changed; quote again');
    // Only one pending confirmation per cart: the earlier ones are superseded, the new one is stored and
    // audited, all in one statement (the UPDATE works on the statement snapshot, so it cannot touch the new row).
    const expires = new Date(now.getTime() + CHECKOUT_MAX_TTL_MS);
    const r = await q.query<CheckoutRow>(
      `WITH sup AS (UPDATE checkouts SET status='invalidated', invalid_reason='SUPERSEDED' WHERE cart_id = $2 AND status IN ('awaiting_user','approved')),
            ins AS (
              INSERT INTO checkouts (user_id, cart_id, cart_version, quote_id, mode, address_fingerprint, total_minor, currency, payment_method_label, cancellation_terms, status, expires_at, created_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting_user',$11,$12) RETURNING *),
            a AS (INSERT INTO audit_log (user_id, actor, action, mode, entity, entity_id, details) SELECT ins.user_id, $13, 'checkout.prepared', ins.mode, 'checkout', ins.id::text, $14::jsonb FROM ins)
       SELECT * FROM ins`,
      [actor.userId, locked.id, locked.version, qr.id, locked.mode, qr.address_fingerprint, qr.total_minor, qr.currency, qr.payment_method_label, qr.cancellation_terms, expires, opts.createdBy ?? actorLabel(actor),
        actorLabel(actor), JSON.stringify({ total: qr.total_minor })],
    );
    return r.rows[0];
  });
  return { ...row, step_up_required: (await stepUpPolicy(ctx, actor.userId, row)).required };
}

/** Statuses from which the confirmation page may offer "refresh price". */
const REFRESHABLE = new Set(['EXPIRED', 'PRICE_CHANGED']);

/**
 * "Refresh price" on the confirmation page: re-quote the SAME cart version the checkout was prepared for
 * and create a new one-time confirmation for it (the old one is superseded). The human still has to
 * review and press Confirm on the new page; this never approves or submits anything.
 * Refused when the cart changed, was ordered, or has a pending submission, and when the checkout is
 * approved or consumed.
 */
export async function refreshCheckout(ctx: Ctx, userId: string, checkoutId: string): Promise<{
  checkout_id: string;
  confirm_url: string;
  total_minor: number;
  previous_total_minor: number;
  currency: string;
  price_changed: boolean;
  expires_at: string;
}> {
  const old = await loadCheckout(ctx.db, userId, checkoutId);
  const attempt = (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE checkout_id = $1', [old.id])).rows[0];
  // A submission the provider definitely refused (e.g. PRICE_CHANGED at submit) ordered nothing and may be retried
  // with a fresh confirmation. "Not received" is excluded: the provider may still create that order late.
  const refusedByProvider = old.status === 'consumed' && attempt?.status === 'rejected' && attempt.error_code !== 'NOT_RECEIVED_BY_PROVIDER';
  const refreshable =
    old.status === 'awaiting_user' ||
    old.status === 'expired' ||
    refusedByProvider ||
    (old.status === 'invalidated' && REFRESHABLE.has(old.invalid_reason ?? ''));
  if (!refreshable) {
    if (old.status === 'approved' || old.status === 'consumed') {
      throw new DomainError('CONFIRMATION_INVALIDATED', 'This confirmation was already used; it cannot be refreshed.', { reason: old.status.toUpperCase() });
    }
    throw reasonToError(old.invalid_reason ?? old.status.toUpperCase());
  }
  const cart = await loadCart(ctx.db, userId, old.cart_id);
  if (cart.status !== 'open') throw new DomainError('CART_NOT_OPEN', `Cart is ${cart.status}`);
  const changed = () =>
    new DomainError('CONFIRMATION_INVALIDATED', 'The cart changed since this confirmation was prepared. Ask your assistant to prepare a new one.', { reason: 'CART_CHANGED' });
  if (cart.version !== old.cart_version) throw changed();
  const actor: Actor = { userId, via: 'web' };
  const { quote } = await quoteCart(ctx, actor, old.cart_id);
  if (quote.cart_version !== old.cart_version) throw changed();
  if (!quote.checkout_allowed) {
    const first = quote.issues[0];
    throw new DomainError((first?.code as any) ?? 'VALIDATION_FAILED', first?.message ?? 'The order cannot be placed as it is', { issues: quote.issues });
  }
  const fresh = await prepareCheckout(ctx, actor, { cart_id: old.cart_id, quote_id: quote.id }, { createdBy: old.created_by });
  await audit(ctx.db, { userId, actor: 'web', action: 'checkout.refreshed', mode: fresh.mode, entity: 'checkout', entityId: fresh.id, details: { from: old.id, total: fresh.total_minor } });
  return {
    checkout_id: fresh.id,
    confirm_url: confirmUrl(ctx, fresh.id),
    total_minor: Number(fresh.total_minor),
    previous_total_minor: Number(old.total_minor),
    currency: fresh.currency,
    price_changed: Number(fresh.total_minor) !== Number(old.total_minor) || fresh.currency !== old.currency,
    expires_at: new Date(fresh.expires_at).toISOString(),
  };
}

/** Full, human-readable view of what is being approved. Used by the confirmation page and get_checkout_status. */
export async function checkoutView(ctx: Ctx, userId: string, id: string, locale: Locale = 'en') {
  // Everything the view shows in one statement: the checkout, its quote, the cart, the approved cart version,
  // the address, the submission attempt and the order (at most one of each: UNIQUE(checkout_id)).
  const row = (await ctx.db.query<Record<string, any>>(
    `SELECT c.*,
       q.lines AS j_lines, q.subtotal_minor AS j_subtotal_minor, q.delivery_fee_minor AS j_delivery_fee_minor, q.service_fee_minor AS j_service_fee_minor,
       q.small_order_fee_minor AS j_small_order_fee_minor, q.discount_minor AS j_discount_minor, q.total_minor AS j_total_minor,
       q.eta_min_minutes AS j_eta_min_minutes, q.eta_max_minutes AS j_eta_max_minutes, q.price_source AS j_price_source, q.fetched_at AS j_fetched_at,
       k.restaurant_name AS j_restaurant_name, k.restaurant_id AS j_restaurant_id, k.service AS j_service,
       v.items AS j_items, v.trip AS j_trip, to_jsonb(ad) AS j_address, to_jsonb(a) AS j_attempt,
       o.id AS j_order_id, o.fulfillment_status AS j_order_status, to_jsonb(o) AS j_order_row
     FROM checkouts c
     JOIN quotes q ON q.id = c.quote_id
     JOIN carts k ON k.id = c.cart_id AND k.user_id = c.user_id
     JOIN cart_versions v ON v.cart_id = c.cart_id AND v.version = c.cart_version
     LEFT JOIN addresses ad ON ad.id = v.address_id
     LEFT JOIN submission_attempts a ON a.checkout_id = c.id
     LEFT JOIN orders o ON o.checkout_id = c.id
     WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId],
  )).rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'Checkout not found');
  const j: Record<string, any> = {};
  const own: Record<string, any> = {};
  for (const [key, val] of Object.entries(row)) (key.startsWith('j_') ? j : own)[key.startsWith('j_') ? key.slice(2) : key] = val;
  let c = own as CheckoutRow;
  if ((c.status === 'awaiting_user' || c.status === 'approved') && new Date(c.expires_at).getTime() <= ctx.clock.now().getTime()) {
    await markInvalid(ctx.db, c.id, 'EXPIRED');
    c = await loadCheckout(ctx.db, userId, id);
  }
  const qr = j as Pick<QuoteRow, 'lines' | 'subtotal_minor' | 'delivery_fee_minor' | 'service_fee_minor' | 'small_order_fee_minor' | 'discount_minor' | 'total_minor' | 'eta_min_minutes' | 'eta_max_minutes' | 'price_source' | 'fetched_at'>;
  const cart = { restaurant_name: j.restaurant_name as string, restaurant_id: j.restaurant_id as string | null, service: j.service as CartState['service'] };
  const v = { items: j.items, trip: j.trip };
  const addr = j.address ?? null;
  // The attempt comes back as JSON: timestamps become Date again, like a plain row read.
  const asDate = (x: unknown) => (x == null ? null : new Date(x as string));
  const attempt: AttemptRow | undefined = j.attempt
    ? { ...j.attempt, started_at: asDate(j.attempt.started_at), finished_at: asDate(j.attempt.finished_at), next_reconcile_at: asDate(j.attempt.next_reconcile_at) }
    : undefined;
  const order = j.order_id ? { id: j.order_id as string, fulfillment_status: j.order_status as string } : undefined;
  const m = (n: number) => money(n, c.currency, locale);
  return {
    checkout: c,
    restaurant_name: cart.restaurant_name,
    restaurant_id: cart.restaurant_id,
    service: cart.service,
    trip: isTripService(cart.service) ? describeTrip(v.trip ?? null) : null,
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
    /** The stored order of this checkout as read by this same statement (timestamps as ISO strings), or null. */
    order_row: (j.order_row as OrderRow | null) ?? null,
    items_snapshot: v.items,
  };
}

const PAID = ['captured', 'refunding', 'refunded'];

/**
 * Payment step of a checkout that must be paid before submission. `awaiting_payment`: the user
 * approved the order but the GrabPay payment is not captured (not started, in progress at Grab,
 * failed, or still being confirmed); nothing is ordered until it is.
 */
export function paymentPhase(c: Pick<CheckoutRow, 'status'>, a: AttemptRow | null, p: PaymentRow | null): 'awaiting_payment' | 'paid' | null {
  if (a || c.status !== 'approved') return p && PAID.includes(p.status) ? 'paid' : null;
  return p && PAID.includes(p.status) ? 'paid' : 'awaiting_payment';
}

export async function checkoutStatus(ctx: Ctx, actor: Actor, id: string) {
  return checkoutStatusOf(ctx, actor, await checkoutView(ctx, actor.userId, id));
}

/** checkoutStatus from a view that was already read. */
export async function checkoutStatusOf(ctx: Ctx, actor: Actor, v: Awaited<ReturnType<typeof checkoutView>>) {
  const c = v.checkout;
  const needsPay = paymentRequired(ctx, c);
  const pay = needsPay ? await checkoutPayment(ctx.db, c.id) : null;
  const phase = needsPay ? paymentPhase(c, v.attempt ?? null, pay) : null;
  const awaitingPayment = phase === 'awaiting_payment';
  return {
    checkout_id: c.id,
    mode: c.mode,
    // awaiting_payment is reported instead of approved: the order is not placed until GrabPay captures the payment.
    status: awaitingPayment ? ('awaiting_payment' as const) : c.status,
    invalid_reason: c.invalid_reason,
    total: money(c.total_minor, c.currency),
    expires_at: new Date(c.expires_at).toISOString(),
    approved_at: c.approved_at ? new Date(c.approved_at).toISOString() : null,
    confirm_url: c.status === 'awaiting_user' || awaitingPayment ? confirmUrl(ctx, c.id) : null,
    submission: v.attempt ? describeAttempt(v.attempt) : null,
    order_id: v.order?.id ?? null,
    step_up_required: (await stepUpPolicy(ctx, actor.userId, c)).required,
    ...(needsPay ? { payment: { method: 'grabpay', status: pay ? pay.status : 'not_started' } } : {}),
    ...(awaitingPayment
      ? { user_action: 'Ask the user to open confirm_url and finish paying with GrabPay (they are sent to Grab to approve). Nothing is ordered until the payment goes through. Then call get_checkout_status again.' }
      : {}),
    summary: needsPay ? paidStatusSummary(c, v.attempt ?? null, pay) : statusSummary(c, v.attempt ?? null),
  };
}

/** Summary for a checkout paid with GrabPay before submission. Never says "placed" before an order exists. */
function paidStatusSummary(c: CheckoutRow, a: AttemptRow | null, p: PaymentRow | null): string {
  const refund = p?.status === 'refunded' ? ' The GrabPay payment was refunded in full.' : p?.status === 'refunding' ? ' The GrabPay payment is being refunded in full.' : '';
  if (a) return describeAttempt(a).message + refund;
  if (c.status === 'awaiting_user') {
    return 'Waiting for the user to open confirm_url, press "Pay with GrabPay" and approve the payment in Grab. The order is placed only after the payment goes through.';
  }
  if (c.status === 'approved') {
    if (p?.status === 'captured') return 'Payment received in GrabPay. The order is being sent to GrabExpress; it is not placed yet. Check again shortly.';
    if (p && PAID.includes(p.status)) return `Not ordered.${refund}`;
    if (p?.status === 'failed') return 'The user confirmed, but the GrabPay payment did not go through and nothing was charged. The user can try again on confirm_url. Nothing is ordered.';
    if (p?.status === 'unknown') return 'The user confirmed; the GrabPay payment is still being confirmed with Grab. Nothing is ordered yet and the user must not pay again.';
    return 'The user confirmed but has not completed the GrabPay payment yet. Nothing is ordered until the payment is approved in Grab.';
  }
  return statusSummary(c, null) + refund;
}

/** One sentence the assistant can relay as is. */
function statusSummary(c: CheckoutRow, a: AttemptRow | null): string {
  if (a) return describeAttempt(a).message;
  switch (c.status) {
    case 'awaiting_user':
      return 'Waiting for the user to open confirm_url and press Confirm. Pressing Confirm places the order.';
    case 'approved':
      return 'The user confirmed but the order was not sent yet (for example, new orders were paused). submit_order sends it.';
    case 'declined':
      return 'The user declined on the confirmation page. Nothing was ordered.';
    case 'expired':
      return 'The confirmation expired before the user confirmed. Nothing was ordered.';
    case 'invalidated':
      return `The confirmation is no longer valid (${c.invalid_reason ?? 'changed'}). Nothing was ordered.`;
    default:
      return 'Nothing was ordered with this confirmation.';
  }
}

/**
 * Re-price the exact cart version a checkout was prepared for (items, address or trip) with the provider.
 * Returns null when the provider would charge the same total with no blocking issues.
 */
export async function repriceProblem(ctx: Ctx, c: CheckoutRow): Promise<string | null> {
  const cart = await loadCart(ctx.db, c.user_id, c.cart_id);
  const v = await loadCartVersion(ctx.db, c.cart_id, c.cart_version);
  const addr = v.address_id ? await getAddress(ctx.db, c.user_id, v.address_id).catch(() => null) : null;
  if (v.address_id && !addr) return 'ADDRESS_CHANGED';
  const pq = await callProvider(() =>
    ctx.provider(c.mode).quote({ restaurant_id: cart.restaurant_id!, lines: v.items, address: addr ? toDeliveryAddress(addr) : null, trip: v.trip }),
  );
  if (pq.issues.length || pq.total_minor !== Number(c.total_minor) || pq.currency !== c.currency) return 'PRICE_CHANGED';
  return null;
}

/**
 * Human approval. Only callable from an authenticated web session (never from MCP).
 * The confirmation lives up to CHECKOUT_MAX_TTL_MS; if the provider quote behind it is older than the
 * provider's own validity, the same cart version is re-priced first. Same total: proceed. Different
 * total or a new blocking issue: the confirmation is invalidated with PRICE_CHANGED.
 */
export async function approveCheckout(
  ctx: Ctx, userId: string, id: string,
  opts: { stepUp?: unknown; via?: string; partnerVerification?: 'tap' | 'biometric' | 'passcode'; pre?: CheckoutWithQuoteExpiry } = {},
) {
  const via = opts.via ?? 'web';
  // opts.pre: the row the caller read a moment ago in this same request. It only decides the unlocked
  // pre-checks (step-up, stale quote); the approval itself re-reads the checkout under a row lock.
  const pre = opts.pre && opts.pre.id === id && opts.pre.user_id === userId ? opts.pre : await loadCheckoutWithQuoteExpiry(ctx.db, userId, id);
  // Step-up: a large order from a user with a passkey is approved only with a fresh passkey assertion
  // bound to this checkout. Checked before anything else; the challenge is consumed either way.
  // Partner apps verify the user on the device (Face ID or passcode); src/partners/checkout.ts enforces
  // that for large orders before calling this.
  let steppedUp = false;
  if (pre.status === 'awaiting_user' && !opts.partnerVerification && (await stepUpPolicy(ctx, userId, pre)).required) {
    await verifyStepUp(ctx, userId, id, opts.stepUp);
    steppedUp = true;
  }
  let staleQuoteProblem: string | null = null;
  let repriced = false;
  if (pre.status === 'awaiting_user' && new Date(pre.expires_at).getTime() > ctx.clock.now().getTime()) {
    if (!pre.quote_expires_at || new Date(pre.quote_expires_at).getTime() <= ctx.clock.now().getTime()) {
      // Provider call outside the transaction; the cart version and location are re-checked under the lock below.
      staleQuoteProblem = await repriceProblem(ctx, pre);
      repriced = true;
    }
  }
  const out = await ctx.db.tx(async (q) => {
    const c = await loadCheckout(q, userId, id, true);
    if (c.status === 'approved' || c.status === 'consumed') return c; // double click
    if (c.status !== 'awaiting_user') throw reasonToError(c.invalid_reason ?? c.status.toUpperCase());
    const problem = (await validityProblem(ctx, q, c)) ?? (c.quote_id === pre.quote_id ? staleQuoteProblem : null);
    if (problem) {
      await markInvalid(q, c.id, problem); // committed, then reported
      return reasonToError(problem);
    }
    const r = await q.query<CheckoutRow>(`UPDATE checkouts SET status='approved', approved_at=$2, approved_via=$3 WHERE id=$1 RETURNING *`, [c.id, ctx.clock.now(), via]);
    if (steppedUp) await audit(q, { userId, actor: via, action: 'checkout.step_up', mode: c.mode, entity: 'checkout', entityId: c.id, details: { method: 'passkey' } });
    const details: Record<string, unknown> = {};
    if (repriced) details.repriced = true;
    if (opts.partnerVerification) details.user_verification = opts.partnerVerification;
    await audit(q, { userId, actor: via, action: 'checkout.approved', mode: c.mode, entity: 'checkout', entityId: c.id, details: Object.keys(details).length ? details : undefined });
    return r.rows[0];
  });
  if (out instanceof DomainError) throw out;
  return out;
}

export async function declineCheckout(ctx: Ctx, userId: string, id: string, via = 'web') {
  await ctx.db.tx(async (q) => {
    const c = await loadCheckout(q, userId, id, true);
    if (c.status === 'awaiting_user' || c.status === 'approved') {
      await q.query(`UPDATE checkouts SET status='declined' WHERE id=$1`, [c.id]);
      await audit(q, { userId, actor: via, action: 'checkout.declined', mode: c.mode, entity: 'checkout', entityId: c.id });
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

/** What recordAccepted needs to know about the checkout being accepted, when the caller already read it under the cart lock. */
interface AcceptKnown {
  user_id: string;
  checkout: Pick<CheckoutRow, 'id' | 'mode' | 'total_minor' | 'currency'>;
  cart: Pick<CartRow, 'id' | 'restaurant_id' | 'restaurant_name' | 'service'>;
  trip: CartState['trip'];
  lines: any[];
  address_label: string | null;
}

/** The partner app's record of the user's tap (partner_confirmations), stored with the cart lock statement. */
export interface PartnerConfirmation { partnerId: string; hash: string; verification: 'tap' | 'biometric' | 'passcode'; device: string | null; at: Date }

interface SubmitOpts {
  pre?: Pick<CheckoutRow, 'id' | 'user_id' | 'mode' | 'cart_id'>;
  /**
   * Approve and submit in one transaction (the partner app's Confirm): a checkout that is still awaiting the user
   * is approved under the same locks that guard the submission. Without it the checkout must already be approved.
   */
  approve?: { via: string; partnerVerification: 'tap' | 'biometric' | 'passcode'; quoteId: string; staleQuoteProblem: string | null; repriced: boolean; confirmation?: PartnerConfirmation };
  /** Demo orders of partner apps run at presentation speed: the simulator and the ETA are sped up by this factor when the order is stored. */
  demoSpeed?: number;
}

/**
 * Sends an approved checkout to the provider, at most once per checkout.
 * Safe to call repeatedly and concurrently: the checkout row lock plus the UNIQUE(checkout_id)
 * constraint on submission_attempts guarantee a single provider call from Unyly's side.
 */
export async function submitOrder(ctx: Ctx, actor: Actor, checkoutId: string, opts: { pre?: SubmitOpts['pre'] } = {}) {
  return (await submit(ctx, actor, checkoutId, { pre: opts.pre })).submission;
}

/**
 * The partner app's Confirm: approval (see approveCheckout) and submission in ONE transaction instead of two
 * back-to-back ones on the same rows. Lock order as everywhere: cart, then checkout. Outcomes are the same as
 * approveCheckout followed by submitOrder: an approval that cannot be sent yet (new orders paused, an earlier
 * submission of the cart pending) is still stored as approved and the reason is reported.
 * Returns the submission and, when this call stored the order, its id.
 */
export async function approveAndSubmit(
  ctx: Ctx, actor: Actor, checkoutId: string,
  a: { via: string; partnerVerification: 'tap' | 'biometric' | 'passcode'; pre: CheckoutWithQuoteExpiry; confirmation?: PartnerConfirmation; demoSpeed?: number },
) {
  const pre = a.pre;
  if (pre.id !== checkoutId || pre.user_id !== actor.userId) throw new DomainError('NOT_FOUND', 'Checkout not found');
  // Same unlocked pre-check as approveCheckout: a provider quote older than its validity is re-priced first
  // (provider call outside the transaction); cart version and location are re-checked under the locks.
  let staleQuoteProblem: string | null = null;
  let repriced = false;
  if (pre.status === 'awaiting_user' && new Date(pre.expires_at).getTime() > ctx.clock.now().getTime()) {
    if (!pre.quote_expires_at || new Date(pre.quote_expires_at).getTime() <= ctx.clock.now().getTime()) {
      staleQuoteProblem = await repriceProblem(ctx, pre);
      repriced = true;
    }
  }
  return submit(ctx, actor, checkoutId, {
    pre, demoSpeed: a.demoSpeed,
    approve: { via: a.via, partnerVerification: a.partnerVerification, quoteId: pre.quote_id, staleQuoteProblem, repriced, confirmation: a.confirmation },
  });
}

async function submit(ctx: Ctx, actor: Actor, checkoutId: string, opts: SubmitOpts): Promise<{ submission: ReturnType<typeof describeAttempt>; order_id?: string }> {
  // opts.pre: mode and cart id of the checkout as the caller just read them (both never change); the checkout is re-read under its lock below.
  const pre = opts.pre && opts.pre.id === checkoutId && opts.pre.user_id === actor.userId ? opts.pre : await loadCheckout(ctx.db, actor.userId, checkoutId);
  requireCapability(ctx, pre.mode, 'submit_order');
  const ap = opts.approve;
  const pc = ap?.confirmation;
  const prepared = await ctx.db.tx(async (q) => {
    // Lock order: cart, then checkout (same as prepareCheckout) to serialize all submissions of a cart.
    // The partner's record of the tap is written by the same statement (kept whenever this transaction commits).
    const cartRow = await lockCart(q, actor.userId, pre.cart_id, pc ? {
      sql: `pc AS (INSERT INTO partner_confirmations (partner_id, user_id, entity, entity_id, confirm_hash, user_verification, device_id, confirmed_at)
                   VALUES ($3,$2,'checkout',$4,$5,$6,$7,$8) ON CONFLICT (entity, entity_id) DO NOTHING)`,
      params: [pc.partnerId, checkoutId, pc.hash, pc.verification, pc.device, pc.at],
    } : undefined);
    // The checkout row lock and everything the decision reads, in one statement. It starts after the cart lock is
    // held, and every writer of this cart's versions and submission attempts takes that lock first, so its
    // snapshot holds what the previous holder committed; the checkout row itself is returned as locked.
    const rd = (await q.query<Record<string, any>>(
      `SELECT c.*,
              (SELECT to_jsonb(v) FROM cart_versions v WHERE v.cart_id = c.cart_id AND v.version = $3) AS j_version,
              (SELECT to_jsonb(a) FROM submission_attempts a WHERE a.checkout_id = c.id) AS j_attempt,
              ${blockSql('c.cart_id', 'c.id')} AS j_block,
              (SELECT value FROM settings WHERE key = 'submissions') AS j_submissions,
              EXISTS (SELECT 1 FROM payments p WHERE p.checkout_id = c.id AND p.status = 'captured') AS j_paid,
              (SELECT qt.lines FROM quotes qt WHERE qt.id = c.quote_id) AS j_quote_lines,
              ${addressesJsonSql('c.user_id')} AS j_addresses
         FROM checkouts c WHERE c.id = $1 AND c.user_id = $2 FOR UPDATE OF c`,
      [checkoutId, actor.userId, cartRow.version],
    )).rows[0];
    if (!rd) throw new DomainError('NOT_FOUND', 'Checkout not found');
    const j: Record<string, any> = {};
    const own: Record<string, any> = {};
    for (const [key, val] of Object.entries(rd)) (key.startsWith('j_') ? j : own)[key.startsWith('j_') ? key.slice(2) : key] = val;
    const c = own as CheckoutRow;
    if (c.cart_id !== cartRow.id) throw new DomainError('NOT_FOUND', 'Checkout not found');
    if (j.attempt) {
      const x = j.attempt;
      const asDate = (d: unknown) => (d == null ? null : new Date(d as string));
      return { replay: { ...x, started_at: asDate(x.started_at), finished_at: asDate(x.finished_at), next_reconcile_at: asDate(x.next_reconcile_at) } as AttemptRow };
    }
    const now = ctx.clock.now();
    const cart: CartState = { ...cartRow, items: j.version?.items ?? [], address_id: j.version?.address_id ?? null, trip: j.version?.trip ?? null };
    const addresses = j.addresses as AddressRow[];
    // Everything the human approved is still exactly true (see checkValidity; here from rows read under the locks).
    const validity = (): string | null => {
      if (new Date(c.expires_at).getTime() <= now.getTime()) return 'EXPIRED';
      const live = ctx.providers.live;
      if (c.mode === 'live' && live instanceof GrabLiveProvider && c.payment_method_label !== live.paymentLabel()) return 'PAYMENT_METHOD_CHANGED';
      if (cart.status !== 'open') return 'CART_NOT_OPEN';
      if (cart.version !== c.cart_version || !j.version) return 'CART_CHANGED';
      const fp = locationFingerprintFrom(cart, addresses);
      if (!fp || fp !== c.address_fingerprint) return 'ADDRESS_CHANGED';
      return null;
    };
    const invalidate = async (problem: string) => {
      await markInvalid(q, c.id, problem); // committed, then reported
      return { invalid: reasonToError(problem) };
    };
    const paymentMissing = () => paymentRequired(ctx, c) && !j.paid
      // Cashless GrabExpress is billed to Unyly: never create the delivery before the user's payment is captured.
      ? new DomainError('CONFIRMATION_REQUIRED', 'The user must complete the GrabPay payment from the confirmation page first. Nothing was ordered.',
        { confirm_url: confirmUrl(ctx, c.id), payment_required: 'grabpay' },
        'Ask the user to open confirm_url and finish paying with GrabPay. Then call get_checkout_status.')
      : null;
    const paused = () => (submissionsOn(ctx, j.submissions, c.mode) ? null : new DomainError('SUBMISSIONS_PAUSED', 'New orders are temporarily paused. Your confirmation stays valid until it expires.'));

    const approving = !!ap && c.status === 'awaiting_user';
    const approvalDetails: Record<string, unknown> = {};
    if (ap?.repriced) approvalDetails.repriced = true;
    if (ap) approvalDetails.user_verification = ap.partnerVerification;
    if (approving) {
      // The approval step (as approveCheckout): only a still valid confirmation is approved.
      const problem = validity() ?? (c.quote_id === ap!.quoteId ? ap!.staleQuoteProblem : null);
      if (problem) return invalidate(problem);
      // Approved. If it cannot be sent right now, the approval alone is stored and the reason reported.
      const notNow = blockError(j.block) ?? paymentMissing() ?? paused();
      if (notNow) {
        await q.query(
          `WITH co AS (UPDATE checkouts SET status='approved', approved_at=$2, approved_via=$3 WHERE id=$1 RETURNING *)
           INSERT INTO audit_log (user_id, actor, action, mode, entity, entity_id, details) SELECT co.user_id, $3, 'checkout.approved', co.mode, 'checkout', co.id::text, $4::jsonb FROM co`,
          [c.id, now, ap!.via, JSON.stringify(approvalDetails)],
        );
        return { invalid: notNow };
      }
    } else {
      const blocked = blockError(j.block);
      if (blocked) return { invalid: blocked };
      if (c.status === 'awaiting_user') {
        return { invalid: new DomainError('CONFIRMATION_REQUIRED', 'The user must confirm this order on the Unyly confirmation page first.', { confirm_url: confirmUrl(ctx, c.id) },
          'Ask the user to open confirm_url, review the order and press Confirm. Then call get_checkout_status.') };
      }
      if (c.status !== 'approved') return { invalid: reasonToError(c.invalid_reason ?? c.status.toUpperCase()) };
      const notNow = paymentMissing() ?? paused();
      if (notNow) return { invalid: notNow };
      const problem = validity();
      if (problem) return invalidate(problem);
    }
    // Send exactly the approved cart version: the cart was read under its lock and found open at the checkout's version.
    const addr = isTripService(cart.service) ? null : addresses.find((x) => x.id === cart.address_id) ?? null;
    if (!isTripService(cart.service) && !addr) throw new DomainError('NOT_FOUND', 'Address not found');
    // Consume the confirmation (approving it first when this is the partner's Confirm), record the attempt and
    // the audit rows: one statement.
    const audits = [
      ...(approving ? [{ actor: ap!.via, action: 'checkout.approved', details: approvalDetails }] : []),
      { actor: actorLabel(actor), action: 'submission.started', details: {} },
    ];
    const a = await q.query<AttemptRow>(
      `WITH co AS (
              UPDATE checkouts SET status='consumed', consumed_at=$2,
                     approved_at = CASE WHEN $3::boolean THEN $2::timestamptz ELSE approved_at END, approved_via = CASE WHEN $3::boolean THEN $4::text ELSE approved_via END
               WHERE id=$1 RETURNING *),
            at AS (
              INSERT INTO submission_attempts (checkout_id, user_id, mode, idempotency_key, status, next_reconcile_at, started_at)
              SELECT co.id, co.user_id, co.mode, $5, 'in_flight', $6, $2 FROM co RETURNING *),
            au AS (
              INSERT INTO audit_log (user_id, actor, action, mode, entity, entity_id, details)
              SELECT co.user_id, x.actor, x.action, co.mode, 'checkout', co.id::text, x.details
                FROM co, jsonb_to_recordset($7::jsonb) WITH ORDINALITY AS x(actor text, action text, details jsonb, ord bigint) ORDER BY x.ord)
       SELECT * FROM at`,
      [c.id, now, approving, ap?.via ?? null, `unyly-${c.id}`, new Date(now.getTime() + ctx.cfg.providerTimeoutMs + 5000), JSON.stringify(audits)],
    );
    const known: AcceptKnown | undefined = Array.isArray(j.quote_lines)
      ? { user_id: actor.userId, checkout: c, cart, trip: cart.trip, lines: j.quote_lines, address_label: addr?.label ?? null }
      : undefined;
    return { attempt: a.rows[0], checkout: c, cart, addr, known };
  });
  if ('invalid' in prepared) throw prepared.invalid;
  if ('replay' in prepared) return { submission: describeAttempt(prepared.replay!) };

  const { attempt, checkout, cart, addr, known } = prepared;
  const provider = ctx.provider(checkout.mode);
  let result: SubmitResult;
  try {
    result = await withTimeout(
      provider.submitOrder({
        idempotency_key: attempt.idempotency_key,
        restaurant_id: cart.restaurant_id!,
        lines: cart.items,
        address: addr ? toDeliveryAddress(addr) : null,
        trip: cart.trip,
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
    return { submission: describeAttempt(a) };
  }

  if (result.outcome === 'accepted') {
    const done = await acceptOrder(ctx, attempt.id, result.provider_order_ref, result.status, result.payment_status, result.eta_at, { known, demoSpeed: opts.demoSpeed });
    if (done.attempt) return { submission: describeAttempt(done.attempt), order_id: done.order_id };
  } else {
    await finishAttempt(ctx, attempt.id, 'rejected', { code: result.code, detail: result.message });
    await audit(ctx.db, { userId: actor.userId, actor: actorLabel(actor), action: 'submission.rejected', mode: checkout.mode, entity: 'submission', entityId: attempt.id, details: { code: result.code } });
    const code = result.code === 'PROVIDER_REJECTED' ? 'PROVIDER_REJECTED' : result.code;
    throw new DomainError(code, `Not ordered: ${result.message}`, { submission_id: attempt.id }, 'Quote the cart again and ask the user to confirm the new details.');
  }
  const a = (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE id = $1', [attempt.id])).rows[0];
  return { submission: describeAttempt(a) };
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

/** The order row of an accepted submission as it is inserted: items, the "where" label and the first event's push text. */
function orderParts(k: { user_id: string; service: CartState['service']; restaurant_name: string; trip: CartState['trip']; lines: any[]; address_label: string | null }) {
  const where = isTripService(k.service) ? tripLabel(k.trip ?? null) ?? 'trip' : k.address_label ?? 'address';
  const items = k.lines.map((l: any) => ({ item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers: l.modifiers_desc, line_total_minor: l.line_total_minor }));
  const title = isTripService(k.service) ? where : k.restaurant_name;
  const notify = (orderId: string, status: string, etaAt: string | null) => (l: Locale) => orderNotify({
    id: orderId, user_id: k.user_id, service: k.service, restaurant_name: k.restaurant_name, address_label: where,
    items: k.lines.map((x: any) => ({ name: x.name })), eta_at: etaAt,
  }, status as FulfillmentStatus, l);
  return { where, items, title, notify };
}

/** Persist an accepted order. Idempotent: the order row is unique per checkout and per provider ref. */
export async function recordAccepted(ctx: Ctx, attemptId: string, ref: string, status: string, paymentStatus: string, etaAt?: string): Promise<AttemptRow | undefined> {
  return (await acceptOrder(ctx, attemptId, ref, status, paymentStatus, etaAt)).attempt;
}

/**
 * recordAccepted, also returning the id of the order when this call stored it.
 * With `known` (a demo checkout read under the cart lock by this same request; demo orders have no prepaid
 * payment) everything is ONE statement, atomic on its own: the guarded attempt update takes the attempt's row lock,
 * and the order, the cart status, the audit row and the order.created event are written from its result. With
 * `demoSpeed` the simulator and the ETA are sped up in that same statement (once, when the order is stored).
 */
async function acceptOrder(
  ctx: Ctx, attemptId: string, ref: string, status: string, paymentStatus: string, etaAt: string | undefined,
  opts: { known?: AcceptKnown; demoSpeed?: number } = {},
): Promise<{ attempt: AttemptRow | undefined; order_id?: string }> {
  const k = opts.known;
  if (k && k.checkout.mode === 'demo') {
    const parts = orderParts({ user_id: k.user_id, service: k.cart.service, restaurant_name: k.cart.restaurant_name, trip: k.trip, lines: k.lines, address_label: k.address_label });
    const orderId = randomUUID();
    // Presentation speed: the order is stored with the ETA the app will keep seeing (never under 30 seconds from now).
    const speed = opts.demoSpeed && opts.demoSpeed > 0 ? opts.demoSpeed : null;
    const created = new Date();
    const eta = etaAt && speed ? new Date(created.getTime() + Math.max(30, Math.round((new Date(etaAt).getTime() - created.getTime()) / 1000 / speed)) * 1000).toISOString() : etaAt ?? null;
    const r = await ctx.db.query<AttemptRow & { j_order_id: string | null }>(
      `WITH a AS (
              UPDATE submission_attempts SET status='accepted', provider_order_ref=$2, finished_at=COALESCE(finished_at,$3), next_reconcile_at=NULL, error_code=NULL
               WHERE id=$1 AND NOT (status = 'rejected' AND error_code IS DISTINCT FROM 'NOT_RECEIVED_BY_PROVIDER') RETURNING *),
            ins AS (
              INSERT INTO orders (id, user_id, checkout_id, submission_id, cart_id, mode, provider, provider_order_ref, restaurant_id, restaurant_name, items, address_label,
                total_minor, currency, fulfillment_status, payment_status, status_version, eta_at, service, picked_up_at, created_at)
              SELECT $4, a.user_id, a.checkout_id, a.id, $5, $6, $7, $2, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, 0, $16, $17, $18, COALESCE($19::timestamptz, now()) FROM a
              ON CONFLICT DO NOTHING RETURNING id),
            k AS (UPDATE carts SET status='ordered', updated_at=now() WHERE id=$5 AND EXISTS (SELECT 1 FROM a)),
            sim AS (UPDATE demo_sim_orders d SET speed = GREATEST(d.speed, $20::real) WHERE d.ref = $2 AND $20::real IS NOT NULL AND EXISTS (SELECT 1 FROM ins)),
            au AS (INSERT INTO audit_log (user_id, actor, action, mode, entity, entity_id, details)
                   SELECT a.user_id, 'system', 'order.accepted', $6, 'order', ins.id::text, $21::jsonb FROM a, ins),
            ${partnerEventCtes('ev', 22, 'EXISTS (SELECT 1 FROM ins)')}
       SELECT a.*, (SELECT id FROM ins) AS j_order_id FROM a`,
      [attemptId, ref, ctx.clock.now(), orderId, k.cart.id, k.checkout.mode, ctx.provider(k.checkout.mode).providerName, k.cart.restaurant_id, k.cart.restaurant_name,
        JSON.stringify(parts.items), parts.where, k.checkout.total_minor, k.checkout.currency, status, paymentStatus, eta, k.cart.service,
        status === 'picked_up' || status === 'delivered' ? ctx.clock.now() : null, speed ? created : null, speed, JSON.stringify({ total: k.checkout.total_minor }),
        ...partnerEventParams(k.user_id, 'order.created', {
          order_id: orderId, checkout_id: k.checkout.id, service: k.cart.service, status, total_minor: Number(k.checkout.total_minor), currency: k.checkout.currency, title: parts.title,
        }, { dedupeKey: `order:${orderId}:created`, notify: parts.notify(orderId, status, eta) })],
    );
    const row = r.rows[0];
    // No row: the attempt was already closed as refused by the provider, which is final.
    if (!row) return { attempt: (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE id = $1', [attemptId])).rows[0] };
    const { j_order_id, ...attempt } = row;
    return { attempt: attempt as AttemptRow, order_id: j_order_id ?? undefined };
  }
  const attempt = await ctx.db.tx(async (q) => {
    const a = (await q.query<AttemptRow>('SELECT * FROM submission_attempts WHERE id = $1 FOR UPDATE', [attemptId])).rows[0];
    // A provider-side rejection is final. Only "not received" may later turn out to be accepted.
    if (a.status === 'rejected' && a.error_code !== 'NOT_RECEIVED_BY_PROVIDER') return a;
    const accepted = (await q.query<AttemptRow>(
      `UPDATE submission_attempts SET status='accepted', provider_order_ref=$2, finished_at=COALESCE(finished_at,$3), next_reconcile_at=NULL, error_code=NULL WHERE id=$1 RETURNING *`,
      [attemptId, ref, ctx.clock.now()],
    )).rows[0];
    // The order is what the human approved: the checkout's cart version, never whatever the cart holds now.
    // Checkout, cart, that cart version, its quote lines, the address label and a prepaid payment in one read.
    const j = (await q.query(
      `SELECT c.id, c.mode, c.total_minor, c.currency, k.id AS cart_id, k.restaurant_id, k.restaurant_name, k.service, v.trip, q.lines, ad.label AS address_label,
         p.id AS pay_id, p.status AS pay_status
       FROM checkouts c
       JOIN carts k ON k.id = c.cart_id AND k.user_id = c.user_id
       JOIN cart_versions v ON v.cart_id = c.cart_id AND v.version = c.cart_version
       JOIN quotes q ON q.id = c.quote_id
       LEFT JOIN addresses ad ON ad.id = v.address_id
       LEFT JOIN LATERAL (SELECT id, status FROM payments WHERE checkout_id = c.id AND status IN ('captured','refunding','refunded') LIMIT 1) p ON true
       WHERE c.id = $1`,
      [a.checkout_id],
    )).rows[0];
    const c = { id: j.id as string, mode: j.mode as CheckoutRow['mode'], total_minor: j.total_minor as number, currency: j.currency as string };
    const cart = { id: j.cart_id as string, restaurant_id: j.restaurant_id as string | null, restaurant_name: j.restaurant_name as string, service: j.service as CartState['service'] };
    const qr = { lines: j.lines as any[] };
    const where = isTripService(cart.service) ? tripLabel(j.trip ?? null) ?? 'trip' : (j.address_label as string | null) ?? 'address';
    const ins = await q.query(
      `INSERT INTO orders (user_id, checkout_id, submission_id, cart_id, mode, provider, provider_order_ref, restaurant_id, restaurant_name, items, address_label,
         total_minor, currency, fulfillment_status, payment_status, status_version, eta_at, service, picked_up_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$16,$17,$18) ON CONFLICT DO NOTHING RETURNING id`,
      [a.user_id, c.id, a.id, cart.id, c.mode, ctx.provider(c.mode).providerName, ref, cart.restaurant_id, cart.restaurant_name,
        JSON.stringify(qr.lines.map((l: any) => ({ item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers: l.modifiers_desc, line_total_minor: l.line_total_minor }))),
        where, c.total_minor, c.currency, status, paymentStatus, etaAt ?? null, cart.service, status === 'picked_up' || status === 'delivered' ? ctx.clock.now() : null],
    );
    await q.query(`UPDATE carts SET status='ordered', updated_at=now() WHERE id=$1`, [cart.id]);
    // An order paid with GrabPay in advance shows that payment, not the provider's payment status.
    if (j.pay_id) {
      await q.query('UPDATE orders SET payment_id = $2, payment_status = $3 WHERE checkout_id = $1 AND payment_id IS NULL', [c.id, j.pay_id, orderPaymentStatus(j.pay_status as PaymentRow['status'])]);
    }
    if (ins.rowCount) {
      await audit(q, { userId: a.user_id, actor: 'system', action: 'order.accepted', mode: c.mode, entity: 'order', entityId: ins.rows[0].id, details: { total: c.total_minor } });
      await enqueuePartnerEvent(q, a.user_id, 'order.created', {
        order_id: ins.rows[0].id, checkout_id: c.id, service: cart.service, status, total_minor: Number(c.total_minor), currency: c.currency,
        title: isTripService(cart.service) ? where : cart.restaurant_name,
      }, {
        dedupeKey: `order:${ins.rows[0].id}:created`,
        // The first status ("Driver assigned", "Restaurant accepted") never arrives as order.status_changed, so its push text rides on this event.
        notify: (l) => orderNotify({
          id: ins.rows[0].id, user_id: a.user_id, service: cart.service, restaurant_name: cart.restaurant_name, address_label: where,
          items: qr.lines.map((x: any) => ({ name: x.name })), eta_at: etaAt ?? null,
        }, status as FulfillmentStatus, l),
      });
    }
    return accepted;
  });
  return { attempt };
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
