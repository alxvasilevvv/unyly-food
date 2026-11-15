// End-to-end behaviour of the /ari demo after the round-trip work of round 6: every service in English, Russian
// and Thai from the first sentence to the final status with its events, cancellation (free, with a fee, refused),
// decline, wrong and missing confirmation hash, a stale quote, an expired card, repeat, double and parallel
// confirmation. The flows live in test/support/r6-flows.ts so they can also be run against another build.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedHeaders } from '../src/partners/auth.js';
import { ariExamples } from '../src/partners/webdemo.js';
import type { Locale } from '../src/domain/locales.js';
import { Harness, startHarness } from './helpers.js';
import { dumpState, LANGS, runFlows, SERVICES, Step } from './support/r6-flows.js';

let h: Harness;
const SECRET = 'r'.repeat(40);
let log: Step[] = [];
let state: Awaited<ReturnType<typeof dumpState>>;
const step = (name: string) => {
  const s = log.find((x) => x.step === name);
  if (!s) throw new Error(`step ${name} did not run (ran: ${log.map((x) => x.step).join(', ')})`);
  return s;
};

beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 100, partners: [{ id: 'ari', name: 'Ari', secret: SECRET, webhookSecret: 'w'.repeat(40), mode: 'demo' }] } });
  log = await runFlows({
    inject: (o) => h.app.inject(o) as any, clock: h.clock, query: (sql, params) => h.demoDb.query(sql, params), examples: (l) => ariExamples(l as Locale),
  });
  state = await dumpState({ query: (sql, params) => h.demoDb.query(sql, params) });
}, 120_000);
afterAll(async () => {
  await h.close();
});

const CARD_SERVICE: Record<string, string> = { ride: 'ride', food: 'food', express: 'express', flowers: 'mart', pharmacy: 'mart', groceries: 'mart', cake: 'mart' };
const HAS: Record<string, RegExp> = { en: /[a-z]/i, ru: /[а-яё]/i, th: /[฀-๿]/ };

describe('every service in every language, from the sentence to the final status', () => {
  for (const lang of LANGS) {
    for (const name of SERVICES) {
      it(`${lang} ${name}: card, confirm, progression, events`, () => {
        const confirm = step(`${lang}:${name}.confirm`);
        expect(confirm.status).toBe(200);
        expect(confirm.body.card).toMatchObject({ type: 'order', service: CARD_SERVICE[name], demo: true });
        expect(confirm.body.order_id).toBe(confirm.body.card.id);
        expect(confirm.body.card.status.code).toBe('accepted');
        expect(confirm.body.card.status.eta_at).toBeTruthy();
        expect(confirm.body.card.actions.map((a: any) => a.kind)).toEqual(['prepare_cancel']);
        expect(confirm.body.reply).toMatch(HAS[lang]);
        expect(confirm.body.trace[0]).toMatchObject({ ok: true });
        expect(confirm.body.trace[0].grab).toBeTruthy();
        // The card before it: a checkout with a confirm button bound to its content and a decline button.
        const before = log[log.indexOf(confirm) - 1].body.card;
        expect(before.type).toBe('checkout');
        expect(before.actions.map((a: any) => a.kind)).toEqual(['confirm', 'decline']);
        expect(before.total.amount_minor).toBe(confirm.body.card.total.amount_minor);
        // Progression to the end, every status once and in order.
        const f = step(`${lang}:${name}.followed`).body;
        expect(f.statuses).toEqual(['accepted', 'preparing', 'picked_up', 'delivered']);
        const final = step(`${lang}:${name}.final`).body.card;
        expect(final.status).toMatchObject({ code: 'delivered', is_final: true, progress: 1 });
        expect(final.actions).toEqual([]);
        // Events: created and confirmed once, then one per status change, each with a push text in the user's language.
        const types = f.events.map((e: any) => e.type);
        expect(types.filter((t: string) => t === 'order.created')).toHaveLength(1);
        expect(types.filter((t: string) => t === 'checkout.confirmed')).toHaveLength(1);
        expect(types.indexOf('order.created')).toBeLessThan(types.indexOf('checkout.confirmed'));
        const changes = f.events.filter((e: any) => e.type === 'order.status_changed');
        expect(changes.map((e: any) => e.data.status)).toEqual(['preparing', 'picked_up', 'delivered']);
        for (const e of [...changes, f.events.find((x: any) => x.type === 'order.created')]) {
          expect(e.data.order_id).toBe(confirm.body.order_id);
          expect(e.notify.title).toMatch(HAS[lang]);
          expect(e.notify.live_activity.state).toBe(e.data.status);
        }
        expect(changes.at(-1).data.is_final).toBe(true);
        expect(changes.at(-1).notify.level).toBe('important');
        const created = f.events.find((x: any) => x.type === 'order.created');
        // The Live Activity ETA of the first event is the ETA of the stored order (demo speed applied once).
        expect(created.notify.live_activity.eta_at).toBe(confirm.body.card.status.eta_at);
        expect(f.events.find((x: any) => x.type === 'checkout.confirmed').data).toMatchObject({ order_id: confirm.body.order_id, user_verification: 'biometric' });
        if (name === 'ride') expect(changes[0].notify).toMatchObject({ level: 'urgent', suggest_call: true });
      });
    }
    it(`${lang}: a returning session reports the newest event number`, () => {
      const again = step(`${lang}:session.again`).body;
      expect(again.ok).toBe(true);
      expect(again.last_event).toBeGreaterThan(0);
      expect(again.user.id).toBe(step(`${lang}:session`).body.user.id);
    });
  }
});

describe('cancellation', () => {
  it('right after the order it is free and goes through; repeating the confirmation changes nothing', () => {
    const terms = step('cancel:food.free.cancel').body.card;
    expect(terms.type).toBe('cancellation');
    expect(terms.subtitle).toMatch(/0\.00/);
    const done = step('cancel:food.free.cancel.confirm').body;
    expect(done.card.status).toMatchObject({ code: 'cancelled', is_final: true });
    expect(done.cancel_card.actions).toEqual([]);
    expect(step('cancel:food.free.cancel.again').body.card.status.code).toBe('cancelled');
    expect(step('cancel:food.free.settled').body.card.status.code).toBe('cancelled'); // a cancelled order never moves again
    const ev = step('cancel:food.free.events').body.events.map((e: any) => e.type);
    expect(ev.filter((t: string) => t === 'cancellation.confirmed')).toHaveLength(1);
  });
  it('once the kitchen or the driver has started, the card shows the fee and the cancellation still goes through', () => {
    expect(step('cancel:food.fee.poll1').body.card.status.code).toBe('preparing');
    const food = step('cancel:food.fee.cancel').body.card;
    expect(food.footnote).toMatch(/50%/);
    expect(food.subtitle).not.toMatch(/ 0\.00/);
    expect(step('cancel:food.fee.cancel.confirm').body.card.status.code).toBe('cancelled');
    const ride = step('cancel:ride.fee.cancel').body.card;
    expect(ride.subtitle).toMatch(/30\.00/);
    expect(step('cancel:ride.fee.cancel.confirm').body.card.status.code).toBe('cancelled');
    const changed = step('cancel:ride.fee.events').body.events.filter((e: any) => e.type === 'order.status_changed').map((e: any) => e.data.status);
    expect(changed).toContain('cancelled');
    // Executed: two free ones (food right away, the pharmacy order from the chat), the ride at 30 baht, the food order at half its total.
    const fees = state.cancellations.filter((c: any) => c.status === 'executed').map((c: any) => Number(c.fee_minor)).sort((a: number, b: number) => a - b);
    expect(fees.slice(0, 3)).toEqual([0, 0, 3000]);
    expect(fees).toHaveLength(4);
    expect(fees[3]).toBeGreaterThan(3000);
  });
  it('after pickup the cancellation is refused and the order goes on', () => {
    const late = step('cancel:ride.late.cancel');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CANCELLATION_NOT_ALLOWED');
    expect(['picked_up', 'delivered']).toContain(step('cancel:ride.late.after').body.card.status.code);
  });
  it('"cancel my order" in the chat only prepares it; the tap on the card cancels', () => {
    expect(step('cancel:chat.where').body.card.type).toBe('order');
    expect(step('cancel:chat.cancel').body.card.type).toBe('cancellation');
    expect(step('cancel:chat.cancel.confirm').body.card.status.code).toBe('cancelled');
  });
});

describe('cards that must not order', () => {
  it('a declined card stays declined and cannot be confirmed', () => {
    const d = step('edge:decline.decline').body;
    expect(d.card.type).toBe('checkout');
    expect(d.card.actions).toEqual([]);
    const after = step('edge:decline.confirm-after');
    expect([after.status, after.body.error.code]).toEqual([409, 'CONFIRMATION_INVALIDATED']);
    expect(step('edge:decline.again').status).toBe(200);
  });
  it('a wrong, missing or foreign confirmation orders nothing; the right one on the same card still works', () => {
    expect(step('edge:hash.wrong').body.error.code).toBe('CONFIRM_HASH_MISMATCH');
    expect(step('edge:hash.missing').body.error.code).toBe('VALIDATION_FAILED');
    expect(step('edge:hash.unknown').status).toBe(404);
    expect(step('edge:hash.right').body.card.type).toBe('order');
  });
  it('a card whose provider quote went stale is re-priced and confirmed at the same total', () => {
    const c = step('edge:stale.confirm');
    expect(c.status).toBe(200);
    expect(c.body.card.type).toBe('order');
    expect(state.audit.some((a: any) => a.action === 'checkout.approved' && a.details.repriced === true)).toBe(true);
  });
  it('an expired card is refused, again and again, and nothing is ordered', () => {
    for (const name of ['edge:expired.confirm', 'edge:expired.again']) {
      expect([step(name).status, step(name).body.error.code]).toEqual([409, 'CONFIRMATION_EXPIRED']);
    }
    expect(state.checkouts.filter((c: any) => c.status === 'expired')).toHaveLength(1);
    expect(state.checkouts.filter((c: any) => c.status === 'declined')).toHaveLength(1);
  });
});

describe('repeat, double and parallel confirmation', () => {
  it('with no earlier order there is nothing to repeat', () => {
    expect(step('repeat:nothing').body.card ?? null).toBeNull();
  });
  it('confirming the same card twice returns the same order', () => {
    expect(step('repeat:first.same-order').body.same).toBe(true);
    expect(step('repeat:first.confirm.twice').status).toBe(200);
    // The first answer is built from the rows the confirmation wrote, the second is read from the database: the same card.
    expect(step('repeat:first.confirm').body.card).toEqual(step('repeat:first.confirm.twice').body.card);
  });
  it('"repeat my last order" prepares a new card; five parallel confirmations of it create exactly one order', () => {
    expect(step('repeat:again').body.card.type).toBe('checkout');
    const p = step('repeat:again.parallel').body;
    expect(p.statuses).toEqual([200, 200, 200, 200, 200]);
    expect(p.distinct_orders).toBe(1);
    expect(p.has_order).toBe(true);
    expect(step('repeat:again.parallel.rows').body).toEqual({ orders: 1, provider_orders: 1, attempts: 1 });
    expect(step('repeat:again.followed').body.statuses.at(-1)).toBe('delivered');
    const ev = step('repeat:again.followed').body.events.filter((e: any) => e.data.order_id && e.type !== 'order.status_changed').map((e: any) => e.type);
    expect(ev.filter((t: string) => t === 'order.created')).toHaveLength(2); // the first order and the repeated one
    expect(step('repeat:track').body.card.type).toBe('order');
  });
});

describe('what the flows left in the database', () => {
  it('one submission, one provider order and one order per confirmed card; every approval is audited before its submission', () => {
    expect(state.attempts.every((a: any) => a.status === 'accepted' && a.has_ref && a.finished && a.settled)).toBe(true);
    expect(state.orders).toHaveLength(state.attempts.length);
    expect(state.sim).toHaveLength(state.attempts.length);
    const consumed = state.checkouts.filter((c: any) => c.status === 'consumed');
    expect(consumed).toHaveLength(state.attempts.length);
    expect(consumed.every((c: any) => c.approved && c.consumed && c.approved_via === 'partner:ari-web')).toBe(true);
    const actions = state.audit.map((a: any) => a.action);
    expect(actions.filter((a: string) => a === 'checkout.approved')).toHaveLength(state.attempts.length);
    expect(actions.filter((a: string) => a === 'submission.started')).toHaveLength(state.attempts.length);
    expect(actions.filter((a: string) => a === 'order.accepted')).toHaveLength(state.attempts.length);
    for (let i = 0; i < actions.length; i++) if (actions[i] === 'submission.started') expect(actions[i - 1]).toBe('checkout.approved');
    // Every tap on Confirm is on record, also the ones that ordered nothing (declined, expired).
    expect(state.confirmations.filter((c: any) => c.entity === 'checkout').length).toBeGreaterThan(state.attempts.length);
    expect(state.confirmations.every((c: any) => c.partner_id === 'ari-web')).toBe(true);
    // Demo orders of the web demo run at presentation speed, set once when the order is stored.
    expect(new Set(state.sim.map((s: any) => Number(s.speed)))).toEqual(new Set([24]));
    expect(state.orders.every((o: any) => o.has_eta)).toBe(true);
    expect(state.carts.filter((c: any) => c.status === 'ordered')).toHaveLength(state.attempts.length);
  });
});

describe('Partner API: the confirm answer built from the written rows is the stored state', () => {
  const api = async (method: string, url: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const r = await h.app.inject({
      method: method as any, url, payload: raw || undefined,
      headers: { ...signedHeaders({ id: 'ari' }, SECRET, method, url, raw, h.clock.now().getTime()), ...(raw ? { 'content-type': 'application/json' } : {}) },
    });
    return { status: r.statusCode, json: r.json() as any };
  };
  for (const [name, tool, args] of [
    ['ride', 'estimate_trip', { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Suvarnabhumi airport' }],
    ['food', 'search_stores', { service: 'food', query: 'tom yum' }],
  ] as const) {
    it(`${name}: the first confirmation, its replay and the status endpoints agree field by field`, async () => {
      const U = `/partner/v1/users/parity-${name}`;
      expect((await api('PUT', U, { locale: 'en' })).status).toBe(201);
      expect((await api('POST', `${U}/places`, { label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Watthana', city: 'Bangkok' })).status).toBe(201);
      const found = await api('POST', `${U}/tools/${tool}`, { arguments: args });
      const opt = found.json.card.options.find((o: any) => o.action);
      const cart = await api('POST', `${U}/tools/create_cart`, { arguments: opt.action.tool.arguments });
      const cf = cart.json.card.actions.find((x: any) => x.kind === 'confirm');
      const first = await api('POST', cf.endpoint.path, { ...cf.endpoint.body, user_verification: 'tap' });
      expect(first.status).toBe(200);
      expect(first.json.checkout).toMatchObject({ status: 'consumed', submission: { status: 'accepted' } });
      expect(first.json.checkout.order_id).toBe(first.json.order.id);
      const replay = await api('POST', cf.endpoint.path, { ...cf.endpoint.body, user_verification: 'tap' });
      expect(replay.status).toBe(200);
      expect(first.json).toEqual(replay.json);
      const status = await api('POST', `${U}/tools/get_checkout_status`, { arguments: { checkout_id: cart.json.card.id } });
      expect(status.json.result).toMatchObject({ status: 'consumed', order_id: first.json.order.id, approved_at: first.json.checkout.approved_at, submission: first.json.checkout.submission });
      const ev = (await api('GET', `${U}/events?after=0`)).json.events;
      expect(ev.map((e: any) => e.type)).toEqual(['order.created', 'checkout.confirmed']);
      expect(ev[1].data).toEqual({ checkout_id: cart.json.card.id, order_id: first.json.order.id, user_verification: 'tap' });
      expect(ev[0].notify.live_activity.eta_at).toBe(first.json.order.card.status.eta_at);
      const row = (await h.db.query('SELECT status, approved_via, approved_at, consumed_at FROM checkouts WHERE id = $1', [cart.json.card.id])).rows[0];
      expect(row).toMatchObject({ status: 'consumed', approved_via: 'partner:ari' });
      expect(new Date(row.approved_at).toISOString()).toBe(first.json.checkout.approved_at);
    });
  }
});
