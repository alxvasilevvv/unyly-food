// DEMO_DB=memory: the website demo (/ari) runs on the embedded in-process database. The whole flow must work
// there and must not touch the shared Postgres at all: no rows, no round trips.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMemoryDemoCtx } from '../src/demo-ctx.js';
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
const confirmCard = (card: any) => post('/ari/api/confirm?lang=en', {
  checkout_id: card.id, confirm_hash: card.actions.find((x: any) => x.kind === 'confirm').endpoint.body.confirm_hash, user_verification: 'biometric',
});
/** Rows of web demo users in the shared Postgres (read through a query that is not counted as app traffic). */
const sharedDemoUsers = async () => {
  const before = { ...h.queries, log: [...h.queries.log] };
  const n = (await h.db.query(`SELECT (SELECT count(*) FROM users WHERE partner_id = 'ari-web') + (SELECT count(*) FROM partner_users WHERE partner_id = 'ari-web') + (SELECT count(*) FROM orders) + (SELECT count(*) FROM demo_sim_orders) + (SELECT count(*) FROM partner_webhooks) AS n`)).rows[0].n;
  Object.assign(h.queries, before);
  return n;
};

beforeAll(async () => {
  h = await startHarness({ cfg: { demoDb: 'memory', guestPerIpHourly: 100 } });
  h.queries.reset();
});
afterAll(async () => {
  await h.close();
});

describe('Website Ari demo on the embedded database (DEMO_DB=memory)', () => {
  it('the flag is validated and the demo context is separate from the main one', () => {
    expect(h.demo).not.toBeNull();
    expect(h.ctx.demoCtx).toBe(h.demo!.ctx);
    expect(h.ctx.demoCtx!.db).not.toBe(h.ctx.db);
    expect(h.ctx.demoCtx!.providers.demo).not.toBe(h.ctx.providers.demo);
    expect(h.ctx.demoCtx!.clock).toBe(h.ctx.clock);
    expect(loadConfig({ env: 'test' }).demoDb).toBe('shared');
    expect(() => loadConfig({ env: 'test', demoDb: 'sqlite' as any })).toThrow(/DEMO_DB/);
    const old = process.env.DEMO_DB;
    try {
      process.env.DEMO_DB = 'memory';
      expect(loadConfig({ env: 'test' }).demoDb).toBe('memory');
      process.env.DEMO_DB = 'ram';
      expect(() => loadConfig({ env: 'test' })).toThrow(/DEMO_DB must be shared or memory/);
    } finally {
      if (old === undefined) delete process.env.DEMO_DB;
      else process.env.DEMO_DB = old;
    }
  });

  it('falls back to the shared database when the process is above the memory ceiling', async () => {
    const notes: string[] = [];
    const none = await createMemoryDemoCtx({ ...h.cfg, demoDbMaxRssMb: 1 }, h.clock, (m) => notes.push(m));
    expect(none).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/DEMO_DB_MAX_RSS_MB=1; the web demo uses the shared database/);
    expect(() => loadConfig({ env: 'test', demoDbMaxRssMb: 0 })).toThrow(/DEMO_DB_MAX_RSS_MB/);
  });

  it('a ride goes from the sentence to delivered', async () => {
    const s = await post('/ari/api/session?lang=en');
    expect(s.status).toBe(200);
    expect(s.json.user.id).toMatch(/^web-/);
    const m = await post('/ari/api/message?lang=en', { text: 'Taxi from Siam Paragon to Suvarnabhumi airport' });
    expect(m.json.card.type).toBe('options');
    const opt = m.json.card.options.find((o: any) => o.action);
    const a = await post('/ari/api/action?lang=en', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments });
    expect(a.json.card.type).toBe('checkout');
    const c = await confirmCard(a.json.card);
    expect(c.status).toBe(200);
    expect(c.json.card.type).toBe('order');
    expect(['submitted', 'accepted']).toContain(c.json.card.status.code);
    expect(typeof c.json.card.status.eta_at).toBe('string');
    const first = await get(`/ari/api/orders/${c.json.order_id}?lang=en`);
    expect(first.json.card.status.eta_at).toBe(c.json.card.status.eta_at);
    const seen = new Set<string>();
    for (let i = 0; i < 12 && !seen.has('delivered'); i++) {
      h.clock.advance(60_000);
      const o = await get(`/ari/api/orders/${c.json.order_id}?lang=en`);
      expect(o.status).toBe(200);
      seen.add(o.json.card.status.code);
    }
    expect([...seen]).toContain('delivered');
    expect(seen.size).toBeGreaterThan(1);
    const ev = await get('/ari/api/events?after=0');
    const types = ev.json.events.map((e: any) => e.type);
    expect(types).toContain('order.created');
    expect(ev.json.events.some((e: any) => e.type === 'order.status_changed' && e.data.status === 'delivered' && e.data.is_final === true)).toBe(true);
    expect(ev.json.events.map((e: any) => e.seq)).toEqual([...ev.json.events.map((e: any) => e.seq)].sort((x: number, y: number) => x - y));
    expect(new Date(ev.json.events[0].created_at).getTime()).toBeGreaterThan(Date.now() - 3600_000);
    // "Where is my order" reads the same order back.
    const where = await post('/ari/api/message?lang=en', { text: 'where is my order' });
    expect(where.json.order_id).toBe(c.json.order_id);
  });

  it('a food order: restaurants, a cart, the confirmation, the order', async () => {
    const f = await post('/ari/api/message?lang=en', { text: 'Dinner for two under 600 baht, no nuts' });
    expect(f.json.card.type).toBe('options');
    const opt = f.json.card.options.find((o: any) => o.action);
    const a = await post('/ari/api/action?lang=en', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments });
    expect(a.status).toBe(200);
    let card = a.json.card;
    // A restaurant row may open the store first; the next action builds the cart.
    for (let i = 0; i < 3 && card?.type !== 'checkout'; i++) {
      const next = (card.options ?? []).map((o: any) => o.action).concat((card.actions ?? []).map((x: any) => x)).find((x: any) => x?.tool);
      expect(next, JSON.stringify(card).slice(0, 400)).toBeTruthy();
      card = (await post('/ari/api/action?lang=en', { tool: next.tool.name, arguments: next.tool.arguments })).json.card;
    }
    expect(card.type).toBe('checkout');
    expect(card.lines.length).toBeGreaterThan(0);
    const c = await confirmCard(card);
    expect(c.status).toBe(200);
    expect(c.json.card.type).toBe('order');
    expect(c.json.card.service).toBe('food');
  });

  it('a shop order can be cancelled', async () => {
    const m = await post('/ari/api/message?lang=en', { text: 'Paracetamol and plasters' });
    expect(m.json.card.type).toBe('checkout');
    const c = await confirmCard(m.json.card);
    expect(c.json.card.actions.map((x: any) => x.kind)).toEqual(['prepare_cancel']);
    const p = await post('/ari/api/cancel?lang=en', { order_id: c.json.order_id });
    expect(p.status).toBe(200);
    expect(p.json.card.type).toBe('cancellation');
    const confirm = p.json.card.actions.find((x: any) => x.kind === 'confirm');
    const done = await post('/ari/api/cancel/confirm?lang=en', { cancellation_id: p.json.card.id, confirm_hash: confirm.endpoint.body.confirm_hash, user_verification: 'tap' });
    expect(done.status).toBe(200);
    expect(done.json.reply).toBe('Cancelled.');
    expect(done.json.card.status.code).toBe('cancelled');
    const o = await get(`/ari/api/orders/${c.json.order_id}?lang=en`);
    expect(o.json.card.status.code).toBe('cancelled');
    // A declined checkout and the simulated Grab link use transactions of their own.
    const again = await post('/ari/api/message?lang=en', { text: 'Red roses with a gift box' });
    const declined = await post('/ari/api/decline?lang=en', { checkout_id: again.json.card.id });
    expect(declined.status).toBe(200);
    const link = await post('/ari/api/grab-link?lang=en');
    expect(link.json.grab).toMatchObject({ status: 'linked', linked: true, simulated: true });
  });

  it('the session resumes with its user, events and locale', async () => {
    const before = await get('/ari/api/events?after=0');
    const last = Math.max(...before.json.events.map((e: any) => e.seq));
    const again = await post('/ari/api/session?lang=ru');
    expect(again.status).toBe(200);
    expect(again.json.last_event).toBe(last);
    expect(again.json.grab.linked).toBe(true);
    expect((await get(`/ari/api/events?after=${last}`)).json.events).toEqual([]);
    const users = await h.demoDb.query(`SELECT u.locale, u.is_guest, u.created_at FROM users u WHERE u.partner_id = 'ari-web'`);
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0].created_at).toBeInstanceOf(Date);
    const ru = await post('/ari/api/message?lang=ru', { text: 'где мой заказ' });
    expect(ru.json.reply).toMatch(/[а-яё]/i);
    expect((await h.demoDb.query(`SELECT locale FROM users WHERE partner_id = 'ari-web'`)).rows[0].locale).toBe('ru');
  });

  it('nothing reached the shared database: no rows and no round trips', async () => {
    expect(h.queries.roundTrips).toBe(0);
    expect(h.queries.log).toEqual([]);
    expect(await sharedDemoUsers()).toBe(0);
    const mem = (await h.demoDb.query(`SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM demo_sim_orders) AS sim, (SELECT count(*) FROM partner_webhooks) AS events`)).rows[0];
    expect(mem.orders).toBe(3);
    expect(mem.sim).toBe(3);
    expect(mem.events).toBeGreaterThan(5);
    // The rest of the site still uses the shared database.
    expect((await h.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect(h.queries.roundTrips).toBeGreaterThan(0);
  });

  it('parallel visitors do not block each other', async () => {
    const visit = async (i: number) => {
      const s = await h.app.inject({ method: 'POST', url: '/ari/api/session?lang=en', headers: { 'x-ari-demo': '1', 'content-type': 'application/json' }, payload: '{}', remoteAddress: `10.1.0.${i + 1}` });
      const ck = String(s.headers['set-cookie']).split(';')[0];
      const hd = { 'x-ari-demo': '1', 'content-type': 'application/json', cookie: ck };
      const m = (await h.app.inject({ method: 'POST', url: '/ari/api/message?lang=en', headers: hd, payload: JSON.stringify({ text: 'Groceries: rice, eggs and water' }) })).json() as any;
      const confirm = m.card.actions.find((x: any) => x.kind === 'confirm');
      const c = await h.app.inject({ method: 'POST', url: '/ari/api/confirm?lang=en', headers: hd, payload: JSON.stringify({ checkout_id: m.card.id, confirm_hash: confirm.endpoint.body.confirm_hash, user_verification: 'biometric' }) });
      return (c.json() as any).card?.type;
    };
    expect(await Promise.all(Array.from({ length: 12 }, (_, i) => visit(i)))).toEqual(Array(12).fill('order'));
  });

  it('the cleanup removes old guests with everything they own, and the page starts a new session', async () => {
    expect(await h.demo!.cleanup()).toBe(0);
    expect((await h.demoDb.query(`SELECT count(*) AS n FROM users`)).rows[0].n).toBe(13);
    expect(await h.demo!.cleanup(0)).toBe(13);
    const left = (await h.demoDb.query(`SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM orders) + (SELECT count(*) FROM carts) + (SELECT count(*) FROM checkouts)
      + (SELECT count(*) FROM partner_users) + (SELECT count(*) FROM partner_webhooks) + (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM addresses) AS n`)).rows[0].n;
    expect(left).toBe(0);
    const gone = await post('/ari/api/message?lang=en', { text: 'hi' });
    expect(gone.status).toBe(401);
    expect(gone.json.error.code).toBe('AUTH_REQUIRED');
    const fresh = await post('/ari/api/session?lang=en');
    expect(fresh.status).toBe(200);
    expect((await post('/ari/api/message?lang=en', { text: 'Chocolate cake for a birthday' })).json.card.type).toBe('checkout');
  });
});
