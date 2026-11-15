import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedHeaders } from '../src/partners/auth.js';
import type { PartnerConfig } from '../src/partners/config.js';
import { Harness, startHarness } from './helpers.js';

const ARI: PartnerConfig = { id: 'ari', name: 'Ari', secret: 'c'.repeat(40), webhookSecret: 'd'.repeat(40), mode: 'demo' };
let h: Harness;

async function call(method: string, url: string, body?: unknown, opts: { headers?: Record<string, string>; raw?: string } = {}) {
  const raw = opts.raw ?? (body === undefined ? '' : JSON.stringify(body));
  const headers: Record<string, string> = { ...signedHeaders(ARI, ARI.secret, method, url, raw, h.clock.now().getTime()), ...(raw ? { 'content-type': 'application/json' } : {}), ...opts.headers };
  const r = await h.app.inject({ method: method as any, url, headers, payload: raw || undefined });
  let json: any = null;
  try { json = r.json(); } catch { /* HEAD and empty bodies */ }
  return { status: r.statusCode, type: String(r.headers['content-type'] ?? ''), body: r.body, json };
}
const isEnvelope = (j: any) => j && j.ok === false && typeof j.error?.code === 'string' && typeof j.error?.message === 'string';

beforeAll(async () => {
  h = await startHarness({ cfg: { partners: [ARI] } });
});
afterAll(async () => {
  await h.close();
});

describe('Partner API contract: one error shape', () => {
  it('unknown paths, wrong methods and trailing slashes answer the JSON 404 after the signature check', async () => {
    for (const [m, u] of [['GET', '/partner/v1/nope'], ['POST', '/partner/v1/ping'], ['GET', '/partner/v1/ping/'], ['GET', '/partner/v1'], ['PUT', '/partner/v1/users/a/b'], ['GET', '/partner/v1/users/u1/orders/']]) {
      const r = await call(m, u);
      expect([m, u, r.status]).toEqual([m, u, 404]);
      expect(r.type).toContain('application/json');
      expect(isEnvelope(r.json)).toBe(true);
      expect(r.json.error.code).toBe('NOT_FOUND');
    }
    const unsigned = await h.app.inject({ method: 'GET', url: '/partner/v1/nope' });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error.code).toBe('PARTNER_AUTH_FAILED');
  });

  it('HEAD and OPTIONS never fail with 500 or an HTML page', async () => {
    expect((await call('HEAD', '/partner/v1/ping')).status).toBe(200);
    const o = await h.app.inject({ method: 'OPTIONS', url: '/partner/v1/ping' });
    expect(o.statusCode).toBe(401);
    expect(String(o.headers['content-type'])).toContain('application/json');
    expect((await call('OPTIONS', '/partner/v1/ping')).status).toBe(404);
    expect((await h.app.inject({ method: 'HEAD', url: '/partner/v1/ping' })).statusCode).toBe(401);
  });

  it('body problems: 413 too large, 400 invalid JSON, wrong content type and non-object bodies', async () => {
    const big = await call('PUT', '/partner/v1/users/u1', { display_name: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    const bad = await call('PUT', '/partner/v1/users/u1', undefined, { raw: '{bad' });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const ct = await call('PUT', '/partner/v1/users/u1', undefined, { raw: '{"locale":"en"}', headers: { 'content-type': 'text/plain' } });
    expect([ct.status, ct.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    for (const raw of ['[1]', 'null', '"x"', '5']) {
      const r = await call('PUT', '/partner/v1/users/u1', undefined, { raw });
      expect([raw, r.status, r.json.error.message]).toEqual([raw, 400, 'Body must be a JSON object']);
    }
    // Nothing above created the user.
    expect((await call('GET', '/partner/v1/users/u1')).status).toBe(404);
  });

  it('every refusal uses { ok: false, error: { code, message } }', async () => {
    await call('PUT', '/partner/v1/users/u1', { locale: 'en' });
    const cases: [string, string, unknown?][] = [
      ['GET', '/partner/v1/users/ghost'], ['GET', '/partner/v1/users/u1/orders/xyz'], ['GET', '/partner/v1/users/u1/checkouts/00000000-0000-4000-8000-000000000000'],
      ['POST', '/partner/v1/users/u1/tools/nope_tool', { arguments: {} }], ['POST', '/partner/v1/users/u1/tools/submit_order', { arguments: {} }],
      ['POST', '/partner/v1/users/u1/tools/estimate_trip', { arguments: [] }], ['POST', '/partner/v1/users/u1/tools/estimate_trip', { arguments: { service: 5 } }],
      ['POST', '/partner/v1/users/u1/places', { label: 'x' }], ['PUT', '/partner/v1/users/u1', { locale: 'xx' }], ['PUT', '/partner/v1/users/a%2Fb', { locale: 'en' }],
      ['POST', '/partner/v1/users/u1/grab/link'].length ? ['DELETE', '/partner/v1/users/u1/places/not-a-uuid'] : ['GET', '/'],
    ];
    for (const [m, u, b] of cases) {
      const r = await call(m, u, b);
      expect([m, u, r.status >= 400 && r.status < 500, isEnvelope(r.json)]).toEqual([m, u, true, true]);
    }
  });

  it('a user id with URL-encoded characters round-trips through signed card action paths', async () => {
    const U = '/partner/v1/users/user%3A1%40x';
    const created = await call('PUT', U, { locale: 'en' });
    expect([created.status, created.json.user.user_id]).toEqual([201, 'user:1@x']);
    // The same user is reachable with the unencoded spelling: the signature covers the URL exactly as sent.
    expect((await call('GET', '/partner/v1/users/user:1@x')).json.user.user_id).toBe('user:1@x');
    expect((await call('POST', `${U}/places`, { label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Watthana', city: 'Bangkok' })).status).toBe(201);
    const est = await call('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Home', dropoff: 'Siam Paragon' } });
    const cart = await call('POST', `${U}/tools/create_cart`, { arguments: est.json.card.options[0].action.tool.arguments });
    const confirm = cart.json.card.actions.find((a: any) => a.kind === 'confirm');
    expect(confirm.endpoint.path.startsWith('/partner/v1/users/user%3A1%40x/checkouts/')).toBe(true);
    const done = await call('POST', confirm.endpoint.path, { ...confirm.endpoint.body, user_verification: 'tap' });
    expect(done.status).toBe(200);
    const cancel = done.json.order.card.actions.find((a: any) => a.kind === 'prepare_cancel');
    const prep = await call('POST', cancel.endpoint.path);
    expect(prep.status).toBe(200);
    const cc = prep.json.card.actions.find((a: any) => a.kind === 'confirm');
    const cancelled = await call('POST', cc.endpoint.path, { ...cc.endpoint.body, user_verification: 'tap' });
    expect([cancelled.status, cancelled.json.cancellation.status]).toEqual([200, 'executed']);
    const ev = await call('GET', `${U}/events?after=0`);
    expect(ev.json.events.every((e: any) => e.user_id === 'user:1@x')).toBe(true);
  });

  it('five parallel confirmations of one checkout create exactly one order', async () => {
    const U = '/partner/v1/users/racer';
    await call('PUT', U, { locale: 'en' });
    await call('POST', `${U}/places`, { label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Watthana', city: 'Bangkok' });
    const est = await call('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Home', dropoff: 'ICONSIAM' } });
    const cart = await call('POST', `${U}/tools/create_cart`, { arguments: est.json.card.options[1].action.tool.arguments });
    const confirm = cart.json.card.actions.find((a: any) => a.kind === 'confirm');
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', confirm.endpoint.path, { ...confirm.endpoint.body, user_verification: 'tap' })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const ids = new Set(rs.map((r) => r.json.order?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
    const uid = (await h.db.query(`SELECT user_id FROM partner_users WHERE external_user_id = 'racer'`)).rows[0].user_id;
    expect((await h.db.query('SELECT count(*)::int n FROM orders WHERE user_id = $1', [uid])).rows[0].n).toBe(1);
    expect((await h.db.query(`SELECT count(*)::int n FROM submission_attempts sa JOIN checkouts c ON c.id = sa.checkout_id WHERE c.user_id = $1`, [uid])).rows[0].n).toBe(1);
    expect((await h.db.query(`SELECT count(*)::int n FROM partner_webhooks WHERE user_id = $1 AND event_type IN ('order.created','checkout.confirmed')`, [uid])).rows[0].n).toBe(2);
    // A later retry is the same answer.
    const again = await call('POST', confirm.endpoint.path, { ...confirm.endpoint.body, user_verification: 'tap' });
    expect(again.json.order.id).toBe([...ids][0]);
  });

  it('a deleted user can be created again with the same id and starts empty', async () => {
    const U = '/partner/v1/users/phoenix';
    expect((await call('PUT', U, { locale: 'en' })).status).toBe(201);
    expect((await call('DELETE', U)).json).toMatchObject({ ok: true, deleted: true });
    expect((await call('GET', U)).status).toBe(404);
    const back = await call('PUT', U, { locale: 'th' });
    expect([back.status, back.json.user.created, back.json.user.locale]).toEqual([201, true, 'th']);
    expect((await call('GET', `${U}/orders`)).json.orders).toEqual([]);
  });
});

describe('Partner API contract: rate limits', () => {
  it('a signed burst over the per-user limit gets the JSON 429 and other users are not affected', async () => {
    await call('PUT', '/partner/v1/users/busy', { locale: 'en' });
    await call('PUT', '/partner/v1/users/calm', { locale: 'en' });
    const rs = await Promise.all(Array.from({ length: 125 }, () => call('POST', '/partner/v1/users/busy/tools/nope_tool', { arguments: {} })));
    const limited = rs.filter((r) => r.status === 429);
    expect(limited.length).toBe(5);
    expect(limited[0].json).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect((await call('POST', '/partner/v1/users/calm/tools/nope_tool', { arguments: {} })).status).toBe(404);
  });

  it('an unsigned flood is cut off per IP without touching the database, then recovers', async () => {
    const before = (await h.db.query('SELECT count(*)::int n FROM partner_nonces')).rows[0].n;
    const codes: number[] = [];
    for (let i = 0; i < 320; i++) codes.push((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', remoteAddress: '203.0.113.9' })).statusCode);
    expect(codes.filter((c) => c === 401).length).toBe(300);
    expect(codes.slice(300).every((c) => c === 429)).toBe(true);
    const blocked = await h.app.inject({ method: 'GET', url: '/partner/v1/ping', remoteAddress: '203.0.113.9' });
    expect(blocked.json()).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect((await h.db.query('SELECT count(*)::int n FROM partner_nonces')).rows[0].n).toBe(before);
    // Another address (the partner's real servers) is not affected.
    expect((await call('GET', '/partner/v1/ping')).status).toBe(200);
  });
});
