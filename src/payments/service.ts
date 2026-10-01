// GrabPay One-time Charge payment state machine. Persisted in payments / payment_refunds /
// payment_events (migration 014). Card data never reaches Unyly: Grab hosts the checkout.
//
//   created ──init ok──► authorizing ──callback code, token ok──► authorized ──complete success──► captured
//      │                     │                                        │                             │
//      │ init 4xx            │ user error / declined                  │ complete failed /           ├─refund─► refunding ─► refunded (full)
//      ▼                     ▼                                        ▼ checkout no longer valid    │                    └► captured (partial)
//    failed ◄────────────── failed ◄──────────────────────────────── failed                        │
//      ▲                                                                                            │
//   unknown (init | token | complete timeout or 5xx) ──reconcile via one-time-charge status──► any of the above
//
// Rules: one non-failed payment per checkout (partial unique index); retries reuse the same
// partnerTxID; an unknown outcome is reconciled via the status endpoint before any new attempt;
// the amount always equals the checkout total; complete is only called while the checkout is
// still valid; the captured hook runs at most once per payment.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Ctx } from '../context.js';
import { audit } from '../context.js';
import type { Queryable } from '../db/db.js';
import { sha256 } from '../domain/crypto.js';
import { DomainError } from '../domain/errors.js';
import type { CheckoutRow } from '../services/checkout.js';
import type { GrabPayConfig, GrabPayCurrency } from './grabpay-config.js';
import {
  AuthSecrets, buildAuthorizeUrl, chargePartnerTxId, ChargeStatus, GrabPayOtcClient, GrabPayOutcomeUnknown, GrabPayRejected, GrabPayUnavailable,
  groupPartnerTxId, isGrabPayCurrency, newAuthSecrets, refundPartnerTxId, RefundStatus, verifyWebhookSignature,
} from './grabpay-otc.js';

export type PaymentStatus = 'created' | 'authorizing' | 'authorized' | 'captured' | 'failed' | 'refunding' | 'refunded' | 'unknown';

export interface PaymentRow {
  id: string;
  user_id: string | null;
  checkout_id: string | null;
  provider: 'grabpay';
  partner_tx_id: string;
  partner_group_tx_id: string;
  amount_minor: number;
  currency: GrabPayCurrency;
  status: PaymentStatus;
  unknown_stage: 'init' | 'token' | 'complete' | null;
  refunded_minor: number;
  grab_tx_id: string | null;
  payment_method: string | null;
  grab_reason: string | null;
  state_hash: string | null;
  auth_secrets_enc: string | null;
  access_token_enc: string | null;
  code_claimed_at: string | null;
  init_at: string | null;
  authorized_at: string | null;
  captured_at: string | null;
  failed_at: string | null;
  last_status_check_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  idem_key: string;
  partner_tx_id: string;
  amount_minor: number;
  reason: string;
  status: 'pending' | 'processing' | 'success' | 'failed' | 'unknown';
  grab_tx_id: string | null;
  grab_reason: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** The OTC request code is valid 20 minutes from init; reuse the redirect only well inside that. */
export const REQUEST_REUSE_MS = 18 * 60 * 1000;
/** A 'created' payment younger than this is an init call still in flight (another click or tab). */
export const INIT_IN_FLIGHT_MS = 30 * 1000;
/** Grab asks for at most one status poll every 2 minutes per transaction. */
export const STATUS_POLL_MIN_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Captured hook (registered by the order flow)
// ---------------------------------------------------------------------------------------------

export type PaymentCapturedHook = (ctx: Ctx, checkoutId: string, paymentId: string) => Promise<void>;

const hooks = new WeakMap<Ctx, PaymentCapturedHook>();

/**
 * Runs right before POST /charge/complete (the call that moves the money) for a payment that was
 * never completed. Returns null to proceed, or a short reason code: the payment is then failed
 * without completing, so the user is not charged (Grab releases the earmark). A thrown error counts
 * as the reason "precheck_failed".
 */
export type BeforeCompleteHook = (ctx: Ctx, checkoutId: string, paymentId: string) => Promise<string | null>;
const beforeCompleteHooks = new WeakMap<Ctx, BeforeCompleteHook>();

export function setBeforePaymentComplete(ctx: Ctx, hook: BeforeCompleteHook | null) {
  if (hook) beforeCompleteHooks.set(ctx, hook);
  else beforeCompleteHooks.delete(ctx);
}

/** Order-level payment status (providers/types PaymentStatus) for a GrabPay payment status. */
export function orderPaymentStatus(s: PaymentStatus): 'pending' | 'authorized' | 'captured' | 'refunded' | 'unknown' {
  switch (s) {
    case 'created':
    case 'authorizing':
      return 'pending';
    case 'authorized':
      return 'authorized';
    case 'captured':
    case 'refunding': // money is still with Unyly until the refund succeeds
      return 'captured';
    case 'refunded':
      return 'refunded';
    default:
      return 'unknown';
  }
}

/** Mirrors the payment status onto the order paid by it (orders.payment_id), if any. */
export async function syncOrderPayment(q: Queryable, paymentId: string) {
  const p = (await q.query<PaymentRow>('SELECT status FROM payments WHERE id = $1', [paymentId])).rows[0];
  if (!p) return;
  await q.query('UPDATE orders SET payment_status = $2 WHERE payment_id = $1 AND payment_status IS DISTINCT FROM $2', [paymentId, orderPaymentStatus(p.status)]);
}

/** Default: no order action, only an audit record that the payment was captured. */
const noopHook: PaymentCapturedHook = async (ctx, checkoutId, paymentId) => {
  await audit(ctx.db, { actor: 'system', action: 'payment.captured_hook_noop', entity: 'payment', entityId: paymentId, details: { checkout_id: checkoutId } });
};

/**
 * Registers what happens after a payment is captured (typically: approve the checkout and submit
 * the order). Called at most once per payment, after the capture is committed. If it throws, the
 * error is recorded in payment_events (outcome "error: ...") and the payment stays captured: the
 * caller decides whether to refund.
 */
export function setOnPaymentCaptured(ctx: Ctx, hook: PaymentCapturedHook | null) {
  if (hook) hooks.set(ctx, hook);
  else hooks.delete(ctx);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export function otcClient(ctx: Ctx): GrabPayOtcClient {
  return new GrabPayOtcClient(ctx.cfg.grabpay, { now: () => ctx.clock.now(), timeoutMs: ctx.cfg.providerTimeoutMs });
}

function requireEnabled(ctx: Ctx) {
  if (!ctx.cfg.grabpay?.enabled) throw new DomainError('CAPABILITY_UNAVAILABLE', 'GrabPay payments are not enabled.', { payment_error: 'GRABPAY_DISABLED' });
}

/** Refunds, reconciliation and webhooks keep working while new payments are switched off, as long as credentials exist. */
function requireCredentials(ctx: Ctx) {
  const g = ctx.cfg.grabpay;
  if (!g?.partnerId || !g.partnerSecret || !g.clientId || !g.clientSecret || !g.merchantId) {
    throw new DomainError('CAPABILITY_UNAVAILABLE', 'GrabPay credentials are not configured.', { payment_error: 'GRABPAY_NOT_CONFIGURED' });
  }
}

function encKey(cfg: GrabPayConfig): Buffer {
  return createHash('sha256').update(cfg.tokenKey || `unyly-grabpay-token-v1|${cfg.clientSecret}`).digest();
}

/** AES-256-GCM; output "v1.<base64url(iv | tag | ciphertext)>". */
export function sealSecret(cfg: GrabPayConfig, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(cfg), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

export function openSecret(cfg: GrabPayConfig, sealed: string): string {
  if (!sealed.startsWith('v1.')) throw new Error('unknown secret format');
  const b = Buffer.from(sealed.slice(3), 'base64url');
  const d = createDecipheriv('aes-256-gcm', encKey(cfg), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

type StoredSecrets = AuthSecrets & { request?: string };

const secretsOf = (ctx: Ctx, p: PaymentRow): StoredSecrets | null => (p.auth_secrets_enc ? JSON.parse(openSecret(ctx.cfg.grabpay, p.auth_secrets_enc)) : null);
const tokenOf = (ctx: Ctx, p: PaymentRow): string | null => (p.access_token_enc ? openSecret(ctx.cfg.grabpay, p.access_token_enc) : null);

/** Grab reason codes are short snake_case words; anything else is reduced to "unknown" before storing or showing it. */
const cleanReason = (r: unknown) => (typeof r === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(r) ? r : 'unknown');

const errText = (e: unknown) =>
  e instanceof GrabPayRejected ? `rejected:${e.status}:${cleanReason(e.reason)}` : e instanceof GrabPayOutcomeUnknown ? `unknown:${e.detail}` : e instanceof GrabPayUnavailable ? `unavailable:${e.detail}` : 'error';

async function loadPayment(q: Queryable, id: string, lock = false): Promise<PaymentRow> {
  const r = await q.query<PaymentRow>(`SELECT * FROM payments WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Payment not found');
  return r.rows[0];
}

/** Payment of one user (owner check). A foreign payment is reported as not found. */
export async function getPayment(ctx: Ctx, userId: string, paymentId: string): Promise<PaymentRow> {
  const p = await loadPayment(ctx.db, paymentId);
  if (p.user_id !== userId) throw new DomainError('NOT_FOUND', 'Payment not found');
  return p;
}

/** Latest payment for a checkout (any status), for the confirmation page and the order flow. */
export async function paymentForCheckout(ctx: Ctx, checkoutId: string): Promise<PaymentRow | null> {
  const r = await ctx.db.query<PaymentRow>('SELECT * FROM payments WHERE checkout_id = $1 ORDER BY (status <> \'failed\') DESC, created_at DESC LIMIT 1', [checkoutId]);
  return r.rows[0] ?? null;
}

async function setStatus(q: Queryable, ctx: Ctx, id: string, fields: Partial<Record<keyof PaymentRow, unknown>>, onlyFrom?: PaymentStatus[]): Promise<PaymentRow | null> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const where = onlyFrom ? ` AND status = ANY($2::text[])` : ' AND $2::text[] IS NULL';
  const r = await q.query<PaymentRow>(
    `UPDATE payments SET ${[...sets, `updated_at = $${keys.length + 3}`].join(', ')} WHERE id = $1${where} RETURNING *`,
    [id, onlyFrom ?? null, ...keys.map((k) => (fields as any)[k]), ctx.clock.now()],
  );
  return r.rows[0] ?? null;
}

function checkoutProblem(ctx: Ctx, c: CheckoutRow): string | null {
  if (!['awaiting_user', 'approved'].includes(c.status)) return `CHECKOUT_${c.status.toUpperCase()}`;
  // Live orders are paid only after the user approved them on the confirmation page (with step-up
  // for large totals): the payment never replaces that consent.
  if (c.mode === 'live' && c.status !== 'approved') return 'CONSENT_REQUIRED';
  if (new Date(c.expires_at).getTime() <= ctx.clock.now().getTime()) return 'CHECKOUT_EXPIRED';
  if (!isGrabPayCurrency(c.currency) || c.currency !== ctx.cfg.grabpay.currency) return 'CURRENCY_UNSUPPORTED';
  // Real money is never taken for a simulated order.
  if (ctx.cfg.grabpay.env === 'production' && c.mode === 'demo') return 'DEMO_MODE';
  return null;
}

function problemError(problem: string): DomainError {
  if (problem === 'CHECKOUT_EXPIRED') return new DomainError('CONFIRMATION_EXPIRED', 'The confirmation expired. Prepare a new checkout.', { payment_error: problem });
  if (problem === 'CONSENT_REQUIRED') return new DomainError('CONFIRMATION_REQUIRED', 'Confirm the order on the Unyly confirmation page first; the payment starts from there.', { payment_error: problem });
  if (problem === 'CURRENCY_UNSUPPORTED' || problem === 'DEMO_MODE') return new DomainError('CAPABILITY_UNAVAILABLE', 'GrabPay cannot be used for this order.', { payment_error: problem });
  return new DomainError('CONFIRMATION_INVALIDATED', 'This confirmation can no longer be paid.', { payment_error: problem });
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

export interface StartResult {
  paymentId: string;
  status: PaymentStatus;
  /** Grab authorize URL to send the browser to; null when the checkout is already paid. */
  redirectUrl: string | null;
}

/**
 * Starts (or resumes) the GrabPay payment for a checkout owned by userId and awaiting the user.
 * `expectedAmountMinor` is the total the user saw; any difference is refused (PRICE_CHANGED).
 * Never creates a second live payment for the checkout: an existing one is resumed (same
 * partnerTxID and redirect), reconciled first when its outcome is unknown, or reported as paid.
 */
export async function startPayment(ctx: Ctx, userId: string, checkoutId: string, opts: { expectedAmountMinor?: number } = {}): Promise<StartResult> {
  requireEnabled(ctx);
  requireCredentials(ctx);
  let reconciled = false;
  for (let round = 0; round < 3; round++) {
    const step = await ctx.db.tx(async (q) => {
      const c = (await q.query<CheckoutRow>('SELECT * FROM checkouts WHERE id = $1 AND user_id = $2 FOR UPDATE', [checkoutId, userId])).rows[0];
      if (!c) throw new DomainError('NOT_FOUND', 'Checkout not found');
      if (opts.expectedAmountMinor !== undefined && opts.expectedAmountMinor !== Number(c.total_minor)) {
        throw new DomainError('PRICE_CHANGED', 'The amount does not match the order total; please review again.', { payment_error: 'AMOUNT_MISMATCH' });
      }
      const existing = (await q.query<PaymentRow>(`SELECT * FROM payments WHERE checkout_id = $1 AND status <> 'failed' FOR UPDATE`, [c.id])).rows[0];
      if (existing && ['captured', 'refunding', 'refunded'].includes(existing.status)) return { kind: 'paid' as const, p: existing };
      const problem = checkoutProblem(ctx, c);
      if (problem && !(existing && ['authorized', 'unknown'].includes(existing.status))) throw problemError(problem);
      if (existing) {
        if (Number(existing.amount_minor) !== Number(c.total_minor) || existing.currency !== c.currency) {
          throw new DomainError('PRICE_CHANGED', 'The amount does not match the order total.', { payment_error: 'AMOUNT_MISMATCH' });
        }
        return { kind: 'existing' as const, p: existing };
      }
      const id = randomUUID();
      const secrets = newAuthSecrets();
      const r = await q.query<PaymentRow>(
        `INSERT INTO payments (id, user_id, checkout_id, partner_tx_id, partner_group_tx_id, amount_minor, currency, status, state_hash, auth_secrets_enc, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'created',$8,$9,$10,$10) RETURNING *`,
        [id, userId, c.id, chargePartnerTxId(id), groupPartnerTxId(c.id), c.total_minor, c.currency, sha256(secrets.state), sealSecret(ctx.cfg.grabpay, JSON.stringify(secrets)), ctx.clock.now()],
      );
      await audit(q, { userId, actor: 'web', action: 'payment.created', mode: c.mode, entity: 'payment', entityId: id, details: { checkout_id: c.id, amount_minor: Number(c.total_minor), currency: c.currency } });
      return { kind: 'new' as const, p: r.rows[0] };
    });

    const p = step.p;
    if (step.kind === 'paid') return { paymentId: p.id, status: p.status, redirectUrl: null };
    if (step.kind === 'new') return initCharge(ctx, p);
    const now = ctx.clock.now().getTime();
    switch (p.status) {
      case 'authorizing': {
        const s = secretsOf(ctx, p);
        if (s?.request && p.init_at && now - new Date(p.init_at).getTime() < REQUEST_REUSE_MS && !p.code_claimed_at) {
          return { paymentId: p.id, status: p.status, redirectUrl: buildAuthorizeUrl(ctx.cfg.grabpay, { request: s.request, currency: p.currency, secrets: s }) };
        }
        break; // request code expired or a callback is being processed: ask Grab
      }
      case 'created':
        if (reconciled || now - new Date(p.updated_at).getTime() >= INIT_IN_FLIGHT_MS) {
          if (reconciled) return initCharge(ctx, p); // Grab confirmed it has no record: same partnerTxID again
          break;
        }
        throw new DomainError('PROVIDER_UNAVAILABLE', 'A payment for this order is being started. Try again in a few seconds.', { payment_error: 'PAYMENT_IN_PROGRESS', payment_id: p.id });
      case 'authorized': {
        const done = await completePayment(ctx, p.id);
        return { paymentId: p.id, status: done.status, redirectUrl: null };
      }
      case 'unknown':
        break;
    }
    if (reconciled) {
      throw new DomainError('SUBMISSION_UNKNOWN', 'We are still confirming the previous payment attempt with GrabPay. Do not pay again; check back in a few minutes.', { payment_error: 'PAYMENT_UNKNOWN', payment_id: p.id });
    }
    await reconcile(ctx, p.id, { force: true });
    reconciled = true;
  }
  throw new DomainError('SUBMISSION_UNKNOWN', 'The payment state is still being confirmed. Try again shortly.', { payment_error: 'PAYMENT_UNKNOWN' });
}

async function initCharge(ctx: Ctx, p: PaymentRow): Promise<StartResult> {
  const client = otcClient(ctx);
  const secrets = secretsOf(ctx, p)!;
  try {
    const r = await client.initCharge({
      partnerTxID: p.partner_tx_id, partnerGroupTxID: p.partner_group_tx_id, amountMinor: Number(p.amount_minor), currency: p.currency,
      description: `Unyly order ${p.partner_group_tx_id.slice(0, 8)}`,
    });
    const stored: StoredSecrets = { ...secrets, request: r.request };
    const u = await setStatus(ctx.db, ctx, p.id, { status: 'authorizing', unknown_stage: null, init_at: ctx.clock.now(), auth_secrets_enc: sealSecret(ctx.cfg.grabpay, JSON.stringify(stored)), last_error: null }, ['created', 'unknown']);
    if (!u) return { paymentId: p.id, status: (await loadPayment(ctx.db, p.id)).status, redirectUrl: null };
    return { paymentId: p.id, status: 'authorizing', redirectUrl: buildAuthorizeUrl(ctx.cfg.grabpay, { request: r.request, currency: p.currency, secrets: stored }) };
  } catch (e) {
    if (e instanceof GrabPayRejected && e.reason === 'transaction_already_exists') {
      // A previous init with this partnerTxID did land: its request code is lost, reconcile decides.
      await setStatus(ctx.db, ctx, p.id, { status: 'unknown', unknown_stage: 'init', last_error: errText(e) }, ['created', 'unknown']);
      throw new DomainError('SUBMISSION_UNKNOWN', 'We are confirming an earlier payment attempt with GrabPay. Try again in a few minutes.', { payment_error: 'PAYMENT_UNKNOWN', payment_id: p.id });
    }
    if (e instanceof GrabPayRejected || e instanceof GrabPayUnavailable) {
      await failPayment(ctx, p.id, e instanceof GrabPayRejected ? cleanReason(e.reason) : 'init_unavailable', errText(e), ['created', 'unknown']);
      throw e instanceof GrabPayRejected
        ? new DomainError('PROVIDER_REJECTED', 'GrabPay did not accept the payment request. Nothing was charged.', { payment_error: 'INIT_REJECTED', reason: cleanReason(e.reason) })
        : new DomainError('PROVIDER_UNAVAILABLE', 'GrabPay is unavailable right now. Nothing was charged; try again later.', { payment_error: 'GRABPAY_UNAVAILABLE' });
    }
    await setStatus(ctx.db, ctx, p.id, { status: 'unknown', unknown_stage: 'init', last_error: errText(e) }, ['created', 'unknown']);
    throw new DomainError('SUBMISSION_UNKNOWN', 'We could not confirm that GrabPay received the payment request. Nothing is charged without your approval in Grab; try again in a few minutes.', { payment_error: 'PAYMENT_UNKNOWN', payment_id: p.id });
  }
}

async function failPayment(ctx: Ctx, id: string, reason: string, lastError: string | null, from: PaymentStatus[]) {
  const u = await setStatus(ctx.db, ctx, id, { status: 'failed', unknown_stage: null, grab_reason: reason, failed_at: ctx.clock.now(), last_error: lastError }, from);
  if (u) await audit(ctx.db, { userId: u.user_id, actor: 'system', action: 'payment.failed', entity: 'payment', entityId: id, details: { reason } });
  return u;
}

// ---------------------------------------------------------------------------------------------
// Callback, token, complete
// ---------------------------------------------------------------------------------------------

export interface CallbackResult {
  outcome: 'captured' | 'pending' | 'failed';
  paymentId: string;
  checkoutId: string | null;
  amountMinor: number;
  currency: string;
  reason?: string;
  /** True when the callback repeated an already finished payment (nothing was done). */
  duplicate?: boolean;
}

const resultOf = (p: PaymentRow, extra: Partial<CallbackResult> = {}): CallbackResult => ({
  outcome: ['captured', 'refunding', 'refunded'].includes(p.status) ? 'captured' : p.status === 'failed' ? 'failed' : 'pending',
  paymentId: p.id,
  checkoutId: p.checkout_id,
  amountMinor: Number(p.amount_minor),
  currency: p.currency,
  reason: p.status === 'failed' ? p.grab_reason ?? undefined : undefined,
  ...extra,
});

/**
 * Handles GET /pay/grab/callback?code&state (or ?error&state) for the signed-in user. The state
 * identifies the payment and must belong to this user. Idempotent: a repeated callback returns
 * the current result without calling Grab or the hook again.
 */
export async function handleCallback(ctx: Ctx, userId: string, query: { code?: unknown; state?: unknown; error?: unknown }): Promise<CallbackResult> {
  requireEnabled(ctx);
  const state = typeof query.state === 'string' && query.state.length <= 256 ? query.state : '';
  if (!state) throw new DomainError('VALIDATION_FAILED', 'Missing state');
  const found = (await ctx.db.query<PaymentRow>('SELECT * FROM payments WHERE state_hash = $1', [sha256(state)])).rows[0];
  if (!found || found.user_id !== userId) throw new DomainError('NOT_FOUND', 'Payment not found');
  let p = found;
  if (typeof query.error === 'string' && query.error) {
    const reason = cleanReason(query.error);
    if (p.status === 'authorizing' || p.status === 'created') {
      p = (await failPayment(ctx, p.id, reason, `redirect_error:${reason}`, ['authorizing', 'created'])) ?? (await loadPayment(ctx.db, p.id));
    }
    return resultOf(p);
  }
  const code = typeof query.code === 'string' && query.code.length > 0 && query.code.length <= 2048 ? query.code : '';
  if (!code) throw new DomainError('VALIDATION_FAILED', 'Missing code');
  if (p.status !== 'authorizing') {
    if (p.status === 'authorized') return resultOf(await completePayment(ctx, p.id), { duplicate: true });
    return resultOf(p, { duplicate: true });
  }
  // Claim the code: only one request redeems it, concurrent duplicates see "pending".
  const claimed = (await ctx.db.query<PaymentRow>(
    `UPDATE payments SET code_claimed_at = $2, updated_at = $2 WHERE id = $1 AND status = 'authorizing' AND code_claimed_at IS NULL RETURNING *`,
    [p.id, ctx.clock.now()],
  )).rows[0];
  if (!claimed) return resultOf(await loadPayment(ctx.db, p.id), { duplicate: true });
  p = await redeemCode(ctx, claimed, code);
  if (p.status === 'authorized') p = await completePayment(ctx, p.id);
  return resultOf(p);
}

/** code -> access token (stored encrypted). Leaves the payment authorized, failed or unknown(token). */
async function redeemCode(ctx: Ctx, p: PaymentRow, code: string): Promise<PaymentRow> {
  const s = secretsOf(ctx, p);
  if (!s) return (await failPayment(ctx, p.id, 'missing_verifier', null, ['authorizing', 'unknown'])) ?? p;
  try {
    const t = await otcClient(ctx).exchangeCode({ code, codeVerifier: s.codeVerifier });
    const u = await setStatus(ctx.db, ctx, p.id, { status: 'authorized', unknown_stage: null, access_token_enc: sealSecret(ctx.cfg.grabpay, t.accessToken), authorized_at: ctx.clock.now(), last_error: null }, ['authorizing', 'unknown']);
    return u ?? (await loadPayment(ctx.db, p.id));
  } catch (e) {
    if (e instanceof GrabPayRejected) {
      // Code refused (expired, already used): the earmark is released by Grab after auth_expired.
      return (await failPayment(ctx, p.id, 'token_rejected', errText(e), ['authorizing', 'unknown'])) ?? (await loadPayment(ctx.db, p.id));
    }
    return (await setStatus(ctx.db, ctx, p.id, { status: 'unknown', unknown_stage: 'token', last_error: errText(e) }, ['authorizing', 'unknown'])) ?? (await loadPayment(ctx.db, p.id));
  }
}

/**
 * POST /charge/complete for an authorized payment: this is the call that moves the money. Only
 * done while the checkout is still payable and its total equals the payment amount; otherwise
 * the payment is failed without completing (Grab releases the earmark on auth expiry).
 * Repeating is safe: Grab returns the latest status for a used partnerTxID.
 */
export async function completePayment(ctx: Ctx, paymentId: string): Promise<PaymentRow> {
  requireCredentials(ctx);
  let p = await loadPayment(ctx.db, paymentId);
  const neverCompleted = p.status === 'authorized';
  if (!(neverCompleted || (p.status === 'unknown' && p.unknown_stage === 'complete'))) return p;
  if (neverCompleted) {
    const c = p.checkout_id ? (await ctx.db.query<CheckoutRow>('SELECT * FROM checkouts WHERE id = $1', [p.checkout_id])).rows[0] : undefined;
    const problem = !c ? 'CHECKOUT_MISSING' : Number(c.total_minor) !== Number(p.amount_minor) || c.currency !== p.currency ? 'AMOUNT_MISMATCH' : checkoutProblem(ctx, c);
    if (problem) return (await failPayment(ctx, p.id, problem.toLowerCase(), 'not completed: checkout no longer payable', ['authorized'])) ?? (await loadPayment(ctx.db, p.id));
    const before = beforeCompleteHooks.get(ctx);
    if (before && p.checkout_id) {
      let veto: string | null;
      try {
        veto = await before(ctx, p.checkout_id, p.id);
      } catch {
        veto = 'precheck_failed';
      }
      if (veto) return (await failPayment(ctx, p.id, cleanReason(veto), `not completed: ${cleanReason(veto)}`, ['authorized'])) ?? (await loadPayment(ctx.db, p.id));
      p = await loadPayment(ctx.db, p.id);
      if (p.status !== 'authorized') return p; // a concurrent callback or reconcile moved it on
    }
  }
  const token = tokenOf(ctx, p);
  if (!token) return (await failPayment(ctx, p.id, 'missing_token', null, ['authorized'])) ?? p;
  let r: ChargeStatus;
  try {
    r = await otcClient(ctx).completeCharge({ partnerTxID: p.partner_tx_id, accessToken: token });
  } catch (e) {
    if (e instanceof GrabPayUnavailable) return p; // not processed (429): stays as is, retried by the next callback / reconcile
    if (e instanceof GrabPayRejected && neverCompleted) return (await failPayment(ctx, p.id, cleanReason(e.reason), errText(e), ['authorized'])) ?? p;
    return (await setStatus(ctx.db, ctx, p.id, { status: 'unknown', unknown_stage: 'complete', last_error: errText(e) }, ['authorized', 'unknown'])) ?? (await loadPayment(ctx.db, p.id));
  }
  p = await applyChargeStatus(ctx, p, r, 'complete');
  return p;
}

/** Applies a charge status (from complete, the status endpoint or a webhook) to the payment. */
async function applyChargeStatus(ctx: Ctx, p: PaymentRow, r: ChargeStatus, source: 'complete' | 'status' | 'webhook'): Promise<PaymentRow> {
  const tx = r.txStatus ?? '';
  if (tx === 'success' && p.status === 'failed') {
    // Grab reports money moved for a payment we gave up on: never silently ignore it.
    await ctx.db.query('UPDATE payments SET last_error = $2, grab_tx_id = COALESCE(grab_tx_id, $3), updated_at = $4 WHERE id = $1', [p.id, `captured_after_failure:${source}`, r.txID ?? null, ctx.clock.now()]);
    await audit(ctx.db, { userId: p.user_id, actor: 'system', action: 'payment.captured_after_failure', entity: 'payment', entityId: p.id, details: { source, needs: 'manual_refund' } });
    return loadPayment(ctx.db, p.id);
  }
  if (tx === 'success') return markCaptured(ctx, p, r);
  if (['failed', 'cancelled', 'authorisation_declined'].includes(tx)) {
    return (await failPayment(ctx, p.id, cleanReason(r.reason ?? tx), `${source}:${tx}`, ['created', 'authorizing', 'authorized', 'unknown'])) ?? (await loadPayment(ctx.db, p.id));
  }
  if (source === 'complete') {
    // processing / authorised after complete: money movement not final yet.
    return (await setStatus(ctx.db, ctx, p.id, { status: 'unknown', unknown_stage: 'complete', last_error: `complete:${cleanReason(tx || 'empty')}` }, ['authorized', 'unknown'])) ?? (await loadPayment(ctx.db, p.id));
  }
  return p;
}

async function markCaptured(ctx: Ctx, p: PaymentRow, r: ChargeStatus): Promise<PaymentRow> {
  const u = await setStatus(ctx.db, ctx, p.id, {
    status: 'captured', unknown_stage: null, grab_tx_id: r.txID ?? p.grab_tx_id, payment_method: r.paymentMethod ?? p.payment_method, captured_at: ctx.clock.now(), last_error: null, grab_reason: null,
  }, ['created', 'authorizing', 'authorized', 'unknown']);
  if (!u) return loadPayment(ctx.db, p.id);
  await audit(ctx.db, { userId: u.user_id, actor: 'system', action: 'payment.captured', entity: 'payment', entityId: u.id, details: { checkout_id: u.checkout_id, amount_minor: Number(u.amount_minor), currency: u.currency } });
  await runCapturedHook(ctx, u);
  return loadPayment(ctx.db, p.id);
}

async function runCapturedHook(ctx: Ctx, p: PaymentRow) {
  if (!p.checkout_id) return;
  const claim = await ctx.db.query(
    `INSERT INTO payment_events (payment_id, source, event_key, outcome) VALUES ($1, 'internal', $2, 'running') ON CONFLICT (event_key) DO NOTHING RETURNING id`,
    [p.id, `hook:captured:${p.id}`],
  );
  if (!claim.rows[0]) return; // already ran (or is running) for this payment
  const hook = hooks.get(ctx) ?? noopHook;
  let outcome = 'ok';
  try {
    await hook(ctx, p.checkout_id, p.id);
  } catch (e) {
    outcome = `error: ${e instanceof Error ? e.message.slice(0, 200) : 'hook failed'}`;
  }
  await ctx.db.query('UPDATE payment_events SET outcome = $2 WHERE id = $1', [claim.rows[0].id, outcome]);
}

// ---------------------------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------------------------

/**
 * Resolves an open or unknown payment from Grab's one-time-charge status (HMAC). Honors Grab's
 * limit of one status poll per 2 minutes unless `force`. Also finishes a payment whose redirect
 * was lost (status authorised + oAuthCode) and checks pending refunds.
 */
export async function reconcile(ctx: Ctx, paymentId: string, opts: { force?: boolean } = {}): Promise<PaymentRow> {
  requireCredentials(ctx);
  let p = await loadPayment(ctx.db, paymentId);
  if (p.status === 'refunding') {
    await reconcileRefunds(ctx, p);
    return loadPayment(ctx.db, p.id);
  }
  if (['captured', 'failed', 'refunded'].includes(p.status)) return p;
  const now = ctx.clock.now();
  if (!opts.force && p.last_status_check_at && now.getTime() - new Date(p.last_status_check_at).getTime() < STATUS_POLL_MIN_MS) return p;
  await ctx.db.query('UPDATE payments SET last_status_check_at = $2 WHERE id = $1', [p.id, now]);
  let st: ChargeStatus | null;
  try {
    st = await otcClient(ctx).chargeStatus({ partnerTxID: p.partner_tx_id, currency: p.currency });
  } catch (e) {
    await ctx.db.query('UPDATE payments SET last_error = $2 WHERE id = $1', [p.id, `status:${errText(e)}`]);
    return loadPayment(ctx.db, p.id);
  }
  if (!st) {
    // Grab has no record of this partnerTxID: init never landed. Retryable with the same partnerTxID.
    if (p.status === 'created' || (p.status === 'unknown' && p.unknown_stage === 'init')) {
      return (await setStatus(ctx.db, ctx, p.id, { status: 'created', unknown_stage: null, last_error: 'status:no_record' }, ['created', 'unknown'])) ?? (await loadPayment(ctx.db, p.id));
    }
    await ctx.db.query('UPDATE payments SET last_error = $2 WHERE id = $1', [p.id, 'status:no_record']);
    return loadPayment(ctx.db, p.id);
  }
  const tx = st.txStatus ?? '';
  if (tx === 'success' || ['failed', 'cancelled', 'authorisation_declined'].includes(tx)) return applyChargeStatus(ctx, p, st, 'status');
  if (tx === 'authorised') {
    if (p.status === 'unknown' && p.unknown_stage === 'complete') return completePayment(ctx, p.id);
    if (p.status === 'authorized') return completePayment(ctx, p.id);
    if (st.oAuthCode && (p.status === 'authorizing' || (p.status === 'unknown' && p.unknown_stage === 'token'))) {
      // Lost redirect (or lost token response): finish the flow from the status oAuthCode.
      p = await redeemCode(ctx, p, st.oAuthCode);
      if (p.status === 'authorized') p = await completePayment(ctx, p.id);
      return p;
    }
    return p;
  }
  // processing (pending consent, authorising, capturing) or an unrecognised value
  if (p.status === 'created' || (p.status === 'unknown' && p.unknown_stage === 'init')) {
    // The init landed but its response (the request code) was lost: nobody can approve it, it expires.
    return (await failPayment(ctx, p.id, 'init_response_lost', `status:${cleanReason(tx || 'empty')}`, ['created', 'unknown'])) ?? (await loadPayment(ctx.db, p.id));
  }
  if (p.status === 'authorizing' && p.init_at && now.getTime() - new Date(p.init_at).getTime() > 25 * 60 * 1000 && st.reason === 'pending_user_consent') {
    return (await failPayment(ctx, p.id, 'session_expired', `status:${cleanReason(st.reason)}`, ['authorizing'])) ?? p;
  }
  await ctx.db.query('UPDATE payments SET last_error = $2 WHERE id = $1', [p.id, `status:${cleanReason(tx || 'empty')}:${cleanReason(st.reason ?? '')}`]);
  return loadPayment(ctx.db, p.id);
}

/** For a background job: reconcile payments that are unknown, stuck or refunding. */
export async function reconcileOpenPayments(ctx: Ctx, limit = 20): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - STATUS_POLL_MIN_MS);
  const r = await ctx.db.query<{ id: string }>(
    `SELECT id FROM payments WHERE status IN ('created','authorizing','authorized','unknown','refunding')
       AND updated_at < $1 AND (last_status_check_at IS NULL OR last_status_check_at < $1)
     ORDER BY updated_at LIMIT $2`,
    [cutoff, limit],
  );
  for (const row of r.rows) await reconcile(ctx, row.id).catch(() => undefined);
  return r.rows.length;
}

// ---------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------

const REASON_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;

/**
 * Refunds a captured payment, fully (amountMinor undefined: everything not yet refunded) or
 * partially. Idempotent per `key` (default: amount + reason): the same call returns the same
 * refund, and an unfinished one is re-sent with the same partnerTxID (Grab returns its latest
 * status). Grab does not support concurrent refunds, so a new refund waits for the previous one.
 */
export async function refundPayment(
  ctx: Ctx, paymentId: string, amountMinor: number | undefined, reason: string, opts: { key?: string; actor?: string } = {},
): Promise<RefundRow> {
  requireCredentials(ctx);
  if (!REASON_RE.test(reason)) throw new DomainError('VALIDATION_FAILED', 'reason must be a short code like delivery_cancelled');
  if (amountMinor !== undefined && !(Number.isSafeInteger(amountMinor) && amountMinor > 0)) throw new DomainError('VALIDATION_FAILED', 'amount must be a positive integer in minor units');
  const key = opts.key ?? `${amountMinor ?? 'full'}:${reason}`;
  if (key.length > 128) throw new DomainError('VALIDATION_FAILED', 'key too long');
  const refund = await ctx.db.tx(async (q) => {
    const p = await loadPayment(q, paymentId, true);
    const same = (await q.query<RefundRow>('SELECT * FROM payment_refunds WHERE payment_id = $1 AND idem_key = $2', [p.id, key])).rows[0];
    if (same) return same;
    if (!['captured', 'refunding'].includes(p.status)) {
      throw new DomainError('CANCELLATION_NOT_ALLOWED', `Payment is ${p.status}; only a captured payment can be refunded.`, { payment_error: 'REFUND_NOT_ALLOWED' });
    }
    const open = (await q.query<RefundRow>(`SELECT * FROM payment_refunds WHERE payment_id = $1 AND status IN ('pending','processing','unknown')`, [p.id])).rows;
    if (open.length) throw new DomainError('CANCELLATION_UNKNOWN', 'A previous refund for this payment is still being processed.', { payment_error: 'REFUND_IN_PROGRESS', refund_id: open[0].id });
    const remaining = Number(p.amount_minor) - Number(p.refunded_minor);
    const amount = amountMinor ?? remaining;
    if (amount <= 0 || amount > remaining) {
      throw new DomainError('VALIDATION_FAILED', `Refund exceeds the refundable amount (${remaining}).`, { payment_error: 'REFUND_EXCEEDS', refundable_minor: remaining });
    }
    const id = randomUUID();
    const r = await q.query<RefundRow>(
      `INSERT INTO payment_refunds (id, payment_id, idem_key, partner_tx_id, amount_minor, reason, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$7) RETURNING *`,
      [id, p.id, key, refundPartnerTxId(p.id, key), amount, reason, ctx.clock.now()],
    );
    await q.query(`UPDATE payments SET status = 'refunding', updated_at = $2 WHERE id = $1`, [p.id, ctx.clock.now()]);
    await audit(q, { userId: p.user_id, actor: opts.actor ?? 'system', action: 'payment.refund_requested', entity: 'payment', entityId: p.id, details: { refund_id: id, amount_minor: amount, reason } });
    return r.rows[0];
  });
  if (['success', 'failed'].includes(refund.status)) return refund;
  return sendRefund(ctx, refund);
}

async function sendRefund(ctx: Ctx, refund: RefundRow): Promise<RefundRow> {
  const p = await loadPayment(ctx.db, refund.payment_id);
  const token = tokenOf(ctx, p);
  if (!token) return finishRefund(ctx, refund.id, 'failed', { grab_reason: 'missing_token' });
  let r: RefundStatus;
  try {
    r = await otcClient(ctx).refund({
      partnerTxID: refund.partner_tx_id, partnerGroupTxID: p.partner_group_tx_id, amountMinor: Number(refund.amount_minor), currency: p.currency,
      originTxID: p.grab_tx_id ?? undefined, description: `Refund ${refund.reason}`.slice(0, 255), accessToken: token,
    });
  } catch (e) {
    if (e instanceof GrabPayRejected) return finishRefund(ctx, refund.id, 'failed', { grab_reason: cleanReason(e.reason), last_error: errText(e) });
    if (e instanceof GrabPayUnavailable) return touchRefund(ctx, refund.id, 'pending', errText(e));
    return touchRefund(ctx, refund.id, 'unknown', errText(e));
  }
  return applyRefundStatus(ctx, refund.id, r);
}

async function touchRefund(ctx: Ctx, id: string, status: RefundRow['status'], lastError: string | null): Promise<RefundRow> {
  const r = await ctx.db.query<RefundRow>(`UPDATE payment_refunds SET status = $2, last_error = $3, updated_at = $4 WHERE id = $1 AND status NOT IN ('success','failed') RETURNING *`, [id, status, lastError, ctx.clock.now()]);
  return r.rows[0] ?? (await ctx.db.query<RefundRow>('SELECT * FROM payment_refunds WHERE id = $1', [id])).rows[0];
}

async function applyRefundStatus(ctx: Ctx, refundId: string, r: RefundStatus): Promise<RefundRow> {
  const tx = r.txStatus ?? '';
  if (tx === 'success') return finishRefund(ctx, refundId, 'success', { grab_tx_id: r.txID ?? null, grab_reason: null });
  if (tx === 'failed') return finishRefund(ctx, refundId, 'failed', { grab_reason: cleanReason(r.reason ?? 'failed') });
  return touchRefund(ctx, refundId, 'processing', `refund:${cleanReason(tx || 'empty')}:${cleanReason(r.reason ?? '')}`);
}

/** Final refund state; on success adds to refunded_minor exactly once (transition guarded by status). */
async function finishRefund(ctx: Ctx, refundId: string, status: 'success' | 'failed', f: { grab_tx_id?: string | null; grab_reason?: string | null; last_error?: string | null }): Promise<RefundRow> {
  return ctx.db.tx(async (q) => {
    const cur = (await q.query<RefundRow>('SELECT * FROM payment_refunds WHERE id = $1 FOR UPDATE', [refundId])).rows[0];
    if (['success', 'failed'].includes(cur.status)) return cur;
    const p = await loadPayment(q, cur.payment_id, true);
    const now = ctx.clock.now();
    const u = (await q.query<RefundRow>(
      `UPDATE payment_refunds SET status = $2, grab_tx_id = COALESCE($3, grab_tx_id), grab_reason = $4, last_error = $5, updated_at = $6 WHERE id = $1 RETURNING *`,
      [refundId, status, f.grab_tx_id ?? null, f.grab_reason ?? null, f.last_error ?? null, now],
    )).rows[0];
    const refunded = Number(p.refunded_minor) + (status === 'success' ? Number(cur.amount_minor) : 0);
    const stillOpen = (await q.query(`SELECT 1 FROM payment_refunds WHERE payment_id = $1 AND id <> $2 AND status IN ('pending','processing','unknown')`, [p.id, refundId])).rows.length > 0;
    const next: PaymentStatus = refunded >= Number(p.amount_minor) ? 'refunded' : stillOpen ? 'refunding' : 'captured';
    await q.query('UPDATE payments SET refunded_minor = $2, status = $3, updated_at = $4 WHERE id = $1', [p.id, refunded, next, now]);
    await syncOrderPayment(q, p.id);
    await audit(q, { userId: p.user_id, actor: 'system', action: status === 'success' ? 'payment.refunded' : 'payment.refund_failed', entity: 'payment', entityId: p.id, details: { refund_id: refundId, amount_minor: Number(cur.amount_minor), reason: f.grab_reason ?? undefined } });
    return u;
  });
}

async function reconcileRefunds(ctx: Ctx, p: PaymentRow) {
  const open = (await ctx.db.query<RefundRow>(`SELECT * FROM payment_refunds WHERE payment_id = $1 AND status IN ('pending','processing','unknown') ORDER BY created_at`, [p.id])).rows;
  const token = tokenOf(ctx, p);
  for (const rf of open) {
    if (rf.status === 'pending') {
      await sendRefund(ctx, rf); // never reached Grab (or 429): send again, same partnerTxID
      continue;
    }
    if (!token) continue;
    try {
      const st = await otcClient(ctx).refundStatus({ partnerTxID: rf.partner_tx_id, currency: p.currency, accessToken: token });
      if (st) await applyRefundStatus(ctx, rf.id, st);
      else await sendRefund(ctx, rf); // Grab has no record: the refund never landed, re-send with the same partnerTxID
    } catch (e) {
      await ctx.db.query('UPDATE payment_refunds SET last_error = $2 WHERE id = $1', [rf.id, `status:${errText(e)}`]);
    }
  }
}

export async function listRefunds(ctx: Ctx, paymentId: string): Promise<RefundRow[]> {
  return (await ctx.db.query<RefundRow>('SELECT * FROM payment_refunds WHERE payment_id = $1 ORDER BY created_at', [paymentId])).rows;
}

// ---------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------

export interface WebhookResult { duplicate?: boolean; outcome: string }

/**
 * POST /webhooks/grabpay. Verifies the request HMAC (partner_secret, received Date within 5 min,
 * our path, raw body), deduplicates by event key and applies Charge / Refund results. Signature
 * failures throw AUTH_REQUIRED (401). Unknown transactions are acknowledged and recorded.
 */
export async function handleGrabPayWebhook(ctx: Ctx, req: { path: string; headers: Record<string, string | string[] | undefined>; rawBody: string }): Promise<WebhookResult> {
  requireCredentials(ctx);
  const check = verifyWebhookSignature(ctx.cfg.grabpay, { method: 'POST', path: req.path, headers: req.headers, rawBody: req.rawBody }, ctx.clock.now());
  if (!check.ok) throw new DomainError('AUTH_REQUIRED', `Invalid webhook signature (${check.reason})`);
  let b: any;
  try {
    b = JSON.parse(req.rawBody);
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'Webhook body is not JSON');
  }
  const partnerTxID = typeof b?.partnerTxID === 'string' ? b.partnerTxID : '';
  const txType = typeof b?.txType === 'string' ? b.txType : '';
  const txStatus = typeof b?.txStatus === 'string' ? b.txStatus : '';
  const txID = typeof b?.txID === 'string' ? b.txID : '';
  if (!partnerTxID || !txType) throw new DomainError('VALIDATION_FAILED', 'Webhook without partnerTxID or txType');

  let p = (await ctx.db.query<PaymentRow>('SELECT * FROM payments WHERE partner_tx_id = $1', [partnerTxID])).rows[0];
  const refund = p ? undefined : (await ctx.db.query<RefundRow>('SELECT * FROM payment_refunds WHERE partner_tx_id = $1', [partnerTxID])).rows[0];
  if (refund) p = await loadPayment(ctx.db, refund.payment_id);

  const eventKey = `wh:${sha256(`${txType}|${partnerTxID}|${txID}|${txStatus}`)}`;
  const ins = await ctx.db.query<{ id: number }>(
    `INSERT INTO payment_events (payment_id, source, event_key, tx_type, tx_status, payload, received_at) VALUES ($1,'webhook',$2,$3,$4,$5,$6)
     ON CONFLICT (event_key) DO NOTHING RETURNING id`,
    [p?.id ?? null, eventKey, txType.slice(0, 32), txStatus.slice(0, 64), JSON.stringify(redactWebhook(b)), ctx.clock.now()],
  );
  if (!ins.rows[0]) return { duplicate: true, outcome: 'duplicate' };
  const eventId = ins.rows[0].id;
  const outcome = await applyWebhook(ctx, p, refund, { txType, txStatus, txID, amount: b?.amount, currency: b?.currency, reason: b?.payload?.reason, paymentMethod: b?.payload?.paymentMethod });
  await ctx.db.query('UPDATE payment_events SET outcome = $2 WHERE id = $1', [eventId, outcome]);
  return { outcome };
}

/** Keep the webhook payload for audit but never echo free-form fields back anywhere. */
function redactWebhook(b: any) {
  const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
  return { ...pick(b, ['txType', 'txStatus', 'partnerID', 'partnerTxID', 'txID', 'origTxID', 'amount', 'currency', 'status', 'createdAt', 'completedAt']), payload: pick(b?.payload, ['partnerGroupTxID', 'reason', 'paymentMethod']) };
}

async function applyWebhook(
  ctx: Ctx, p: PaymentRow | undefined, refund: RefundRow | undefined,
  e: { txType: string; txStatus: string; txID: string; amount: unknown; currency: unknown; reason: unknown; paymentMethod: unknown },
): Promise<string> {
  if (!p) return 'unknown_transaction';
  const amountOk = (expected: number) => (e.amount === undefined || Number(e.amount) === expected) && (e.currency === undefined || e.currency === p!.currency);
  if (refund) {
    if (!amountOk(Number(refund.amount_minor))) {
      await audit(ctx.db, { userId: p.user_id, actor: 'system', action: 'payment.webhook_mismatch', entity: 'payment', entityId: p.id, details: { refund_id: refund.id } });
      return 'amount_mismatch';
    }
    if (e.txStatus === 'success' || e.txStatus === 'failed') {
      await applyRefundStatus(ctx, refund.id, { txStatus: e.txStatus, txID: e.txID || undefined, reason: typeof e.reason === 'string' ? e.reason : undefined });
      return `refund_${e.txStatus}`;
    }
    return 'recorded';
  }
  if (!amountOk(Number(p.amount_minor))) {
    await audit(ctx.db, { userId: p.user_id, actor: 'system', action: 'payment.webhook_mismatch', entity: 'payment', entityId: p.id, details: { amount: Number(e.amount), currency: String(e.currency) } });
    return 'amount_mismatch';
  }
  const type = e.txType.toLowerCase();
  if (type === 'charge' || type === 'capture') {
    if (e.txStatus === 'success' || ['failed', 'cancelled', 'authorisation_declined'].includes(e.txStatus)) {
      const u = await applyChargeStatus(ctx, p, { txStatus: e.txStatus, txID: e.txID || undefined, reason: typeof e.reason === 'string' ? e.reason : undefined, paymentMethod: typeof e.paymentMethod === 'string' ? e.paymentMethod : undefined }, 'webhook');
      return `charge_${u.status}`;
    }
    return 'recorded';
  }
  if (type === 'auth' && (p.status === 'authorizing' || p.status === 'unknown')) {
    // The user approved in Grab. If the redirect never reaches us, the status endpoint carries the
    // oAuthCode: finish in the background so Grab gets its 200 quickly.
    const id = p.id;
    setTimeout(() => {
      reconcile(ctx, id, { force: true }).catch(() => undefined);
    }, 5_000).unref();
    return 'auth_scheduled';
  }
  return 'recorded';
}
