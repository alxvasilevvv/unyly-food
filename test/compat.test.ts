import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redirectMatches } from '../src/auth/oauth.js';
import { addHomeAddress, Harness, mcpClient, startHarness, webLogin } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const b64url = (b: Buffer) => b.toString('base64url');

describe('AI client compatibility (OAuth)', () => {
  it('metadata advertises CIMD, public clients, iss parameter and offline_access', async () => {
    const md = (await h.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(md.client_id_metadata_document_supported).toBe(true);
    expect(md.token_endpoint_auth_methods_supported).toContain('none');
    expect(md.authorization_response_iss_parameter_supported).toBe(true);
    expect(md.scopes_supported).toContain('offline_access');
  });

  it('loopback redirect URIs may use any port; other hosts must match exactly', () => {
    const reg = ['http://127.0.0.1/callback', 'https://claude.ai/api/mcp/auth_callback'];
    expect(redirectMatches(reg, 'http://127.0.0.1:53682/callback')).toBe(true);
    expect(redirectMatches(reg, 'http://127.0.0.1:53682/other')).toBe(false);
    expect(redirectMatches(reg, 'http://evil.example:80/callback')).toBe(false);
    expect(redirectMatches(reg, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectMatches(reg, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false);
  });

  it('a client asking only for offline_access (ChatGPT style) gets the consent page with all Unyly scopes', async () => {
    const s = await webLogin(h, 'gpt@example.com');
    const client = (await h.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] } })).json();
    const verifier = b64url(randomBytes(32));
    const q = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: 's', scope: 'offline_access', resource: h.cfg.mcpResourceUrl,
    });
    const page = await h.app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: { cookie: s.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('orders:submit');
    const bad = await h.app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), scope: 'admin:everything' })}`, headers: { cookie: s.cookie } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('Personal tokens (bearer-only clients)', () => {
  async function createToken(s: { cookie: string; csrf: string }, scopes = ['orders:read', 'orders:prepare']) {
    const body = new URLSearchParams({ _csrf: s.csrf, name: 'Le Chat', days: '30' });
    for (const sc of scopes) body.append('scope', sc);
    const r = await h.app.inject({ method: 'POST', url: '/app/tokens', headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: body.toString() });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    return /(unyly_pat_[A-Za-z0-9_-]+)/.exec(r.body)![1];
  }

  it('a token works over MCP with exactly its scopes, and is shown only once', async () => {
    const s = await webLogin(h, 'pat@example.com');
    await addHomeAddress(h, s.userId);
    const token = await createToken(s);
    const page = await h.app.inject({ method: 'GET', url: '/app/connections', headers: { cookie: s.cookie } });
    expect(page.body).toContain('Le Chat');
    expect(page.body).not.toContain(token);
    const m = await mcpClient(h, token);
    const caps = await m.call('get_capabilities');
    expect(caps.ok).toBe(true);
    const cart = await m.call('create_cart', { store_id: 'demo-r1', items: [{ item_id: 'r1-rice', quantity: 1 }] });
    expect(cart.ok).toBe(true);
    const cancel = await m.call('cancel_order', { cancellation_id: '00000000-0000-4000-8000-000000000000' });
    expect(cancel.error.code).toBe('INSUFFICIENT_SCOPE');
    await m.close();
  });

  it('revoked tokens stop working; tokens in the URL are never accepted', async () => {
    const s = await webLogin(h, 'pat2@example.com');
    const token = await createToken(s);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const viaQuery = await h.app.inject({ method: 'POST', url: `/mcp?access_token=${token}`, headers, payload: init });
    expect(viaQuery.statusCode).toBe(401);
    const ok = await h.app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, authorization: `Bearer ${token}` }, payload: init });
    expect(ok.statusCode).toBe(200);
    const id = (await h.db.query('SELECT id FROM personal_tokens WHERE user_id = $1', [s.userId])).rows[0].id;
    await h.app.inject({ method: 'POST', url: `/app/tokens/${id}/revoke`, headers: { cookie: s.cookie }, payload: { _csrf: s.csrf } });
    const after = await h.app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, authorization: `Bearer ${token}` }, payload: init });
    expect(after.statusCode).toBe(401);
  });

  it('guests cannot create tokens', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/try/start', headers: { origin: 'http://localhost:3000' }, payload: { q: 'x' } });
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    const page = await h.app.inject({ method: 'GET', url: String(r.headers.location), headers: { cookie } });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1];
    const t = await h.app.inject({ method: 'POST', url: '/app/tokens', headers: { cookie }, payload: { _csrf: csrf, name: 'x', scope: 'orders:read' } });
    expect(t.statusCode).toBe(403);
    expect((await h.db.query('SELECT count(*)::int n FROM personal_tokens')).rows[0].n).toBe(2);
  });
});
