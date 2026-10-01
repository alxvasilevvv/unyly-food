import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GrabPayConfig } from '../src/payments/grabpay-config.js';
import { loadGrabPayConfig } from '../src/payments/grabpay-config.js';
import {
  bodyDigest, buildAuthorizeUrl, chargePartnerTxId, hmacSignature, popHeader, refundPartnerTxId, signingPayload, toMinor, verifyWebhookSignature,
} from '../src/payments/grabpay-otc.js';
import { reconcile, refundPayment, setOnPaymentCaptured, startPayment } from '../src/payments/service.js';
import { demoUser, Harness, preparedCheckout, startHarness, webLogin } from './helpers.js';
import { GrabPayMock, mockHmac, startGrabPayMock } from './support/grabpay-mock.js';

const CREDS = {
  partnerId: 'test-partner',
  partnerSecret: 'test-partner-secret',
  clientId: 'test-client',
  clientSecret: 'test-client-secret',
  merchantId: 'test-merchant',
};

const baseGp = (apiBase: string): GrabPayConfig => ({
  enabled: true, env: 'sandbox', apiBase, ...CREDS, redirectUri: 'http://localhost:3000/pay/grab/callback', currency: 'THB', tokenKey: '',
});

// ---------------------------------------------------------------------------------------------
// Pure functions: signatures and identifiers
// ---------------------------------------------------------------------------------------------

describe('GrabPay OTC signatures', () => {
  const date = 'Thu, 01 Oct 2026 10:00:00 GMT';
  const body = '{"partnerGroupTxID":"g1","partnerTxID":"t1","amount":12345,"currency":"THB","merchantID":"m-test"}';

  it('request HMAC matches a vector computed independently with openssl', () => {
    // printf body | openssl dgst -sha256 -binary | base64; then openssl dgst -sha256 -hmac secret over the payload
    expect(bodyDigest('POST', body)).toBe('Q+5GMYZKR7vivmGgc4aIRZebIrTNMlley97aLAFtf5k=');
    expect(signingPayload({ method: 'POST', contentType: 'application/json', date, path: '/grabpay/partner/v2/charge/init', body }))
      .toBe(`POST\napplication/json\n${date}\n/grabpay/partner/v2/charge/init\nQ+5GMYZKR7vivmGgc4aIRZebIrTNMlley97aLAFtf5k=\n`);
    expect(hmacSignature('test-partner-secret', { method: 'POST', contentType: 'application/json', date, path: '/grabpay/partner/v2/charge/init', body }))
      .toBe('yxlNQA2XxPNHU9SzBYcSXS6GvG60+xDeJTPZszwiNvM=');
  });

  it('GET requests sign an empty body digest and include the query string', () => {
    expect(bodyDigest('GET', 'ignored')).toBe('');
    expect(hmacSignature('test-partner-secret', { method: 'GET', contentType: 'application/json', date, path: '/grabpay/partner/v2/one-time-charge/t1/status?currency=THB', body: '' }))
      .toBe('i6bHtMybuvFA9Y0Aq7TnA2WgCTHauBJs7EQtF7RDCGk=');
  });

  it('X-GID-AUX-POP matches an independently computed vector', () => {
    expect(popHeader('test-client-secret', 'tok-abc', 1790848800)).toBe('eyJ0aW1lX3NpbmNlX2Vwb2NoIjoxNzkwODQ4ODAwLCJzaWciOiJzUXFMdWhSekF1WW5jdXl3aWFsc3B1RWJfSzNPR3dHc0ZlcEllZGtOU3FJIn0');
    const decoded = JSON.parse(Buffer.from(popHeader('k', 'tok', 42), 'base64url').toString());
    expect(decoded.time_since_epoch).toBe(42);
    expect(decoded.sig).toBe(createHmac('sha256', 'k').update('42tok').digest('base64url'));
    expect(decoded.sig).not.toMatch(/[=+/]/);
  });

  it('webhook verification: valid, wrong secret, stale date, wrong partner, tampered body', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    const hdr = (secret: string, d: Date, partner = CREDS.partnerId, ct = 'application/json; charset=utf-8') => ({
      authorization: `${partner}:${mockHmac(secret, 'POST', ct, d.toUTCString(), '/webhooks/grabpay', body)}`, date: d.toUTCString(), 'content-type': ct,
    });
    const v = (headers: any, raw = body) => verifyWebhookSignature(CREDS, { method: 'POST', path: '/webhooks/grabpay', headers, rawBody: raw }, now);
    expect(v(hdr(CREDS.partnerSecret, now))).toEqual({ ok: true });
    // staging sends a doubled content type: it must be signed exactly as received
    expect(v(hdr(CREDS.partnerSecret, now, CREDS.partnerId, 'application/json; charset=utf-8,application/json'))).toEqual({ ok: true });
    expect(v(hdr('wrong', now))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(v(hdr(CREDS.partnerSecret, new Date(now.getTime() - 6 * 60 * 1000)))).toEqual({ ok: false, reason: 'stale_date' });
    expect(v(hdr(CREDS.partnerSecret, now, 'other'))).toEqual({ ok: false, reason: 'bad_partner' });
    expect(v(hdr(CREDS.partnerSecret, now), body.replace('12345', '1'))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(v({})).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('partnerTxIDs are deterministic, within 32 chars and the allowed alphabet', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(chargePartnerTxId(id)).toBe('0f8fad5bd9cb469fa16570867728950e');
    expect(refundPartnerTxId(id, 'full:x')).toBe(refundPartnerTxId(id, 'full:x'));
    expect(refundPartnerTxId(id, 'full:x')).not.toBe(refundPartnerTxId(id, 'full:y'));
    expect(refundPartnerTxId(id, 'k')).toMatch(/^r[0-9a-f]{31}$/);
    expect(() => chargePartnerTxId('nope')).toThrow();
  });

  it('minor units and the authorize URL carry every required parameter', () => {
    expect(toMinor('120.5', 'THB')).toBe(12050);
    expect(() => toMinor('1.234', 'THB')).toThrow();
    const u = new URL(buildAuthorizeUrl(baseGp('https://partner-api.stg-myteksi.com'), { request: 'req.jwt.', currency: 'THB', secrets: { state: 's', nonce: 'n', codeVerifier: 'v'.repeat(43) } }));
    expect(u.origin + u.pathname).toBe('https://partner-api.stg-myteksi.com/grabid/v1/oauth2/authorize');
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({ acr_values: 'consent_ctx:countryCode=TH,currency=THB', client_id: 'test-client', code_challenge_method: 'S256', response_type: 'code', scope: 'payment.one_time_charge', state: 's', nonce: 'n', request: 'req.jwt.' });
    expect(q.code_challenge).toBe(createHash('sha256').update('v'.repeat(43)).digest('base64url'));
  });

  it('config: off by default, validated when on, production requires https', () => {
    expect(loadGrabPayConfig('https://x.org', 'production', {}).enabled).toBe(false);
    expect(() => loadGrabPayConfig('https://x.org', 'development', { GRABPAY: 'on' })).toThrow(/GRABPAY_PARTNER_ID/);
    expect(() => loadGrabPayConfig('https://x.org', 'development', { GRABPAY: 'maybe' })).toThrow(/on or off/);
    expect(() => loadGrabPayConfig('https://x.org', 'development', { GRABPAY_ENV: 'live' })).toThrow(/sandbox or production/);
    const env = { GRABPAY: 'on', GRABPAY_PARTNER_ID: 'p', GRABPAY_PARTNER_SECRET: 's1', GRABPAY_MERCHANT_ID: 'm', GRABPAY_CLIENT_ID: 'c', GRABPAY_CLIENT_SECRET: 's2' };
    const c = loadGrabPayConfig('https://unyly-food.unyly.org', 'production', { ...env, GRABPAY_ENV: 'production' });
    expect(c.redirectUri).toBe('https://unyly-food.unyly.org/pay/grab/callback');
    expect(c.apiBase).toBe('https://partner-api.grab.com');
    expect(loadGrabPayConfig('http://localhost:3000', 'development', env).apiBase).toBe('https://partner-api.stg-myteksi.com');
    expect(() => loadGrabPayConfig('http://localhost:3000', 'production', env)).toThrow(/https/);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end against the mock
// ---------------------------------------------------------------------------------------------

describe('GrabPay One-time Charge flow', () => {
  let h: Harness;
  let mock: GrabPayMock;
  let alice: Awaited<ReturnType<typeof demoUser>>;
  let hookCalls: { checkoutId: string; paymentId: string }[] = [];

  beforeAll(async () => {
    mock = await startGrabPayMock(CREDS);
    h = await startHarness({ cfg: { grabpay: baseGp(mock.baseUrl) } });
    alice = await demoUser(h, 'alice-pay@example.com');
  });
  afterAll(async () => {
    await alice?.mcp.close();
    await h?.close();
    await mock?.close();
  });
  beforeEach(() => {
    hookCalls = [];
    setOnPaymentCaptured(h.ctx, async (_ctx, checkoutId, paymentId) => {
      hookCalls.push({ checkoutId, paymentId });
    });
    mock.consent = 'approve';
    mock.completeOutcome = 'success';
    mock.authFailures = [];
  });

  const newCheckout = async () => (await preparedCheckout(alice.mcp.call)).checkout as { checkout_id: string; total: { amount_minor: number } };
  const totalOf = async (id: string) => Number((await h.db.query('SELECT total_minor FROM checkouts WHERE id = $1', [id])).rows[0].total_minor);
  const start = (id: string, total: number | string, cookie = alice.cookie) =>
    h.app.inject({ method: 'GET', url: `/pay/grab/start/${id}?total_minor=${total}`, headers: { cookie } });
  const callback = (u: URL, cookie = alice.cookie) => h.app.inject({ method: 'GET', url: `/pay/grab/callback${u.search}`, headers: { cookie } });
  const payment = async (checkoutId: string) => (await h.db.query(`SELECT * FROM payments WHERE checkout_id = $1 ORDER BY created_at DESC`, [checkoutId])).rows;
  const count = (route: string) => mock.calls.filter((c) => c === route).length;

  /** start -> Grab consent -> back to the callback URL (not yet called). */
  async function toCallback(checkoutId: string) {
    const r = await start(checkoutId, await totalOf(checkoutId));
    expect(r.statusCode, r.body.slice(0, 300)).toBe(302);
    const loc = String(r.headers.location);
    expect(loc.startsWith(`${mock.baseUrl}/grabid/v1/oauth2/authorize?`)).toBe(true);
    return mock.consentRedirect(loc);
  }

  it('happy path: init -> consent -> callback -> complete -> captured, hook called once', async () => {
    const co = await newCheckout();
    const total = await totalOf(co.checkout_id);
    const back = await toCallback(co.checkout_id);
    expect(back.origin + back.pathname).toBe('http://localhost:3000/pay/grab/callback');
    const page = await callback(back);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Payment received');
    const [p] = await payment(co.checkout_id);
    expect(p).toMatchObject({ status: 'captured', amount_minor: total, currency: 'THB', partner_tx_id: p.id.replace(/-/g, ''), payment_method: 'GPWALLET' });
    expect(p.grab_tx_id).toMatch(/^[0-9a-f]{32}$/);
    expect(p.access_token_enc).toMatch(/^v1\./); // encrypted at rest
    expect(p.access_token_enc).not.toContain('gpat_');
    expect(mock.txs.get(p.partner_tx_id)!.amount).toBe(total);
    expect(hookCalls).toEqual([{ checkoutId: co.checkout_id, paymentId: p.id }]);
    expect(mock.authFailures).toEqual([]); // every HMAC, Bearer and POP header verified

    // duplicate callback: same page, no second token exchange, complete or hook call
    const before = { token: count('token'), complete: count('complete') };
    const again = await callback(back);
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain('Payment received');
    expect({ token: count('token'), complete: count('complete') }).toEqual(before);
    expect(hookCalls).toHaveLength(1);
    // starting again for a paid checkout does not create a payment or call init
    const inits = count('init');
    const r = await start(co.checkout_id, total);
    expect(r.statusCode).toBe(302);
    expect(String(r.headers.location)).toBe(`/confirm/${co.checkout_id}`);
    expect(count('init')).toBe(inits);
    expect(await payment(co.checkout_id)).toHaveLength(1);
  });

  it('default captured hook (none registered) records an audit event', async () => {
    setOnPaymentCaptured(h.ctx, null);
    const co = await newCheckout();
    await callback(await toCallback(co.checkout_id));
    const [p] = await payment(co.checkout_id);
    expect(p.status).toBe('captured');
    const a = await h.db.query(`SELECT 1 FROM audit_log WHERE action = 'payment.captured_hook_noop' AND entity_id = $1`, [p.id]);
    expect(a.rows).toHaveLength(1);
    const ev = await h.db.query(`SELECT outcome FROM payment_events WHERE event_key = $1`, [`hook:captured:${p.id}`]);
    expect(ev.rows[0].outcome).toBe('ok');
  });

  it('a retried start reuses the same payment, partnerTxID and redirect (no second init)', async () => {
    const co = await newCheckout();
    const total = await totalOf(co.checkout_id);
    const inits = count('init');
    const [a, b] = await Promise.all([start(co.checkout_id, total), start(co.checkout_id, total)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(302);
    const again = await start(co.checkout_id, total);
    expect(again.statusCode).toBe(302);
    expect(count('init')).toBe(inits + 1);
    const rows = await payment(co.checkout_id);
    expect(rows).toHaveLength(1);
    const st = new URL(String(again.headers.location)).searchParams.get('state');
    expect(new URL(String(a.statusCode === 302 ? a.headers.location : b.headers.location)).searchParams.get('state')).toBe(st);
  });

  it('amount mismatch is rejected before anything is sent to Grab', async () => {
    const co = await newCheckout();
    const total = await totalOf(co.checkout_id);
    const inits = count('init');
    const r = await start(co.checkout_id, total + 1);
    expect(r.statusCode).toBe(409);
    expect(await payment(co.checkout_id)).toHaveLength(0);
    expect(count('init')).toBe(inits);
    const missing = await h.app.inject({ method: 'GET', url: `/pay/grab/start/${co.checkout_id}`, headers: { cookie: alice.cookie } });
    expect(missing.statusCode).toBe(400);
    // the service API refuses it too
    await expect(startPayment(h.ctx, alice.userId, co.checkout_id, { expectedAmountMinor: total - 1 })).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
  });

  it('only the owner can start or finish a payment', async () => {
    const co = await newCheckout();
    const bob = await webLogin(h, 'bob-pay@example.com');
    const inits = count('init');
    const r = await start(co.checkout_id, await totalOf(co.checkout_id), bob.cookie);
    expect(r.statusCode).toBe(404);
    expect(count('init')).toBe(inits);
    const anon = await h.app.inject({ method: 'GET', url: `/pay/grab/start/${co.checkout_id}?total_minor=1` });
    expect(anon.statusCode).toBe(302);
    expect(String(anon.headers.location)).toMatch(/^\/login\?next=/);
    // bob replays alice's callback: refused, nothing redeemed
    const back = await toCallback(co.checkout_id);
    const tokens = count('token');
    const stolen = await callback(back, bob.cookie);
    expect(stolen.statusCode).toBe(404);
    expect(count('token')).toBe(tokens);
    expect((await payment(co.checkout_id))[0].status).toBe('authorizing');
    // alice then finishes normally
    expect((await callback(back)).body).toContain('Payment received');
  });

  it('a checkout that is no longer awaiting the user cannot be paid', async () => {
    const co = await newCheckout();
    await h.db.query(`UPDATE checkouts SET status = 'declined' WHERE id = $1`, [co.checkout_id]);
    const r = await start(co.checkout_id, await totalOf(co.checkout_id));
    expect(r.statusCode).toBe(409);
    expect(await payment(co.checkout_id)).toHaveLength(0);
  });

  it('checkout invalidated while the user is in Grab: complete is never called', async () => {
    const co = await newCheckout();
    const back = await toCallback(co.checkout_id);
    await h.db.query(`UPDATE checkouts SET status = 'invalidated', invalid_reason = 'CART_CHANGED' WHERE id = $1`, [co.checkout_id]);
    const completes = count('complete');
    const page = await callback(back);
    expect(page.body).toContain('Payment not completed');
    expect(count('complete')).toBe(completes);
    const [p] = await payment(co.checkout_id);
    expect(p).toMatchObject({ status: 'failed', grab_reason: 'checkout_invalidated' });
    expect(hookCalls).toHaveLength(0);
  });

  it('user cancels in Grab: failed, and a new attempt gets a new partnerTxID', async () => {
    const co = await newCheckout();
    mock.consent = 'cancel';
    const page = await callback(await toCallback(co.checkout_id));
    expect(page.body).toContain('You cancelled the payment');
    const [p1] = await payment(co.checkout_id);
    expect(p1).toMatchObject({ status: 'failed', grab_reason: 'user_canceled' });
    mock.consent = 'approve';
    await callback(await toCallback(co.checkout_id));
    const rows = await payment(co.checkout_id);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('captured');
    expect(rows[0].partner_tx_id).not.toBe(p1.partner_tx_id);
  });

  it('full and partial refunds, idempotent per key, never above the captured amount', async () => {
    const co = await newCheckout();
    await callback(await toCallback(co.checkout_id));
    const [p] = await payment(co.checkout_id);
    const total = Number(p.amount_minor);

    const r1 = await refundPayment(h.ctx, p.id, 1000, 'item_unavailable');
    expect(r1).toMatchObject({ status: 'success', amount_minor: 1000 });
    expect(r1.grab_tx_id).toMatch(/^[0-9a-f]{32}$/);
    const again = await refundPayment(h.ctx, p.id, 1000, 'item_unavailable');
    expect(again.id).toBe(r1.id);
    expect([...mock.refunds.values()].filter((x) => x.origin === p.partner_tx_id)).toHaveLength(1);
    let row = (await h.db.query('SELECT * FROM payments WHERE id = $1', [p.id])).rows[0];
    expect(row).toMatchObject({ status: 'captured', refunded_minor: 1000 });

    await expect(refundPayment(h.ctx, p.id, total, 'too_much')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(refundPayment(h.ctx, p.id, 1.5, 'bad_amount')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(refundPayment(h.ctx, p.id, undefined, 'not a code!')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const full = await refundPayment(h.ctx, p.id, undefined, 'delivery_cancelled');
    expect(full).toMatchObject({ status: 'success', amount_minor: total - 1000 });
    row = (await h.db.query('SELECT * FROM payments WHERE id = $1', [p.id])).rows[0];
    expect(row).toMatchObject({ status: 'refunded', refunded_minor: total });
    await expect(refundPayment(h.ctx, p.id, 100, 'one_more')).rejects.toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED' });
    expect(mock.authFailures).toEqual([]);
  });

  it('refund with an unknown outcome is re-sent with the same partnerTxID and settles once', async () => {
    const co = await newCheckout();
    await callback(await toCallback(co.checkout_id));
    const [p] = await payment(co.checkout_id);
    mock.failNext('refund', 'reset_after');
    const r = await refundPayment(h.ctx, p.id, undefined, 'delivery_failed');
    expect(r.status).toBe('unknown');
    expect((await h.db.query('SELECT status FROM payments WHERE id = $1', [p.id])).rows[0].status).toBe('refunding');
    // a different refund must wait (Grab does not support concurrent refunds)
    await expect(refundPayment(h.ctx, p.id, 100, 'other')).rejects.toMatchObject({ code: 'CANCELLATION_UNKNOWN' });
    await reconcile(h.ctx, p.id);
    const row = (await h.db.query('SELECT status, refunded_minor, amount_minor FROM payments WHERE id = $1', [p.id])).rows[0];
    expect(row.status).toBe('refunded');
    expect(row.refunded_minor).toBe(row.amount_minor);
    expect((await refundPayment(h.ctx, p.id, undefined, 'delivery_failed')).status).toBe('success');
    expect([...mock.refunds.values()].filter((x) => x.origin === p.partner_tx_id)).toHaveLength(1);
  });

  it('unknown complete outcome: reconcile via the status endpoint, hook once, no new attempt meanwhile', async () => {
    const co = await newCheckout();
    mock.failNext('complete', 'reset_after'); // Grab captured, but the response was lost
    const page = await callback(await toCallback(co.checkout_id));
    expect(page.body).toContain('Checking the payment');
    let [p] = await payment(co.checkout_id);
    expect(p).toMatchObject({ status: 'unknown', unknown_stage: 'complete' });
    expect(hookCalls).toHaveLength(0);
    // starting again reconciles first instead of charging again
    const inits = count('init');
    const r = await start(co.checkout_id, Number(p.amount_minor));
    expect(r.statusCode).toBe(302);
    expect(String(r.headers.location)).toBe(`/confirm/${co.checkout_id}`);
    expect(count('init')).toBe(inits);
    [p] = await payment(co.checkout_id);
    expect(p.status).toBe('captured');
    expect(hookCalls).toEqual([{ checkoutId: co.checkout_id, paymentId: p.id }]);
    await reconcile(h.ctx, p.id, { force: true });
    expect(hookCalls).toHaveLength(1);
    expect((await payment(co.checkout_id))).toHaveLength(1);
  });

  it('unknown complete outcome resolved by reconcile() directly', async () => {
    const co = await newCheckout();
    mock.failNext('complete', 'http_500');
    await callback(await toCallback(co.checkout_id));
    let [p] = await payment(co.checkout_id);
    expect(p.status).toBe('unknown');
    p = await reconcile(h.ctx, p.id);
    expect(p.status).toBe('captured');
    expect(hookCalls).toHaveLength(1);
    // the owner's "check again" page shows the result
    const page = await h.app.inject({ method: 'GET', url: `/pay/grab/payments/${p.id}`, headers: { cookie: alice.cookie } });
    expect(page.body).toContain('Payment received');
  });

  it('unknown init: Grab never got it -> retried with the same partnerTxID', async () => {
    const co = await newCheckout();
    const total = await totalOf(co.checkout_id);
    mock.failNext('init', 'reset_before');
    const r1 = await start(co.checkout_id, total);
    expect(r1.statusCode).toBe(202);
    const [p1] = await payment(co.checkout_id);
    expect(p1).toMatchObject({ status: 'unknown', unknown_stage: 'init' });
    const r2 = await start(co.checkout_id, total);
    expect(r2.statusCode).toBe(302);
    const rows = await payment(co.checkout_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: p1.id, status: 'authorizing', partner_tx_id: p1.partner_tx_id });
    expect(mock.txs.has(p1.partner_tx_id)).toBe(true);
  });

  it('unknown init: Grab got it but the response was lost -> that attempt fails, a new one starts', async () => {
    const co = await newCheckout();
    const total = await totalOf(co.checkout_id);
    mock.failNext('init', 'reset_after');
    expect((await start(co.checkout_id, total)).statusCode).toBe(202);
    const r2 = await start(co.checkout_id, total);
    expect(r2.statusCode).toBe(302);
    const rows = await payment(co.checkout_id);
    expect(rows.map((x: any) => x.status).sort()).toEqual(['authorizing', 'failed']);
    expect(rows.find((x: any) => x.status === 'failed').grab_reason).toBe('init_response_lost');
  });

  it('webhook: valid signature applies a capture once, invalid or stale signatures are refused', async () => {
    const co = await newCheckout();
    mock.failNext('complete', 'reset_after');
    await callback(await toCallback(co.checkout_id));
    const [p] = await payment(co.checkout_id);
    expect(p.status).toBe('unknown');
    const tx = mock.txs.get(p.partner_tx_id)!;
    const body = JSON.stringify({
      txType: 'Charge', txStatus: 'success', partnerID: CREDS.partnerId, partnerTxID: p.partner_tx_id, txID: tx.txID, origTxID: '', amount: Number(p.amount_minor), currency: 'THB',
      status: 'success', createdAt: 1790848800, completedAt: 1790848801, payload: { partnerGroupTxID: p.partner_group_tx_id, reason: '', paymentMethod: 'GPWALLET' },
    });
    const send = (headers: Record<string, string>, raw = body) => h.app.inject({ method: 'POST', url: '/webhooks/grabpay', headers, payload: raw });

    expect((await send(mock.signWebhook('/webhooks/grabpay', body, { secret: 'wrong' }))).statusCode).toBe(401);
    expect((await send(mock.signWebhook('/webhooks/grabpay', body, { date: new Date(Date.now() - 10 * 60 * 1000) }))).statusCode).toBe(401);
    expect((await send({ 'content-type': 'application/json' })).statusCode).toBe(401);
    const tampered = body.replace(`"amount":${Number(p.amount_minor)}`, '"amount":1');
    expect((await send(mock.signWebhook('/webhooks/grabpay', body), tampered)).statusCode).toBe(401);
    expect((await payment(co.checkout_id))[0].status).toBe('unknown');

    const ok = await send(mock.signWebhook('/webhooks/grabpay', body));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, outcome: 'charge_captured' });
    expect((await payment(co.checkout_id))[0].status).toBe('captured');
    expect(hookCalls).toHaveLength(1);
    const dup = await send(mock.signWebhook('/webhooks/grabpay', body));
    expect(dup.json()).toMatchObject({ ok: true, duplicate: true });
    expect(hookCalls).toHaveLength(1);

    // a correctly signed webhook with a different amount is recorded but not applied
    const other = await newCheckout();
    mock.failNext('complete', 'reset_after');
    await callback(await toCallback(other.checkout_id));
    const [q] = await payment(other.checkout_id);
    const wrongAmount = JSON.stringify({ txType: 'Charge', txStatus: 'success', partnerTxID: q.partner_tx_id, txID: mock.txs.get(q.partner_tx_id)!.txID, amount: 1, currency: 'THB' });
    const mm = await send(mock.signWebhook('/webhooks/grabpay', wrongAmount), wrongAmount);
    expect(mm.json()).toMatchObject({ outcome: 'amount_mismatch' });
    expect((await payment(other.checkout_id))[0].status).toBe('unknown');

    // unknown transactions are acknowledged (so Grab stops retrying) and recorded
    const stray = JSON.stringify({ txType: 'Charge', txStatus: 'success', partnerTxID: 'nope', txID: 'x', amount: 1, currency: 'THB' });
    expect((await send(mock.signWebhook('/webhooks/grabpay', stray), stray)).json()).toMatchObject({ outcome: 'unknown_transaction' });
  });
});

describe('GrabPay switched off', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ cfg: { grabpay: { ...baseGp('http://127.0.0.1:9'), enabled: false } } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('every payment route answers 404 and the service refuses', async () => {
    const s = await webLogin(h, 'off@example.com');
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    for (const url of [`/pay/grab/start/${id}?total_minor=100`, '/pay/grab/callback?code=a&state=b', `/pay/grab/payments/${id}`]) {
      const r = await h.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
      expect(r.statusCode, url).toBe(404);
    }
    const w = await h.app.inject({ method: 'POST', url: '/webhooks/grabpay', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(w.statusCode).toBe(404);
    await expect(startPayment(h.ctx, s.userId, id)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });

  it('default configuration has GrabPay off', () => {
    expect(loadGrabPayConfig('http://localhost:3000', 'test', {}).enabled).toBe(false);
  });
});
