// Contract tests for Live GrabExpress against the mock Grab server (test/support/grab-mock.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createCtx } from '../src/context.js';
import { createDb } from '../src/db/db.js';
import { loadGrabConfig } from '../src/providers/grab/config.js';
import { GrabLiveProvider } from '../src/providers/grab/provider.js';
import { GrabTokenCache } from '../src/providers/grab/token.js';
import { LiveGrabProvider } from '../src/providers/unavailable.js';
import { reconcileAttempt } from '../src/services/checkout.js';
import { setSubmissionsEnabled } from '../src/services/common.js';
import { addAddress } from '../src/services/users.js';
import { confirmOnWeb, Harness, mcpClient, oauthToken, startHarness, TEST_DB, webLogin } from './helpers.js';
import { GrabMock, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, mockGrabEnv, startGrabMock } from './support/grab-mock.js';

let mock: GrabMock;
let h: Harness;
const AUTH = mockGrabEnv({ url: '' } as any).GRAB_EXPRESS_WEBHOOK_AUTH;

async function liveUser(email: string) {
  const s = await webLogin(h, email);
  const mode = await h.app.inject({ method: 'POST', url: '/app/mode', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, region: 'TH', mode: 'live' } });
  expect(mode.statusCode).toBe(302);
  await addAddress(h.ctx, s.userId, {
    label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Khlong Toei', city: 'Bangkok', country: 'TH',
    coordinates: '13.7221034, 100.5678001', contact_name: 'Alex Sender', contact_phone: '+66 81 234 5678', instructions: 'Lobby',
  }, true);
  await addAddress(h.ctx, s.userId, {
    label: 'Office', line1: '999 Rama I Road', district: 'Pathum Wan', city: 'Bangkok', country: 'TH',
    coordinates: '13.746228, 100.534713', contact_name: 'Bee Recipient', contact_phone: '+66 89 765 4321',
  }, false);
  const tok = await oauthToken(h, s);
  const m = await mcpClient(h, tok.access_token);
  return { ...s, mcp: m };
}

const expressCart = (call: any, extra: Record<string, unknown> = {}) =>
  call('create_cart', { service: 'express', pickup: 'Home', dropoff: 'Office', parcel_weight_kg: 2, parcel_description: 'Documents', items: [{ item_id: 'express-bike', quantity: 1 }], ...extra });

async function submissionOf(checkoutId: string) {
  return (await h.db.query('SELECT * FROM submission_attempts WHERE checkout_id = $1', [checkoutId])).rows[0];
}

beforeAll(async () => {
  mock = await startGrabMock();
  h = await startHarness({ cfg: { grab: loadGrabConfig(mockGrabEnv(mock, { GRAB_EXPRESS: 'on' })), providerTimeoutMs: 4000 } });
  await setSubmissionsEnabled(h.db, 'live', true);
});
afterAll(async () => {
  await h.close();
  await mock.close();
});
beforeEach(() => {
  mock.knobs.createDelayMs = undefined;
  mock.knobs.createDropMs = undefined;
  mock.knobs.cancelConflict = false;
  mock.knobs.quoteError = undefined;
  mock.knobs.createError = undefined;
  mock.knobs.quoteAmount = 55;
});

describe('Grab config', () => {
  it('requires credentials and a webhook secret when a feature is on, and picks the documented hosts', () => {
    expect(() => loadGrabConfig({ GRAB_EXPRESS: 'on' })).toThrow(/GRAB_CLIENT_ID/);
    expect(() => loadGrabConfig({ GRAB_EXPRESS: 'on', GRAB_CLIENT_ID: 'a', GRAB_CLIENT_SECRET: 'b' })).toThrow(/GRAB_EXPRESS_WEBHOOK_AUTH/);
    expect(() => loadGrabConfig({ GRAB_FAREFEED: 'on' })).toThrow(/GRAB_CLIENT_ID/);
    expect(() => loadGrabConfig({ GRAB_EXPRESS: 'maybe' })).toThrow(/on or off/);
    expect(() => loadGrabConfig({ GRAB_API_BASE: 'http://grab.example.com' })).toThrow(/https/);
    expect(() => loadGrabConfig({ GRAB_EXPRESS_PAYMENT: 'card' })).toThrow(/cash, cashless/);
    const sb = loadGrabConfig({});
    expect(sb.express.enabled).toBe(false);
    expect(sb.express.baseUrl).toBe('https://partner-api.grab.com/grab-express-sandbox');
    expect(sb.farefeed.baseUrl).toBe('https://partner-api.stg-myteksi.com');
    expect(sb.express.payment).toBe('cash');
    expect(sb.express.serviceType).toBe('INSTANT');
    const prod = loadGrabConfig({ GRAB_ENV: 'production', GRAB_CLIENT_ID: 'a', GRAB_CLIENT_SECRET: 'b' });
    expect(prod.express.baseUrl).toBe('https://partner-api.grab.com/grab-express');
    expect(prod.express.creds!.tokenUrl).toBe('https://partner-api.grab.com/grabid/v1/oauth2/token');
    expect(prod.farefeed.baseUrl).toBe('https://partner-api.grab.com');
  });

  it('features off: live stays unavailable exactly as before and the webhook is not exposed', async () => {
    const cfg = loadConfig({ env: 'test', databaseUrl: TEST_DB, webOrigin: 'http://localhost:3000', grab: loadGrabConfig({}) });
    const db = createDb(TEST_DB, 2);
    try {
      const ctx = createCtx(cfg, db);
      expect(ctx.providers.live).toBeInstanceOf(LiveGrabProvider);
      for (const c of Object.values(ctx.providers.live.capabilities())) expect(c.available).toBe(false);
      expect(ctx.providers.live.capabilities().submit_order.reason).toMatch(/partner agreement/);
    } finally {
      await db.close();
    }
    expect(h.ctx.providers.live).toBeInstanceOf(GrabLiveProvider);
  });
});

describe('Token cache', () => {
  it('reuses one token, refreshes after a 401 once, and shares a concurrent refresh', async () => {
    const tokensBefore = mock.tokenRequests.length;
    const p = h.ctx.providers.live as GrabLiveProvider;
    const creds = h.cfg.grab.express.creds!;
    const t1 = await p.tokens.get(creds, 'grab_express.partner_deliveries');
    const t2 = await p.tokens.get(creds, 'grab_express.partner_deliveries');
    expect(t2).toBe(t1);
    // Concurrent callers on a fresh cache share one request.
    const fresh = new GrabTokenCache({ timeoutMs: 1000 });
    const all = await Promise.all(Array.from({ length: 5 }, () => fresh.get(creds, 'grab_express.partner_deliveries')));
    expect(new Set(all).size).toBe(1);
    expect(fresh.requests).toBe(1);
    // Wrong secret: a clear provider error, never a silent fallback.
    const bad = new GrabTokenCache({ timeoutMs: 1000 });
    await expect(bad.get({ ...creds, clientSecret: 'wrong' }, 'ride.estimate')).rejects.toThrow(/invalid_client/);
    expect(mock.tokenRequests.length - tokensBefore).toBe(3);
    expect(creds.clientId).toBe(MOCK_CLIENT_ID);
    expect(MOCK_CLIENT_SECRET).not.toBe('');
  });
});

describe('Live GrabExpress through MCP', () => {
  let u: Awaited<ReturnType<typeof liveUser>>;
  beforeAll(async () => {
    u = await liveUser('sender@example.com');
  });
  afterAll(async () => {
    await u.mcp.close();
  });

  it('estimate_trip maps live quotes per vehicle; the token is cached and refreshed after a 401', async () => {
    const tokens0 = mock.tokenRequests.length;
    const est = await u.mcp.call('estimate_trip', { service: 'express', pickup: 'Home', dropoff: 'Office', parcel_weight_kg: 2 });
    expect(est.ok).toBe(true);
    expect(est.mode).toBe('live');
    expect(est.notices.join(' ')).not.toMatch(/DEMO/);
    expect(est.result.options.map((o: any) => o.item_id)).toEqual(['express-bike', 'express-car', 'express-van']);
    expect(est.result.options[0].estimated_total).toMatchObject({ amount_minor: 5500, currency: 'THB' });
    const q = mock.ops('quotes').at(-1)!.body;
    expect(q.origin.coordinates).toEqual({ latitude: 13.722103, longitude: 100.5678 });
    expect(q.origin.address).toContain('Sukhumvit Soi 24');
    expect(q.packages[0].dimensions).toEqual({ height: 20, width: 30, depth: 25, weight: 2000 });
    expect(q.serviceType).toBe('INSTANT');
    expect(q.paymentMethod).toBe('CASH');
    const used = mock.tokenRequests.length - tokens0;
    expect(used).toBeLessThanOrEqual(1); // three quote calls, at most one token
    mock.expireTokens();
    const again = await u.mcp.call('estimate_trip', { service: 'express', pickup: 'Home', dropoff: 'Office', parcel_weight_kg: 2 });
    expect(again.ok).toBe(true);
    expect(mock.tokenRequests.length - tokens0).toBe(used + 1);
  });

  it('full flow: cart, human confirmation, delivery with merchantOrderID = submission id, webhooks to delivered', async () => {
    const cart = await expressCart(u.mcp.call);
    expect(cart.ok).toBe(true);
    expect(cart.result.quote.breakdown.total.amount_minor).toBe(5500);
    const checkout = cart.result.checkout;
    expect(checkout.payment_method).toMatch(/Cash/);
    expect(checkout.cancellation_terms).toMatch(/free cancellation/i);
    // Model text never confirms: submit_order before the human presses Confirm is refused.
    const early = await u.mcp.call('submit_order', { checkout_id: checkout.checkout_id });
    expect(early.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(mock.ops('create')).toHaveLength(0);

    const page = await h.app.inject({ url: `/confirm/${checkout.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.statusCode).toBe(200);
    const post = await confirmOnWeb(h, u, checkout.checkout_id);
    expect(post.statusCode).toBe(302);
    const sub = await submissionOf(checkout.checkout_id);
    expect(sub.status).toBe('accepted');
    const creates = mock.ops('create');
    expect(creates).toHaveLength(1);
    const body = creates[0].body;
    expect(body.merchantOrderID).toBe(sub.id);
    expect(body.paymentMethod).toBe('CASH');
    expect(body.payer).toBe('SENDER');
    expect(body.sender).toMatchObject({ firstName: 'Alex', lastName: 'Sender', phone: '66812345678', smsEnabled: false, instruction: 'Lobby' });
    expect(body.recipient).toMatchObject({ firstName: 'Bee', lastName: 'Recipient', phone: '66897654321', smsEnabled: true });
    expect(body.vehicleType).toBe('BIKE');
    const deliveryID = sub.provider_order_ref;
    expect(mock.deliveries.get(deliveryID)?.merchantOrderID).toBe(sub.id);

    // Idempotent: repeating submit_order does not create a second delivery.
    const again = await u.mcp.call('submit_order', { checkout_id: checkout.checkout_id });
    expect(again.ok).toBe(true);
    expect(mock.ops('create')).toHaveLength(1);

    const st = await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id });
    const orderId = st.result.order_id;
    expect(orderId).toBeTruthy();
    const ts = Math.floor(Date.now() / 1000);
    const hook = (status: string, t: number) => mock.emitWebhook(h.baseUrl, { deliveryID, merchantOrderID: sub.id, timestamp: t, status, driver: { name: 'D', phone: '6600000000' } }, { authorization: AUTH });
    expect((await hook('PICKING_UP', ts)).status).toBe(204);
    mock.setStatus(deliveryID, 'PICKING_UP');
    let o = (await h.db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    expect(o.fulfillment_status).toBe('preparing');
    expect((await hook('PENDING_DROP_OFF', ts + 60)).status).toBe(204);
    expect((await hook('COMPLETED', ts + 600)).status).toBe(204);
    // Duplicate and late webhooks are harmless.
    expect((await hook('COMPLETED', ts + 600)).status).toBe(204);
    expect((await hook('PICKING_UP', ts + 30)).status).toBe(204);
    o = (await h.db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    expect(o.fulfillment_status).toBe('delivered');
    expect(o.provider).toBe('grab');
    const raw = (await h.db.query('SELECT last_status FROM grab_deliveries WHERE delivery_id = $1', [deliveryID])).rows[0];
    expect(raw.last_status).toBe('COMPLETED');
    expect((await h.db.query('SELECT count(*)::int n FROM grab_webhook_events WHERE delivery_id = $1', [deliveryID])).rows[0].n).toBe(4);
    const view = await u.mcp.call('get_order_status', { order_id: orderId });
    expect(view.result.fulfillment_status ?? view.result.order?.fulfillment_status).toBe('delivered');
  });

  it('webhook authentication: wrong or missing secret is 401, bad body is 400', async () => {
    const payload = { deliveryID: 'IN-2-X', merchantOrderID: 'x', timestamp: 1, status: 'ALLOCATING' };
    expect((await mock.emitWebhook(h.baseUrl, payload, { authorization: 'nope' })).status).toBe(401);
    expect((await mock.emitWebhook(h.baseUrl, payload, {})).status).toBe(401);
    expect((await mock.emitWebhook(h.baseUrl, payload, { authorization: `${AUTH}x` })).status).toBe(401);
    expect((await mock.emitWebhook(h.baseUrl, { deliveryID: 'IN-2-X' }, { authorization: AUTH })).status).toBe(400);
    const r = await fetch(`${h.baseUrl}/webhooks/grab-express`, { method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json' }, body: '{not json' });
    expect(r.status).toBe(400);
    // Unknown delivery with valid auth: accepted (204) and ignored.
    expect((await mock.emitWebhook(h.baseUrl, payload, { authorization: AUTH })).status).toBe(204);
  });

  it('timeout on create: outcome unknown, no second POST, reconciled by the webhook carrying merchantOrderID', async () => {
    mock.knobs.createDelayMs = 2500; // stored at Grab, response arrives after the 1 s client timeout
    const cart = await expressCart(u.mcp.call);
    const co = cart.result.checkout.checkout_id;
    const post = await confirmOnWeb(h, u, co);
    expect(post.statusCode).toBe(302);
    let sub = await submissionOf(co);
    expect(sub.status).toBe('unknown');
    expect(mock.ops('create').filter((c) => c.body.merchantOrderID === sub.id)).toHaveLength(1);
    const st = await u.mcp.call('get_checkout_status', { checkout_id: co });
    expect(st.result.submission.status).toBe('unknown');
    // Reconciliation before the webhook: still unknown, and never a resend.
    await reconcileAttempt(h.ctx, sub.id);
    const rep = await u.mcp.call('submit_order', { checkout_id: co });
    expect(rep.ok === false ? rep.error.code : rep.result.status).toMatch(/SUBMISSION_UNKNOWN|unknown/);
    expect(mock.ops('create').filter((c) => c.body.merchantOrderID === sub.id)).toHaveLength(1);
    const d = [...mock.deliveries.values()].find((x) => x.merchantOrderID === sub.id)!;
    const r = await mock.emitWebhook(h.baseUrl, { deliveryID: d.deliveryID, merchantOrderID: sub.id, timestamp: Math.floor(Date.now() / 1000), status: 'PENDING_PICKUP' }, { authorization: AUTH });
    expect(r.status).toBe(204);
    sub = await submissionOf(co);
    expect(sub.status).toBe('accepted');
    expect(sub.provider_order_ref).toBe(d.deliveryID);
    const o = (await h.db.query('SELECT * FROM orders WHERE checkout_id = $1', [co])).rows[0];
    expect(o.fulfillment_status).toBe('accepted');
    expect(mock.ops('create').filter((c) => c.body.merchantOrderID === sub.id)).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 1600)); // let the delayed mock response finish
  });

  it('dropped create (nothing at Grab): after the wait cancel-by-merchant answers 404 and the submission ends as not received', async () => {
    mock.knobs.createDropMs = 1500;
    const cart = await expressCart(u.mcp.call);
    const co = cart.result.checkout.checkout_id;
    await confirmOnWeb(h, u, co);
    const sub = await submissionOf(co);
    expect(sub.status).toBe('unknown');
    await new Promise((res) => setTimeout(res, 700));
    h.clock.advance(11 * 60_000);
    try {
      for (let i = 0; i < 4; i++) {
        await reconcileAttempt(h.ctx, sub.id);
        h.clock.advance(60_000);
      }
    } finally {
      h.clock.advance(-15 * 60_000);
    }
    const after = await submissionOf(co);
    expect(after.status).toBe('rejected');
    expect(after.error_code).toBe('NOT_RECEIVED_BY_PROVIDER');
    expect((await h.db.query('SELECT state FROM grab_deliveries WHERE merchant_order_id = $1', [sub.id])).rows[0].state).toBe('not_found');
    expect(mock.ops('create').filter((c) => c.body.merchantOrderID === sub.id)).toHaveLength(1);
  });

  it('a lost response after Grab stored the delivery is cancelled by merchantOrderID when no webhook arrives', async () => {
    // Simulate a create that reached Grab but whose response never arrived and whose deliveryID is unknown.
    const cart = await expressCart(u.mcp.call);
    const co = cart.result.checkout.checkout_id;
    mock.knobs.createDelayMs = 2500;
    await confirmOnWeb(h, u, co);
    const sub = await submissionOf(co);
    expect(sub.status).toBe('unknown');
    // Make sure our row has no deliveryID (the late response is still pending at the mock).
    expect((await h.db.query('SELECT delivery_id FROM grab_deliveries WHERE merchant_order_id = $1', [sub.id])).rows[0].delivery_id).toBeNull();
    h.clock.advance(11 * 60_000);
    try {
      await reconcileAttempt(h.ctx, sub.id);
    } finally {
      h.clock.advance(-11 * 60_000);
    }
    const after = await submissionOf(co);
    expect(after.status).toBe('accepted');
    expect(after.provider_order_ref).toBe(`merchant:${sub.id}`);
    const o = (await h.db.query('SELECT fulfillment_status FROM orders WHERE checkout_id = $1', [co])).rows[0];
    expect(o.fulfillment_status).toBe('cancelled');
    expect([...mock.deliveries.values()].find((x) => x.merchantOrderID === sub.id)!.status).toBe('CANCELED');
    await new Promise((res) => setTimeout(res, 1600));
  });

  it('cancel flow: free before pickup with web confirmation; 409 from Grab is reported; not possible after pickup', async () => {
    const cart = await expressCart(u.mcp.call);
    const co = cart.result.checkout.checkout_id;
    await confirmOnWeb(h, u, co);
    const orderId = (await u.mcp.call('get_checkout_status', { checkout_id: co })).result.order_id;
    const deliveryID = (await submissionOf(co)).provider_order_ref;

    const prep = await u.mcp.call('prepare_cancellation', { order_id: orderId });
    expect(prep.ok).toBe(true);
    expect(prep.result.fee.amount_minor).toBe(0);
    const early = await u.mcp.call('cancel_order', { cancellation_id: prep.result.cancellation_id });
    expect(early.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(mock.ops('cancel')).toHaveLength(0);
    const post = await h.app.inject({ method: 'POST', url: `/confirm-cancel/${prep.result.cancellation_id}`, headers: { cookie: u.cookie }, payload: { _csrf: u.csrf, fee_minor: '0' } });
    expect(post.statusCode).toBe(302);
    const done = await u.mcp.call('cancel_order', { cancellation_id: prep.result.cancellation_id });
    expect(done.result.status).toBe('executed');
    expect(mock.deliveries.get(deliveryID)!.status).toBe('CANCELED');
    const st = await u.mcp.call('get_order_status', { order_id: orderId });
    expect(JSON.stringify(st.result)).toMatch(/"fulfillment_status":"cancelled"/);

    // Grab answers 409 although the status looked cancellable.
    const cart2 = await expressCart(u.mcp.call);
    await confirmOnWeb(h, u, cart2.result.checkout.checkout_id);
    const order2 = (await u.mcp.call('get_checkout_status', { checkout_id: cart2.result.checkout.checkout_id })).result.order_id;
    const prep2 = await u.mcp.call('prepare_cancellation', { order_id: order2 });
    mock.knobs.cancelConflict = true; // the confirm-cancel page executes right after approval
    await h.app.inject({ method: 'POST', url: `/confirm-cancel/${prep2.result.cancellation_id}`, headers: { cookie: u.cookie }, payload: { _csrf: u.csrf, fee_minor: '0' } });
    const r2 = await u.mcp.call('cancel_order', { cancellation_id: prep2.result.cancellation_id });
    expect(r2.result.status).toBe('rejected');
    expect(mock.deliveries.get((await submissionOf(cart2.result.checkout.checkout_id)).provider_order_ref)!.status).toBe('ALLOCATING');

    // After pickup: the terms say no.
    const id2 = (await submissionOf(cart2.result.checkout.checkout_id)).provider_order_ref;
    mock.setStatus(id2, 'PENDING_DROP_OFF');
    const prep3 = await u.mcp.call('prepare_cancellation', { order_id: order2 });
    expect(prep3.error.code).toBe('CANCELLATION_NOT_ALLOWED');
    expect(prep3.error.message).toMatch(/PENDING_DROP_OFF/);
  });

  it('Grab business errors become quote issues; a price change at submit is refused before any create', async () => {
    mock.knobs.quoteError = { status: 400, message: 'Package over weight limit' };
    const blocked = await expressCart(u.mcp.call, { parcel_weight_kg: 90 });
    expect(blocked.ok).toBe(true);
    expect(blocked.result.checkout).toBeNull();
    expect(blocked.result.quote.issues[0].code).toBe('WEIGHT_LIMIT');
    mock.knobs.quoteError = undefined;

    const cart = await expressCart(u.mcp.call);
    const creates = mock.ops('create').length;
    mock.knobs.quoteAmount = 61;
    const post = await confirmOnWeb(h, u, cart.result.checkout.checkout_id);
    expect(post.statusCode).toBe(409);
    expect(mock.ops('create')).toHaveLength(creates);
  });
});

describe('Live places and unavailable services', () => {
  let u: Awaited<ReturnType<typeof liveUser>>;
  beforeAll(async () => {
    u = await liveUser('places@example.com');
    await addAddress(h.ctx, u.userId, { label: 'Gym', line1: '55 Sathorn Road', district: 'Sathon', city: 'Bangkok', country: 'TH' }, false);
    await addAddress(h.ctx, u.userId, { label: 'Shop', line1: '7 Silom Road', district: 'Bang Rak', city: 'Bangkok', country: 'TH', coordinates: '13.728500, 100.534300' }, false);
  });
  afterAll(async () => {
    await u.mcp.close();
  });

  it('missing coordinates: clear ADDRESS_REQUIRED with a user action; landmarks are never used in Live', async () => {
    const r = await u.mcp.call('estimate_trip', { service: 'express', pickup: 'Gym', dropoff: 'Office', parcel_weight_kg: 1 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ADDRESS_REQUIRED');
    expect(r.error.user_action).toMatch(/coordinates/);
    expect(r.error.user_action).toContain('/app/addresses');
    const lm = await u.mcp.call('estimate_trip', { service: 'express', pickup: 'Siam Paragon', dropoff: 'Office', parcel_weight_kg: 1 });
    expect(lm.error.code).toBe('PLACE_NOT_FOUND');
    expect(lm.error.details.suggestions).toContain('Home');
    // Coordinates but no contact phone: refused before a delivery could be created.
    const nc = await u.mcp.call('estimate_trip', { service: 'express', pickup: 'Shop', dropoff: 'Office', parcel_weight_kg: 1 });
    expect(nc.error.code).toBe('ADDRESS_REQUIRED');
    expect(nc.error.user_action).toMatch(/contact/);
  });

  it('food and mart in Live: CAPABILITY_UNAVAILABLE with the explicit reason, no fallback', async () => {
    const r = await u.mcp.call('search_stores', { service: 'food', query: 'pad thai' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(r.error.details.reason).toBe('Grab has no public API to place Food or Mart orders for a customer; use Handoff mode');
    const m = await u.mcp.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-greencurry', quantity: 1 }] });
    expect(m.error.code).toBe('CAPABILITY_UNAVAILABLE');
    const caps = await u.mcp.call('get_capabilities');
    expect(caps.result.capabilities.available).toEqual(expect.arrayContaining(['cart', 'quote', 'checkout', 'submit_order', 'order_status', 'cancel_order']));
    expect(caps.result.capabilities.unavailable.search_restaurants).toMatch(/Food or Mart/);
  });

  it('address form accepts "lat, lng" and a phone, and validates them', async () => {
    const ok = await h.app.inject({
      method: 'POST', url: '/app/addresses', headers: { cookie: u.cookie },
      payload: { _csrf: u.csrf, label: 'Park', line1: '139 Witthayu Road', district: 'Pathum Wan', city: 'Bangkok', country: 'TH', coordinates: ' 13.731400, 100.541800 ', contact_name: 'Park Guard', contact_phone: '+66 2 252 7006' },
    });
    expect(ok.statusCode).toBe(302);
    const row = (await h.db.query(`SELECT latitude, longitude, contact_phone FROM addresses WHERE user_id = $1 AND label = 'Park'`, [u.userId])).rows[0];
    expect(row).toEqual({ latitude: 13.7314, longitude: 100.5418, contact_phone: '+6622527006' });
    const page = await h.app.inject({ url: '/app/addresses', headers: { cookie: u.cookie } });
    expect(page.body).toContain('13.731400, 100.541800');
    const badCoords = await h.app.inject({ method: 'POST', url: '/app/addresses', headers: { cookie: u.cookie }, payload: { _csrf: u.csrf, label: 'X', line1: '1 Test Road', district: 'Sathon', city: 'Bangkok', country: 'TH', coordinates: '13.7, 100.5' } });
    expect(badCoords.statusCode).toBe(400);
    const badPhone = await h.app.inject({ method: 'POST', url: '/app/addresses', headers: { cookie: u.cookie }, payload: { _csrf: u.csrf, label: 'Y', line1: '1 Test Road', district: 'Sathon', city: 'Bangkok', country: 'TH', contact_phone: '0812345678' } });
    expect(badPhone.statusCode).toBe(400);
  });
});
