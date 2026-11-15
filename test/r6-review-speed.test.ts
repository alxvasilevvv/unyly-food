// Review finding: before round 6 every partner Confirm that ended with an order sped the demo order up
// (resultAfterSubmit). After the rewrite only the call that stored the order in the one-statement path does; an
// order stored another way during the same Confirm (the provider's answer was lost and the immediate
// reconciliation found the order) stayed at normal speed, about half an hour instead of a couple of minutes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ariExamples } from '../src/partners/webdemo.js';
import { Harness, startHarness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 100, demoDb: 'shared' } });
});
afterAll(async () => {
  await h.close();
});

async function visitor(ip: string) {
  let cookie = '';
  const post = async (url: string, body: unknown = {}) => {
    const r = await h.app.inject({ method: 'POST', url, headers: { 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body), remoteAddress: ip });
    const sc = r.headers['set-cookie'];
    if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c: string) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.json() as any };
  };
  await post('/ari/api/session');
  const m = await post('/ari/api/message', { text: ariExamples('en')[1] });
  let card = m.body.card;
  if (card?.type === 'options') {
    const opt = card.options.find((o: any) => o.action);
    card = (await post('/ari/api/action', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments })).body.card;
  }
  const confirm = () => post('/ari/api/confirm', { checkout_id: card.id, confirm_hash: card.actions.find((x: any) => x.kind === 'confirm').endpoint.body.confirm_hash });
  return { card, confirm };
}

describe('demo orders of the partner Confirm run at presentation speed however the order was stored', () => {
  const want = () => Math.max(h.cfg.demoGuestSpeed * 2, 1);
  const sim = async (checkoutId: string) => (await h.db.query(
    `SELECT d.speed, o.id FROM orders o JOIN demo_sim_orders d ON d.ref = o.provider_order_ref WHERE o.checkout_id = $1`, [checkoutId],
  )).rows[0];

  it('the usual path', async () => {
    const v = await visitor('10.8.0.1');
    const c = await v.confirm();
    expect(c.status).toBe(200);
    expect(Number((await sim(v.card.id)).speed)).toBe(want());
  });

  it('the provider answer was lost and the order was found by the immediate reconciliation', async () => {
    const v = await visitor('10.8.0.2');
    h.ctx.providers.demo.faults = { timeoutAfterAccept: true };
    let c;
    try {
      c = await v.confirm();
    } finally {
      h.ctx.providers.demo.faults = {};
    }
    expect(c.status).toBe(200);
    expect(c.body.order_id).toBeTruthy();
    const row = await sim(v.card.id);
    expect(Number(row.speed)).toBe(want());
    // (An order found by reconciliation carries no ETA, before and after round 6: the lookup does not return one.)
    // Exactly one of everything.
    const n = (await h.db.query(
      `SELECT (SELECT count(*)::int FROM orders WHERE checkout_id = $1) AS orders, (SELECT count(*)::int FROM submission_attempts WHERE checkout_id = $1) AS attempts,
              (SELECT count(*)::int FROM partner_webhooks WHERE event_type = 'checkout.confirmed' AND payload #>> '{data,checkout_id}' = $1::text) AS confirmed,
              (SELECT count(*)::int FROM partner_webhooks WHERE event_type = 'order.created' AND payload #>> '{data,checkout_id}' = $1::text) AS created`, [v.card.id],
    )).rows[0];
    expect(n).toEqual({ orders: 1, attempts: 1, confirmed: 1, created: 1 });
  });
});
