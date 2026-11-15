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

  it('the example requests build exactly the cart that was asked for', async () => {
    const titles = (r: any) => r.json.card.lines.map((x: any) => x.title);
    const ru = await post('/ari/api/message?lang=ru', { text: 'Продукты: рис, яйца и вода' });
    expect(titles(ru)).toEqual(['Jasmine rice 5 kg', 'Fresh eggs, 10 pack', 'Drinking water 6 x 1.5 L']);
    const th = await post('/ari/api/message?lang=th', { text: 'ของชำ ข้าวสาร ไข่ไก่ น้ำดื่ม' });
    expect(titles(th)).toEqual(['Jasmine rice 5 kg', 'Fresh eggs, 10 pack', 'Drinking water 6 x 1.5 L']);
    for (const [lang, text] of [['en', 'Red roses with a gift box'], ['ru', 'Букет роз в подарочной коробке'], ['th', 'ช่อดอกกุหลาบพร้อมกล่องของขวัญ']]) {
      const roses = await post(`/ari/api/message?lang=${lang}`, { text });
      expect(roses.json.card.lines[0].detail).toContain('Gift box');
    }
    const plain = await post('/ari/api/message?lang=en', { text: 'Red roses' });
    expect(plain.json.card.lines[0].detail).toContain('Kraft paper');
    const cake = await post('/ari/api/message?lang=en', { text: 'Chocolate cake for a birthday' });
    expect(titles(cake)).toEqual(['Chocolate fudge cake, 1 lb']);
  });

  it('the reply matches the card: over budget, too heavy, and no guessing on unknown requests', async () => {
    const poor = await post('/ari/api/message?lang=en', { text: 'Dinner for two under 10 baht' });
    expect(poor.json.reply).toContain('Nothing fits');
    const heavy = await post('/ari/api/message?lang=en', { text: 'Send a 500 kg parcel to ICONSIAM' });
    expect(heavy.json.reply).toContain('too heavy');
    expect(heavy.json.card.options.every((o: any) => !o.action && /300|200|100|20/.test(o.disabled_reason))).toBe(true);
    const unknown = await post('/ari/api/message?lang=en', { text: 'aspirin 1000 tablets' });
    expect(unknown.json.card ?? null).toBeNull();
    expect(unknown.json.chips.length).toBeGreaterThan(0);
    const pizza = await post('/ari/api/message?lang=en', { text: 'pizza' });
    expect(pizza.json.card.type).toBe('options');
    const parcel = await post('/ari/api/message?lang=ru', { text: 'отправить посылку' });
    expect(parcel.json.chips[0]).toContain('посылку');
  });

  it('offers cancellation only while the order can still be cancelled', async () => {
    const m = await post('/ari/api/message?lang=ru', { text: 'Парацетамол и пластыри' });
    const confirm = m.json.card.actions.find((x: any) => x.kind === 'confirm');
    const c = await post('/ari/api/confirm?lang=ru', { checkout_id: m.json.card.id, confirm_hash: confirm.endpoint.body.confirm_hash, user_verification: 'biometric' });
    expect(c.json.card.actions.map((a: any) => a.kind)).toEqual(['prepare_cancel']);
    // The first card already carries the presentation-speed ETA the next poll will show.
    const first = await get(`/ari/api/orders/${c.json.order_id}?lang=ru`);
    expect(first.json.card.status.eta_at).toBe(c.json.card.status.eta_at);
    // Mart timeline: picked up after 12 simulated minutes, delivered after 25.
    const speed = h.cfg.demoTimeScale * Math.max(h.cfg.demoGuestSpeed * 2, 1);
    h.clock.advance((15 * 60_000) / speed);
    const o = await get(`/ari/api/orders/${c.json.order_id}?lang=ru`);
    expect(o.json.card.status.code).toBe('picked_up');
    expect(o.json.card.actions).toEqual([]);
    const refused = await post('/ari/api/cancel?lang=ru', { order_id: c.json.order_id });
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toMatch(/[а-яё]/i);
  });

  it('session resume starts after the newest event, however many there are', async () => {
    const s = await post('/ari/api/session?lang=en');
    const uid = (await h.demoDb.query('SELECT user_id FROM partner_users WHERE external_user_id = $1', [s.json.user.id])).rows[0].user_id;
    await h.demoDb.query(
      `INSERT INTO partner_webhooks (partner_id, user_id, event_type, payload, status)
       SELECT 'ari-web', $1, 'grab.linked', '{"type":"grab.linked","data":{}}'::jsonb, 'skipped' FROM generate_series(1, 130)`,
      [uid],
    );
    const max = Number((await h.demoDb.query('SELECT max(id) AS m FROM partner_webhooks WHERE user_id = $1', [uid])).rows[0].m);
    const again = await post('/ari/api/session?lang=en');
    expect(again.json.last_event).toBe(max);
    const rest = await get(`/ari/api/events?after=${again.json.last_event}`);
    expect(rest.json.events).toEqual([]);
  });
});
