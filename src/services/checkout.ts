import type { Locale } from '../domain/locales.js';
import type { Actor, Ctx } from '../context.js';
import { actorLabel, audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { DomainError } from '../domain/errors.js';
import { money } from '../domain/money.js';
import { FulfillmentStatus, ProviderOutcomeUnknownError, ProviderUnavailableError, SubmitResult } from '../providers/types.js';
import { CartState, describeTrip, loadCart, loadCartVersion, locationFingerprint, quoteCart, QuoteRow, tripLabel } from './carts.js';
import { isTripService } from '../domain/regions.js';
import { enqueuePartnerEvent, orderNotify } from '../partners/webhooks.js';
import { callProvider, requireCapability, submissionsEnabled, withTimeout } from './common.js';
import { addressFingerprint, getAddress, maskedAddress, toDeliveryAddress } from './users.js';
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
  if (!(await submissionsEnabled(ctx, ctx.db, cart.mode))) {
    throw new DomainError('SUBMISSIONS_PAUSED', 'New orders are temporarily paused. Order status and history remain available.');
  }
  const row = await ctx.db.tx(async (q) => {
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
    const fp = await locationFingerprint(q, actor.userId, locked);
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
       o.id AS j_order_id, o.fulfillment_status AS j_order_status
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
  const v = await checkoutView(ctx, actor.userId, id);
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

/**
 * Sends an approved checkout to the provider, at most once per checkout.
 * Safe to call repeatedly and concurrently: the checkout row lock plus the UNIQUE(checkout_id)
 * constraint on submission_attempts guarantee a single provider call from Unyly's side.
 */
export async function submitOrder(ctx: Ctx, actor: Actor, checkoutId: string, opts: { pre?: Pick<CheckoutRow, 'id' | 'user_id' | 'mode' | 'cart_id'> } = {}) {
  // opts.pre: mode and cart id of the checkout as the caller just read them (both never change); the checkout is re-read under its lock below.
  const pre = opts.pre && opts.pre.id === checkoutId && opts.pre.user_id === actor.userId ? opts.pre : await loadCheckout(ctx.db, actor.userId, checkoutId);
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
    if (paymentRequired(ctx, c)) {
      // Cashless GrabExpress is billed to Unyly: never create the delivery before the user's payment is captured.
      const paid = (await q.query(`SELECT 1 FROM payments WHERE checkout_id = $1 AND status = 'captured'`, [c.id])).rows[0];
      if (!paid) {
        throw new DomainError('CONFIRMATION_REQUIRED', 'The user must complete the GrabPay payment from the confirmation page first. Nothing was ordered.',
          { confirm_url: confirmUrl(ctx, c.id), payment_required: 'grabpay' },
          'Ask the user to open confirm_url and finish paying with GrabPay. Then call get_checkout_status.');
      }
    }
    if (!(await submissionsEnabled(ctx, q, c.mode))) {
      throw new DomainError('SUBMISSIONS_PAUSED', 'New orders are temporarily paused. Your confirmation stays valid until it expires.');
    }
    const { problem, cart: checked } = await checkValidity(ctx, q, c);
    if (problem || !checked) {
      await markInvalid(q, c.id, problem ?? 'CART_CHANGED'); // committed, then reported
      return { invalid: reasonToError(problem ?? 'CART_CHANGED') };
    }
    const now = ctx.clock.now();
    await q.query(`UPDATE checkouts SET status='consumed', consumed_at=$2 WHERE id=$1`, [c.id, now]);
    const a = await q.query<AttemptRow>(
      `INSERT INTO submission_attempts (checkout_id, user_id, mode, idempotency_key, status, next_reconcile_at, started_at)
       VALUES ($1,$2,$3,$4,'in_flight',$5,$6) RETURNING *`,
      [c.id, actor.userId, c.mode, `unyly-${c.id}`, new Date(now.getTime() + ctx.cfg.providerTimeoutMs + 5000), now],
    );
    // Send exactly the approved cart version: the validity check above read the cart under the cart lock
    // taken at the top of this transaction and found it open at the checkout's version, so that read is it.
    const cart: CartState = checked;
    const addr = isTripService(cart.service) ? null : await getAddress(q, actor.userId, cart.address_id!);
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
    return describeAttempt(a);
  }

  if (result.outcome === 'accepted') {
    const done = await recordAccepted(ctx, attempt.id, result.provider_order_ref, result.status, result.payment_status, result.eta_at);
    if (done) return describeAttempt(done);
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
export async function recordAccepted(ctx: Ctx, attemptId: string, ref: string, status: string, paymentStatus: string, etaAt?: string): Promise<AttemptRow | undefined> {
  return ctx.db.tx(async (q) => {
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
