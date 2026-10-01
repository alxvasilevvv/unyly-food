// Cashless Live GrabExpress paid with GrabPay before the delivery is created, end to end against both
// mocks: test/support/grab-mock.ts (GrabExpress) and test/support/grabpay-mock.ts (GrabPay OTC).
import { createHash, createSign, generateKeyPairSync, KeyObject, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STEP_UP_THRESHOLDS, loadConfig } from '../src/config.js';
import { runJobsOnce } from '../src/jobs/worker.js';
import type { GrabPayConfig } from '../src/payments/grabpay-config.js';
import { refundPayment } from '../src/payments/service.js';
import { loadGrabConfig } from '../src/providers/grab/config.js';
import { reconcileAttempt } from '../src/services/checkout.js';
import { setSubmissionsEnabled } from '../src/services/common.js';
import { settleLivePayments, settlePayment } from '../src/services/live-payment.js';
import { addAddress } from '../src/services/users.js';
import { confirmOnWeb, Harness, mcpClient, oauthToken, startHarness, TEST_DB, webLogin } from './helpers.js';
import { GrabMock, mockGrabEnv, startGrabMock } from './support/grab-mock.js';
import { GrabPayMock, startGrabPayMock } from './support/grabpay-mock.js';

const CREDS = {
  partnerId: 'test-partner',
  partnerSecret: 'test-partner-secret',
  clientId: 'test-client',
  clientSecret: 'test-client-secret',
  merchantId: 'test-merchant',
};
const ORIGIN = 'http://localhost:3000';
const gpConfig = (apiBase: string, currency: GrabPayConfig['currency'] = 'THB'): GrabPayConfig => ({
  enabled: true, env: 'sandbox', apiBase, ...CREDS, redirectUri: `${ORIGIN}/pay/grab/callback`, currency, tokenKey: '',
});

let grab: GrabMock;
let gp: GrabPayMock;
let h: Harness;
const AUTH = mockGrabEnv({ url: '' } as any).GRAB_EXPRESS_WEBHOOK_AUTH;

async function liveUser(email: string) {
  const s = await webLogin(h, email);
  const mode = await h.app.inject({ method: 'POST', url: '/app/mode', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, region: 'TH', mode: 'live' } });
  expect(mode.statusCode).toBe(302);
  await addAddress(h.ctx, s.userId, {
    label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Khlong Toei', city: 'Bangkok', country: 'TH',
    coordinates: '13.7221034, 100.5678001', contact_name: 'Alex Sender', contact_phone: '+66 81 234 5678',
  }, true);
  await addAddress(h.ctx, s.userId, {
    label: 'Office', line1: '999 Rama I Road', district: 'Pathum Wan', city: 'Bangkok', country: 'TH',
    coordinates: '13.746228, 100.534713', contact_name: 'Bee Recipient', contact_phone: '+66 89 765 4321',
  }, false);
  const tok = await oauthToken(h, s);
  const m = await mcpClient(h, tok.access_token);
  return { ...s, mcp: m };
}
type User = Awaited<ReturnType<typeof liveUser>>;

const newCheckout = async (u: User): Promise<string> => {
  const cart = await u.mcp.call('create_cart', { service: 'express', pickup: 'Home', dropoff: 'Office', parcel_weight_kg: 2, items: [{ item_id: 'express-bike', quantity: 1 }] });
  expect(cart.ok).toBe(true);
  return cart.result.checkout.checkout_id;
};

/** Confirm on the Unyly page: consent is recorded and the browser is sent (303) to the GrabPay start route. */
async function confirm(u: User, checkoutId: string): Promise<string> {
  const post = await confirmOnWeb(h, u, checkoutId);
  expect(post.statusCode).toBe(303);
  const loc = String(post.headers.location);
  expect(loc).toBe(`/pay/grab/start/${checkoutId}?total_minor=5500`);
  return loc;
}

/** The browser follows the start redirect to Grab, the user approves, Grab redirects back: the callback URL. */
async function approveInGrab(u: User, startUrl: string): Promise<string> {
  const start = await h.app.inject({ url: startUrl, headers: { cookie: u.cookie } });
  expect(start.statusCode).toBe(302);
  expect(String(start.headers.location)).toContain(`${gp.baseUrl}/grabid/v1/oauth2/authorize`);
  const back = await gp.consentRedirect(String(start.headers.location));
  return `/pay/grab/callback${back.search}`;
}

const callback = (u: User, url: string) => h.app.inject({ url, headers: { cookie: u.cookie } });
const submissionOf = async (co: string) => (await h.db.query('SELECT * FROM submission_attempts WHERE checkout_id = $1', [co])).rows[0];
const paymentOf = async (co: string) => (await h.db.query(`SELECT * FROM payments WHERE checkout_id = $1 ORDER BY created_at DESC`, [co])).rows[0];
const orderOf = async (co: string) => (await h.db.query('SELECT * FROM orders WHERE checkout_id = $1', [co])).rows[0];
const refundsOf = async (paymentId: string) => (await h.db.query('SELECT * FROM payment_refunds WHERE payment_id = $1', [paymentId])).rows;
const settlementOf = async (paymentId: string) => (await h.db.query('SELECT * FROM live_payment_settlements WHERE payment_id = $1', [paymentId])).rows[0];
const createsFor = (mid: string) => grab.ops('create').filter((c) => c.body.merchantOrderID === mid);
const completes = () => gp.calls.filter((c) => c === 'complete').length;
const hook = (deliveryID: string, mid: string, status: string, t: number) =>
  grab.emitWebhook(h.baseUrl, { deliveryID, merchantOrderID: mid, timestamp: t, status }, { authorization: AUTH });

/** Paid, delivered-to-Grab order: returns ids for the follow-up steps. */
async function paidOrder(u: User) {
  const co = await newCheckout(u);
  const cb = await callback(u, await approveInGrab(u, await confirm(u, co)));
  expect(cb.statusCode).toBe(303);
  const o = await orderOf(co);
  expect(String(cb.headers.location)).toBe(`/app/orders/${o.id}?placed=1`);
  const sub = await submissionOf(co);
  return { co, order: o, sub, deliveryID: sub.provider_order_ref as string, payment: await paymentOf(co) };
}

beforeAll(async () => {
  grab = await startGrabMock();
  gp = await startGrabPayMock(CREDS);
  h = await startHarness({
    cfg: { grab: loadGrabConfig(mockGrabEnv(grab, { GRAB_EXPRESS: 'on', GRAB_EXPRESS_PAYMENT: 'cashless' })), grabpay: gpConfig(gp.baseUrl), providerTimeoutMs: 4000 },
  });
  await setSubmissionsEnabled(h.db, 'live', true);
});
afterAll(async () => {
  await h?.close();
  await grab?.close();
  await gp?.close();
});
beforeEach(() => {
  grab.knobs.quoteAmount = 55;
  grab.knobs.createError = undefined;
  grab.knobs.createDropMs = undefined;
  grab.knobs.createDelayMs = undefined;
  grab.knobs.cancelConflict = false;
  gp.consent = 'approve';
  gp.completeOutcome = 'success';
  h.cfg.stepUp = { enabled: true, thresholds: { ...DEFAULT_STEP_UP_THRESHOLDS } };
});

describe('Config: cashless GrabExpress needs GrabPay', () => {
  const base = { env: 'test' as const, databaseUrl: TEST_DB, webOrigin: ORIGIN };
  const cashless = () => loadGrabConfig(mockGrabEnv({ url: 'http://127.0.0.1:9' } as any, { GRAB_EXPRESS: 'on', GRAB_EXPRESS_PAYMENT: 'cashless' }));

  it('fails startup without GrabPay or with another currency; cash mode needs nothing', () => {
    expect(() => loadConfig({ ...base, grab: cashless(), grabpay: { ...gpConfig('http://127.0.0.1:9'), enabled: false } })).toThrow(/GRAB_EXPRESS_PAYMENT=cashless requires GRABPAY=on/);
    expect(() => loadConfig({ ...base, grab: cashless(), grabpay: gpConfig('http://127.0.0.1:9', 'SGD') })).toThrow(/GRABPAY_CURRENCY=THB \(GRAB_EXPRESS_REGION=TH\), got SGD/);
    const sg = loadGrabConfig(mockGrabEnv({ url: 'http://127.0.0.1:9' } as any, { GRAB_EXPRESS: 'on', GRAB_EXPRESS_PAYMENT: 'cashless', GRAB_EXPRESS_REGION: 'sg' }));
    expect(sg.express.currency).toBe('SGD');
    expect(loadConfig({ ...base, grab: sg, grabpay: gpConfig('http://127.0.0.1:9', 'SGD') }).grab.express.region).toBe('SG');
    expect(() => loadGrabConfig({ GRAB_EXPRESS_REGION: 'XX' })).toThrow(/GRAB_EXPRESS_REGION/);
    const cash = loadGrabConfig(mockGrabEnv({ url: 'http://127.0.0.1:9' } as any, { GRAB_EXPRESS: 'on' }));
    expect(loadConfig({ ...base, grab: cash, grabpay: { ...gpConfig('http://127.0.0.1:9'), enabled: false } }).grab.express.payment).toBe('cash');
    // Cashless while GrabExpress is off is not validated (nothing would be ordered).
    expect(() => loadConfig({ ...base, grab: loadGrabConfig({ GRAB_EXPRESS_PAYMENT: 'cashless' }), grabpay: { ...gpConfig('x'), enabled: false } })).not.toThrow();
  });
});

describe('Cashless Live GrabExpress with GrabPay', () => {
  let u: User;
  beforeAll(async () => {
    u = await liveUser('payer@example.com');
  });
  afterAll(async () => u?.mcp.close());

  it('happy path: estimate, cart, confirm, 303 to GrabPay, capture, one delivery, webhooks to delivered', async () => {
    const est = await u.mcp.call('estimate_trip', { service: 'express', pickup: 'Home', dropoff: 'Office', parcel_weight_kg: 2 });
    expect(est.ok).toBe(true);
    expect(est.result.options[0].estimated_total).toMatchObject({ amount_minor: 5500, currency: 'THB' });
    const cart = await u.mcp.call('create_cart', { service: 'express', pickup: 'Home', dropoff: 'Office', parcel_weight_kg: 2, items: [{ item_id: 'express-bike', quantity: 1 }] });
    const co = cart.result.checkout.checkout_id;
    expect(cart.result.checkout.payment_method).toMatch(/GrabPay/);
    expect(cart.result.checkout.note).toMatch(/Pay with GrabPay/);
    expect(grab.ops('quotes').at(-1)!.body.paymentMethod).toBe('CASHLESS');

    // The page tells the user what the button does.
    const page = await h.app.inject({ url: `/confirm/${co}`, headers: { cookie: u.cookie } });
    expect(page.body).toMatch(/Pay [^<]*55\.00 with GrabPay and place the order/);
    expect(page.body).toContain('GrabPay (you will be redirected to Grab to approve)');

    // Payment cannot start before consent, and the assistant cannot submit.
    const early = await h.app.inject({ url: `/pay/grab/start/${co}?total_minor=5500`, headers: { cookie: u.cookie } });
    expect(early.statusCode).toBe(409);
    expect((await u.mcp.call('submit_order', { checkout_id: co })).error.code).toBe('CONFIRMATION_REQUIRED');

    const startUrl = await confirm(u, co);
    expect(grab.ops('create')).toHaveLength(0);
    // Consent recorded, payment pending: awaiting_payment, never "placed".
    const st = await u.mcp.call('get_checkout_status', { checkout_id: co });
    expect(st.result.status).toBe('awaiting_payment');
    expect(st.result.user_action).toMatch(/GrabPay/);
    expect(st.result.confirm_url).toContain(`/confirm/${co}`);
    expect(st.result.order_id).toBeNull();
    expect(st.result.summary).not.toMatch(/placed\b(?! only)/i);
    expect(st.next_actions?.map((n: any) => n.tool) ?? []).not.toContain('submit_order');
    const sub0 = await u.mcp.call('submit_order', { checkout_id: co });
    expect(sub0.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(sub0.error.details.payment_required).toBe('grabpay');
    expect(grab.ops('create')).toHaveLength(0);

    const cbUrl = await approveInGrab(u, startUrl);
    const cb = await callback(u, cbUrl);
    expect(cb.statusCode).toBe(303);
    const o = await orderOf(co);
    expect(String(cb.headers.location)).toBe(`/app/orders/${o.id}?placed=1`);
    const p = await paymentOf(co);
    expect(p.status).toBe('captured');
    expect(Number(p.amount_minor)).toBe(5500);
    const sub = await submissionOf(co);
    expect(sub.status).toBe('accepted');
    const creates = createsFor(sub.id);
    expect(creates).toHaveLength(1);
    expect(creates[0].body.paymentMethod).toBe('CASHLESS');
    expect(creates[0].body.payer).toBe('SENDER');
    expect(o.payment_id).toBe(p.id);
    expect(o.payment_status).toBe('captured');

    // Duplicate callback: same answer, no second delivery, no second complete.
    const n = completes();
    const again = await callback(u, cbUrl);
    expect(again.statusCode).toBe(303);
    expect(String(again.headers.location)).toBe(`/app/orders/${o.id}?placed=1`);
    expect(createsFor(sub.id)).toHaveLength(1);
    expect(completes()).toBe(n);

    const deliveryID = sub.provider_order_ref;
    const ts = Math.floor(Date.now() / 1000);
    for (const [s, t] of [['PICKING_UP', 0], ['PENDING_DROP_OFF', 60], ['COMPLETED', 600]] as const) expect((await hook(deliveryID, sub.id, s, ts + t)).status).toBe(204);
    const done = await orderOf(co);
    expect(done.fulfillment_status).toBe('delivered');
    expect(done.payment_status).toBe('captured'); // provider events never overwrite the GrabPay status
    expect(done.picked_up_at).not.toBeNull();
    expect((await settlementOf(p.id)).outcome).toBe('kept');
    expect(await refundsOf(p.id)).toHaveLength(0);

    const view = await u.mcp.call('get_order_status', { order_id: o.id });
    expect(view.result.payment_status).toBe('captured');
    expect(view.result.payment_method).toBe('grabpay');
    const orderPage = await h.app.inject({ url: `/app/orders/${o.id}`, headers: { cookie: u.cookie } });
    expect(orderPage.body).toContain('GrabPay');
    const fin = await u.mcp.call('get_checkout_status', { checkout_id: co });
    expect(fin.result.order_id).toBe(o.id);
    expect(fin.result.payment).toEqual({ method: 'grabpay', status: 'captured' });
  });

  it('step-up is still enforced for large totals before the redirect to GrabPay', async () => {
    const key = await addSoftPasskey(u.userId);
    try {
      h.cfg.stepUp.thresholds.THB = 5500;
      const co = await newCheckout(u);
      const page = await h.app.inject({ url: `/confirm/${co}`, headers: { cookie: u.cookie } });
      const total = /name="total_minor" value="(\d+)"/.exec(page.body)![1];
      const post = (stepUp?: string) => h.app.inject({ method: 'POST', url: `/confirm/${co}`, headers: { cookie: u.cookie, origin: ORIGIN }, payload: { _csrf: u.csrf, total_minor: total, ...(stepUp ? { step_up: stepUp } : {}) } });
      const bare = await post();
      expect(bare.statusCode).toBe(403);
      expect((await h.db.query('SELECT status FROM checkouts WHERE id = $1', [co])).rows[0].status).toBe('awaiting_user');
      expect(await paymentOf(co)).toBeUndefined();
      const opt = await h.app.inject({ method: 'POST', url: `/confirm/${co}/step-up/options`, headers: { origin: ORIGIN, cookie: u.cookie }, payload: { _csrf: u.csrf } });
      expect(opt.statusCode).toBe(200);
      const { challenge_id, options } = opt.json();
      const ok = await post(JSON.stringify({ challenge_id, response: key.sign(options.challenge) }));
      expect(ok.statusCode).toBe(303);
      expect(String(ok.headers.location)).toBe(`/pay/grab/start/${co}?total_minor=5500`);
      expect((await h.db.query(`SELECT 1 FROM audit_log WHERE action = 'checkout.step_up' AND entity_id = $1`, [co])).rows).toHaveLength(1);
    } finally {
      await h.db.query('DELETE FROM webauthn_credentials WHERE user_id = $1', [u.userId]);
    }
  });

  it('price changed between consent and capture: complete is never called, nothing charged, no delivery', async () => {
    const co = await newCheckout(u);
    const startUrl = await confirm(u, co);
    grab.knobs.quoteAmount = 60;
    const n = completes();
    const cb = await callback(u, await approveInGrab(u, startUrl));
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('Payment not completed');
    expect(completes()).toBe(n);
    const p = await paymentOf(co);
    expect(p.status).toBe('failed');
    expect(p.grab_reason).toBe('price_changed');
    expect(await submissionOf(co)).toBeUndefined();
    expect(await orderOf(co)).toBeUndefined();
    const c = (await h.db.query('SELECT status, invalid_reason FROM checkouts WHERE id = $1', [co])).rows[0];
    expect(c).toEqual({ status: 'invalidated', invalid_reason: 'PRICE_CHANGED' });
    const st = await u.mcp.call('get_checkout_status', { checkout_id: co });
    expect(st.result.status).toBe('invalidated');
    expect(st.result.order_id).toBeNull();
  });

  it('GrabExpress rejects the create after capture: full refund, audited, idempotent', async () => {
    const co = await newCheckout(u);
    const startUrl = await confirm(u, co);
    grab.knobs.createError = { status: 400, message: 'Invalid parameters' };
    const cb = await callback(u, await approveInGrab(u, startUrl));
    expect(cb.statusCode).toBe(303);
    expect(String(cb.headers.location)).toBe(`/confirm/${co}`);
    const sub = await submissionOf(co);
    expect(sub.status).toBe('rejected');
    expect(await orderOf(co)).toBeUndefined();
    const p = await paymentOf(co);
    expect(p.status).toBe('refunded');
    const refunds = await refundsOf(p.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ reason: 'order_rejected', status: 'success', idem_key: `order:${co}:order_rejected` });
    expect(Number(refunds[0].amount_minor)).toBe(5500);
    expect((await settlementOf(p.id)).outcome).toBe('refund_requested');
    expect((await h.db.query(`SELECT 1 FROM audit_log WHERE action = 'order.payment_refund' AND entity_id = $1`, [co])).rows).toHaveLength(1);
    // Repeats never refund twice.
    await settlePayment(h.ctx, p.id);
    await settleLivePayments(h.ctx);
    expect((await refundPayment(h.ctx, p.id, undefined, 'order_rejected', { key: `order:${co}:order_rejected` })).id).toBe(refunds[0].id);
    expect(await refundsOf(p.id)).toHaveLength(1);
    expect(gp.refunds.size).toBeGreaterThanOrEqual(1);
    const page = await h.app.inject({ url: `/confirm/${co}`, headers: { cookie: u.cookie } });
    expect(page.body).toMatch(/was refunded to GrabPay/);
    const st = await u.mcp.call('get_checkout_status', { checkout_id: co });
    expect(st.result.summary).toMatch(/refunded/);
  });

  it('user cancels before pickup: delivery cancelled and payment refunded', async () => {
    const { co, order, deliveryID, payment } = await paidOrder(u);
    const c1 = await h.app.inject({ method: 'POST', url: `/app/orders/${order.id}/cancel`, headers: { cookie: u.cookie }, payload: { _csrf: u.csrf } });
    expect(c1.statusCode).toBe(302);
    const cid = String(c1.headers.location).split('/').pop()!;
    const c2 = await h.app.inject({ method: 'POST', url: `/confirm-cancel/${cid}`, headers: { cookie: u.cookie }, payload: { _csrf: u.csrf, fee_minor: '0' } });
    expect(c2.statusCode).toBe(302);
    expect(grab.deliveries.get(deliveryID)!.status).toBe('CANCELED');
    const o = await orderOf(co);
    expect(o.fulfillment_status).toBe('cancelled');
    expect(o.payment_status).toBe('refunded');
    const p = await paymentOf(co);
    expect(p.status).toBe('refunded');
    const refunds = await refundsOf(payment.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].reason).toBe('delivery_cancelled');
    const view = await u.mcp.call('get_order_status', { order_id: order.id });
    expect(view.result.payment_status).toBe('refunded');
    const pageHtml = (await h.app.inject({ url: `/app/orders/${order.id}`, headers: { cookie: u.cookie } })).body;
    expect(pageHtml).toMatch(/was refunded to GrabPay/);
  });

  it('Grab cancels before pickup (no driver found): refunded from the webhook', async () => {
    const { co, sub, deliveryID, payment } = await paidOrder(u);
    grab.setStatus(deliveryID, 'CANCELED');
    expect((await hook(deliveryID, sub.id, 'CANCELED', Math.floor(Date.now() / 1000))).status).toBe(204);
    expect((await orderOf(co)).fulfillment_status).toBe('cancelled');
    expect((await paymentOf(co)).status).toBe('refunded');
    expect((await refundsOf(payment.id))[0].reason).toBe('delivery_cancelled');
  });

  it('cancel after pickup is refused and nothing is refunded; a failure after pickup goes to support', async () => {
    const { co, order, sub, deliveryID, payment } = await paidOrder(u);
    grab.setStatus(deliveryID, 'PENDING_DROP_OFF');
    expect((await hook(deliveryID, sub.id, 'PENDING_DROP_OFF', Math.floor(Date.now() / 1000))).status).toBe(204);
    const c1 = await h.app.inject({ method: 'POST', url: `/app/orders/${order.id}/cancel`, headers: { cookie: u.cookie }, payload: { _csrf: u.csrf } });
    expect(c1.statusCode).toBe(409);
    expect(grab.ops('cancel')).toHaveLength(1); // only the earlier test's cancel
    expect(await refundsOf(payment.id)).toHaveLength(0);
    expect((await paymentOf(co)).status).toBe('captured');
    grab.setStatus(deliveryID, 'FAILED');
    expect((await hook(deliveryID, sub.id, 'FAILED', Math.floor(Date.now() / 1000) + 60)).status).toBe(204);
    expect((await orderOf(co)).fulfillment_status).toBe('failed');
    expect(await refundsOf(payment.id)).toHaveLength(0);
    expect(await settlementOf(payment.id)).toMatchObject({ outcome: 'support', reason: 'failed_after_pickup' });
    expect((await h.db.query(`SELECT 1 FROM audit_log WHERE action = 'order.payment_needs_support' AND entity_id = $1`, [order.id])).rows).toHaveLength(1);
    const pageHtml = (await h.app.inject({ url: `/app/orders/${order.id}`, headers: { cookie: u.cookie } })).body;
    expect(pageHtml).toContain('Unyly support will contact you');
  });

  it('unknown create outcome after capture: no refund until resolved, then refunded as not received', async () => {
    const co = await newCheckout(u);
    const startUrl = await confirm(u, co);
    grab.knobs.createDropMs = 1500;
    const cb = await callback(u, await approveInGrab(u, startUrl));
    expect(cb.statusCode).toBe(303);
    const sub = await submissionOf(co);
    expect(sub.status).toBe('unknown');
    const p = await paymentOf(co);
    expect(p.status).toBe('captured');
    await settleLivePayments(h.ctx);
    expect(await refundsOf(p.id)).toHaveLength(0);
    const st = await u.mcp.call('get_checkout_status', { checkout_id: co });
    expect(st.result.submission.status).toBe('unknown');
    expect(st.result.order_id).toBeNull();
    await new Promise((res) => setTimeout(res, 700));
    h.clock.advance(11 * 60_000);
    try {
      for (let i = 0; i < 4; i++) {
        await reconcileAttempt(h.ctx, sub.id);
        h.clock.advance(60_000);
      }
    } finally {
      h.clock.advance(-15 * 60_000); // GrabPay checks the Date header against real time
    }
    expect((await submissionOf(co)).error_code).toBe('NOT_RECEIVED_BY_PROVIDER');
    expect(createsFor(sub.id)).toHaveLength(1);
    await settleLivePayments(h.ctx);
    expect((await paymentOf(co)).status).toBe('refunded');
    expect((await refundsOf(p.id))[0].reason).toBe('order_not_received');
  });

  it('kill switch: with new orders paused, Confirm starts no payment', async () => {
    const co = await newCheckout(u);
    await setSubmissionsEnabled(h.db, 'live', false);
    try {
      const post = await confirmOnWeb(h, u, co);
      expect(post.statusCode).toBe(409);
      expect(post.body).toContain('No payment was started');
      expect(await paymentOf(co)).toBeUndefined();
    } finally {
      await setSubmissionsEnabled(h.db, 'live', true);
    }
  });

  it('cash mode is unchanged: no payment step, Confirm creates the delivery right away', async () => {
    h.cfg.grab.express.payment = 'cash';
    try {
      const co = await newCheckout(u);
      const page = await h.app.inject({ url: `/confirm/${co}`, headers: { cookie: u.cookie } });
      expect(page.body).not.toContain('with GrabPay');
      const post = await confirmOnWeb(h, u, co);
      expect(post.statusCode).toBe(302);
      const o = await orderOf(co);
      expect(String(post.headers.location)).toBe(`/app/orders/${o.id}?placed=1`);
      expect(await paymentOf(co)).toBeUndefined();
      expect(o.payment_id).toBeNull();
      expect(o.payment_status).toBe('pending');
      expect(createsFor((await submissionOf(co)).id)[0].body.paymentMethod).toBe('CASH');
    } finally {
      h.cfg.grab.express.payment = 'cashless';
    }
  });

  it('a confirmation prepared for one payment method is invalidated if the method changes', async () => {
    const co = await newCheckout(u); // GrabPay label
    h.cfg.grab.express.payment = 'cash';
    try {
      const post = await confirmOnWeb(h, u, co);
      expect(post.statusCode).toBe(409);
      expect((await h.db.query('SELECT invalid_reason FROM checkouts WHERE id = $1', [co])).rows[0].invalid_reason).toBe('PAYMENT_METHOD_CHANGED');
      expect(await submissionOf(co)).toBeUndefined();
    } finally {
      h.cfg.grab.express.payment = 'cashless';
    }
  });

  it('the worker runs the payment steps without failures', async () => {
    const r = await runJobsOnce(h.ctx);
    expect(r.failed).toEqual([]);
    expect(r.skipped).not.toContain('settle_live_payments');
  });
});

/** Minimal software authenticator (as in step-up.test.ts): one ES256 credential registered into the DB. */
async function addSoftPasskey(userId: string) {
  const b64u = (b: Buffer) => b.toString('base64url');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')]);
  const id = b64u(randomBytes(16));
  await h.db.query('INSERT INTO webauthn_credentials (id, user_id, public_key, counter) VALUES ($1,$2,$3,0)', [id, userId, cose]);
  let counter = 0;
  return {
    sign(challenge: string) {
      counter += 1;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
      const cnt = Buffer.alloc(4);
      cnt.writeUInt32BE(counter);
      const authData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([0x05]), cnt]);
      const sig = createSign('SHA256').update(Buffer.concat([authData, createHash('sha256').update(clientData).digest()])).sign(privateKey as KeyObject);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) } };
    },
  };
}
