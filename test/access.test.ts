import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAuthzRequest } from '../src/auth/oauth.js';
import { confirmOnWeb, demoUser, Harness, mcpClient, oauthToken, preparedCheckout, startHarness, webLogin } from './helpers.js';

let h: Harness;
let alice: Awaited<ReturnType<typeof demoUser>>;
let bob: Awaited<ReturnType<typeof demoUser>>;
let aliceOrder: string;
let aliceCheckout: string;
let aliceCart: string;
beforeAll(async () => {
  h = await startHarness();
  alice = await demoUser(h, 'alice@example.com');
  bob = await demoUser(h, 'bob@example.com');
  const p = await preparedCheckout(alice.mcp.call);
  await confirmOnWeb(h, alice, p.checkout.checkout_id);
  aliceCheckout = p.checkout.checkout_id;
  aliceCart = p.cart.cart_id;
  aliceOrder = (await alice.mcp.call('get_checkout_status', { checkout_id: aliceCheckout })).result.order_id;
});
afterAll(async () => {
  await alice.mcp.close();
  await bob.mcp.close();
  await h.close();
});

describe('Object ownership', () => {
  it('Bob cannot read or change Alice\'s objects via MCP', async () => {
    for (const [tool, args] of [
      ['get_order_status', { order_id: aliceOrder }],
      ['get_checkout_status', { checkout_id: aliceCheckout }],
      ['submit_order', { checkout_id: aliceCheckout }],
      ['quote_cart', { cart_id: aliceCart }],
      ['update_cart', { cart_id: aliceCart, expected_version: 1, operations: [{ op: 'add_item', item: { item_id: 'r1-rice', quantity: 1 } }] }],
      ['prepare_cancellation', { order_id: aliceOrder }],
      ['create_cart', { from_order_id: aliceOrder }],
    ] as const) {
      const r = await bob.mcp.call(tool, args as any);
      expect(r.error?.code, tool).toBe('NOT_FOUND');
    }
    expect((await bob.mcp.call('list_orders')).result.orders).toHaveLength(0);
  });

  it('user_id cannot be injected through tool arguments', async () => {
    const r = await bob.mcp.call('list_orders', { user_id: alice.userId });
    expect(r.isError).toBe(true);
  });

  it('Bob cannot open or confirm Alice\'s pages', async () => {
    const p = await preparedCheckout(alice.mcp.call);
    const view = await h.app.inject({ method: 'GET', url: `/confirm/${p.checkout.checkout_id}`, headers: { cookie: bob.cookie } });
    expect(view.statusCode).toBe(404);
    const post = await h.app.inject({ method: 'POST', url: `/confirm/${p.checkout.checkout_id}`, headers: { cookie: bob.cookie }, payload: { _csrf: bob.csrf, total_minor: String(p.checkout.total.amount_minor) } });
    expect(post.statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/app/orders/${aliceOrder}`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    const anon = await h.app.inject({ method: 'GET', url: `/confirm/${p.checkout.checkout_id}` });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toContain('/login?next=');
  });
});

describe('OAuth and tokens', () => {
  it('rejects requests without a token with a spec-compliant challenge', async () => {
    const r = await fetch(`${h.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"');
  });

  it('publishes AS and protected-resource metadata', async () => {
    const as = (await h.app.inject({ url: '/.well-known/oauth-authorization-server' })).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.client_id_metadata_document_supported).toBe(true);
    const prm = (await h.app.inject({ url: '/.well-known/oauth-protected-resource/mcp' })).json();
    expect(prm.resource).toBe('http://localhost:3000/mcp');
  });

  it('never redirects to an unregistered redirect_uri (no open redirect)', async () => {
    const reg = (await h.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'x', redirect_uris: ['https://good.example/cb'] } })).json();
    const r = await h.app.inject({ url: `/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`, headers: { cookie: alice.cookie } });
    expect(r.statusCode).toBe(400);
    expect(r.headers.location).toBeUndefined();
    const bad = await h.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.example/cb'] } });
    expect(bad.json().error).toBe('invalid_redirect_uri');
  });

  it('requires PKCE S256 and rejects a wrong verifier and code reuse', async () => {
    const reg = (await h.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'x', redirect_uris: ['http://localhost:9999/cb'] } })).json();
    await expect(parseAuthzRequest(h.ctx, { client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', response_type: 'code', code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' })).rejects.toThrow(/PKCE/);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: challenge, code_challenge_method: 'S256', scope: 'orders:read' });
    const form = new URLSearchParams([...q.entries(), ['_csrf', alice.csrf], ['decision', 'allow'], ['grant', 'orders:read']]);
    const post = await h.app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie: alice.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: form.toString() });
    const loc = new URL(String(post.headers.location));
    expect(loc.searchParams.get('iss')).toBe('http://localhost:3000');
    const code = loc.searchParams.get('code');
    const bad = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:9999/cb', client_id: reg.client_id, code_verifier: 'wrong'.repeat(10) } });
    expect(bad.json().error).toBe('invalid_grant');
    const good = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:9999/cb', client_id: reg.client_id, code_verifier: verifier } });
    expect(good.statusCode).toBe(200);
    const reuse = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:9999/cb', client_id: reg.client_id, code_verifier: verifier } });
    expect(reuse.json().error).toBe('invalid_grant');
    // Code reuse revokes the tokens issued from it.
    const m = await mcpClient(h, good.json().access_token).catch((e) => e);
    expect(m).toBeInstanceOf(Error);
  });

  it('rejects a token for a different resource (audience check)', async () => {
    await h.db.query(`UPDATE oauth_grants SET resource = 'https://other.example/mcp' WHERE user_id = $1`, [bob.userId]);
    const r = await fetch(`${h.baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${bob.token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(401);
    await h.db.query(`UPDATE oauth_grants SET resource = $2 WHERE user_id = $1`, [bob.userId, h.cfg.mcpResourceUrl]);
  });

  it('scopes are enforced per tool', async () => {
    const s = await webLogin(h, 'carol@example.com');
    const tok = await oauthToken(h, s, 'orders:read');
    const m = await mcpClient(h, tok.access_token);
    expect((await m.call('get_capabilities')).ok).toBe(true);
    const r = await m.call('create_cart', { restaurant_id: 'demo-r1', items: [] });
    expect(r.error.code).toBe('INSUFFICIENT_SCOPE');
    await m.close();
  });

  it('refresh token rotation with reuse detection', async () => {
    const s = await webLogin(h, 'dave@example.com');
    const tok = await oauthToken(h, s);
    const r1 = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: tok.client_id } });
    expect(r1.statusCode).toBe(200);
    const reuse = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: tok.client_id } });
    expect(reuse.json().error).toBe('invalid_grant');
    const r2 = await h.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: r1.json().refresh_token, client_id: tok.client_id } });
    expect(r2.statusCode).toBe(400); // whole grant revoked after reuse
  });

  it('revoking access in the dashboard cuts off the assistant immediately', async () => {
    const s = await webLogin(h, 'erin@example.com');
    const tok = await oauthToken(h, s);
    const m = await mcpClient(h, tok.access_token);
    expect((await m.call('get_capabilities')).ok).toBe(true);
    const grant = (await h.db.query('SELECT id FROM oauth_grants WHERE user_id=$1', [s.userId])).rows[0].id;
    const page = await h.app.inject({ method: 'GET', url: '/app/connections', headers: { cookie: s.cookie } });
    expect(page.body).toContain('Test Assistant');
    await h.app.inject({ method: 'POST', url: `/app/connections/${grant}/revoke`, headers: { cookie: s.cookie }, payload: { _csrf: s.csrf } });
    await expect(m.call('get_capabilities')).rejects.toThrow();
  });

  it('client ID metadata documents are fetched with SSRF protection', async () => {
    await expect(parseAuthzRequest(h.ctx, { client_id: 'https://127.0.0.1/client.json' })).rejects.toThrow(/not allowed/);
    await expect(parseAuthzRequest(h.ctx, { client_id: 'https://localhost:8443/c.json' })).rejects.toThrow(/not allowed/);
    const doc = { client_id: 'https://app.example.com/oauth/client.json', client_name: 'Example', redirect_uris: ['https://app.example.com/cb'] };
    const req = await parseAuthzRequest(
      h.ctx,
      { client_id: doc.client_id, redirect_uri: 'https://app.example.com/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' },
      async () => doc,
    );
    expect(req.client.registration).toBe('cimd');
  });
});

describe('Account data', () => {
  it('export and deletion', async () => {
    const s = await webLogin(h, 'frank@example.com');
    const exp = await h.app.inject({ url: '/app/data/export', headers: { cookie: s.cookie } });
    expect(exp.json().user.email).toBe('frank@example.com');
    const tok = await oauthToken(h, s);
    await h.app.inject({ method: 'POST', url: '/app/data/delete', headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, confirm: 'DELETE' } });
    expect((await h.db.query('SELECT count(*)::int n FROM users WHERE lower(email)=$1', ['frank@example.com'])).rows[0].n).toBe(0);
    const r = await fetch(`${h.baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(r.status).toBe(401);
  });
});
