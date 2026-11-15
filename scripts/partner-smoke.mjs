#!/usr/bin/env node
// Partner API smoke test: one ride from estimate to order and its cancellation, with PASS/FAIL per step.
//
//   BASE=https://unyly-food.unyly.org PARTNER_ID=ari PARTNER_SECRET=... node scripts/partner-smoke.mjs
//
// Optional: SMOKE_USER (default smoke-<time>), KEEP_USER=1 (do not delete the test user at the end),
// ALLOW_LIVE=1 (confirm even when the partner runs in live mode: this places a REAL order).
// Needs Node 18+. Exit code 0 when every step passed.
import { createHash, createHmac, randomBytes } from 'node:crypto';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/+$/, '');
const PARTNER_ID = process.env.PARTNER_ID || 'ari';
const SECRET = process.env.PARTNER_SECRET || '';
if (!SECRET) {
  console.error('PARTNER_SECRET is required (the value of PARTNER_<ID>_SECRET on the server).');
  process.exit(2);
}
const uid = process.env.SMOKE_USER || `smoke-${Date.now()}`;
const U = `/partner/v1/users/${encodeURIComponent(uid)}`;

/** One signed call. `path` is signed exactly as sent (path plus query string). */
async function api(method, path, body, { allowError = false } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const canonical = ['v1', method, path, ts, nonce, createHash('sha256').update(raw).digest('hex')].join('\n');
  const headers = {
    'x-unyly-partner': PARTNER_ID, 'x-unyly-timestamp': ts, 'x-unyly-nonce': nonce,
    'x-unyly-signature': `v1=${createHmac('sha256', SECRET).update(canonical).digest('hex')}`,
    ...(raw ? { 'content-type': 'application/json' } : {}),
  };
  const res = await fetch(BASE + path, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: reported below */ }
  if (!json) throw new Error(`${method} ${path}: HTTP ${res.status}, body is not JSON: ${text.slice(0, 120)}`);
  if (allowError) return { status: res.status, json };
  if (!res.ok || json.ok === false) throw new Error(`${method} ${path}: HTTP ${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim());
  return json;
}

let failed = 0;
let stop = false;
async function step(name, fn) {
  if (stop) return console.log(`SKIP  ${name}`);
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`PASS  ${name}${note ? `: ${note}` : ''} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    stop = true; // later steps depend on this one
    console.log(`FAIL  ${name}: ${e?.message ?? e}`);
  }
}
const need = (v, what) => { if (v === undefined || v === null || v === '') throw new Error(`missing ${what}`); return v; };

console.log(`Partner API smoke test: ${BASE} as "${PARTNER_ID}", user ${uid}`);
let mode = 'unknown';
let option; let checkout; let confirm; let orderId; let created = false;

await step('ping', async () => {
  const r = await api('GET', '/partner/v1/ping');
  mode = need(r.mode, 'mode');
  const skew = Math.round((Date.now() - Date.parse(r.time)) / 1000);
  return `mode ${mode}, clock skew ${skew} s`;
});
await step('user upsert', async () => {
  const r = await api('PUT', U, { locale: 'en', region: 'TH', display_name: 'Smoke Test' });
  created = true;
  return `${r.user.created ? 'created' : 'existing'}, mode ${r.user.mode}`;
});
await step('saved place', async () => {
  const r = await api('POST', `${U}/places`, { label: 'Smoke Home', line1: '88 Sukhumvit Soi 24', district: 'Khlong Toei', city: 'Bangkok' });
  const id = need(r.place?.place_id, 'place.place_id');
  const list = await api('GET', `${U}/places`);
  if (!list.places.some((p) => p.place_id === id)) throw new Error('the new place is not in the list');
  return `${r.place.label}, ${r.place.area}`;
});
await step('estimate_trip', async () => {
  const r = await api('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Suvarnabhumi airport' } });
  option = need((r.card?.options ?? []).find((o) => o.action), 'a selectable option on the card');
  return `${r.card.options.length} options, picking ${option.title} ${option.price ?? ''}`.trim();
});
await step('create_cart', async () => {
  const r = await api('POST', `${U}/tools/${option.action.tool.name}`, { arguments: option.action.tool.arguments });
  checkout = need(r.card?.type === 'checkout' ? r.card : null, 'a checkout card');
  confirm = need(checkout.actions.find((a) => a.kind === 'confirm'), 'a confirm action');
  return `checkout ${checkout.id}, total ${checkout.total.value}, verification ${confirm.requires_user_verification}`;
});
await step('confirm', async () => {
  if (mode !== 'demo' && process.env.ALLOW_LIVE !== '1') throw new Error(`partner mode is "${mode}": confirming would place a real order. Set ALLOW_LIVE=1 to do that on purpose.`);
  const body = { ...confirm.endpoint.body, user_verification: confirm.requires_user_verification === 'biometric' ? 'biometric' : 'tap', confirmed_at: new Date().toISOString(), device_id: 'partner-smoke' };
  const r = await api(confirm.endpoint.method, confirm.endpoint.path, body);
  orderId = need(r.order?.id, 'order.id (checkout status: ' + r.checkout?.status + ')');
  const again = await api(confirm.endpoint.method, confirm.endpoint.path, body);
  if (again.order?.id !== orderId) throw new Error('repeating the confirmation returned a different order');
  return `order ${orderId}, repeat is idempotent`;
});
await step('order status', async () => {
  const r = await api('GET', `${U}/orders/${orderId}`);
  return `${need(r.card?.status?.code, 'status code')} (${r.card.status.label})`;
});
await step('events', async () => {
  const r = await api('GET', `${U}/events?after=0`);
  const types = r.events.map((e) => e.type);
  for (const t of ['order.created', 'checkout.confirmed']) if (!types.includes(t)) throw new Error(`no ${t} event; got ${types.join(', ') || 'none'}`);
  return `${r.events.length} events, last seq ${r.events[r.events.length - 1].seq}`;
});
await step('cancellation', async () => {
  if (mode !== 'demo') return 'skipped outside demo mode (a real cancellation may cost a fee)';
  const order = await api('GET', `${U}/orders/${orderId}`);
  const prepare = need(order.card.actions.find((a) => a.kind === 'prepare_cancel'), 'a prepare_cancel action on the order card');
  const prepared = await api(prepare.endpoint.method, prepare.endpoint.path);
  const yes = need(prepared.card?.actions.find((a) => a.kind === 'confirm'), 'a confirm action on the cancellation card');
  const r = await api(yes.endpoint.method, yes.endpoint.path, { ...yes.endpoint.body, user_verification: 'tap' });
  if (r.cancellation?.status !== 'executed') throw new Error(`cancellation status is ${r.cancellation?.status}`);
  return `fee ${prepared.cancellation.fee.formatted}, order is ${need(r.order?.card?.status?.code, 'order status')}`;
});
await step('error shape', async () => {
  const r = await api('GET', `${U}/orders/00000000-0000-4000-8000-000000000000`, undefined, { allowError: true });
  if (r.status !== 404 || r.json.ok !== false || r.json.error?.code !== 'NOT_FOUND' || typeof r.json.error?.message !== 'string') throw new Error(`expected 404 { ok: false, error: { code: "NOT_FOUND", message } }, got HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  return '404 NOT_FOUND in the common envelope';
});

// Cleanup runs even after a failure: the test user and its demo order are removed.
if (created && process.env.KEEP_USER !== '1') {
  stop = false;
  await step('cleanup (delete test user)', async () => { await api('DELETE', U); });
}
console.log(failed ? `\nRESULT: FAIL (${failed} step${failed === 1 ? '' : 's'} failed)` : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
