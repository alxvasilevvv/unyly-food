import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { Config, loadConfig } from '../src/config.js';
import { createCtx, Ctx, OffsetClock } from '../src/context.js';
import { createDb, Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { addAddress } from '../src/services/users.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/unyly_test';

export interface Harness {
  cfg: Config;
  db: Db;
  ctx: Ctx;
  clock: OffsetClock;
  app: FastifyInstance;
  baseUrl: string;
  close(): Promise<void>;
}

export async function resetDb() {
  const db = createDb(TEST_DB, 2);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await db.close();
}

/** Start an app instance on a random port. `fresh=false` reuses the existing DB (simulates a restart). */
export async function startHarness(opts: { fresh?: boolean; cfg?: Partial<Config> } = {}): Promise<Harness> {
  if (opts.fresh !== false) await resetDb();
  const cfg = loadConfig({
    env: 'test',
    databaseUrl: TEST_DB,
    webOrigin: 'http://localhost:3000',
    mcpResourceUrl: 'http://localhost:3000/mcp',
    cookieSecure: false,
    devEchoLoginCode: true,
    providerTimeoutMs: 1500,
    demoTimeScale: 1,
    demoGuestSpeed: 12,
    runJobs: false,
    ...opts.cfg,
  });
  const db = createDb(cfg.databaseUrl, 10);
  const clock = new OffsetClock();
  const ctx = createCtx(cfg, db, clock);
  const app = await buildApp(ctx);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  return {
    cfg, db, ctx, clock, app, baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/** Sign in through the real web flow (email code), returns the session cookie. */
export async function webLogin(h: Harness, email: string): Promise<{ cookie: string; userId: string; csrf: string }> {
  const r1 = await h.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost:3000' }, payload: { email, next: '/app' } });
  const code = /код (\d{6})|code (\d{6})/.exec(r1.body);
  if (!code) throw new Error('no dev code in page');
  const r2 = await h.app.inject({ method: 'POST', url: '/login/verify', headers: { origin: 'http://localhost:3000' }, payload: { email, code: code[1] ?? code[2], next: '/app' } });
  const setCookie = String(r2.headers['set-cookie']);
  const cookie = setCookie.split(';')[0];
  const u = await h.db.query('SELECT id FROM users WHERE lower(email) = $1', [email.toLowerCase()]);
  const page = await h.app.inject({ method: 'GET', url: '/app/preferences', headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1];
  return { cookie, userId: u.rows[0].id, csrf };
}

export async function addHomeAddress(h: Harness, userId: string, district = 'Watthana') {
  return addAddress(h.ctx, userId, { label: 'Home', line1: '12/3 Sukhumvit Soi 24', district, city: 'Bangkok', country: 'TH' }, true);
}

const b64url = (b: Buffer) => b.toString('base64url');

/** Full OAuth 2.1 flow: DCR, authorize (consent via web session), PKCE token exchange. */
export async function oauthToken(h: Harness, session: { cookie: string; csrf: string }, scopes = 'orders:read orders:prepare orders:submit orders:cancel') {
  const reg = await h.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Test Assistant', redirect_uris: ['http://localhost:9999/cb'] } });
  const client = reg.json();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st1', scope: scopes, resource: h.cfg.mcpResourceUrl,
  });
  const consent = await h.app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: { cookie: session.cookie } });
  if (consent.statusCode !== 200) throw new Error(`consent page ${consent.statusCode}: ${consent.body.slice(0, 300)}`);
  const form: Record<string, any> = Object.fromEntries(q.entries());
  form._csrf = session.csrf;
  form.decision = 'allow';
  form.grant = scopes.split(' ');
  const post = await h.app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString(), });
  if (post.statusCode !== 302) throw new Error(`authorize POST ${post.statusCode}: ${post.body.slice(0, 300)}`);
  const loc = new URL(String(post.headers.location));
  if (loc.searchParams.get('state') !== 'st1') throw new Error('state mismatch');
  const tok = await h.app.inject({
    method: 'POST', url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: 'http://localhost:9999/cb', client_id: client.client_id, code_verifier: verifier, resource: h.cfg.mcpResourceUrl },
  });
  if (tok.statusCode !== 200) throw new Error(`token ${tok.statusCode} ${tok.body}`);
  return { ...tok.json(), client_id: client.client_id } as { access_token: string; refresh_token: string; client_id: string; scope: string };
}

/** Real MCP client over Streamable HTTP. */
export async function mcpClient(h: Harness, token: string) {
  const client = new Client({ name: 'unyly-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { ...(r.structuredContent ?? {}), isError: !!r.isError, rawText: r.content?.[0]?.text } as any;
  };
  return { client, call, close: () => client.close() };
}

/** Web confirmation as the human would do it. */
export async function confirmOnWeb(h: Harness, s: { cookie: string; csrf: string }, checkoutId: string) {
  const page = await h.app.inject({ method: 'GET', url: `/confirm/${checkoutId}`, headers: { cookie: s.cookie } });
  const total = /name="total_minor" value="(\d+)"/.exec(page.body)?.[1];
  return h.app.inject({ method: 'POST', url: `/confirm/${checkoutId}`, headers: { cookie: s.cookie }, payload: { _csrf: s.csrf, total_minor: total ?? '0' } });
}

/** A ready-to-go demo user with address, token and MCP client. */
export async function demoUser(h: Harness, email = 'alice@example.com', district = 'Watthana') {
  const s = await webLogin(h, email);
  await addHomeAddress(h, s.userId, district);
  const tok = await oauthToken(h, s);
  const m = await mcpClient(h, tok.access_token);
  return { ...s, token: tok, mcp: m };
}

/** create_cart → quote_cart → prepare_checkout for a simple valid demo order. */
export async function preparedCheckout(call: (n: string, a?: any) => Promise<any>, items = [{ item_id: 'r1-greencurry', quantity: 2 }], store_id = 'demo-r1') {
  const cart = await call('create_cart', { store_id, items });
  if (!cart.ok) throw new Error(JSON.stringify(cart));
  const quote = await call('quote_cart', { cart_id: cart.result.cart_id });
  if (!quote.ok) throw new Error(JSON.stringify(quote));
  const co = await call('prepare_checkout', { cart_id: cart.result.cart_id, quote_id: quote.result.quote_id });
  if (!co.ok) throw new Error(JSON.stringify(co));
  return { cart: cart.result, quote: quote.result, checkout: co.result };
}
