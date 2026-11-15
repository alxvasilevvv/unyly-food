import { afterAll, beforeAll, it } from 'vitest';
import { Harness, startHarness } from './helpers.js';
let h: Harness; let cookie = '';
const H = () => ({ 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' });
async function counted(name: string, fn: () => Promise<any>) {
  h.queries.reset(); const out = await fn();
  (await import('node:fs')).appendFileSync(process.env.PERF_LOG!, '\n' + `=== ${name}: trips=${h.queries.roundTrips} tx=${h.queries.transactions}\n` + h.queries.log.join('\n'));
  return out;
}
const post = async (url: string, body: unknown = {}) => {
  const r = await h.app.inject({ method: 'POST', url, headers: H(), payload: JSON.stringify(body) });
  const sc = r.headers['set-cookie'];
  if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
  return r.json() as any;
};
const get = async (url: string) => (await h.app.inject({ method: 'GET', url, headers: H() })).json() as any;
beforeAll(async () => { h = await startHarness({ cfg: { guestPerIpHourly: 100 } }); });
afterAll(async () => { await h.close(); });
it('log', async () => {
  await counted('session', () => post('/ari/api/session?lang=ru'));
  await counted('session again', () => post('/ari/api/session?lang=ru'));
  const m = await counted('message', () => post('/ari/api/message?lang=ru', { text: 'Такси от Сиам Парагона до аэропорта Суварнабхуми' }));
  const opt = m.card.options.find((o: any) => o.action);
  const a = await counted('action', () => post('/ari/api/action?lang=ru', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments }));
  const confirm = a.card.actions.find((x: any) => x.kind === 'confirm');
  const c = await counted('confirm', () => post('/ari/api/confirm?lang=ru', { checkout_id: a.card.id, confirm_hash: confirm.endpoint.body.confirm_hash }));
  await counted('poll1', () => get(`/ari/api/orders/${c.order_id}?lang=ru`));
  await counted('poll2', () => get(`/ari/api/orders/${c.order_id}?lang=ru`));
  await counted('events', () => get(`/ari/api/events?after=0`));
  h.clock.advance(10 * 60_000);
  await counted('poll changed', () => get(`/ari/api/orders/${c.order_id}?lang=ru`));
  const m2 = await counted('message food', () => post('/ari/api/message?lang=ru', { text: 'Закажи том ям' }));
  (await import('node:fs')).appendFileSync(process.env.PERF_LOG!, '\n' + JSON.stringify(m2).slice(0, 1500));
});
