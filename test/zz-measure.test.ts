// TEMPORARY measurement (deleted before finishing)
import { afterAll, beforeAll, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Harness, startHarness } from './helpers.js';
import { signedHeaders } from '../src/partners/auth.js';

let h: Harness;
let cookie = '';
const SECRET = 'a'.repeat(40);
const out: string[] = [];
const H = () => ({ 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' });
const step = async (name: string, fn: () => Promise<any>) => {
  h.queries.reset();
  const r = await fn();
  out.push(`### ${name}: roundTrips=${h.queries.roundTrips} statements=${h.queries.statements} tx=${h.queries.transactions}`);
  if (process.env.MEASURE_LOG) out.push(...h.queries.log.map((x) => '    ' + x));
  return r;
};
const post = async (url: string, body: unknown = {}) => {
  const r = await h.app.inject({ method: 'POST', url, headers: H(), payload: JSON.stringify(body) });
  const sc = r.headers['set-cookie'];
  if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
  if (r.statusCode >= 400) throw new Error(url + ' ' + r.body);
  return r.json() as any;
};
const get = async (url: string) => (await h.app.inject({ method: 'GET', url, headers: H() })).json() as any;
const api = async (method: string, url: string, body?: unknown) => {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const r = await h.app.inject({ method: method as any, url, headers: { ...signedHeaders({ id: 'ari' }, SECRET, method, url, raw), ...(raw ? { 'content-type': 'application/json' } : {}) }, payload: raw || undefined });
  if (r.statusCode >= 400) throw new Error(url + ' ' + r.body);
  return r.json() as any;
};

beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 100, partners: [{ id: 'ari', name: 'Ari', secret: SECRET, webhookSecret: 'b'.repeat(40), mode: 'demo' }] } });
});
afterAll(async () => {
  await h.close();
  writeFileSync(process.env.MEASURE_OUT || '/tmp/measure.txt', out.join('\n') + '\n');
});

it('measure', async () => {
  await step('web session create', () => post('/ari/api/session?lang=en'));
  await step('web session again', () => post('/ari/api/session?lang=en'));
  const m = await step('web message(ride)', () => post('/ari/api/message?lang=en', { text: 'Taxi from Siam Paragon to Suvarnabhumi airport' }));
  const opt = m.card.options.find((o: any) => o.action);
  const a = await step('web action(create_cart)', () => post('/ari/api/action?lang=en', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments }));
  const confirm = a.card.actions.find((x: any) => x.kind === 'confirm');
  const c = await step('web confirm', () => post('/ari/api/confirm?lang=en', { checkout_id: a.card.id, confirm_hash: confirm.endpoint.body.confirm_hash }));
  await step('web order poll (no change)', () => get(`/ari/api/orders/${c.order_id}?lang=en`));
  await step('web order poll 2 (no change)', () => get(`/ari/api/orders/${c.order_id}?lang=en`));
  const ev = await step('web events poll', () => get('/ari/api/events?after=0'));
  await step('web events poll (nothing new)', () => get(`/ari/api/events?after=${ev.events.at(-1).seq}`));
  h.clock.advance(60_000);
  await step('web order poll (status changed)', () => get(`/ari/api/orders/${c.order_id}?lang=en`));
  await step('web message(food)', () => post('/ari/api/message?lang=en', { text: 'Dinner for two under 600 baht, no nuts' }));
  await step('web message(shop->checkout)', () => post('/ari/api/message?lang=en', { text: 'Paracetamol and plasters' }));
  await step('web message(track)', () => post('/ari/api/message?lang=en', { text: 'where is my order' }));

  const U = '/partner/v1/users/u1';
  await step('api PUT user (create)', () => api('PUT', U, { locale: 'en' }));
  await step('api PUT user (existing)', () => api('PUT', U, { locale: 'en' }));
  await step('api POST place', () => api('POST', `${U}/places`, { label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Watthana', city: 'Bangkok' }));
  const e = await step('api tool estimate_trip', () => api('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Suvarnabhumi airport' } }));
  const o2 = e.card.options.find((o: any) => o.action);
  const cc = await step('api tool create_cart', () => api('POST', `${U}/tools/create_cart`, { arguments: o2.action.tool.arguments }));
  const cf = cc.card.actions.find((x: any) => x.kind === 'confirm');
  const done = await step('api confirm', () => api('POST', cf.endpoint.path, { ...cf.endpoint.body, user_verification: 'biometric' }));
  await step('api order poll (no change)', () => api('GET', `${U}/orders/${done.order.id}`));
  const ev2 = await step('api events poll', () => api('GET', `${U}/events?after=0`));
  await step('api events poll (nothing new)', () => api('GET', `${U}/events?after=${ev2.events.at(-1).seq}`));
  await step('api tool search_stores', () => api('POST', `${U}/tools/search_stores`, { arguments: { service: 'food', party_size: 2 } }));
  await step('api tool get_order_status', () => api('POST', `${U}/tools/get_order_status`, { arguments: { order_id: done.order.id } }));
  const pc = await step('api prepare cancel', () => api('POST', `${U}/orders/${done.order.id}/cancel`));
  const xc = pc.card.actions.find((x: any) => x.kind === 'confirm');
  await step('api confirm cancel', () => api('POST', xc.endpoint.path, { ...xc.endpoint.body, user_verification: 'tap' }));
});
