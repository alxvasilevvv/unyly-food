// Regression tests for the security / MCP-protocol review fixes (migration 009).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipKey } from '../src/app.js';
import { createPersonalToken, getClient, normalizeResource, parseAuthzRequest } from '../src/auth/oauth.js';
import { createSession, isSameOrigin, loginMail, safeNext } from '../src/auth/session.js';
import { loadConfig, parseTrustProxy } from '../src/config.js';
import { createMailer } from '../src/services/mailer.js';
import { findOrCreateUserByEmail } from '../src/services/users.js';
import { Harness, oauthToken, startHarness, webLogin } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const origin = { origin: 'http://localhost:3000' };
const csrfOf = async (cookie: string) => {
  const page = await h.app.inject({ method: 'GET', url: '/app/preferences', headers: { cookie } });
  return /name="_csrf" value="([^"]+)"/.exec(page.body)![1];
};
const mcpPost = (body: string, headers: Record<string, string> = {}, path = '/mcp') =>
  fetch(`${h.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body });
const toolsCall = (name: string, args?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: args === undefined ? { name } : { name, arguments: args } });

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

describe('1. Account pre-hijacking via passkey registration', () => {
  it('first email-code sign-in to a passkey-created account revokes everything attached before', async () => {
    const email = 'victim@example.com';
    // The attacker "registered" with the victim's email (passkey path: unverified account).
    const u = await findOrCreateUserByEmail(h.db, email, 'en', { verified: false });
    expect(u.email_verified_at).toBeNull();
    await h.db.query(`INSERT INTO webauthn_credentials (id, user_id, public_key) VALUES ('attacker-cred', $1, '\\x00')`, [u.id]);
    const attackerCookie = `unyly_session=${await createSession(h.db, u.id)}`;
    const attackerTok = await oauthToken(h, { cookie: attackerCookie, csrf: await csrfOf(attackerCookie) });
    const pat = await createPersonalToken(h.ctx, u.id, 'attacker', ['orders:read']);

    const victim = await webLogin(h, email);
    expect(victim.userId).toBe(u.id);

    expect((await h.db.query('SELECT count(*)::int n FROM webauthn_credentials WHERE user_id = $1', [u.id])).rows[0].n).toBe(0);
    expect((await h.app.inject({ method: 'GET', url: '/app/preferences', headers: { cookie: attackerCookie } })).statusCode).toBe(302);
    expect((await h.app.inject({ method: 'GET', url: '/app/preferences', headers: { cookie: victim.cookie } })).statusCode).toBe(200);
    expect((await mcpPost(toolsCall('get_capabilities', {}), { authorization: `Bearer ${attackerTok.access_token}` })).status).toBe(401);
    expect((await mcpPost(toolsCall('get_capabilities', {}), { authorization: `Bearer ${pat.token}` })).status).toBe(401);
    const refresh = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: attackerTok.refresh_token } });
    expect(refresh.json().error).toBe('invalid_grant');

    const row = (await h.db.query('SELECT email_verified_at FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row.email_verified_at).not.toBeNull();
    const a = (await h.db.query(`SELECT details FROM audit_log WHERE user_id = $1 AND action = 'user.email_verified'`, [u.id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].details.revoked).toMatchObject({ passkeys: 1, oauth_grants: 1, personal_tokens: 1 });

    // Later sign-ins of the now verified account revoke nothing.
    const again = await webLogin(h, email);
    expect((await h.app.inject({ method: 'GET', url: '/app/preferences', headers: { cookie: victim.cookie } })).statusCode).toBe(200);
    expect(again.userId).toBe(u.id);
  });

  it('email-code sign-up creates a verified account', async () => {
    const s = await webLogin(h, 'fresh@example.com');
    expect((await h.db.query('SELECT email_verified_at FROM users WHERE id = $1', [s.userId])).rows[0].email_verified_at).not.toBeNull();
  });

  it('passkey registration start does not reveal whether an account exists', async () => {
    await webLogin(h, 'exists@example.com');
    const a = await h.app.inject({ method: 'POST', url: '/auth/passkey/register/options', headers: origin, payload: { email: 'exists@example.com' } });
    const b = await h.app.inject({ method: 'POST', url: '/auth/passkey/register/options', headers: origin, payload: { email: 'nobody-here@example.com' } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(Object.keys(a.json()).sort()).toEqual(Object.keys(b.json()).sort());
    expect(Object.keys(a.json().options).sort()).toEqual(Object.keys(b.json().options).sort());
  });

  it('a used registration challenge no longer holds the email', async () => {
    const o = (await h.app.inject({ method: 'POST', url: '/auth/passkey/register/options', headers: origin, payload: { email: 'forget-me@example.com' } })).json();
    const bogus = { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {}, clientExtensionResults: {} };
    const r = await h.app.inject({ method: 'POST', url: '/auth/passkey/register/verify', headers: origin, payload: { challenge_id: o.challenge_id, response: bogus } });
    expect(r.statusCode).toBe(401);
    const row = (await h.db.query('SELECT email, consumed_at FROM webauthn_challenges WHERE id = $1', [o.challenge_id])).rows[0];
    expect(row.consumed_at).not.toBeNull();
    expect(row.email).toBeNull();
  });
});

describe('2/3. Rate-limit keys and proxy trust', () => {
  it('groups IPv6 by /64 and folds IPv4-mapped addresses', () => {
    expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0db8:0001:0002::9')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(ipKey('192.0.2.7')).toBe('192.0.2.7');
  });

  it('random Bearer values do not get a fresh bucket each (MCP keyed by IP until verified)', async () => {
    let last = 0;
    for (let i = 0; i < 121; i++) {
      const r = await h.app.inject({
        method: 'POST', url: '/mcp', remoteAddress: '198.51.100.23',
        headers: { authorization: `Bearer junk-${i}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: toolsCall('get_capabilities', {}),
      });
      last = r.statusCode;
      if (i < 120) expect(r.statusCode).toBe(401);
    }
    expect(last).toBe(429);
  });

  it('global routes are keyed by IP, not by a client-chosen Authorization header', async () => {
    let last = 0;
    for (let i = 0; i < 301; i++) {
      last = (await h.app.inject({ method: 'GET', url: '/healthz', remoteAddress: '198.51.100.99', headers: { authorization: `Bearer x${i}` } })).statusCode;
    }
    expect(last).toBe(429);
  });

  it('TRUST_PROXY accepts a hop count or a CIDR list, never "trust all"', () => {
    expect(parseTrustProxy(undefined, 1)).toBe(1);
    expect(parseTrustProxy('2', false)).toBe(2);
    expect(parseTrustProxy('true', false)).toBe(1);
    expect(parseTrustProxy('false', 1)).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1,::1', false)).toEqual(['10.0.0.0/8', '127.0.0.1', '::1']);
    expect(() => parseTrustProxy('10.0.0.0/33', false)).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('everyone', false)).toThrow(/TRUST_PROXY/);
    expect(withEnv({ TRUST_PROXY: undefined }, () => loadConfig({ env: 'test' }).trustProxy)).toBe(false);
  });
});

describe('4. safeNext', () => {
  it('keeps same-origin paths and rejects everything that can leave the site', () => {
    expect(safeNext('/app/orders?x=1#top')).toBe('/app/orders?x=1#top');
    expect(safeNext('/oauth/authorize?client_id=a&state=b')).toBe('/oauth/authorize?client_id=a&state=b');
    for (const bad of ['//evil.example', '/\\evil.example', '/.//evil.example', '/a/..//evil.example', 'https://evil.example/', '/\tjavascript:x', '/app\n', '/app x', 'javascript:alert(1)', '', null, 5]) {
      expect(safeNext(bad)).toBe('/app');
    }
  });
});

describe('5. Login CSRF', () => {
  it('rejects cross-site sign-in form posts', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, { referer: 'https://evil.example/x' }, { origin: 'null' }]) {
      expect((await h.app.inject({ method: 'POST', url: '/login', headers, payload: { email: 'csrf@example.com' } })).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'POST', url: '/login/verify', headers, payload: { email: 'csrf@example.com', code: '000000' } })).statusCode).toBe(401);
    }
    expect((await h.app.inject({ method: 'POST', url: '/login', headers: origin, payload: { email: 'csrf@example.com' } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/login', headers: { referer: 'http://localhost:3000/login' }, payload: { email: 'csrf2@example.com' } })).statusCode).toBe(200);
  });

  it('requires the header outright when allowMissing is off (production)', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as any;
    expect(isSameOrigin(h.ctx, req({}), { allowMissing: false })).toBe(false);
    expect(isSameOrigin(h.ctx, req({}), { allowMissing: true })).toBe(true);
    expect(isSameOrigin(h.ctx, req(origin))).toBe(true);
  });
});

describe('6. Mail', () => {
  it('keeps the code out of the subject and localises the message', async () => {
    for (const l of ['en', 'ru', 'th', 'vi', 'zh'] as const) {
      const m = loginMail(l, '123456');
      expect(m.subject).not.toMatch(/\d{6}/);
      expect(m.text).toContain('123456');
    }
    expect(loginMail('ru', '1').subject).toBe('Код входа в Unyly');
    expect(loginMail('th', '1').subject).toMatch(/Unyly/);
    await h.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost:3000' }, payload: { email: 'mail@example.com' } });
    const sent = h.ctx.mailer.outbox.at(-1)!;
    expect(sent.to).toBe('mail@example.com');
    expect(sent.subject).not.toMatch(/\d{6}/);
  });

  it('refuses unknown MAIL_MODE values', () => {
    expect(() => withEnv({ MAIL_MODE: 'smpt' }, () => loadConfig({ env: 'test' }))).toThrow(/MAIL_MODE/);
    expect(() => createMailer({ ...h.cfg, mail: { ...h.cfg.mail, mode: 'bogus' as any } })).toThrow(/MAIL_MODE/);
  });
});

describe('7. Config validation', () => {
  const prod = {
    env: 'production' as const, webOrigin: 'https://food.example', mcpResourceUrl: 'https://food.example/mcp', devEchoLoginCode: false,
    databaseUrl: 'postgres://u:strongpassword@db/unyly', demoWebhookSecret: 'a'.repeat(64), mail: { mode: 'smtp' as const, smtpUrl: 'smtp://x', from: 'x' },
  };
  it('accepts a sound production config', () => {
    expect(loadConfig(prod).env).toBe('production');
  });
  it('rejects weak production settings', () => {
    expect(() => loadConfig({ ...prod, demoWebhookSecret: 'short' })).toThrow(/DEMO_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...prod, demoWebhookSecret: `CHANGE_ME${'x'.repeat(40)}` })).toThrow(/DEMO_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...prod, mcpResourceUrl: 'http://food.example/mcp' })).toThrow(/MCP_RESOURCE_URL/);
    expect(() => loadConfig({ ...prod, databaseUrl: 'postgres://u:CHANGE_ME@db/unyly' })).toThrow(/DATABASE_URL/);
    const { databaseUrl: _omit, ...noDb } = prod;
    expect(() => withEnv({ DATABASE_URL: undefined }, () => loadConfig(noDb))).toThrow(/DATABASE_URL/);
  });
  it('rejects non-numeric and out-of-range numbers', () => {
    expect(() => withEnv({ DEMO_TIME_SCALE: '0' }, () => loadConfig({ env: 'test' }))).toThrow(/DEMO_TIME_SCALE/);
    expect(() => withEnv({ DEMO_TIME_SCALE: 'fast' }, () => loadConfig({ env: 'test' }))).toThrow(/DEMO_TIME_SCALE/);
    expect(() => withEnv({ PORT: 'eighty' }, () => loadConfig({ env: 'test' }))).toThrow(/PORT/);
    expect(() => withEnv({ ACCESS_TOKEN_TTL_SEC: '-5' }, () => loadConfig({ env: 'test' }))).toThrow(/ACCESS_TOKEN_TTL_SEC/);
  });
});

describe('8. OAuth', () => {
  let s: { cookie: string; csrf: string; userId: string };
  beforeAll(async () => {
    s = await webLogin(h, 'oauth-fixes@example.com');
  });

  it('refresh reuse within the grace window returns a fresh pair; after it, revokes the grant', async () => {
    const tok = await oauthToken(h, s);
    const r1 = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: tok.client_id } });
    expect(r1.statusCode).toBe(200);
    const retry = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: tok.client_id } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().refresh_token).not.toBe(r1.json().refresh_token);
    await h.db.query(`UPDATE oauth_tokens SET consumed_at = now() - interval '2 minutes' WHERE consumed_at IS NOT NULL AND grant_id = (SELECT grant_id FROM oauth_tokens WHERE token_hash = encode(sha256($1::bytea), 'hex'))`, [tok.refresh_token]);
    const late = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: tok.client_id } });
    expect(late.json().error).toBe('invalid_grant');
    const after = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: r1.json().refresh_token, client_id: tok.client_id } });
    expect(after.statusCode).toBe(400);
  });

  it('client_id: optional on refresh, accepted from HTTP Basic, must agree when both are sent', async () => {
    const tok = await oauthToken(h, s);
    const noId = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tok.refresh_token } });
    expect(noId.statusCode).toBe(200);
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(tok.client_id)}:`).toString('base64')}`;
    const viaBasic = await h.app.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: basic }, payload: { grant_type: 'refresh_token', refresh_token: noId.json().refresh_token } });
    expect(viaBasic.statusCode).toBe(200);
    const clash = await h.app.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: basic }, payload: { grant_type: 'refresh_token', refresh_token: viaBasic.json().refresh_token, client_id: 'someone-else' } });
    expect(clash.json().error).toBe('invalid_request');
  });

  it('repeated or structured parameters are invalid_request, never a 500', async () => {
    const t = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: ['refresh_token', 'authorization_code'], refresh_token: 'x' } });
    expect(t.statusCode).toBe(400);
    expect(t.json().error).toBe('invalid_request');
    const t2 = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: { $ne: 1 } } });
    expect(t2.json().error).toBe('invalid_request');
    const form = await h.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=refresh_token&refresh_token=a&refresh_token=b' });
    expect(form.json().error).toBe('invalid_request');
    const rv = await h.app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: ['a', 'b'] } });
    expect(rv.json().error).toBe('invalid_request');
    const az = await h.app.inject({ url: '/oauth/authorize?client_id=a&client_id=b', headers: { cookie: s.cookie } });
    expect(az.statusCode).toBe(400);
    expect(az.body).toContain('invalid_request');
  });

  it('normalises the resource indicator', () => {
    expect(normalizeResource(h.ctx, 'HTTP://LOCALHOST:3000/mcp/')).toBe(h.cfg.mcpResourceUrl);
    expect(normalizeResource(h.ctx, 'http://localhost:3000')).toBe(h.cfg.mcpResourceUrl);
    expect(normalizeResource(h.ctx, 'http://localhost:3000/')).toBe(h.cfg.mcpResourceUrl);
    expect(normalizeResource(h.ctx, undefined)).toBe(h.cfg.mcpResourceUrl);
    expect(() => normalizeResource(h.ctx, 'http://localhost:3000/other')).toThrow(/resource/);
    expect(() => normalizeResource(h.ctx, 'https://evil.example/mcp')).toThrow(/resource/);
  });

  it('re-fetches client metadata when stale or on a redirect_uri mismatch', async () => {
    const id = 'https://refetch.example.com/client.json';
    let calls = 0;
    let uris = ['https://refetch.example.com/cb'];
    const fetcher = async () => {
      calls++;
      return { client_id: id, client_name: 'Refetch', redirect_uris: uris };
    };
    const base = { client_id: id, response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' };
    await parseAuthzRequest(h.ctx, { ...base, redirect_uri: 'https://refetch.example.com/cb' }, fetcher);
    await parseAuthzRequest(h.ctx, { ...base, redirect_uri: 'https://refetch.example.com/cb' }, fetcher);
    expect(calls).toBe(1);
    // New redirect URI: re-fetched, but at most once a minute.
    uris = [...uris, 'https://refetch.example.com/cb2'];
    await expect(parseAuthzRequest(h.ctx, { ...base, redirect_uri: 'https://refetch.example.com/cb2' }, fetcher)).rejects.toThrow(/redirect_uri/);
    expect(calls).toBe(1);
    await h.db.query(`UPDATE oauth_clients SET updated_at = now() - interval '2 minutes' WHERE client_id = $1`, [id]);
    await parseAuthzRequest(h.ctx, { ...base, redirect_uri: 'https://refetch.example.com/cb2' }, fetcher);
    expect(calls).toBe(2);
    // Older than 24 h: re-fetched on the next use.
    await h.db.query(`UPDATE oauth_clients SET updated_at = now() - interval '25 hours' WHERE client_id = $1`, [id]);
    await getClient(h.ctx, id, fetcher);
    expect(calls).toBe(3);
  });

  it('anonymous /oauth/authorize visitors are sent to sign-in before any metadata fetch', async () => {
    const id = 'https://never-fetched.example.com/client.json';
    const url = `/oauth/authorize?client_id=${encodeURIComponent(id)}&response_type=code&redirect_uri=${encodeURIComponent('https://never-fetched.example.com/cb')}`;
    const r = await h.app.inject({ url });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
    expect((await h.db.query('SELECT 1 FROM oauth_clients WHERE client_id = $1', [id])).rowCount).toBe(0);
  });
});

describe('9. MCP transport', () => {
  let read: { access_token: string };
  beforeAll(async () => {
    const s = await webLogin(h, 'mcp-fixes@example.com');
    read = await oauthToken(h, s, 'orders:read');
  });

  it('answers CORS preflight on public OAuth/MCP endpoints only', async () => {
    const pre = await h.app.inject({ method: 'OPTIONS', url: '/mcp', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, mcp-protocol-version' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(String(pre.headers['access-control-allow-headers'])).toContain('mcp-protocol-version');
    expect(String(pre.headers['access-control-expose-headers'])).toContain('WWW-Authenticate');
    for (const url of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
      expect((await h.app.inject({ url, headers: { origin: 'https://x.example' } })).headers['access-control-allow-origin']).toBe('*');
    }
    expect((await h.app.inject({ method: 'OPTIONS', url: '/oauth/token' })).statusCode).toBe(204);
    for (const url of ['/login', '/app', '/oauth/authorize?client_id=x']) {
      expect((await h.app.inject({ url, headers: { origin: 'https://x.example' } })).headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('no longer serves a non-compliant openid-configuration', async () => {
    expect((await h.app.inject({ url: '/.well-known/openid-configuration' })).statusCode).toBe(404);
  });

  it('401 challenges: no error code without credentials', async () => {
    const none = await mcpPost(toolsCall('get_capabilities', {}));
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).not.toContain('error=');
    expect(none.headers.get('access-control-allow-origin')).toBe('*');
    const basic = await mcpPost(toolsCall('get_capabilities', {}), { authorization: 'Basic abc' });
    expect(basic.headers.get('www-authenticate')).toContain('error="invalid_request"');
    const bad = await mcpPost(toolsCall('get_capabilities', {}), { authorization: 'Bearer nope' });
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('tolerates common client variations: scheme case, trailing slash, Accept, missing arguments', async () => {
    const r = await mcpPost(toolsCall('get_capabilities'), { authorization: `bearer ${read.access_token}`, accept: 'application/json' }, '/mcp/');
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const j: any = await r.json();
    expect(j.result.structuredContent.ok).toBe(true);
    const star = await fetch(`${h.baseUrl}/mcp`, { method: 'POST', headers: { authorization: `BEARER ${read.access_token}`, 'content-type': 'application/json', accept: '*/*' }, body: toolsCall('get_capabilities', {}) });
    expect(star.status).toBe(200);
    const noAccept = await fetch(`${h.baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${read.access_token}`, 'content-type': 'application/json' }, body: toolsCall('get_capabilities', {}) });
    expect(noAccept.status).toBe(200);
  });

  it('rejects JSON-RPC batches and reports malformed JSON as -32700', async () => {
    const auth = { authorization: `Bearer ${read.access_token}` };
    const batch = await mcpPost(JSON.stringify([JSON.parse(toolsCall('get_capabilities', {})), JSON.parse(toolsCall('get_capabilities', {}))]), auth);
    expect(batch.status).toBe(400);
    expect(((await batch.json()) as any).error.code).toBe(-32600);
    const broken = await mcpPost('{"jsonrpc": "2.0", "id": 1,', auth);
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as any).error.code).toBe(-32700);
  });

  it('answers a tools/call beyond the granted scopes with 403 insufficient_scope', async () => {
    const r = await mcpPost(toolsCall('create_cart', { store_id: 'demo-r1', items: [] }), { authorization: `Bearer ${read.access_token}` });
    expect(r.status).toBe(403);
    const www = r.headers.get('www-authenticate')!;
    expect(www).toContain('error="insufficient_scope"');
    expect(www).toContain('orders:prepare');
    expect(www).toContain('resource_metadata=');
  });
});
