import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, startHarness } from './helpers.js';

let h: Harness;
let cookie = '';
const H = () => ({ 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' });
const post = async (url: string, body: unknown = {}) => {
  const r = await h.app.inject({ method: 'POST', url, headers: H(), payload: JSON.stringify(body) });
  const sc = r.headers['set-cookie'];
  if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
  return { status: r.statusCode, json: r.json() as any };
};
const get = async (url: string) => {
  const r = await h.app.inject({ method: 'GET', url, headers: H() });
  return { status: r.statusCode, json: r.json() as any };
};

beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 100 } });
});
afterAll(async () => {
  await h.close();
});

describe('Website Ari demo (/ari)', () => {
  it('refuses cross-site calls and calls without a session', async () => {
    const x = await h.app.inject({ method: 'POST', url: '/ari/api/session', headers: { origin: 'https://evil.example', 'x-ari-demo': '1' } });
    expect(x.statusCode).toBe(401);
    const y = await h.app.inject({ method: 'POST', url: '/ari/api/message', headers: { 'x-ari-demo': '1', 'content-type': 'application/json' }, payload: '{"text":"hi"}' });
    expect(y.statusCode).toBe(401);
  });

  it('runs a ride from sentence to tracked order through the partner path', async () => {
    const s = await post('/ari/api/session?lang=ru');
    expect(s.status).toBe(200);
    expect(s.json.greeting).toContain('Ari');
    const m = await post('/ari/api/message?lang=ru', { text: 'Такси от Сиам Парагона до аэропорта Суварнабхуми' });
    expect(m.json.card.type).toBe('options');
    expect(m.json.trace[0].call).toMatch(/tools\/estimate_trip$/);
    const opt = m.json.card.options.find((o: any) => o.action);
    const a = await post('/ari/api/action?lang=ru', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments });
    expect(a.json.card.type).toBe('checkout');
    expect(a.json.card.footnote).toContain('Демо');
    const confirm = a.json.card.actions.find((x: any) => x.kind === 'confirm');
    const c = await post('/ari/api/confirm?lang=ru', { checkout_id: a.json.card.id, confirm_hash: confirm.endpoint.body.confirm_hash, user_verification: 'biometric' });
    expect(c.status).toBe(200);
    expect(c.json.card.type).toBe('order');
    expect(c.json.card.courier.fictional).toBe(true);
    h.clock.advance(10 * 60_000);
    const o = await get(`/ari/api/orders/${c.json.order_id}?lang=ru`);
    expect(o.json.card.status.code).not.toBe('submitted');
    const ev = await get('/ari/api/events?after=0');
    expect(ev.json.events.map((e: any) => e.type)).toContain('order.created');
    const bad = await post('/ari/api/action', { tool: 'submit_order', arguments: {} });
    expect(bad.status).toBe(400);
  });

  it('a food request returns restaurant options and a shop request a checkout', async () => {
    const f = await post('/ari/api/message?lang=en', { text: 'Dinner for two under 600 baht, no nuts' });
    expect(f.json.card.type).toBe('options');
    expect(f.json.card.options.length).toBeGreaterThan(0);
    const s = await post('/ari/api/message?lang=th', { text: 'พาราเซตามอลกับพลาสเตอร์' });
    expect(s.json.card.type).toBe('checkout');
  });
});
