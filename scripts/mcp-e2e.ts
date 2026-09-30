// End-to-end smoke test against a RUNNING Unyly server (local or staging) in Demo mode.
// Requires DEV_ECHO_LOGIN_CODE=true on the server (never in production).
// Usage: BASE_URL=http://localhost:3000 npm run e2e:mcp   (prints a bearer token you can reuse with MCP Inspector)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const email = process.env.E2E_EMAIL || `e2e+${Date.now()}@example.com`;
let cookie = '';
const form = (o: Record<string, string | string[]>) =>
  new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString();
async function post(path: string, body: Record<string, string | string[]>) {
  const r = await fetch(BASE + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: BASE }, body: form(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r;
}
const get = (path: string) => fetch(BASE + path, { redirect: 'manual', headers: { cookie } });
const step = (s: string) => console.log(`\n▶ ${s}`);

step(`sign in as ${email}`);
const codePage = await (await post('/login', { email, next: '/app' })).text();
const code = /(?:код|code) (\d{6})/.exec(codePage)?.[1];
if (!code) throw new Error('No dev login code on page (is DEV_ECHO_LOGIN_CODE=true?)');
await post('/login/verify', { email, code, next: '/app' });
const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await get('/app/addresses')).text())![1];

step('choose Demo mode and add an address');
await post('/app/mode', { _csrf: csrf, region: 'TH', mode: 'demo' });
await post('/app/addresses', { _csrf: csrf, label: 'Home', line1: '12/3 Sukhumvit Soi 24', district: 'Watthana', city: 'Bangkok', country: 'TH', default: '1' });

step('OAuth: discovery → dynamic registration → consent → PKCE token');
const probe = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const prmUrl = /resource_metadata="([^"]+)"/.exec(probe.headers.get('www-authenticate') ?? '')?.[1];
const prm = await (await fetch(prmUrl!)).json();
const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
const reg = await (await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Unyly e2e', redirect_uris: ['http://localhost:8765/cb'] }) })).json();
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:8765/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e', scope: as.scopes_supported.join(' '), resource: prm.resource };
await get(`/oauth/authorize?${new URLSearchParams(params)}`);
const consent = await post('/oauth/authorize', { ...params, _csrf: csrf, decision: 'allow', grant: as.scopes_supported });
const authCode = new URL(consent.headers.get('location')!).searchParams.get('code')!;
const tok = await (await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code: authCode, redirect_uri: params.redirect_uri, client_id: reg.client_id, code_verifier: verifier, resource: prm.resource }) })).json();
if (!tok.access_token) throw new Error(`token error ${JSON.stringify(tok)}`);

step('MCP over Streamable HTTP');
const client = new Client({ name: 'unyly-e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const sc = r.structuredContent;
  console.log(`  ${name}: ${sc.ok ? 'ok' : `ERROR ${sc.error.code}`}`);
  return sc;
};
console.log(`  tools: ${(await client.listTools()).tools.map((t) => t.name).join(', ')}`);
await call('get_capabilities');
const s = await call('search_stores', { party_size: 2, budget_total_major: 600, exclude_allergens: ['peanut', 'tree_nut'], limit: 3 });
for (const r of s.result.stores) console.log(`   • ${r.store.name}: ${r.suggestion ? `${r.suggestion.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')} ≈ ${r.suggestion.estimated_total.formatted}` : r.availability_notes.join('; ')}`);
const first = s.result.stores.find((r: any) => r.suggestion && r.suggestion.within_budget);
const cart = await call('create_cart', { store_id: first.store.store_id, items: first.suggestion.items.map((i: any) => ({ item_id: i.item_id, quantity: i.quantity })) });
const quote = await call('quote_cart', { cart_id: cart.result.cart_id });
console.log(`   total ${quote.result.breakdown.total.formatted}`);
const co = await call('prepare_checkout', { cart_id: cart.result.cart_id, quote_id: quote.result.quote_id });
const early = await call('submit_order', { checkout_id: co.result.checkout_id });
if (early.error?.code !== 'CONFIRMATION_REQUIRED') throw new Error('submit without confirmation must fail');

if (process.env.E2E_STOP_BEFORE_CONFIRM) {
  console.log(`\nStopped before confirmation. Open as ${email}: ${co.result.confirm_url}\nCHECKOUT=${co.result.checkout_id}`);
  await client.close();
  process.exit(0);
}
step('human confirms on the web page');
const pageHtml = await (await get(`/confirm/${co.result.checkout_id}`)).text();
const total = /name="total_minor" value="(\d+)"/.exec(pageHtml)![1];
await post(`/confirm/${co.result.checkout_id}`, { _csrf: csrf, total_minor: total });
const st = await call('get_checkout_status', { checkout_id: co.result.checkout_id });
console.log(`   submission: ${st.result.submission?.status}, order ${st.result.order_id}`);
const os = await call('get_order_status', { order_id: st.result.order_id });
console.log(`   fulfillment: ${os.result.fulfillment_status}, payment: ${os.result.payment_status}`);
await client.close();
console.log(`\n✔ E2E passed.\nBearer token for MCP Inspector (expires in ${tok.expires_in}s):\n${tok.access_token}`);
