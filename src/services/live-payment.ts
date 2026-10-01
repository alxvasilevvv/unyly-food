// Cashless Live GrabExpress paid with GrabPay before the delivery is created.
//
//   POST /confirm/:id  (CSRF, origin, step-up passkey, price re-check, consent recorded by approveCheckout)
//     └─303─► GET /pay/grab/start/:id?total_minor=  ──► Grab consent page ──► GET /pay/grab/callback
//              (startPayment refuses a Live checkout          │
//               that is not approved)                         ▼
//                                     beforeComplete: approved, not expired, same cart and payment method,
//                                     submissions on, fresh Grab quote equals the approved total
//                                       │ any problem: payment failed WITHOUT complete (nothing charged)
//                                       ▼
//                                     POST /charge/complete ─► captured ─► onCaptured (at most once per payment)
//                                                                            └► submitOrder (idempotent per checkout)
//
// Settlement (settlePayment) decides from persisted state only, so it is safe to repeat from the
// captured hook, cancellation, webhooks and the worker:
//   rejected by Grab / NOT_RECEIVED_BY_PROVIDER / quote or price failure / never submitted -> full refund
//   cancelled or failed before pickup                                                      -> full refund
//   cancelled or failed after pickup, refund refused by GrabPay                            -> support, no automatic refund
//   submission outcome unknown, delivery in progress                                       -> wait
//   delivered                                                                              -> kept
// Refunds are idempotent: key "order:<checkout_id>:<reason>" and at most one automatic full refund per
// payment; every decision is audited and recorded in live_payment_settlements.
import type { Ctx } from '../context.js';
import { audit } from '../context.js';
import { DomainError, isDomainError } from '../domain/errors.js';
import { PaymentRow, reconcile, refundPayment, RefundRow, setBeforePaymentComplete, setOnPaymentCaptured, syncOrderPayment } from '../payments/service.js';
import { AttemptRow, CheckoutRow, markInvalid, paymentRequired, repriceProblem, submitOrder, validityProblem } from './checkout.js';
import { submissionsEnabled } from './common.js';

/** A captured payment whose checkout still has no submission is re-submitted by the worker after this. */
const RESUBMIT_AFTER_MS = 30_000;
/** Refund reasons decided while no delivery existed. */
const PRE_ORDER_REFUNDS = ['order_not_placed', 'order_not_received', 'order_rejected'];

export type Settlement = { outcome: 'kept' | 'refund_requested' | 'support'; reason: string } | { outcome: 'wait'; reason: string };

/** Wires the GrabPay hooks for this ctx. Called once from buildApp. Non-Live payments keep the default behaviour. */
export function registerLiveExpressPayment(ctx: Ctx) {
  setOnPaymentCaptured(ctx, onCaptured);
  setBeforePaymentComplete(ctx, beforeComplete);
}

async function loadCheckout(ctx: Ctx, id: string): Promise<CheckoutRow | undefined> {
  return (await ctx.db.query<CheckoutRow>('SELECT * FROM checkouts WHERE id = $1', [id])).rows[0];
}

/**
 * Last check before the money moves. Returns a reason code to fail the payment without completing it.
 * The fresh Grab quote is the same one submitOrder would get a moment later: a changed price stops
 * the charge instead of charging and refunding.
 */
export async function beforeComplete(ctx: Ctx, checkoutId: string): Promise<string | null> {
  const c = await loadCheckout(ctx, checkoutId);
  if (!c) return 'checkout_missing';
  if (c.mode !== 'live') return null;
  if (!paymentRequired(ctx, c)) return 'payment_not_required';
  if (c.status !== 'approved') return 'consent_required';
  if (!(await submissionsEnabled(ctx, ctx.db, c.mode))) return 'submissions_paused';
  if ((await ctx.db.query('SELECT 1 FROM submission_attempts WHERE checkout_id = $1', [c.id])).rows[0]) return 'already_submitted';
  const invalid = await validityProblem(ctx, ctx.db, c);
  if (invalid) {
    await markInvalid(ctx.db, c.id, invalid);
    return invalid.toLowerCase();
  }
  let reprice: string | null;
  try {
    reprice = await repriceProblem(ctx, c);
  } catch {
    return 'quote_unavailable'; // nothing charged; the checkout stays approved and the user can retry
  }
  if (reprice) {
    await markInvalid(ctx.db, c.id, reprice);
    await audit(ctx.db, { userId: c.user_id, actor: 'system', action: 'checkout.payment_stopped', mode: c.mode, entity: 'checkout', entityId: c.id, details: { reason: reprice } });
    return reprice.toLowerCase();
  }
  return null;
}

/** Captured hook: place the order for a paid Live checkout, then settle. Other checkouts: audit only. */
export async function onCaptured(ctx: Ctx, checkoutId: string, paymentId: string): Promise<void> {
  const c = await loadCheckout(ctx, checkoutId);
  if (!c || c.mode !== 'live') {
    await audit(ctx.db, { actor: 'system', action: 'payment.captured_hook_noop', entity: 'payment', entityId: paymentId, details: { checkout_id: checkoutId } });
    return;
  }
  await placePaidOrder(ctx, c, paymentId);
}

/** submitOrder for a paid checkout (idempotent: an existing submission is returned, never resent), then settle. */
async function placePaidOrder(ctx: Ctx, c: CheckoutRow, paymentId: string) {
  let submitError: DomainError | undefined;
  try {
    await submitOrder(ctx, { userId: c.user_id, via: 'system' }, c.id);
  } catch (e) {
    if (!isDomainError(e)) throw e; // unexpected (database): the worker retries
    submitError = e;
  }
  await settlePayment(ctx, paymentId, { submitError });
}

async function attemptOf(ctx: Ctx, checkoutId: string): Promise<AttemptRow | undefined> {
  return (await ctx.db.query<AttemptRow>('SELECT * FROM submission_attempts WHERE checkout_id = $1', [checkoutId])).rows[0];
}

/**
 * Decides what happens to a captured payment of a Live checkout. Safe to call any number of times
 * from anywhere; does nothing for other payments or once a decision is recorded.
 */
export async function settlePayment(ctx: Ctx, paymentId: string, opts: { submitError?: DomainError } = {}): Promise<Settlement | null> {
  const p = (await ctx.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId])).rows[0];
  if (!p?.checkout_id) return null;
  const c = await loadCheckout(ctx, p.checkout_id);
  if (!c || c.mode !== 'live') return null;
  const done = (await ctx.db.query<{ outcome: Settlement['outcome']; reason: string }>('SELECT outcome, reason FROM live_payment_settlements WHERE payment_id = $1', [p.id])).rows[0];
  const a = await attemptOf(ctx, c.id);
  const o = (await ctx.db.query<{ id: string; fulfillment_status: string; picked_up_at: string | null }>(
    'SELECT id, fulfillment_status, picked_up_at FROM orders WHERE checkout_id = $1', [c.id],
  )).rows[0];
  if (done) {
    // A delivery that appeared after its payment was refunded (late "not received"): Grab bills Unyly
    // for it, so a person has to look at it.
    if (done.outcome === 'refund_requested' && PRE_ORDER_REFUNDS.includes(done.reason) && o && o.fulfillment_status !== 'cancelled') {
      await recordSupport(ctx, p, c, 'order_found_after_refund', o.id);
      return { outcome: 'support', reason: 'order_found_after_refund' };
    }
    return done;
  }
  if (p.status !== 'captured') return null; // refunds and failures are handled by the payment itself

  if (!a) {
    if (c.status === 'approved' && !opts.submitError) return { outcome: 'wait', reason: 'not_submitted_yet' };
    const why = opts.submitError ? opts.submitError.code.toLowerCase() : `checkout_${c.status}`;
    return refundFull(ctx, p, c, 'order_not_placed', { detail: why });
  }
  if (a.status === 'in_flight' || a.status === 'unknown') return { outcome: 'wait', reason: 'submission_unknown' };
  if (a.status === 'rejected') {
    return refundFull(ctx, p, c, a.error_code === 'NOT_RECEIVED_BY_PROVIDER' ? 'order_not_received' : 'order_rejected', { detail: (a.error_code ?? '').toLowerCase() });
  }
  if (!o) return { outcome: 'wait', reason: 'order_pending' };
  if (o.fulfillment_status === 'delivered') {
    await record(ctx, p, c, 'kept', 'delivered', null);
    return { outcome: 'kept', reason: 'delivered' };
  }
  if (o.fulfillment_status === 'cancelled' || o.fulfillment_status === 'failed') {
    if (o.picked_up_at) {
      const reason = `${o.fulfillment_status}_after_pickup`;
      await recordSupport(ctx, p, c, reason, o.id);
      return { outcome: 'support', reason };
    }
    return refundFull(ctx, p, c, o.fulfillment_status === 'cancelled' ? 'delivery_cancelled' : 'delivery_failed', { orderId: o.id });
  }
  return { outcome: 'wait', reason: 'in_delivery' };
}

async function record(ctx: Ctx, p: PaymentRow, c: CheckoutRow, outcome: 'kept' | 'refund_requested' | 'support', reason: string, refundId: string | null) {
  const r = await ctx.db.query(
    `INSERT INTO live_payment_settlements (payment_id, checkout_id, outcome, reason, refund_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (payment_id) DO UPDATE SET outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, refund_id = COALESCE(EXCLUDED.refund_id, live_payment_settlements.refund_id), updated_at = now()
       WHERE live_payment_settlements.outcome <> 'support' AND EXCLUDED.outcome = 'support'
     RETURNING payment_id`,
    [p.id, c.id, outcome, reason, refundId],
  );
  return r.rowCount > 0;
}

async function recordSupport(ctx: Ctx, p: PaymentRow, c: CheckoutRow, reason: string, orderId?: string) {
  if (await record(ctx, p, c, 'support', reason, null)) {
    await audit(ctx.db, {
      userId: c.user_id, actor: 'system', action: 'order.payment_needs_support', mode: c.mode, entity: orderId ? 'order' : 'checkout', entityId: orderId ?? c.id,
      details: { payment_id: p.id, reason, amount_minor: Number(p.amount_minor), currency: p.currency },
    });
    if (ctx.cfg.env !== 'test') console.warn(JSON.stringify({ evt: 'live_payment_needs_support', payment_id: p.id, reason }));
  }
}

/** Full refund of what is left, idempotent per checkout and reason, and never a second automatic refund. */
async function refundFull(ctx: Ctx, p: PaymentRow, c: CheckoutRow, reason: string, extra: { orderId?: string; detail?: string } = {}): Promise<Settlement> {
  const open = (await ctx.db.query<RefundRow>(`SELECT * FROM payment_refunds WHERE payment_id = $1 AND status <> 'failed' ORDER BY created_at LIMIT 1`, [p.id])).rows[0];
  let refund: RefundRow | undefined = open;
  if (!refund) {
    try {
      refund = await refundPayment(ctx, p.id, undefined, reason, { key: `order:${c.id}:${reason}`, actor: 'system' });
    } catch (e) {
      // GrabPay not reachable before a refund row exists, or a concurrent refund: the worker tries again.
      await audit(ctx.db, { userId: c.user_id, actor: 'system', action: 'order.payment_refund_retry', mode: c.mode, entity: 'checkout', entityId: c.id, details: { payment_id: p.id, reason, error: isDomainError(e) ? e.code : 'error' } });
      return { outcome: 'wait', reason: 'refund_retry' };
    }
  }
  const inserted = await ctx.db.query(
    `INSERT INTO live_payment_settlements (payment_id, checkout_id, outcome, reason, refund_id) VALUES ($1,$2,'refund_requested',$3,$4) ON CONFLICT (payment_id) DO NOTHING RETURNING payment_id`,
    [p.id, c.id, reason, refund.id],
  );
  if (inserted.rowCount) {
    await audit(ctx.db, {
      userId: c.user_id, actor: 'system', action: 'order.payment_refund', mode: c.mode, entity: extra.orderId ? 'order' : 'checkout', entityId: extra.orderId ?? c.id,
      details: { payment_id: p.id, refund_id: refund.id, reason, detail: extra.detail, amount_minor: Number(refund.amount_minor), currency: p.currency, refund_status: refund.status },
    });
  }
  await syncOrderPayment(ctx.db, p.id);
  if (refund.status === 'failed') await recordSupport(ctx, p, c, 'refund_failed', extra.orderId);
  return { outcome: 'refund_requested', reason };
}

/** Settles the payment of one checkout, if it has a captured Live payment. Errors are logged, never thrown. */
export async function settleCheckout(ctx: Ctx, checkoutId: string): Promise<Settlement | null> {
  try {
    const p = (await ctx.db.query<{ id: string }>(`SELECT id FROM payments WHERE checkout_id = $1 AND status <> 'failed' ORDER BY created_at DESC LIMIT 1`, [checkoutId])).rows[0];
    return p ? await settlePayment(ctx, p.id) : null;
  } catch (e: any) {
    console.error('[live-payment] settle failed:', e?.message ?? e);
    return null;
  }
}

export async function settleOrder(ctx: Ctx, orderId: string) {
  const o = (await ctx.db.query<{ checkout_id: string; mode: string }>('SELECT checkout_id, mode FROM orders WHERE id = $1', [orderId])).rows[0];
  if (o?.mode === 'live') await settleCheckout(ctx, o.checkout_id);
}

/**
 * Worker: settle captured Live payments that need a decision (submission finished, delivery ended, or a
 * paid checkout that was never submitted), resubmitting a paid checkout whose captured hook did not get
 * to submit (crash). Returns how many payments were looked at.
 */
export async function settleLivePayments(ctx: Ctx, limit = 20): Promise<number> {
  const r = await ctx.db.query<{ id: string; checkout_id: string; captured_at: string | null; attempt: string | null; checkout_status: string }>(
    `SELECT p.id, p.checkout_id, p.captured_at, a.id AS attempt, c.status AS checkout_status
       FROM payments p JOIN checkouts c ON c.id = p.checkout_id
       LEFT JOIN live_payment_settlements s ON s.payment_id = p.id
       LEFT JOIN submission_attempts a ON a.checkout_id = c.id
       LEFT JOIN orders o ON o.checkout_id = c.id
      WHERE c.mode = 'live' AND p.status = 'captured' AND s.payment_id IS NULL
        AND (a.id IS NULL OR a.status = 'rejected' OR o.fulfillment_status IN ('delivered','cancelled','failed'))
      ORDER BY p.updated_at LIMIT $1`,
    [limit],
  );
  const now = ctx.clock.now().getTime();
  for (const row of r.rows) {
    try {
      if (!row.attempt && row.checkout_status === 'approved') {
        if (row.captured_at && now - new Date(row.captured_at).getTime() < RESUBMIT_AFTER_MS) continue; // the request path is still on it
        const c = await loadCheckout(ctx, row.checkout_id);
        if (c) await placePaidOrder(ctx, c, row.id);
        continue;
      }
      await settlePayment(ctx, row.id);
    } catch (e: any) {
      console.error(`[live-payment] settle ${row.id} failed:`, e?.message ?? e);
    }
  }
  // Refunded for "not received" but the delivery showed up later: hand to support.
  const late = await ctx.db.query<{ payment_id: string }>(
    `SELECT s.payment_id FROM live_payment_settlements s JOIN orders o ON o.checkout_id = s.checkout_id
      WHERE s.outcome = 'refund_requested' AND s.reason = ANY($2::text[]) AND o.fulfillment_status <> 'cancelled' LIMIT $1`,
    [limit, PRE_ORDER_REFUNDS],
  );
  for (const row of late.rows) await settlePayment(ctx, row.payment_id).catch((e: any) => console.error('[live-payment] late check failed:', e?.message ?? e));
  return r.rows.length;
}

/**
 * Worker: push refunds forward. Pending refunds (never reached GrabPay, or rate limited) are re-sent with
 * the same partnerTxID; processing or unknown ones are checked at most every 2 minutes; a refund GrabPay
 * refused is handed to support. Returns how many refunds were looked at.
 */
export async function retryPendingRefunds(ctx: Ctx, limit = 20): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - 2 * 60_000);
  const r = await ctx.db.query<{ payment_id: string }>(
    `SELECT DISTINCT ON (r.payment_id) r.payment_id, r.updated_at FROM payment_refunds r
      WHERE r.status = 'pending' OR (r.status IN ('processing','unknown') AND r.updated_at < $1)
      ORDER BY r.payment_id, r.updated_at LIMIT $2`,
    [cutoff, limit],
  );
  for (const row of r.rows) {
    try {
      await reconcile(ctx, row.payment_id, { force: true });
      await syncOrderPayment(ctx.db, row.payment_id);
    } catch (e: any) {
      console.error(`[live-payment] refund retry ${row.payment_id} failed:`, e?.message ?? e);
    }
  }
  const failed = await ctx.db.query<PaymentRow & { c_id: string }>(
    `SELECT p.*, c.id AS c_id FROM live_payment_settlements s JOIN payment_refunds r ON r.id = s.refund_id JOIN payments p ON p.id = s.payment_id
       JOIN checkouts c ON c.id = s.checkout_id
      WHERE s.outcome = 'refund_requested' AND r.status = 'failed' LIMIT $1`,
    [limit],
  );
  for (const p of failed.rows) {
    const c = await loadCheckout(ctx, p.c_id);
    if (c) await recordSupport(ctx, p, c, 'refund_failed');
  }
  return r.rows.length;
}
