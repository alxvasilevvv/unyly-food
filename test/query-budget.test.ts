// Round trips to the database per step of the Ari flow. Production talks to a remote Postgres through a
// pooler (tens of milliseconds per statement), so the number of statements is what the user waits for.
// The bounds are a little above today's numbers: a change that adds reads or writes to a step fails here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedHeaders } from '../src/partners/auth.js';
import { Harness, startHarness } from './helpers.js';

let h: Harness;
let cookie = '';
const SECRET = 'q'.repeat(40);
const H = () => ({ 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' });

/** Runs one request and returns its JSON together with the database round trips it caused. */
async function counted<T>(fn: () => Promise<T>) {
  h.queries.reset();
  const out = await fn();
  return { out, trips: h.queries.roundTrips, tx: h.queries.transactions, log: [...h.queries.log] };
}
const post = async (url: string, body: unknown = {}) => {
  const r = await h.app.inject({ method: 'POST', url, headers: H(), payload: JSON.stringify(body) });
  const sc = r.headers['set-cookie'];
  if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json() as any;
};
const get = async (url: string) => {
  const r = await h.app.inject({ method: 'GET', url, headers: H() });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as any;
};
const api = async (method: string, url: string, body?: unknown) => {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const r = await h.app.inject({
    method: method as any, url, payload: raw || undefined,
    headers: { ...signedHeaders({ id: 'ari' }, SECRET, method, url, raw, h.clock.now().getTime()), ...(raw ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: r.statusCode, json: r.json() as any, headers: r.headers };
};

beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 100, partners: [{ id: 'ari', name: 'Ari', secret: SECRET, webhookSecret: 'w'.repeat(40), mode: 'demo' }] } });
});
afterAll(async () => {
  await h.close();
});

describe('database round trips per step', () => {
  let orderId = '';

  it('website demo: session, message, action, confirm', async () => {
    const s = await counted(() => post('/ari/api/session?lang=ru'));
    expect(s.trips).toBeLessThanOrEqual(5); // BEGIN with the guest lock, the count, the user, the home address, COMMIT
    expect(s.tx).toBe(1); // the guest and the demo home address are created together
    expect(s.out.grab.linked).toBe(false);
    expect(s.out.last_event).toBe(0);
    const again = await counted(() => post('/ari/api/session?lang=ru'));
    expect(again.trips).toBe(1); // the user, the Grab link and the newest event number in one statement
    expect(again.out.user.id).toBe(s.out.user.id);

    const m = await counted(() => post('/ari/api/message?lang=ru', { text: 'Такси от Сиам Парагона до аэропорта Суварнабхуми' }));
    expect(m.out.card.type).toBe('options');
    expect(m.trips).toBe(1); // the user and the saved places together
    expect(m.tx).toBe(0);

    const opt = m.out.card.options.find((o: any) => o.action);
    const a = await counted(() => post('/ari/api/action?lang=ru', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments }));
    expect(a.out.card.type).toBe('checkout');
    expect(a.trips).toBeLessThanOrEqual(8); // user, cart, quote, one transaction of four round trips, the card
    expect(a.tx).toBe(1);

    const confirm = a.out.card.actions.find((x: any) => x.kind === 'confirm');
    const c = await counted(() => post('/ari/api/confirm?lang=ru', { checkout_id: a.out.card.id, confirm_hash: confirm.endpoint.body.confirm_hash }));
    expect(c.out.card.type).toBe('order');
    expect(c.out.trace[0].grab).toMatch(/Ride booking/);
    // user + checkout, one transaction (BEGIN with the cart lock, checkout lock + reads, writes, COMMIT), the provider,
    // and one statement for the order with its events. The answer is built from the rows those statements returned.
    expect(c.trips).toBeLessThanOrEqual(7);
    expect(c.tx).toBe(1);
    orderId = c.out.order_id;
  });

  it('website demo: a poll with no news is one read and writes nothing', async () => {
    await get(`/ari/api/orders/${orderId}?lang=ru`); // picks up whatever the simulation has by now
    const p = await counted(() => get(`/ari/api/orders/${orderId}?lang=ru`));
    expect(p.out.card.type).toBe('order');
    expect(p.trips).toBe(1);
    expect(p.tx).toBe(0);
    expect(p.log.some((x) => /^\s*(tx )?(INSERT|UPDATE|DELETE)/i.test(x))).toBe(false);

    const ev = await counted(() => get('/ari/api/events?after=0'));
    expect(ev.trips).toBe(1);
    const types = ev.out.events.map((e: any) => e.type);
    expect(types).toContain('order.created');
    expect(types).toContain('checkout.confirmed');
    const none = await counted(() => get(`/ari/api/events?after=${ev.out.events.at(-1).seq}`));
    expect(none.trips).toBe(1);
    expect(none.out.events).toEqual([]);
  });

  it('a status change is still picked up by the poll, written once and sent as an event', async () => {
    const before = (await get(`/ari/api/orders/${orderId}?lang=ru`)).card.status.code;
    const seq = (await get('/ari/api/events?after=0')).events.at(-1).seq;
    h.clock.advance(10 * 60_000);
    const p = await counted(() => get(`/ari/api/orders/${orderId}?lang=ru`));
    expect(p.out.card.status.code).not.toBe(before);
    expect(p.trips).toBeLessThanOrEqual(3); // the read, the simulator step, the order (update, audit and event in one statement)
    expect(p.tx).toBe(0);
    const stored = (await h.db.query('SELECT fulfillment_status FROM orders WHERE id = $1', [orderId])).rows[0];
    expect(stored.fulfillment_status).toBe(p.out.card.status.code);
    const ev = (await get(`/ari/api/events?after=${seq}`)).events;
    expect(ev.map((e: any) => e.type)).toContain('order.status_changed');
    // The push text is in the language of the user (Russian here), chosen in the same statement that stores the event.
    expect(ev.find((e: any) => e.type === 'order.status_changed').notify.title).toMatch(/[а-яё]/i);
    const again = await counted(() => get(`/ari/api/orders/${orderId}?lang=ru`));
    expect(again.tx).toBe(0);
  });

  it('the order.created event carries the same ETA as the stored order after the demo speed-up', async () => {
    const o = (await h.db.query('SELECT eta_at, created_at FROM orders WHERE id = $1', [orderId])).rows[0];
    const ev = (await get('/ari/api/events?after=0')).events.find((e: any) => e.type === 'order.created');
    expect(ev.notify.live_activity.eta_at).toBe(new Date(o.eta_at).toISOString());
    // Presentation speed: the whole trip takes minutes, never less than 30 seconds.
    const secs = (new Date(o.eta_at).getTime() - new Date(o.created_at).getTime()) / 1000;
    expect(secs).toBeGreaterThanOrEqual(30);
    expect(secs).toBeLessThan(15 * 60);
  });

  it('Partner API: one tool call, confirm and the polls', async () => {
    const U = '/partner/v1/users/budget-user';
    const created = await counted(() => api('PUT', U, { locale: 'en' }));
    expect(created.out.status).toBe(201);
    const existing = await counted(() => api('PUT', U, { locale: 'th', display_name: 'Nok' }));
    expect(existing.out.status).toBe(200);
    expect(existing.out.json.user).toMatchObject({ locale: 'th', display_name: 'Nok', created: false });
    expect(existing.trips).toBeLessThanOrEqual(3); // nonce, user, Grab link
    expect((await api('GET', U)).json.user).toMatchObject({ locale: 'th', display_name: 'Nok' });
    expect((await api('POST', `${U}/places`, { label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Watthana', city: 'Bangkok' })).status).toBe(201);

    const est = await counted(() => api('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Home', dropoff: 'Suvarnabhumi airport' } }));
    expect(est.out.json.ok).toBe(true);
    expect(est.trips).toBeLessThanOrEqual(4); // nonce, user, saved places (read once for both ends of the trip)
    expect(est.tx).toBe(0);

    const opt = est.out.json.card.options.find((o: any) => o.action);
    const cart = await counted(() => api('POST', `${U}/tools/create_cart`, { arguments: opt.action.tool.arguments }));
    expect(cart.out.json.card.type).toBe('checkout');
    expect(cart.trips).toBeLessThanOrEqual(11);

    const cf = cart.out.json.card.actions.find((x: any) => x.kind === 'confirm');
    const done = await counted(() => api('POST', cf.endpoint.path, { ...cf.endpoint.body, user_verification: 'biometric' }));
    expect(done.out.status).toBe(200);
    expect(done.trips).toBeLessThanOrEqual(10); // nonce, user, checkout, the seven of the confirmation itself
    expect(done.tx).toBe(1);
    const oid = done.out.json.order.id;

    await api('GET', `${U}/orders/${oid}`);
    const poll = await counted(() => api('GET', `${U}/orders/${oid}`));
    expect(poll.out.json.card.type).toBe('order');
    expect(poll.trips).toBeLessThanOrEqual(4); // nonce, user, order, provider
    expect(poll.tx).toBe(0);

    const ev = await counted(() => api('GET', `${U}/events?after=0`));
    expect(ev.trips).toBe(2); // nonce, user and events together
    expect(ev.out.json.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['order.created', 'checkout.confirmed']));

    const search = await counted(() => api('POST', `${U}/tools/search_stores`, { arguments: { service: 'food', party_size: 2 } }));
    expect(search.out.json.ok).toBe(true);
    expect(search.trips).toBeLessThanOrEqual(4);
  });

  it('events of an unknown or deleted user are a 404, not an empty list', async () => {
    expect((await api('GET', '/partner/v1/users/nobody-here/events?after=0')).status).toBe(404);
    await api('PUT', '/partner/v1/users/short-lived', {});
    expect((await api('GET', '/partner/v1/users/short-lived/events')).json.events).toEqual([]);
    expect((await api('DELETE', '/partner/v1/users/short-lived')).status).toBe(200);
    expect((await api('GET', '/partner/v1/users/short-lived/events')).status).toBe(404);
    const bad = await api('GET', '/partner/v1/users/bad%20id/events');
    expect(bad.status).toBe(400);
  });

  it('server-timing is sent on the demo API and the Partner API only', async () => {
    const a = await h.app.inject({ method: 'POST', url: '/ari/api/session', headers: H(), payload: '{}' });
    expect(String(a.headers['server-timing'])).toMatch(/^app;dur=\d+(\.\d+)?$/);
    const p = await api('GET', '/partner/v1/ping');
    expect(String(p.headers['server-timing'])).toMatch(/^app;dur=\d+(\.\d+)?$/);
    const unsigned = await h.app.inject({ method: 'GET', url: '/partner/v1/ping' });
    // No precise timing of a failed signature check for an unsigned caller.
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.headers['server-timing']).toBeUndefined();
    const page = await h.app.inject({ method: 'GET', url: '/' });
    expect(page.headers['server-timing']).toBeUndefined();
  });
});
