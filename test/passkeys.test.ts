import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, startHarness, webLogin } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());
const origin = { origin: 'http://localhost:3000' };

describe('Passkey endpoints', () => {
  it('require a same-origin request', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/auth/passkey/login/options', payload: {} })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/auth/passkey/login/options', headers: { origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'POST', url: '/auth/passkey/login/options', headers: origin, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().options.rpId).toBe('localhost');
  });

  it('challenges are single-use and cannot be used for a different purpose', async () => {
    const o = (await h.app.inject({ method: 'POST', url: '/auth/passkey/login/options', headers: origin, payload: {} })).json();
    const bogus = { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {}, clientExtensionResults: {} };
    const r1 = await h.app.inject({ method: 'POST', url: '/auth/passkey/register/verify', headers: origin, payload: { challenge_id: o.challenge_id, response: bogus } });
    expect(r1.statusCode).toBe(401); // purpose mismatch
    const r2 = await h.app.inject({ method: 'POST', url: '/auth/passkey/login/verify', headers: origin, payload: { challenge_id: o.challenge_id, response: bogus } });
    expect(r2.statusCode).toBe(401); // unknown credential
    const r3 = await h.app.inject({ method: 'POST', url: '/auth/passkey/login/verify', headers: origin, payload: { challenge_id: o.challenge_id, response: bogus } });
    expect(r3.json().message).toMatch(/expired/); // already consumed
  });

  it('cannot register a passkey onto an existing account without signing in', async () => {
    await webLogin(h, 'owner@example.com');
    const r = await h.app.inject({ method: 'POST', url: '/auth/passkey/register/options', headers: origin, payload: { email: 'owner@example.com' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/already exists/);
  });

  it('adding a passkey to a signed-in account needs the session CSRF token', async () => {
    const s = await webLogin(h, 'adder@example.com');
    const bad = await h.app.inject({ method: 'POST', url: '/auth/passkey/register/options', headers: { ...origin, cookie: s.cookie }, payload: {} });
    expect(bad.statusCode).toBe(403);
    const good = await h.app.inject({ method: 'POST', url: '/auth/passkey/register/options', headers: { ...origin, cookie: s.cookie }, payload: { _csrf: s.csrf } });
    expect(good.statusCode).toBe(200);
    expect(good.json().options.authenticatorSelection.residentKey).toBe('required');
  });
});
