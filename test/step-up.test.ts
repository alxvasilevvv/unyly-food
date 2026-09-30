// Step-up confirmation: large orders from users with a passkey need a fresh WebAuthn assertion bound
// to the checkout. A software authenticator (P-256 key, real signatures) drives the real verifier.
import { createHash, createSign, generateKeyPairSync, KeyObject, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_STEP_UP_THRESHOLDS, loadConfig } from '../src/config.js';
import { confirmOnWeb, demoUser, Harness, preparedCheckout, startHarness, webLogin } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());
afterEach(() => {
  h.cfg.stepUp = { enabled: true, thresholds: { ...DEFAULT_STEP_UP_THRESHOLDS } };
});

const ORIGIN = 'http://localhost:3000';
const b64u = (b: Buffer) => b.toString('base64url');

/** Minimal software authenticator: one ES256 credential registered straight into the DB. */
async function addSoftPasskey(userId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  const id = b64u(randomBytes(16));
  await h.db.query('INSERT INTO webauthn_credentials (id, user_id, public_key, counter) VALUES ($1,$2,$3,0)', [id, userId, cose]);
  let counter = 0;
  return {
    id,
    sign(challenge: string, o: { uv?: boolean; origin?: string } = {}) {
      counter += 1;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
      const flags = 0x01 | (o.uv === false ? 0 : 0x04);
      const cnt = Buffer.alloc(4);
      cnt.writeUInt32BE(counter);
      const authData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([flags]), cnt]);
      const sig = createSign('SHA256').update(Buffer.concat([authData, createHash('sha256').update(clientData).digest()])).sign(privateKey as KeyObject);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) },
      };
    },
  };
}

async function options(s: { cookie: string; csrf: string }, checkoutId: string) {
  return h.app.inject({ method: 'POST', url: `/confirm/${checkoutId}/step-up/options`, headers: { origin: ORIGIN, cookie: s.cookie }, payload: { _csrf: s.csrf } });
}

async function postConfirm(s: { cookie: string; csrf: string }, checkoutId: string, stepUp?: unknown) {
  const page = await h.app.inject({ method: 'GET', url: `/confirm/${checkoutId}`, headers: { cookie: s.cookie } });
  const total = /name="total_minor" value="(\d+)"/.exec(page.body)![1];
  return h.app.inject({
    method: 'POST', url: `/confirm/${checkoutId}`, headers: { cookie: s.cookie, origin: ORIGIN },
    payload: { _csrf: s.csrf, total_minor: total, ...(stepUp === undefined ? {} : { step_up: typeof stepUp === 'string' ? stepUp : JSON.stringify(stepUp) }) },
  });
}

const orderFor = async (checkoutId: string) => (await h.db.query('SELECT id FROM orders WHERE checkout_id = $1', [checkoutId])).rows[0];
const statusOf = async (checkoutId: string) => (await h.db.query('SELECT status FROM checkouts WHERE id = $1', [checkoutId])).rows[0].status;
/** Make this checkout "large": the THB threshold equals its total (the rule is total >= threshold). */
const makeLarge = (total: number) => (h.cfg.stepUp.thresholds.THB = total);

describe('Step-up confirmation for large orders', () => {
  it('config: defaults for all 8 market currencies, env overrides, STEP_UP=off, strict parsing', () => {
    expect(Object.keys(DEFAULT_STEP_UP_THRESHOLDS).sort()).toEqual(['IDR', 'MMK', 'MYR', 'PHP', 'SGD', 'THB', 'USD', 'VND']);
    const saved = { ...process.env };
    try {
      process.env.STEP_UP_THRESHOLD_THB = '123';
      process.env.STEP_UP = 'off';
      const c = loadConfig({ env: 'test' });
      expect(c.stepUp.enabled).toBe(false);
      expect(c.stepUp.thresholds.THB).toBe(123);
      expect(c.stepUp.thresholds.SGD).toBe(DEFAULT_STEP_UP_THRESHOLDS.SGD);
      process.env.STEP_UP = 'of';
      expect(() => loadConfig({ env: 'test' })).toThrow(/STEP_UP must be on or off/);
      process.env.STEP_UP = 'on';
      process.env.STEP_UP_THRESHOLD_THB = '12.5';
      expect(() => loadConfig({ env: 'test' })).toThrow(/STEP_UP_THRESHOLD_THB/);
    } finally {
      process.env = saved;
    }
  });

  it('large total + passkey: POST without an assertion is refused (403) and nothing is ordered', async () => {
    const u = await demoUser(h, 'big1@example.com');
    await addSoftPasskey(u.userId);
    const { checkout } = await preparedCheckout(u.mcp.call);
    makeLarge(checkout.total.amount_minor);
    const page = await h.app.inject({ method: 'GET', url: `/confirm/${checkout.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.body).toContain('data-step-up=');
    expect(page.body).toMatch(/Passkey required for orders from/);
    const r = await postConfirm(u, checkout.checkout_id);
    expect(r.statusCode).toBe(403);
    expect(r.body).toMatch(/needs your passkey/);
    expect(r.body).toMatch(/Nothing was ordered/);
    expect(await orderFor(checkout.checkout_id)).toBeUndefined();
    expect(await statusOf(checkout.checkout_id)).toBe('awaiting_user');
    const bad = await postConfirm(u, checkout.checkout_id, 'not json');
    expect(bad.statusCode).toBe(403);
    expect(await orderFor(checkout.checkout_id)).toBeUndefined();
    await u.mcp.close();
  });

  it('large total + passkey: a valid assertion places the order and is audited', async () => {
    const u = await demoUser(h, 'big2@example.com');
    const pk = await addSoftPasskey(u.userId);
    const { checkout } = await preparedCheckout(u.mcp.call);
    makeLarge(checkout.total.amount_minor);
    // The assistant is told in advance that a passkey will be needed.
    const st = await u.mcp.call('get_checkout_status', { checkout_id: checkout.checkout_id });
    expect(st.result.step_up_required).toBe(true);
    const o = await options(u, checkout.checkout_id);
    expect(o.statusCode).toBe(200);
    const { challenge_id, options: opts } = o.json();
    expect(opts.userVerification).toBe('required');
    expect(opts.allowCredentials.map((c: any) => c.id)).toEqual([pk.id]);
    const ttl = (await h.db.query(`SELECT extract(epoch FROM expires_at - now()) s, purpose, checkout_id, user_id FROM webauthn_challenges WHERE id = $1`, [challenge_id])).rows[0];
    expect(Number(ttl.s)).toBeLessThanOrEqual(120);
    expect(ttl).toMatchObject({ purpose: 'step_up', checkout_id: checkout.checkout_id, user_id: u.userId });
    const r = await postConfirm(u, checkout.checkout_id, { challenge_id, response: pk.sign(opts.challenge) });
    expect(r.statusCode).toBe(302);
    expect(String(r.headers.location)).toMatch(/^\/app\/orders\/.+\?placed=1$/);
    expect(await orderFor(checkout.checkout_id)).toBeTruthy();
    const a = (await h.db.query(`SELECT details FROM audit_log WHERE action = 'checkout.step_up' AND entity_id = $1`, [checkout.checkout_id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].details).toEqual({ method: 'passkey' });
    await u.mcp.close();
  });

  it('challenges are single use and bound to one checkout; user verification is required', async () => {
    const u = await demoUser(h, 'big3@example.com');
    const pk = await addSoftPasskey(u.userId);
    const a = (await preparedCheckout(u.mcp.call)).checkout;
    const b = (await preparedCheckout(u.mcp.call, [{ item_id: 'r1-greencurry', quantity: 2 }])).checkout;
    makeLarge(Math.min(a.total.amount_minor, b.total.amount_minor));
    // Issued for A, presented on B: refused, nothing ordered.
    const oa = (await options(u, a.checkout_id)).json();
    const wrong = await postConfirm(u, b.checkout_id, { challenge_id: oa.challenge_id, response: pk.sign(oa.options.challenge) });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).toMatch(/different order/);
    expect(await orderFor(b.checkout_id)).toBeUndefined();
    // That attempt consumed the challenge: it cannot be used on A afterwards either.
    const replay = await postConfirm(u, a.checkout_id, { challenge_id: oa.challenge_id, response: pk.sign(oa.options.challenge) });
    expect(replay.statusCode).toBe(403);
    expect(replay.body).toMatch(/expired/);
    expect(await orderFor(a.checkout_id)).toBeUndefined();
    // Presence without user verification is not enough.
    const ob = (await options(u, b.checkout_id)).json();
    const noUv = await postConfirm(u, b.checkout_id, { challenge_id: ob.challenge_id, response: pk.sign(ob.options.challenge, { uv: false }) });
    expect(noUv.statusCode).toBe(403);
    expect(noUv.body).toMatch(/verification failed/);
    // A fresh challenge for B works once...
    const ob2 = (await options(u, b.checkout_id)).json();
    const ok = await postConfirm(u, b.checkout_id, { challenge_id: ob2.challenge_id, response: pk.sign(ob2.options.challenge) });
    expect(ok.statusCode).toBe(302);
    expect(await orderFor(b.checkout_id)).toBeTruthy();
    // ...and never again.
    const used = await h.db.query('SELECT consumed_at FROM webauthn_challenges WHERE id = $1', [ob2.challenge_id]);
    expect(used.rows[0].consumed_at).not.toBeNull();
    await u.mcp.close();
  });

  it("another user's passkey or challenge cannot approve", async () => {
    const u = await demoUser(h, 'big4@example.com');
    await addSoftPasskey(u.userId);
    const other = await webLogin(h, 'mallory@example.com');
    const opk = await addSoftPasskey(other.userId);
    const { checkout } = await preparedCheckout(u.mcp.call);
    makeLarge(checkout.total.amount_minor);
    // Mallory cannot get options for someone else's checkout.
    expect((await options(other, checkout.checkout_id)).statusCode).toBe(404);
    const o = (await options(u, checkout.checkout_id)).json();
    const r = await postConfirm(u, checkout.checkout_id, { challenge_id: o.challenge_id, response: opk.sign(o.options.challenge) });
    expect(r.statusCode).toBe(403);
    expect(await orderFor(checkout.checkout_id)).toBeUndefined();
    await u.mcp.close();
  });

  it('options endpoint keeps the origin and CSRF checks', async () => {
    const u = await demoUser(h, 'big5@example.com');
    await addSoftPasskey(u.userId);
    const { checkout } = await preparedCheckout(u.mcp.call);
    makeLarge(checkout.total.amount_minor);
    const noOrigin = await h.app.inject({ method: 'POST', url: `/confirm/${checkout.checkout_id}/step-up/options`, headers: { cookie: u.cookie }, payload: { _csrf: u.csrf } });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await h.app.inject({ method: 'POST', url: `/confirm/${checkout.checkout_id}/step-up/options`, headers: { cookie: u.cookie, origin: 'https://evil.example' }, payload: { _csrf: u.csrf } });
    expect(evil.statusCode).toBe(403);
    const noCsrf = await h.app.inject({ method: 'POST', url: `/confirm/${checkout.checkout_id}/step-up/options`, headers: { cookie: u.cookie, origin: ORIGIN }, payload: {} });
    expect(noCsrf.statusCode).toBe(401);
    await u.mcp.close();
  });

  it('below the threshold nothing changes, even with a passkey', async () => {
    const u = await demoUser(h, 'small@example.com');
    await addSoftPasskey(u.userId);
    const { checkout } = await preparedCheckout(u.mcp.call);
    h.cfg.stepUp.thresholds.THB = checkout.total.amount_minor + 1;
    expect(checkout.step_up_required).toBe(false);
    const page = await h.app.inject({ method: 'GET', url: `/confirm/${checkout.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.body).not.toContain('data-step-up=');
    expect(page.body).not.toMatch(/Passkey required/);
    const r = await confirmOnWeb(h, u, checkout.checkout_id);
    expect(r.statusCode).toBe(302);
    expect(await orderFor(checkout.checkout_id)).toBeTruthy();
    await u.mcp.close();
  });

  it('users without a passkey keep the plain flow and see a recommendation', async () => {
    const u = await demoUser(h, 'nopk@example.com');
    h.cfg.stepUp.thresholds.THB = 1;
    const { checkout } = await preparedCheckout(u.mcp.call);
    expect(checkout.step_up_required).toBe(false);
    const page = await h.app.inject({ method: 'GET', url: `/confirm/${checkout.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.body).not.toContain('data-step-up=');
    expect(page.body).toMatch(/add a passkey in your account settings/);
    expect(page.body).toContain('href="/app/data#passkeys"');
    const r = await confirmOnWeb(h, u, checkout.checkout_id);
    expect(r.statusCode).toBe(302);
    expect(await orderFor(checkout.checkout_id)).toBeTruthy();
    await u.mcp.close();
  });

  it('STEP_UP=off disables the check', async () => {
    const u = await demoUser(h, 'off@example.com');
    await addSoftPasskey(u.userId);
    h.cfg.stepUp.enabled = false;
    h.cfg.stepUp.thresholds.THB = 1;
    const { checkout } = await preparedCheckout(u.mcp.call);
    expect(checkout.step_up_required).toBe(false);
    const page = await h.app.inject({ method: 'GET', url: `/confirm/${checkout.checkout_id}`, headers: { cookie: u.cookie } });
    expect(page.body).not.toContain('data-step-up=');
    expect(page.body).not.toMatch(/Passkey required|add a passkey/);
    const r = await confirmOnWeb(h, u, checkout.checkout_id);
    expect(r.statusCode).toBe(302);
    expect(await orderFor(checkout.checkout_id)).toBeTruthy();
    await u.mcp.close();
  });

  it('declining a large order needs no passkey', async () => {
    const u = await demoUser(h, 'decline@example.com');
    await addSoftPasskey(u.userId);
    const { checkout } = await preparedCheckout(u.mcp.call);
    makeLarge(checkout.total.amount_minor);
    const r = await h.app.inject({ method: 'POST', url: `/confirm/${checkout.checkout_id}/decline`, headers: { cookie: u.cookie }, payload: { _csrf: u.csrf } });
    expect(r.statusCode).toBe(302);
    expect(await statusOf(checkout.checkout_id)).toBe('declined');
    await u.mcp.close();
  });
});
