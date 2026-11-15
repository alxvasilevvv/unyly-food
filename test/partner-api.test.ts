import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedHeaders, sign } from '../src/partners/auth.js';
import type { PartnerConfig } from '../src/partners/config.js';
import { deliverPartnerWebhooks } from '../src/partners/webhooks.js';
import { Harness, startHarness } from './helpers.js';

const ARI: PartnerConfig = { id: 'ari', name: 'Ari', secret: 'a'.repeat(40), webhookUrl: 'https://ari.example/hooks/unyly', webhookSecret: 'w'.repeat(40), mode: 'demo' };
const OTHER: PartnerConfig = { id: 'other', name: 'Other', secret: 'b'.repeat(40), webhookSecret: 'b'.repeat(40), mode: 'demo' };

let h: Harness;

async function call(p: PartnerConfig, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, opts: { headers?: Record<string, string> } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { ...signedHeaders(p, p.secret, method, url, raw, h.clock.now().getTime()), ...(raw ? { 'content-type': 'application/json' } : {}), ...opts.headers };
  const r = await h.app.inject({ method, url, headers, payload: raw || undefined });
  return { status: r.statusCode, json: r.json() as any };
}

beforeAll(async () => {
  h = await startHarness({ cfg: { partners: [ARI, OTHER] } });
});
afterAll(async () => {
  await h.close();
});

describe('Partner API: request signing', () => {
  it('accepts a correctly signed request', async () => {
    const r = await call(ARI, 'GET', '/partner/v1/ping');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, partner: 'ari', mode: 'demo' });
  });

  it('rejects a missing, wrong, replayed or stale signature with the same 401', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/ping' })).statusCode).toBe(401);
    const bad = signedHeaders(ARI, 'x'.repeat(40), 'GET', '/partner/v1/ping', '');
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', headers: bad })).statusCode).toBe(401);
    const good = signedHeaders(ARI, ARI.secret, 'GET', '/partner/v1/ping', '');
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', headers: good })).statusCode).toBe(200);
    const replay = await h.app.inject({ method: 'GET', url: '/partner/v1/ping', headers: good });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('PARTNER_AUTH_FAILED');
    const stale = signedHeaders(ARI, ARI.secret, 'GET', '/partner/v1/ping', '', Date.now() - 10 * 60_000);
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', headers: stale })).statusCode).toBe(401);
  });

  it('binds the signature to the path and the body', async () => {
    const hd = signedHeaders(ARI, ARI.secret, 'GET', '/partner/v1/ping', '');
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/catalog', headers: hd })).statusCode).toBe(401);
    const raw = JSON.stringify({ locale: 'en' });
    const hb = signedHeaders(ARI, ARI.secret, 'PUT', '/partner/v1/users/u-sig', raw);
    const tampered = await h.app.inject({ method: 'PUT', url: '/partner/v1/users/u-sig', headers: { ...hb, 'content-type': 'application/json' }, payload: JSON.stringify({ locale: 'th' }) });
    expect(tampered.statusCode).toBe(401);
  });

  it('serves the OpenAPI document publicly', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/partner/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    expect(r.json().paths['/partner/v1/users/{uid}/checkouts/{cid}/confirm']).toBeTruthy();
  });
});

describe('Partner API: ride from request to order', () => {
  const U = '/partner/v1/users/ari-user-1';

  it('creates the user, lists tools without submit_order, and returns the catalog', async () => {
    const r1 = await call(ARI, 'PUT', U, { locale: 'en', region: 'TH', display_name: 'Alex' });
    expect(r1.status).toBe(201);
    expect(r1.json.user).toMatchObject({ user_id: 'ari-user-1', mode: 'demo', created: true });
    const r2 = await call(ARI, 'PUT', U, { locale: 'ru' });
    expect(r2.status).toBe(200);
    expect(r2.json.user.locale).toBe('ru');
    await call(ARI, 'PUT', U, { locale: 'en' });
    const tools = await call(ARI, 'GET', '/partner/v1/tools');
    const names = tools.json.tools.map((t: any) => t.name);
    expect(names).toContain('estimate_trip');
    expect(names).not.toContain('submit_order');
    expect(JSON.stringify(tools.json)).not.toContain('confirm_url');
    const cat = await call(ARI, 'GET', '/partner/v1/catalog?lang=th');
    expect(cat.json.products.find((p: any) => p.id === 'express').status).toBe('built');
    expect(cat.json.markets).toHaveLength(8);
  });

  let checkout: any;
  it('estimate_trip returns an options card whose action creates the cart', async () => {
    const est = await call(ARI, 'POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Suvarnabhumi airport' } });
    expect(est.status).toBe(200);
    expect(est.json.card).toMatchObject({ schema: 'unyly.card.v1', type: 'options', service: 'ride', demo: true });
    const opt = est.json.card.options.find((o: any) => o.action);
    expect(opt.action.tool.name).toBe('create_cart');
    const cart = await call(ARI, 'POST', `${U}/tools/create_cart`, { arguments: opt.action.tool.arguments });
    expect(cart.status).toBe(200);
    expect(JSON.stringify(cart.json)).not.toContain('confirm_url');
    expect(cart.json.card.type).toBe('checkout');
    checkout = cart.json.card;
    const confirm = checkout.actions.find((a: any) => a.kind === 'confirm');
    expect(confirm.requires_user_verification).toBe('tap');
    expect(confirm.endpoint.body.confirm_hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses a confirmation for a different card (hash mismatch) and a chat-only "yes"', async () => {
    const path = `${U}/checkouts/${checkout.id}/confirm`;
    const wrong = await call(ARI, 'POST', path, { confirm_hash: '0'.repeat(40), user_verification: 'tap' });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error.code).toBe('CONFIRM_HASH_MISMATCH');
    const noVer = await call(ARI, 'POST', path, { confirm_hash: 'x' });
    expect(noVer.status).toBe(400);
  });

  let orderId: string;
  it('confirm places exactly one order, idempotently', async () => {
    const action = checkout.actions.find((a: any) => a.kind === 'confirm');
    const r = await call(ARI, 'POST', action.endpoint.path, { ...action.endpoint.body, user_verification: 'tap', confirmed_at: h.clock.now().toISOString() });
    expect(r.status).toBe(200);
    expect(r.json.order.card).toMatchObject({ type: 'order', service: 'ride' });
    expect(r.json.order.card.status.steps).toHaveLength(4);
    orderId = r.json.order.id;
    const again = await call(ARI, 'POST', action.endpoint.path, { ...action.endpoint.body, user_verification: 'tap' });
    expect(again.status).toBe(200);
    expect(again.json.order.id).toBe(orderId);
    const n = await h.db.query('SELECT count(*)::int n FROM orders WHERE checkout_id = $1', [checkout.id]);
    expect(n.rows[0].n).toBe(1);
    const audit = await h.db.query(`SELECT actor, details FROM audit_log WHERE action = 'checkout.approved' AND entity_id = $1`, [checkout.id]);
    expect(audit.rows[0]).toMatchObject({ actor: 'partner:ari', details: { user_verification: 'tap' } });
  });

  it('emits events with notify hints, and delivers them signed to the webhook', async () => {
    const ev = await call(ARI, 'GET', `${U}/events`);
    const types = ev.json.events.map((e: any) => e.type);
    expect(types).toContain('order.created');
    expect(types).toContain('checkout.confirmed');
    // The first status has no order.status_changed of its own: its push text rides on order.created.
    const created = ev.json.events.find((e: any) => e.type === 'order.created');
    expect(created.notify).toMatchObject({ title: 'Driver assigned', level: 'important', live_activity: { state: 'accepted' } });
    expect(created).toMatchObject({ partner_id: 'ari', user_id: 'ari-user-1' });
    // Advance the demo trip: status events carry a localized notify block.
    h.clock.advance(30 * 60_000);
    const card = await call(ARI, 'GET', `${U}/orders/${orderId}`);
    expect(card.status).toBe(200);
    const ev2 = await call(ARI, 'GET', `${U}/events?after=${ev.json.events.at(-1).seq}`);
    const st = ev2.json.events.find((e: any) => e.type === 'order.status_changed');
    expect(st.notify).toMatchObject({ level: expect.any(String), title: expect.any(String) });
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetcher = (async (url: string, init: any) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return new Response(null, { status: 204 });
    }) as any;
    const n = await deliverPartnerWebhooks(h.ctx, 50, fetcher);
    expect(n).toBeGreaterThan(0);
    const one = sent[0];
    expect(one.url).toBe(ARI.webhookUrl);
    const expected = sign(ARI.webhookSecret, 'POST', '/hooks/unyly', one.headers['x-unyly-timestamp'], one.headers['x-unyly-nonce'], one.body);
    expect(one.headers['x-unyly-signature']).toBe(expected);
    expect(JSON.parse(one.body).user_id).toBe('ari-user-1');
    // Webhook and polling carry the same sequence number.
    expect(JSON.parse(one.body).seq).toBe(ev.json.events.find((e: any) => e.event_id === JSON.parse(one.body).event_id).seq);
  });

  it('rejects an incomplete place with 400 and saves a complete one', async () => {
    const bad = await call(ARI, 'POST', `${U}/places`, { label: 'Home' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { fields: ['line1', 'district', 'city'] } });
    const noNumber = await call(ARI, 'POST', `${U}/places`, { label: 'Home', line1: 'Sukhumvit', district: 'Watthana', city: 'Bangkok' });
    expect(noNumber.status).toBe(400);
    const good = await call(ARI, 'POST', `${U}/places`, { label: 'Home', line1: '88 Sukhumvit Soi 24', district: 'Watthana', city: 'Bangkok', latitude: 13.7242, longitude: 100.5681 });
    expect(good.status).toBe(201);
    expect(good.json.place.label).toBe('Home');
  });

  it('cards and notifications for other locales are fully English, never mixed', async () => {
    const V = '/partner/v1/users/ari-vi';
    await call(ARI, 'PUT', V, { locale: 'vi' });
    const est = await call(ARI, 'POST', `${V}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM' } });
    expect(est.json.card.title).toBe('Choose a ride');
    expect(est.json.card.options[0].badges[0]).toMatch(/^\d+ seats?$/);
    const cart = await call(ARI, 'POST', `${V}/tools/create_cart`, { arguments: est.json.card.options[0].action.tool.arguments });
    expect(cart.json.card.total.label).toBe('Total');
    expect(cart.json.card.total.value).toMatch(/^฿/);
  });

  it('keeps users of different partners and different users apart', async () => {
    const other = await call(OTHER, 'PUT', '/partner/v1/users/ari-user-1', { locale: 'en' });
    expect(other.status).toBe(201);
    const peek = await call(OTHER, 'GET', `/partner/v1/users/ari-user-1/orders/${orderId}`);
    expect(peek.status).toBe(404);
    await call(ARI, 'PUT', '/partner/v1/users/ari-user-2', { locale: 'en' });
    const peek2 = await call(ARI, 'GET', `/partner/v1/users/ari-user-2/checkouts/${checkout.id}`);
    expect(peek2.status).toBe(404);
  });
});

describe('Partner API: Face ID for large totals, cancellation, deletion', () => {
  const U = '/partner/v1/users/ari-big';
  it('a large total needs biometric verification', async () => {
    h.cfg.stepUp = { enabled: true, thresholds: { THB: 100 } };
    await call(ARI, 'PUT', U, { locale: 'th' });
    const est = await call(ARI, 'POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM' } });
    const opt = est.json.card.options.find((o: any) => o.action);
    const cart = await call(ARI, 'POST', `${U}/tools/create_cart`, { arguments: opt.action.tool.arguments });
    const a = cart.json.card.actions.find((x: any) => x.kind === 'confirm');
    expect(a.requires_user_verification).toBe('biometric');
    const tap = await call(ARI, 'POST', a.endpoint.path, { ...a.endpoint.body, user_verification: 'tap' });
    expect(tap.status).toBe(403);
    expect(tap.json.error.code).toBe('STEP_UP_REQUIRED');
    const bio = await call(ARI, 'POST', a.endpoint.path, { ...a.endpoint.body, user_verification: 'biometric' });
    expect(bio.status).toBe(200);
    const orderId = bio.json.order.id;
    // Cancellation: a card with the fee, then the confirmed cancel.
    const prep = await call(ARI, 'POST', `${U}/orders/${orderId}/cancel`);
    expect(prep.status).toBe(200);
    expect(prep.json.card.type).toBe('cancellation');
    const c = prep.json.card.actions.find((x: any) => x.kind === 'confirm');
    const done = await call(ARI, 'POST', c.endpoint.path, { ...c.endpoint.body, user_verification: 'tap' });
    expect(done.status).toBe(200);
    expect(['executed', 'unknown', 'rejected']).toContain(done.json.cancellation.status);
  });

  it('DELETE removes the user and their data', async () => {
    const d = await call(ARI, 'DELETE', U);
    expect(d.json).toMatchObject({ ok: true, deleted: true });
    const again = await call(ARI, 'GET', `${U}/orders`);
    expect(again.status).toBe(404);
  });

  it('demo Grab link is simulated and reported as such', async () => {
    await call(ARI, 'PUT', '/partner/v1/users/ari-link', {});
    const l = await call(ARI, 'POST', '/partner/v1/users/ari-link/grab/link');
    expect(l.json).toMatchObject({ ok: true, status: 'linked', linked: true, simulated: true });
    const un = await call(ARI, 'DELETE', '/partner/v1/users/ari-link/grab');
    expect(un.json.grab.linked).toBe(false);
  });
});
