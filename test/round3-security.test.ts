// Round 3 security pass: the bad-signature limiter, chat cancellation, guest creation, the bounded wait in
// confirm and production configuration.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { signedHeaders } from '../src/partners/auth.js';
import { isWeakSecret, loadPartners } from '../src/partners/config.js';
import { authFailureLimiter } from '../src/partners/routes.js';
import { Harness, startHarness } from './helpers.js';

let h: Harness;
let cookie = '';
const SECRET = `test-only-${'r3Kx8Wp1Zq5Hn7Vd'.repeat(2)}`;
const H = () => ({ 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' });
const post = async (url: string, body: unknown = {}) => {
  const r = await h.app.inject({ method: 'POST', url, headers: H(), payload: JSON.stringify(body) });
  const sc = r.headers['set-cookie'];
  if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
  return { status: r.statusCode, json: r.json() as any };
};
const api = async (method: string, url: string, body?: unknown, remoteAddress?: string) => {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const r = await h.app.inject({
    method: method as any, url, payload: raw || undefined, remoteAddress,
    headers: { ...signedHeaders({ id: 'ari' }, SECRET, method, url, raw, h.clock.now().getTime()), ...(raw ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: r.statusCode, json: r.json() as any };
};
const guests = async () => (await h.db.query('SELECT count(*)::int n FROM users WHERE is_guest')).rows[0].n as number;

beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 100, partners: [{ id: 'ari', name: 'Ari', secret: SECRET, webhookSecret: `test-only-${'w4Jc9Ty2Lm6Bf0Gs'.repeat(2)}`, mode: 'demo' }] } });
});
afterAll(async () => {
  await h.close();
});

describe('bad-signature limiter', () => {
  it('never refuses a valid signature, even from an address that is flooding bad ones', async () => {
    const ip = '203.0.113.50';
    let last = 0;
    for (let i = 0; i < 305; i++) last = (await h.app.inject({ method: 'GET', url: '/partner/v1/ping', remoteAddress: ip })).statusCode;
    expect(last).toBe(429);
    // Same address (a shared NAT, or a proxy missing from TRUST_PROXY): the partner's signed call still goes through.
    expect((await api('GET', '/partner/v1/ping', undefined, ip)).status).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', remoteAddress: ip })).statusCode).toBe(429);
  });

  it('counts IPv6 addresses of one /64 together', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 302; i++) {
      codes.push((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', remoteAddress: `2001:db8:77:1::${(i + 1).toString(16)}` })).statusCode);
    }
    expect(codes.slice(0, 300).every((c) => c === 401)).toBe(true);
    expect(codes.slice(300)).toEqual([429, 429]);
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', remoteAddress: '2001:db8:77:2::1' })).statusCode).toBe(401);
  });

  it('keeps a bounded number of addresses and does not forget a blocked one when it fills up', () => {
    const lim = authFailureLimiter(3, 60_000, 100);
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) lim.fail('offender', t);
    expect(lim.fail('offender', t)).toBe(true);
    for (let i = 0; i < 5000; i++) lim.fail(`drive-by-${i}`, t + 1);
    expect(lim.size()).toBeLessThanOrEqual(100);
    expect(lim.fail('offender', t + 2)).toBe(true);
    // The window ends: the address starts from zero again.
    expect(lim.fail('offender', t + 60_001)).toBe(false);
    // Entries that expired are dropped rather than kept forever.
    for (let i = 0; i < 300; i++) lim.fail(`later-${i}`, t + 200_000);
    expect(lim.size()).toBeLessThanOrEqual(100);
  });
});

describe('website demo', () => {
  it('opening the session again and again keeps one guest; a database error never creates another', async () => {
    const before = await guests();
    const first = await post('/ari/api/session?lang=en');
    expect(first.status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await post('/ari/api/session?lang=en')).json.user.id).toBe(first.json.user.id);
    expect(await guests()).toBe(before + 1);
    // The user lookup fails once (database hiccup): the answer is an error, not a fresh guest with a new cookie.
    const real = h.ctx.db.query;
    h.ctx.db.query = ((sql: string, params?: unknown[]) => (/FROM partner_users pu JOIN users u/.test(sql) ? Promise.reject(new Error('connection reset')) : real(sql, params))) as typeof real;
    try {
      const r = await h.app.inject({ method: 'POST', url: '/ari/api/session?lang=en', headers: H(), payload: '{}' });
      expect(r.statusCode).toBe(500);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect((await post('/ari/api/message?lang=en', { text: 'hi there, taxi to Asok' })).status).toBe(500);
    } finally {
      h.ctx.db.query = real;
    }
    expect(await guests()).toBe(before + 1);
    expect((await post('/ari/api/session?lang=en')).json.user.id).toBe(first.json.user.id);
  });

  it('"cancel my order" in the chat only prepares the cancellation: nothing is cancelled without the tap on the card', async () => {
    const m = await post('/ari/api/message?lang=en', { text: 'Taxi from Siam Paragon to Suvarnabhumi airport' });
    const opt = m.json.card.options.find((o: any) => o.action);
    const a = await post('/ari/api/action?lang=en', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments });
    const confirm = a.json.card.actions.find((x: any) => x.kind === 'confirm');
    // Saying yes in the chat is not a confirmation either.
    await post('/ari/api/message?lang=en', { text: 'yes, confirm it' });
    expect((await h.db.query('SELECT count(*)::int n FROM orders')).rows[0].n).toBe(0);
    const c = await post('/ari/api/confirm?lang=en', { checkout_id: a.json.card.id, confirm_hash: confirm.endpoint.body.confirm_hash });
    const orderId = c.json.order_id as string;
    const status = async () => (await h.db.query('SELECT fulfillment_status FROM orders WHERE id = $1', [orderId])).rows[0].fulfillment_status as string;

    const ask = await post('/ari/api/message?lang=en', { text: 'cancel my order' });
    expect(ask.json.card.type).toBe('cancellation');
    expect(await status()).not.toBe('cancelled');
    const reqs = (await h.db.query('SELECT status FROM cancellation_requests WHERE order_id = $1', [orderId])).rows.map((r) => r.status);
    expect(reqs).toEqual(['awaiting_user']);
    // More chat does not turn into the tap.
    for (const text of ['yes', 'yes cancel it', 'confirm', 'да, отмени']) await post('/ari/api/message?lang=en', { text });
    expect(await status()).not.toBe('cancelled');
    expect((await h.db.query(`SELECT count(*)::int n FROM cancellation_requests WHERE order_id = $1 AND status NOT IN ('awaiting_user','invalidated')`, [orderId])).rows[0].n).toBe(0);
    // The confirm endpoint needs the hash of the card that is on the screen.
    const cardId = (await h.db.query(`SELECT id FROM cancellation_requests WHERE order_id = $1 AND status = 'awaiting_user'`, [orderId])).rows[0].id;
    expect((await post('/ari/api/cancel/confirm', { cancellation_id: cardId })).status).toBe(400);
    expect((await post('/ari/api/cancel/confirm', { cancellation_id: cardId, confirm_hash: '0'.repeat(40) })).json.error.code).toBe('CONFIRM_HASH_MISMATCH');
    expect(await status()).not.toBe('cancelled');
    // The tap on the latest card does cancel.
    const latest = await post('/ari/api/message?lang=en', { text: 'cancel my order' });
    const cc = latest.json.card.actions.find((x: any) => x.kind === 'confirm');
    const done = await post('/ari/api/cancel/confirm', { cancellation_id: latest.json.card.id, confirm_hash: cc.endpoint.body.confirm_hash });
    expect(done.json.card.status.code).toBe('cancelled');
    expect(await status()).toBe('cancelled');
  });
});

describe('confirm while a submission is in flight', () => {
  it('waits about two seconds at most, with a handful of status reads, and reports in_flight', async () => {
    const U = '/partner/v1/users/waiter';
    await api('PUT', U, {});
    const est = await api('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Asok' } });
    const opt = est.json.card.options.find((o: any) => o.action);
    const cart = await api('POST', `${U}/tools/create_cart`, { arguments: opt.action.tool.arguments });
    const cf = cart.json.card.actions.find((x: any) => x.kind === 'confirm');
    const checkoutId = cart.json.card.id as string;
    // The state another process leaves while its call to the provider is still running.
    const co = (await h.db.query('SELECT user_id, mode FROM checkouts WHERE id = $1', [checkoutId])).rows[0];
    await h.db.query(`UPDATE checkouts SET status = 'consumed', approved_at = now(), consumed_at = now() WHERE id = $1`, [checkoutId]);
    await h.db.query(
      `INSERT INTO partner_confirmations (partner_id, user_id, entity, entity_id, confirm_hash, user_verification, confirmed_at) VALUES ('ari', $1, 'checkout', $2, $3, 'tap', now())`,
      [co.user_id, checkoutId, cf.endpoint.body.confirm_hash],
    );
    await h.db.query(
      `INSERT INTO submission_attempts (checkout_id, user_id, mode, idempotency_key, status, next_reconcile_at) VALUES ($1, $2, $3, $4, 'in_flight', now() + interval '1 hour')`,
      [checkoutId, co.user_id, co.mode, `unyly-${checkoutId}`],
    );
    h.queries.reset();
    const t0 = Date.now();
    const r = await api('POST', cf.endpoint.path, { ...cf.endpoint.body, user_verification: 'tap' });
    const ms = Date.now() - t0;
    expect(r.status).toBe(200);
    expect(r.json.order).toBeNull();
    expect(r.json.checkout.submission.status).toBe('in_flight');
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(4000);
    expect(h.queries.roundTrips).toBeLessThanOrEqual(14);
    expect((await h.db.query('SELECT count(*)::int n FROM orders WHERE checkout_id = $1', [checkoutId])).rows[0].n).toBe(0);
  });
});

describe('production configuration', () => {
  const strong = `prod-${'k9Qz7Lm2Xv4Bn6Tp'.repeat(3)}`;
  const prod = {
    env: 'production' as const, webOrigin: 'https://food.example', mcpResourceUrl: 'https://food.example/mcp', devEchoLoginCode: false,
    databaseUrl: 'postgres://u:strongpassword@db/unyly', demoWebhookSecret: strong, mail: { mode: 'smtp' as const, smtpUrl: 'smtp://x', from: 'x' },
  };
  const partner = (over: Record<string, unknown> = {}) => ({ id: 'ari', name: 'Ari', secret: `req-${'t5Yh2Nq8Wc1Xz6Lb'.repeat(3)}`, webhookSecret: `hook-${'m3Vd7Rk0Js4Pg9Fa'.repeat(3)}`, mode: 'demo' as const, ...over });

  it('tells placeholders and low-variety values from real secrets', () => {
    expect(isWeakSecret('a'.repeat(64))).toBe(true);
    expect(isWeakSecret('abcabcabcabcabcabcabcabcabcabcabcabc')).toBe(true);
    expect(isWeakSecret(`CHANGE_ME_${'x9Kq'.repeat(10)}`)).toBe(true);
    expect(isWeakSecret('<64 hex characters from openssl rand -hex 32>')).toBe(true);
    expect(isWeakSecret('dev-only-demo-webhook-secret-change-me')).toBe(true);
    expect(isWeakSecret('short')).toBe(true);
    expect(isWeakSecret(strong)).toBe(false);
  });

  it('refuses the built-in default and weak values for the key behind confirm_hash and the demo cookie', () => {
    expect(loadConfig({ ...prod, partners: [partner()] }).cookieSecure).toBe(true);
    const { demoWebhookSecret: _omit, ...noSecret } = prod;
    expect(() => loadConfig(noSecret)).toThrow(/DEMO_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...prod, demoWebhookSecret: 'z'.repeat(48) })).toThrow(/DEMO_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...prod, cookieSecure: false })).toThrow(/COOKIE_SECURE/);
  });

  it('refuses weak partner secrets in production and a partner secret equal to the server key anywhere', () => {
    expect(() => loadConfig({ ...prod, partners: [partner({ secret: 'b'.repeat(40) })] })).toThrow(/Partner "ari"/);
    expect(() => loadConfig({ ...prod, partners: [partner({ webhookUrl: 'https://ari.example/hook', webhookSecret: 'c'.repeat(40) })] })).toThrow(/Partner "ari"/);
    expect(() => loadConfig({ ...prod, partners: [partner({ secret: strong })] })).toThrow(/differ from DEMO_WEBHOOK_SECRET/);
    expect(() => loadConfig({ env: 'test', demoWebhookSecret: strong, partners: [partner({ secret: strong })] })).toThrow(/differ from DEMO_WEBHOOK_SECRET/);
    const env = { PARTNERS: 'ari', PARTNER_ARI_SECRET: 'change-me-change-me-change-me-change-me' } as NodeJS.ProcessEnv;
    expect(() => loadPartners(env, 'production')).toThrow(/PARTNER_ARI_SECRET/);
    expect(loadPartners(env, 'development')[0].id).toBe('ari');
    expect(loadPartners({ PARTNERS: 'ari', PARTNER_ARI_SECRET: strong } as NodeJS.ProcessEnv, 'production')[0].secret).toBe(strong);
  });
});
