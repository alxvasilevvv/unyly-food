// Round 4 contract check: the three descriptions of the Partner API (routes.ts, the OpenAPI document and the
// two guides) against the running API, walked the way the Russian task file tells the Ari team to do it.
// The signing code here is written from the text of the guide only (no helper from src/partners/auth.ts).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PartnerConfig } from '../src/partners/config.js';
import { deliverPartnerWebhooks } from '../src/partners/webhooks.js';
import { Harness, startHarness } from './helpers.js';

const ARI: PartnerConfig = {
  id: 'ari', name: 'Ari', secret: 'e1'.repeat(32), webhookUrl: 'https://api.ari.example/webhooks/unyly?src=unyly', webhookSecret: 'f2'.repeat(32), mode: 'demo',
};
const RU_DOC = readFileSync(new URL('../src/web/static/docs/ari-integration-ru.md', import.meta.url), 'utf8');
const EN_DOC = readFileSync(new URL('../docs/partner-api.md', import.meta.url), 'utf8');
const ROUTES_SRC = readFileSync(new URL('../src/partners/routes.ts', import.meta.url), 'utf8');

let h: Harness;
let doc: any;
let ajv: Ajv;

/** Section 4 of the guide, as written there. */
function signature(secret: string, method: string, pathWithQuery: string, ts: string, nonce: string, rawBody: string) {
  const canonical = ['v1', method.toUpperCase(), pathWithQuery, ts, nonce, createHash('sha256').update(rawBody).digest('hex')].join('\n');
  return 'v1=' + createHmac('sha256', secret).update(canonical).digest('hex');
}

async function unyly(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(h.clock.now().getTime() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const headers: Record<string, string> = {
    'x-unyly-partner': ARI.id, 'x-unyly-timestamp': ts, 'x-unyly-nonce': nonce, 'x-unyly-signature': signature(ARI.secret, method, path, ts, nonce, raw),
    ...(raw ? { 'content-type': 'application/json' } : {}),
  };
  const r = await h.app.inject({ method: method as any, url: path, headers, payload: raw || undefined });
  return { status: r.statusCode, json: r.json() as any, headers: r.headers };
}

/** Validates a value against a schema of the served OpenAPI document. */
function matches(schemaName: string, value: unknown) {
  const validate = ajv.compile({ $ref: `#/components/schemas/${schemaName}`, components: doc.components });
  const ok = validate(value);
  return ok ? [] : (validate.errors ?? []).map((e) => `${schemaName}${e.instancePath} ${e.message}`);
}
/** The documented response schema of one operation and status. */
function responseErrors(method: string, path: string, status: number, value: unknown) {
  const op = doc.paths[path]?.[method.toLowerCase()];
  if (!op) return [`${method} ${path} is not in the OpenAPI document`];
  const res = op.responses[String(status)];
  if (!res) return [`${method} ${path}: status ${status} is not documented (documented: ${Object.keys(op.responses).join(', ')})`];
  const validate = ajv.compile({ ...res.content['application/json'].schema, components: doc.components });
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${method} ${path} ${status}${e.instancePath} ${e.message}`);
}
const keys = (o: unknown) => Object.keys(o as object).sort();
const isErrorEnvelope = (j: any) => j?.ok === false && typeof j.error?.code === 'string' && typeof j.error?.message === 'string';

beforeAll(async () => {
  h = await startHarness({ cfg: { partners: [ARI] } });
  doc = (await h.app.inject({ method: 'GET', url: '/partner/v1/openapi.json' })).json();
  ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
});
afterAll(async () => {
  await h.close();
});

describe('r4 contract: the three descriptions name the same endpoints', () => {
  const registered = [...ROUTES_SRC.matchAll(/(?:app|scope)\.(get|put|post|delete)\('(\/partner\/v1[^']*)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2].replace(/:(\w+)/g, '{$1}')}`).sort();

  it('every registered route is in the OpenAPI document and nothing else is', () => {
    const documented = Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item as object).map((m) => `${m.toUpperCase()} ${p}`)).sort();
    expect(registered.length).toBe(23);
    expect(documented).toEqual(registered);
  });

  it('every operation has an operationId, and path parameters are declared', () => {
    const ids = new Set<string>();
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(item)) {
        expect([m, p, typeof op.operationId]).toEqual([m, p, 'string']);
        expect(ids.has(op.operationId)).toBe(false);
        ids.add(op.operationId);
        const inPath = [...p.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
        const declared = (op.parameters ?? []).filter((x: any) => x.in === 'path').map((x: any) => x.name).sort();
        expect([p, declared]).toEqual([p, inPath]);
      }
    }
  });

  it('the English reference lists exactly the same endpoints', () => {
    const table = [...EN_DOC.matchAll(/^\| `(GET|PUT|POST|DELETE) (\/[^` ]*)` \|/gm)].map((m) => `${m[1]} /partner/v1${m[2].split('?')[0]}`).sort();
    expect(table).toEqual(registered);
  });

  it('every endpoint the Russian task file mentions exists, with the same parameter names', () => {
    const mentioned = [...RU_DOC.matchAll(/`?(GET|PUT|POST|DELETE) (\/partner\/v1\/[A-Za-z0-9_{}/.-]*)/g)].map((m) => `${m[1]} ${m[2].replace(/[.,]$/, '')}`)
      .filter((m) => m !== 'PUT /partner/v1/users/u_1'); // the worked signing example
    expect(mentioned.length).toBeGreaterThan(20);
    for (const m of new Set(mentioned)) expect([m, registered.includes(m)]).toEqual([m, true]);
    // Each part of the API is covered by a task.
    for (const r of registered.filter((x) => !x.endsWith('/openapi.json') && !x.endsWith('/catalog'))) expect([r, mentioned.includes(r)]).toEqual([r, true]);
    // The names that earlier versions of the spec used for path parameters are gone.
    expect(RU_DOC).not.toMatch(/\{(checkout_id|order_id|cancellation_id|place_id|user_id|id)\}/);
    expect(EN_DOC).not.toMatch(/\{(checkout_id|order_id|cancellation_id|place_id|user_id|id)\}/);
  });

  it('tools named in the guides exist, and the hidden ones are not offered', async () => {
    const tools = await unyly('GET', '/partner/v1/tools');
    expect(responseErrors('GET', '/partner/v1/tools', 200, tools.json)).toEqual([]);
    const names: string[] = tools.json.tools.map((t: any) => t.name);
    expect(typeof tools.json.instructions).toBe('string');
    expect(keys(tools.json.tools[0])).toEqual(['description', 'input_schema', 'name', 'read_only', 'title']);
    for (const t of ['search_stores', 'estimate_trip', 'create_cart', 'update_cart', 'quote_cart', 'prepare_checkout', 'get_checkout_status', 'get_order_status', 'list_orders', 'prepare_cancellation', 'get_capabilities', 'get_store']) {
      expect([t, names.includes(t), RU_DOC.includes(`\`${t}\``)]).toEqual([t, true, true]);
    }
    expect(names).not.toContain('submit_order');
    expect(names).not.toContain('cancel_order');
    // What the guides say about passengers.
    const schema = (n: string) => tools.json.tools.find((t: any) => t.name === n).input_schema.properties;
    expect(schema('estimate_trip').passengers).toMatchObject({ minimum: 1, maximum: 10 });
    expect(schema('create_cart').passengers).toBeUndefined();
  });
});

describe('r4 contract: signing recipe from the guide', () => {
  it('the worked example in the guide is correct', () => {
    const field = (name: string) => new RegExp(`^${name}:\\s+(.+)$`, 'm').exec(RU_DOC)![1].trim();
    const [method, path] = field('метод и путь').split(' ');
    const body = field('тело');
    expect(createHash('sha256').update(body).digest('hex')).toBe(field('sha256\\(тело\\)'));
    expect(signature(field('partner_secret'), method, path, field('timestamp'), field('nonce'), body)).toBe(field('подпись'));
  });

  it('ping answers what the guide shows; a broken signature is always the same 401', async () => {
    const ok = await unyly('GET', '/partner/v1/ping');
    expect(ok.status).toBe(200);
    expect(keys(ok.json)).toEqual(['mode', 'ok', 'partner', 'time']);
    expect(ok.json).toMatchObject({ ok: true, partner: 'ari', mode: 'demo' });
    expect(responseErrors('GET', '/partner/v1/ping', 200, ok.json)).toEqual([]);
    expect(String(ok.headers['server-timing'])).toMatch(/^app;dur=/);

    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(18).toString('base64url');
    const good = signature(ARI.secret, 'GET', '/partner/v1/ping', ts, nonce, '');
    const base = { 'x-unyly-partner': 'ari', 'x-unyly-timestamp': ts, 'x-unyly-nonce': nonce, 'x-unyly-signature': good };
    const stale = String(Number(ts) - 301);
    const variants: Record<string, string>[] = [
      {}, { ...base, 'x-unyly-signature': good.replace(/.$/, good.endsWith('0') ? '1' : '0') }, { ...base, 'x-unyly-partner': 'nobody' },
      { ...base, 'x-unyly-timestamp': stale, 'x-unyly-signature': signature(ARI.secret, 'GET', '/partner/v1/ping', stale, nonce, '') },
      { ...base, 'x-unyly-nonce': 'short', 'x-unyly-signature': signature(ARI.secret, 'GET', '/partner/v1/ping', ts, 'short', '') },
    ];
    for (const headers of variants) {
      const r = await h.app.inject({ method: 'GET', url: '/partner/v1/ping', headers });
      expect([r.statusCode, r.json()]).toEqual([401, { ok: false, error: { code: 'PARTNER_AUTH_FAILED', message: 'Partner signature missing or invalid.' } }]);
      expect(responseErrors('GET', '/partner/v1/ping', 401, r.json())).toEqual([]);
    }
    // The untouched headers work once, and a replay of the same nonce does not.
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', headers: base })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/partner/v1/ping', headers: base })).statusCode).toBe(401);
    // The query string is part of what is signed.
    expect((await unyly('GET', '/partner/v1/catalog?lang=ru')).status).toBe(200);
  });
});

describe('r4 contract: the happy path of the Russian task file, step by step', () => {
  const U = '/partner/v1/users/u_1';
  let checkout: any;
  let orderId = '';

  it('B2: PUT creates the user (201), repeats update it (200), every other call needs the user', async () => {
    const before = await unyly('GET', `${U}/orders`);
    expect([before.status, before.json.error.code]).toEqual([404, 'NOT_FOUND']);
    expect(before.json.error.message).toMatch(/PUT \/partner\/v1\/users\/\{(uid|user_id)\}/);

    const created = await unyly('PUT', U, { locale: 'th', region: 'TH', display_name: 'Alex' });
    expect(created.status).toBe(201);
    expect(keys(created.json)).toEqual(['grab', 'ok', 'user']);
    expect(created.json.user).toEqual({ user_id: 'u_1', display_name: 'Alex', locale: 'th', region: 'TH', mode: 'demo', created: true });
    expect(created.json.grab).toEqual({ linked: false, linked_at: null, simulated: false });
    expect(responseErrors('PUT', '/partner/v1/users/{uid}', 201, created.json)).toEqual([]);

    const again = await unyly('PUT', U, { locale: 'en' });
    expect([again.status, again.json.user.created, again.json.user.locale, again.json.user.region, again.json.user.display_name]).toEqual([200, false, 'en', 'TH', 'Alex']);
    expect(responseErrors('PUT', '/partner/v1/users/{uid}', 200, again.json)).toEqual([]);
    const read = await unyly('GET', U);
    expect(read.json.user).toEqual(again.json.user);

    // No body at all: defaults en and TH.
    const bare = await unyly('PUT', '/partner/v1/users/bare');
    expect([bare.status, bare.json.user.locale, bare.json.user.region]).toEqual([201, 'en', 'TH']);
    const bad = await unyly('PUT', U, { locale: 'xx' });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(responseErrors('PUT', '/partner/v1/users/{uid}', 400, bad.json)).toEqual([]);
  });

  it('B6: a place is saved with 201; an incomplete one is a 400 with details.fields', async () => {
    const missing = await unyly('POST', `${U}/places`, { label: 'Дом' });
    expect([missing.status, missing.json.error.code, missing.json.error.details.fields]).toEqual([400, 'VALIDATION_FAILED', ['line1', 'district', 'city']]);
    const noHouse = await unyly('POST', `${U}/places`, { label: 'Дом', line1: 'Sukhumvit Road', district: 'Khlong Toei', city: 'Bangkok' });
    expect([noHouse.status, noHouse.json.error.code, noHouse.json.error.details.fields]).toEqual([400, 'VALIDATION_FAILED', ['line1']]);

    const saved = await unyly('POST', `${U}/places`, { label: 'Дом', line1: '88 Sukhumvit Soi 24', district: 'Khlong Toei', city: 'Bangkok', latitude: 13.7246, longitude: 100.5672 });
    expect(saved.status).toBe(201);
    expect(saved.json.place).toMatchObject({ label: 'Дом', area: 'Khlong Toei, Bangkok', is_default: true });
    expect(saved.json.place.place_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(saved.json)).not.toContain('Sukhumvit Soi 24');
    expect(responseErrors('POST', '/partner/v1/users/{uid}/places', 201, saved.json)).toEqual([]);

    const list = await unyly('GET', `${U}/places`);
    expect(list.json.places.map((p: any) => p.place_id)).toEqual([saved.json.place.place_id]);
    expect(responseErrors('GET', '/partner/v1/users/{uid}/places', 200, list.json)).toEqual([]);

    const work = await unyly('POST', `${U}/places`, { label: 'Work', line1: '1 Rama IV Road', district: 'Pathum Wan', city: 'Bangkok', is_default: false });
    expect([work.status, work.json.place.is_default]).toEqual([201, false]);
    const gone = await unyly('DELETE', `${U}/places/${work.json.place.place_id}`);
    expect([gone.status, gone.json]).toEqual([200, { ok: true, deleted: true }]);
    expect((await unyly('DELETE', `${U}/places/not-a-uuid`)).status).toBe(404);
  });

  it('B3: estimate_trip returns an options card; places can be landmarks or saved labels; errors are 422 with error.code', async () => {
    const trip = await unyly('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Suvarnabhumi' } });
    expect(trip.status).toBe(200);
    for (const k of ['ok', 'mode', 'data_as_of', 'result', 'next_actions', 'notices', 'card']) expect([k, k in trip.json]).toEqual([k, true]);
    expect(trip.json.mode).toBe('demo');
    expect(responseErrors('POST', '/partner/v1/users/{uid}/tools/{name}', 200, trip.json)).toEqual([]);
    const card = trip.json.card;
    expect(card).toMatchObject({ schema: 'unyly.card.v1', type: 'options', service: 'ride', demo: true, actions: [] });
    expect(card.route).toMatchObject({ from: 'Siam Paragon', to: 'Suvarnabhumi Airport (BKK)' });
    expect(typeof card.route.distance_km).toBe('number');
    expect(typeof card.route.minutes).toBe('number');
    expect(card.options.length).toBeGreaterThan(2);
    for (const o of card.options) {
      for (const k of ['id', 'title', 'subtitle', 'price', 'eta', 'badges']) expect([o.id, k, k in o]).toEqual([o.id, k, true]);
      expect(o.action).toMatchObject({ kind: 'tool', tool: { name: 'create_cart', arguments: { service: 'ride', items: [{ item_id: o.id, quantity: 1 }] } } });
    }

    // "такси домой": the saved label works as a place.
    const home = await unyly('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Дом' } });
    expect([home.status, home.json.card.route.to]).toEqual([200, 'Дом']);

    // "такси до аэропорта": two airports, the model has to ask.
    const amb = await unyly('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'airport' } });
    expect([amb.status, amb.json.ok, amb.json.error.code, amb.json.card]).toEqual([422, false, 'PLACE_AMBIGUOUS', null]);
    expect(amb.json.error.details.suggestions).toEqual(['Suvarnabhumi Airport (BKK)', 'Don Mueang Airport (DMK)']);
    expect(typeof amb.json.error.user_action).toBe('string');
    expect(typeof amb.json.operation_id).toBe('string');
    expect(responseErrors('POST', '/partner/v1/users/{uid}/tools/{name}', 422, amb.json)).toEqual([]);
    const unknown = await unyly('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Zzyzx', dropoff: 'Siam Paragon' } });
    expect([unknown.status, unknown.json.error.code]).toEqual([422, 'PLACE_NOT_FOUND']);
    const wrongArgs = await unyly('POST', `${U}/tools/estimate_trip`, { arguments: { service: 5 } });
    expect([wrongArgs.status, wrongArgs.json.error.code]).toEqual([422, 'VALIDATION_FAILED']);

    // Not tool errors: unknown tool 404, hidden tool 400.
    const noTool = await unyly('POST', `${U}/tools/nope_tool`, { arguments: {} });
    expect([noTool.status, noTool.json.error.code]).toEqual([404, 'NOT_FOUND']);
    const hidden = await unyly('POST', `${U}/tools/submit_order`, { arguments: {} });
    expect([hidden.status, hidden.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('B3: too many passengers disables the small vehicles with a reason; more than 10 is a 422', async () => {
    await unyly('PUT', '/partner/v1/users/u_ru', { locale: 'ru' });
    const six = await unyly('POST', '/partner/v1/users/u_ru/tools/estimate_trip', { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM', passengers: 5 } });
    expect(six.status).toBe(200);
    const byId = Object.fromEntries(six.json.card.options.map((o: any) => [o.id, o]));
    expect(byId.justgrab.disabled_reason).toBe('Мест всего 4');
    expect(byId.justgrab.action).toBeUndefined();
    expect(byId.grabcar_suv.disabled_reason).toBeUndefined();
    expect(byId.grabcar_suv.action.tool.name).toBe('create_cart');
    const en = await unyly('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM', passengers: 5 } });
    expect(en.json.card.options.find((o: any) => o.id === 'justgrab').disabled_reason).toBe('Seats 4 only');
    const eleven = await unyly('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM', passengers: 11 } });
    expect([eleven.status, eleven.json.error.code]).toEqual([422, 'VALIDATION_FAILED']);
  });

  it('B3 and A1: create_cart returns the checkout card with the documented fields', async () => {
    const trip = await unyly('POST', `${U}/tools/estimate_trip`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'Suvarnabhumi' } });
    const choice = trip.json.card.options.find((o: any) => o.id === 'justgrab');
    const cart = await unyly('POST', `${U}/tools/${choice.action.tool.name}`, { arguments: choice.action.tool.arguments });
    expect(cart.status).toBe(200);
    checkout = cart.json.card;
    expect(matches('Card', checkout)).toEqual([]);
    expect(checkout).toMatchObject({ schema: 'unyly.card.v1', type: 'checkout', service: 'ride', title: 'JustGrab', demo: true });
    expect(checkout.id).toBe(cart.json.result.checkout.checkout_id);
    expect(checkout.badges[0]).toBe('Demo: nothing is delivered or charged');
    expect(keys(checkout.lines[0])).toEqual(['quantity', 'title', 'value']);
    expect(keys(checkout.breakdown[0])).toEqual(['label', 'value']);
    expect(keys(checkout.total)).toEqual(['amount_minor', 'currency', 'label', 'value']);
    expect(checkout.total).toMatchObject({ label: 'Total', currency: 'THB' });
    expect(new Date(checkout.expires_at).getTime() - h.clock.now().getTime()).toBeLessThanOrEqual(15 * 60_000);
    const [confirm, decline] = checkout.actions;
    expect(confirm).toMatchObject({ id: 'confirm', kind: 'confirm', style: 'primary', requires_user_verification: 'tap', endpoint: { method: 'POST', path: `${U}/checkouts/${checkout.id}/confirm` } });
    expect(keys(confirm.endpoint.body)).toEqual(['confirm_hash']);
    expect(decline).toMatchObject({ id: 'decline', kind: 'decline', style: 'secondary', endpoint: { method: 'POST', path: `${U}/checkouts/${checkout.id}/decline` } });

    // The checkout example of the task file uses only fields a real card has.
    const example = JSON.parse(/Карточка `checkout`:\n```json\n([\s\S]*?)\n```/.exec(RU_DOC)![1]);
    expect(matches('Card', example)).toEqual([]);
    expect(keys(example)).toEqual(keys(checkout));
    expect(example.actions.map((a: any) => keys(a))).toEqual(checkout.actions.map((a: any) => keys(a)));

    // B2: the card language follows the user's locale.
    await unyly('PUT', U, { locale: 'ru' });
    const ru = await unyly('GET', `${U}/checkouts/${checkout.id}`);
    expect([ru.status, ru.json.card.total.label, ru.json.card.id]).toEqual([200, 'Итого', checkout.id]);
    expect(responseErrors('GET', '/partner/v1/users/{uid}/checkouts/{cid}', 200, ru.json)).toEqual([]);
    await unyly('PUT', U, { locale: 'en' });
    expect((await unyly('GET', `${U}/checkouts/${checkout.id}`)).json.card.total.label).toBe('Total');
  });

  it('B4: confirm needs confirm_hash and user_verification, refuses a foreign hash, then places one order', async () => {
    const confirm = checkout.actions.find((a: any) => a.kind === 'confirm');
    const noVerification = await unyly('POST', confirm.endpoint.path, { ...confirm.endpoint.body });
    expect([noVerification.status, noVerification.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const old = await unyly('POST', confirm.endpoint.path, { ...confirm.endpoint.body, user_verification: 'biometric', confirmed_at: new Date(h.clock.now().getTime() - 11 * 60_000).toISOString() });
    expect([old.status, old.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const foreign = await unyly('POST', confirm.endpoint.path, { confirm_hash: 'deadbeef', user_verification: 'biometric' });
    expect([foreign.status, foreign.json.error.code, foreign.json.error.details.card_path]).toEqual([409, 'CONFIRM_HASH_MISMATCH', `${U}/checkouts/${checkout.id}`]);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/checkouts/{cid}/confirm', 409, foreign.json)).toEqual([]);
    // Nothing above ordered anything.
    expect((await unyly('GET', `${U}/orders`)).json.orders).toEqual([]);

    const body = { ...confirm.endpoint.body, user_verification: 'biometric', confirmed_at: h.clock.now().toISOString(), device_id: 'iphone-1' };
    const done = await unyly('POST', confirm.endpoint.path, body);
    expect(done.status).toBe(200);
    expect(keys(done.json)).toEqual(['checkout', 'ok', 'order']);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/checkouts/{cid}/confirm', 200, done.json)).toEqual([]);
    expect(done.json.checkout).toMatchObject({ checkout_id: checkout.id, status: 'consumed', submission: { status: 'accepted' } });
    for (const k of ['checkout_id', 'status', 'total', 'submission', 'order_id', 'summary']) expect([k, k in done.json.checkout]).toEqual([k, true]);
    expect(done.json.checkout.confirm_url).toBeUndefined();
    orderId = done.json.order.id;
    expect(done.json.checkout.order_id).toBe(orderId);
    const card = done.json.order.card;
    expect(card).toMatchObject({ type: 'order', id: orderId, service: 'ride', demo: true, status: { code: 'accepted', label: 'Driver assigned', is_final: false } });
    expect(keys(card.status)).toEqual(['code', 'eta_at', 'is_final', 'label', 'progress', 'steps']);
    expect(keys(card.status.steps[0])).toEqual(['code', 'done', 'label']);
    expect(keys(card.courier)).toEqual(['fictional', 'name', 'plate', 'rating', 'vehicle']);
    expect(card.courier.fictional).toBe(true);
    expect(card.actions).toEqual([{ id: 'cancel', label: 'Cancel order', style: 'destructive', kind: 'prepare_cancel', endpoint: { method: 'POST', path: `${U}/orders/${orderId}/cancel` } }]);

    // The confirm example of the task file: same fields as the real answer.
    const example = JSON.parse(/Ответ подтверждения[^\n]*\n```json\n([\s\S]*?)\n```/.exec(RU_DOC)![1]);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/checkouts/{cid}/confirm', 200, example)).toEqual([]);
    expect(keys(example.order.card)).toEqual(keys(card));
    for (const k of keys(example.checkout)) expect([k, k in done.json.checkout]).toEqual([k, true]);

    // Repeats, also in parallel, return the same order.
    const repeats = await Promise.all([1, 2, 3].map(() => unyly('POST', confirm.endpoint.path, body)));
    expect(repeats.map((r) => [r.status, r.json.order.id])).toEqual([[200, orderId], [200, orderId], [200, orderId]]);
    expect((await unyly('GET', `${U}/orders`)).json.orders.length).toBe(1);
    // The confirmed checkout card has no buttons any more.
    expect((await unyly('GET', `${U}/checkouts/${checkout.id}`)).json.card.actions).toEqual([]);
  });

  it('orders: the list and the order card', async () => {
    const list = await unyly('GET', `${U}/orders?limit=10`);
    expect(keys(list.json)).toEqual(['handoffs', 'next_before', 'ok', 'orders']);
    expect(list.json.orders[0]).toMatchObject({ order_id: orderId, service: 'ride', fulfillment_status: 'accepted', is_final: false });
    expect(responseErrors('GET', '/partner/v1/users/{uid}/orders', 200, list.json)).toEqual([]);
    const one = await unyly('GET', `${U}/orders/${orderId}`);
    expect([one.status, one.json.card.type, one.json.card.id]).toEqual([200, 'order', orderId]);
    expect(responseErrors('GET', '/partner/v1/users/{uid}/orders/{oid}', 200, one.json)).toEqual([]);
    // The tool gives the model the status; the guides send the app to the GET above for the card.
    const viaTool = await unyly('POST', `${U}/tools/get_order_status`, { arguments: { order_id: orderId } });
    expect([viaTool.status, viaTool.json.result.order_id, viaTool.json.result.fulfillment_status]).toEqual([200, orderId, 'accepted']);
    expect(viaTool.json.card === null || viaTool.json.card.id === orderId).toBe(true);
    const missing = await unyly('GET', `${U}/orders/00000000-0000-4000-8000-000000000000`);
    expect([missing.status, missing.json.error.code]).toEqual([404, 'NOT_FOUND']);
    expect((await unyly('GET', `${U}/orders/xyz`)).status).toBe(404);
  });

  it('B5: events by polling and by webhook are the same objects, with the documented fields and signature', async () => {
    const polled = await unyly('GET', `${U}/events?after=0`);
    expect(polled.status).toBe(200);
    expect(responseErrors('GET', '/partner/v1/users/{uid}/events', 200, polled.json)).toEqual([]);
    const events: any[] = polled.json.events;
    expect(events.map((e) => e.type)).toEqual(['order.created', 'checkout.confirmed']);
    for (const e of events) {
      expect(keys(e).filter((k) => k !== 'notify')).toEqual(['created_at', 'data', 'event_id', 'partner_id', 'seq', 'type', 'user_id']);
      expect([e.partner_id, e.user_id]).toEqual(['ari', 'u_1']);
    }
    expect(events[0].seq).toBeLessThan(events[1].seq);
    const [created, confirmed] = events;
    expect(keys(created.data)).toEqual(['checkout_id', 'currency', 'order_id', 'service', 'status', 'title', 'total_minor']);
    expect(created.data).toMatchObject({ order_id: orderId, checkout_id: checkout.id, service: 'ride', status: 'accepted', currency: 'THB' });
    expect(created.notify).toMatchObject({ title: 'Driver assigned', level: 'important', live_activity: { state: 'accepted', progress: 0.3 } });
    expect('suggest_call' in created.notify).toBe(false);
    expect(keys(created.notify.live_activity)).toEqual(['eta_at', 'progress', 'state']);
    expect(confirmed.data).toEqual({ checkout_id: checkout.id, order_id: orderId, user_verification: 'biometric' });
    expect(confirmed.notify).toBeUndefined();
    // ?after= resumes after a sequence number.
    expect((await unyly('GET', `${U}/events?after=${created.seq}`)).json.events.map((e: any) => e.event_id)).toEqual([confirmed.event_id]);
    expect((await unyly('GET', `${U}/events?after=${confirmed.seq}`)).json.events).toEqual([]);

    // Webhooks: verified exactly as B5 says (webhook secret, POST, path and query of the webhook URL, raw body).
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetcher = (async (url: string, init: any) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return new Response(null, { status: 204 });
    }) as any;
    await deliverPartnerWebhooks(h.ctx, 50, fetcher);
    const mine = sent.filter((s) => JSON.parse(s.body).user_id === 'u_1');
    expect(mine.length).toBe(2);
    for (const s of mine) {
      const hd = s.headers;
      const payload = JSON.parse(s.body);
      expect(s.url).toBe(ARI.webhookUrl);
      expect(hd['x-unyly-signature']).toBe(signature(ARI.webhookSecret, 'POST', '/webhooks/unyly?src=unyly', hd['x-unyly-timestamp'], hd['x-unyly-nonce'], s.body));
      expect(hd['x-unyly-signature']).not.toBe(signature(ARI.secret, 'POST', '/webhooks/unyly?src=unyly', hd['x-unyly-timestamp'], hd['x-unyly-nonce'], s.body));
      expect([hd['x-unyly-partner'], hd['x-unyly-event'], hd['x-unyly-delivery'], hd['content-type']]).toEqual(['ari', payload.type, payload.event_id, 'application/json']);
      expect(Math.abs(h.clock.now().getTime() / 1000 - Number(hd['x-unyly-timestamp']))).toBeLessThan(300);
      expect(matches('Event', payload)).toEqual([]);
      // The same event as the polled one. created_at may differ by a few milliseconds between the two channels.
      const twin = events.find((e) => e.event_id === payload.event_id);
      const { created_at: a, ...restWebhook } = payload;
      const { created_at: b, ...restPolled } = twin;
      expect(restWebhook).toEqual(JSON.parse(JSON.stringify(restPolled)));
      expect(Math.abs(Date.parse(a) - Date.parse(b))).toBeLessThan(5000);
    }
    // Delivered once: a second run sends nothing.
    sent.length = 0;
    await deliverPartnerWebhooks(h.ctx, 50, fetcher);
    expect(sent.length).toBe(0);

    // The event example of the task file has the fields of a real order.status_changed event.
    const example = JSON.parse(/Событие вебхука[^\n]*\n```json\n([\s\S]*?)\n```/.exec(RU_DOC)![1]);
    expect(matches('Event', example)).toEqual([]);
    expect(keys(example)).toEqual([...keys(created)].sort());
    expect(keys(example.notify.live_activity)).toEqual(keys(created.notify.live_activity));
  });

  it('B5: the next status arrives as order.status_changed; a ride on its way suggests a call', async () => {
    let status = 'accepted';
    for (let i = 0; i < 40 && status === 'accepted'; i++) {
      h.clock.advance(5_000);
      status = (await unyly('GET', `${U}/orders/${orderId}`)).json.card.status.code;
    }
    expect(status).toBe('preparing');
    const events: any[] = (await unyly('GET', `${U}/events?after=0`)).json.events;
    const changed = events.find((e) => e.type === 'order.status_changed');
    expect(keys(changed.data)).toEqual(['eta_at', 'is_final', 'order_id', 'service', 'status', 'status_label']);
    expect(changed.data).toMatchObject({ order_id: orderId, service: 'ride', status: 'preparing', is_final: false });
    expect(changed.notify).toMatchObject({ title: 'Driver arriving', level: 'urgent', suggest_call: true, live_activity: { state: 'preparing', progress: 0.5 } });
    expect(matches('Event', changed)).toEqual([]);
    // The order card still offers the cancellation, now with a fee.
    const card = (await unyly('GET', `${U}/orders/${orderId}`)).json.card;
    expect(card.actions.map((a: any) => a.kind)).toEqual(['prepare_cancel']);
    expect(card.courier.fictional).toBe(true);
  });

  it('B9: cancellation is prepared, shown with its fee, and confirmed by the user', async () => {
    const order = (await unyly('GET', `${U}/orders/${orderId}`)).json.card;
    const prepare = order.actions.find((a: any) => a.kind === 'prepare_cancel');
    const prepared = await unyly(prepare.endpoint.method, prepare.endpoint.path);
    expect(prepared.status).toBe(200);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/orders/{oid}/cancel', 200, prepared.json)).toEqual([]);
    expect(keys(prepared.json.cancellation)).toEqual(['cancellation_id', 'expires_at', 'fee', 'message', 'order_id', 'status', 'terms']);
    expect(prepared.json.cancellation).toMatchObject({ order_id: orderId, status: 'awaiting_user', fee: { amount_minor: 3000, currency: 'THB' } });
    expect(JSON.stringify(prepared.json.cancellation)).not.toMatch(/Unyly page|confirm_url/);
    const card = prepared.json.card;
    const xid = prepared.json.cancellation.cancellation_id;
    expect(card).toMatchObject({ type: 'cancellation', id: xid, service: 'ride', demo: true });
    expect(card.subtitle).toContain('฿30.00');
    expect(new Date(card.expires_at).getTime() - h.clock.now().getTime()).toBeLessThanOrEqual(5 * 60_000);
    const [yes, keep] = card.actions;
    expect(yes).toMatchObject({ kind: 'confirm', style: 'destructive', requires_user_verification: 'tap', endpoint: { method: 'POST', path: `${U}/cancellations/${xid}/confirm` } });
    expect(keep).toEqual({ id: 'keep', label: 'Keep order', style: 'secondary', kind: 'decline' });
    // Preparing cancelled nothing.
    expect((await unyly('GET', `${U}/orders/${orderId}`)).json.card.status.code).toBe('preparing');
    const reread = await unyly('GET', `${U}/cancellations/${xid}`);
    expect([reread.status, reread.json.card.id]).toEqual([200, xid]);
    expect(responseErrors('GET', '/partner/v1/users/{uid}/cancellations/{xid}', 200, reread.json)).toEqual([]);

    const noVerification = await unyly('POST', yes.endpoint.path, { ...yes.endpoint.body });
    expect([noVerification.status, noVerification.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const foreign = await unyly('POST', yes.endpoint.path, { confirm_hash: 'deadbeef', user_verification: 'tap' });
    expect([foreign.status, foreign.json.error.code]).toEqual([409, 'CONFIRM_HASH_MISMATCH']);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/cancellations/{xid}/confirm', 409, foreign.json)).toEqual([]);

    const done = await unyly('POST', yes.endpoint.path, { ...yes.endpoint.body, user_verification: 'tap' });
    expect(done.status).toBe(200);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/cancellations/{xid}/confirm', 200, done.json)).toEqual([]);
    expect(done.json.cancellation).toMatchObject({ cancellation_id: xid, status: 'executed' });
    expect(done.json.order).toMatchObject({ id: orderId, card: { type: 'order', status: { code: 'cancelled', is_final: true }, actions: [] } });
    expect(done.json.order.card.courier).toBeUndefined();
    // A repeat is the same answer; a second cancellation is refused.
    expect((await unyly('POST', yes.endpoint.path, { ...yes.endpoint.body, user_verification: 'tap' })).json.cancellation.status).toBe('executed');
    const late = await unyly('POST', `${U}/orders/${orderId}/cancel`);
    expect([late.status, late.json.error.code]).toEqual([409, 'CANCELLATION_NOT_ALLOWED']);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/orders/{oid}/cancel', 409, late.json)).toEqual([]);

    const types = (await unyly('GET', `${U}/events?after=0`)).json.events.map((e: any) => [e.type, e.data.status]);
    expect(types).toContainEqual(['order.status_changed', 'cancelled']);
    expect(types).toContainEqual(['cancellation.confirmed', 'executed']);
  });

  it('B4: a declined or changed checkout is closed; an expired one too; a large total needs Face ID', async () => {
    const args = { service: 'express', pickup: 'Siam Paragon', dropoff: 'ICONSIAM', parcel_weight_kg: 3, items: [{ item_id: 'express_bike', quantity: 1 }] };
    const parcel = (await unyly('POST', `${U}/tools/create_cart`, { arguments: args })).json.card;
    const declined = await unyly('POST', parcel.actions.find((a: any) => a.kind === 'decline').endpoint.path);
    expect([declined.status, declined.json.checkout.status]).toEqual([200, 'declined']);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/checkouts/{cid}/decline', 200, declined.json)).toEqual([]);
    const afterDecline = await unyly('POST', parcel.actions[0].endpoint.path, { ...parcel.actions[0].endpoint.body, user_verification: 'tap' });
    expect([afterDecline.status, afterDecline.json.error.code, afterDecline.json.error.details.reason]).toEqual([409, 'CONFIRMATION_INVALIDATED', 'DECLINED']);

    // Food: needs the default place saved in B6; update_cart closes the card shown before.
    const stores = await unyly('POST', `${U}/tools/search_stores`, { arguments: { party_size: 2, budget_total_major: 600, exclude_allergens: ['peanut', 'tree_nut'] } });
    expect([stores.status, stores.json.card.type, stores.json.card.subtitle]).toEqual([200, 'options', 'Дом · Khlong Toei, Bangkok']);
    const pick = stores.json.card.options.find((o: any) => o.action);
    expect(pick.badges).toContain('Within budget');
    expect(pick.action.tool).toMatchObject({ name: 'create_cart', arguments: { store_id: pick.id } });
    const food = await unyly('POST', `${U}/tools/create_cart`, { arguments: { store_id: 'demo-r3', items: [{ item_id: 'r3-crispypork', quantity: 2 }] } });
    expect(food.json.card).toMatchObject({ type: 'checkout', service: 'food', subtitle: 'Дом' });
    expect(food.json.card.breakdown.length).toBeGreaterThan(1);
    const line = food.json.result.items[0];
    const updated = await unyly('POST', `${U}/tools/update_cart`, { arguments: { cart_id: food.json.result.cart_id, expected_version: food.json.result.version, operations: [{ op: 'set_quantity', line_id: line.line_id, quantity: 16 }] } });
    expect(updated.status).toBe(200);
    const big = updated.json.card;
    expect(big.type).toBe('checkout');
    expect(big.id).not.toBe(food.json.card.id);
    const stale = await unyly('POST', food.json.card.actions[0].endpoint.path, { ...food.json.card.actions[0].endpoint.body, user_verification: 'tap' });
    expect([stale.status, stale.json.error.code, stale.json.error.details.reason]).toEqual([409, 'CONFIRMATION_INVALIDATED', 'CART_CHANGED']);
    expect((await unyly('GET', `${U}/checkouts/${food.json.card.id}`)).json.card.actions).toEqual([]);

    // 16 portions is above 2,000 THB: the card asks for biometric and a plain tap is refused.
    expect(big.total.amount_minor).toBeGreaterThanOrEqual(200_000);
    const confirm = big.actions.find((a: any) => a.kind === 'confirm');
    expect(confirm.requires_user_verification).toBe('biometric');
    const tap = await unyly('POST', confirm.endpoint.path, { ...confirm.endpoint.body, user_verification: 'tap' });
    expect([tap.status, tap.json.error.code, tap.json.error.details]).toEqual([403, 'STEP_UP_REQUIRED', { required: 'biometric', threshold_minor: 200_000 }]);
    expect(responseErrors('POST', '/partner/v1/users/{uid}/checkouts/{cid}/confirm', 403, tap.json)).toEqual([]);
    const faceId = await unyly('POST', confirm.endpoint.path, { ...confirm.endpoint.body, user_verification: 'biometric' });
    expect([faceId.status, faceId.json.order.card.type, faceId.json.order.card.lines.length > 0]).toEqual([200, 'order', true]);

    // After expires_at (15 minutes) the card cannot be confirmed; create_cart with the same arguments gives a new one.
    const again = (await unyly('POST', `${U}/tools/create_cart`, { arguments: args })).json.card;
    h.clock.advance(16 * 60_000);
    const expired = await unyly('POST', again.actions[0].endpoint.path, { ...again.actions[0].endpoint.body, user_verification: 'tap' });
    expect([expired.status, expired.json.error.code]).toEqual([409, 'CONFIRMATION_EXPIRED']);
    const fresh = await unyly('POST', `${U}/tools/create_cart`, { arguments: args });
    expect([fresh.status, fresh.json.card.type, fresh.json.card.id !== again.id]).toEqual([200, 'checkout', true]);
  });

  it('B3: tools without a card answer card null; after prepare_checkout the card is read by id', async () => {
    const cart = await unyly('POST', `${U}/tools/create_cart`, { arguments: { service: 'ride', pickup: 'Siam Paragon', dropoff: 'ICONSIAM', items: [{ item_id: 'grabtaxi', quantity: 1 }] } });
    const viaTool = await unyly('POST', `${U}/tools/prepare_cancellation`, { arguments: { order_id: '00000000-0000-4000-8000-000000000000' } });
    expect([viaTool.status, viaTool.json.error.code, viaTool.json.card]).toEqual([422, 'NOT_FOUND', null]);
    for (const [tool, args] of [['get_capabilities', {}], ['list_orders', {}], ['get_checkout_status', { checkout_id: cart.json.card.id }]] as const) {
      const r = await unyly('POST', `${U}/tools/${tool}`, { arguments: args });
      expect([tool, r.status, r.json.ok, r.json.card]).toEqual([tool, 200, true, null]);
    }
    // No body at all is accepted for a tool without arguments.
    expect((await unyly('POST', `${U}/tools/get_capabilities`)).status).toBe(200);
    const quote = await unyly('POST', `${U}/tools/quote_cart`, { arguments: { cart_id: cart.json.result.cart_id } });
    expect([quote.status, quote.json.card]).toEqual([200, null]);
    const prepared = await unyly('POST', `${U}/tools/prepare_checkout`, { arguments: { cart_id: cart.json.result.cart_id, quote_id: quote.json.result.quote_id } });
    expect(prepared.status).toBe(200);
    const byId = await unyly('GET', `${U}/checkouts/${prepared.json.result.checkout_id}`);
    expect([byId.status, byId.json.card.type, byId.json.card.actions.length]).toEqual([200, 'checkout', 2]);
  });

  it('B7: the Grab account link in demo', async () => {
    const linked = await unyly('POST', `${U}/grab/link`);
    expect(linked.status).toBe(200);
    expect(keys(linked.json)).toEqual(['linked', 'linked_at', 'ok', 'simulated', 'status']);
    expect(linked.json).toMatchObject({ status: 'linked', linked: true, simulated: true });
    expect(responseErrors('POST', '/partner/v1/users/{uid}/grab/link', 200, linked.json)).toEqual([]);
    const status = await unyly('GET', `${U}/grab`);
    expect(status.json.grab).toMatchObject({ linked: true, simulated: true });
    const unlinked = await unyly('DELETE', `${U}/grab`);
    expect([unlinked.status, unlinked.json.grab]).toEqual([200, { linked: false, linked_at: null, simulated: false }]);
    const types = (await unyly('GET', `${U}/events?after=0`)).json.events.map((e: any) => e.type);
    expect(types).toContain('grab.linked');
    expect(types).toContain('grab.unlinked');
  });

  it('B10: one error shape, with the documented codes and statuses', async () => {
    const cases: [string, string, unknown, number, string][] = [
      ['GET', '/partner/v1/users/ghost', undefined, 404, 'NOT_FOUND'],
      ['GET', '/partner/v1/nope', undefined, 404, 'NOT_FOUND'],
      ['POST', '/partner/v1/ping', undefined, 404, 'NOT_FOUND'],
      ['GET', `${U}/places/`, undefined, 404, 'NOT_FOUND'],
      ['GET', `${U}/checkouts/not-a-uuid`, undefined, 404, 'NOT_FOUND'],
      ['GET', '/partner/v1/users/a%2Fb', undefined, 400, 'VALIDATION_FAILED'],
      ['PUT', U, { display_name: 'x'.repeat(70_000) }, 413, 'PAYLOAD_TOO_LARGE'],
    ];
    for (const [m, p, b, status, code] of cases) {
      const r = await unyly(m, p, b);
      expect([m, p, r.status, r.json.error?.code, isErrorEnvelope(r.json)]).toEqual([m, p, status, code, true]);
      expect(matches('Error', r.json)).toEqual([]);
    }
    // Every code of the table in B10 is a status the API really uses for it.
    const table = [...RU_DOC.matchAll(/^\| ((?:`[A-Z_]+`(?:, )?)+) \| (\d{3}) \|/gm)].flatMap((m) => [...m[1].matchAll(/`([A-Z_]+)`/g)].map((c) => [c[1], Number(m[2])] as const));
    const { ErrorCodes } = await import('../src/domain/errors.js');
    expect(table.length).toBeGreaterThanOrEqual(18);
    for (const [code, status] of table) {
      const real = code === 'PAYLOAD_TOO_LARGE' ? 413 : (ErrorCodes as Record<string, number>)[code];
      expect([code, status]).toEqual([code, real]);
    }
  });

  it('rate limits answer 429 in the same envelope, per user', async () => {
    await unyly('PUT', '/partner/v1/users/busy', {});
    const burst = await Promise.all(Array.from({ length: 123 }, () => unyly('POST', '/partner/v1/users/busy/tools/nope_tool', { arguments: {} })));
    const limited = burst.filter((r) => r.status === 429);
    expect(limited.length).toBe(3);
    expect(limited[0].json).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect(matches('Error', limited[0].json)).toEqual([]);
    // Another endpoint of the same user and the same endpoint of another user still answer.
    expect((await unyly('GET', '/partner/v1/users/busy')).status).toBe(200);
    expect((await unyly('POST', `${U}/tools/nope_tool`, { arguments: {} })).status).toBe(404);
  });

  it('B8: deleting the user removes everything; the same id starts empty', async () => {
    const gone = await unyly('DELETE', U);
    expect([gone.status, gone.json]).toEqual([200, { ok: true, deleted: true }]);
    expect((await unyly('GET', U)).status).toBe(404);
    expect((await unyly('GET', `${U}/events?after=0`)).status).toBe(404);
    const back = await unyly('PUT', U, { locale: 'ru' });
    expect([back.status, back.json.user.created]).toEqual([201, true]);
    expect((await unyly('GET', `${U}/orders`)).json.orders).toEqual([]);
    expect((await unyly('GET', `${U}/places`)).json.places).toEqual([]);
    expect((await unyly('GET', `${U}/events?after=0`)).json.events).toEqual([]);
  });
});

describe('r4 contract: wording rules of the Russian task file', () => {
  it('has no long dashes, calls demo data fictional and does not claim an agreement with Grab', () => {
    expect(RU_DOC).not.toMatch(/[‒-―]/);
    expect(EN_DOC).not.toMatch(/[‒-―]/);
    expect(RU_DOC).toMatch(/Все данные в нём вымышлены/);
    expect(RU_DOC).not.toMatch(/партн[её]р(ом|ы|ство)? Grab|Grab (одобрил|утвердил|подтвердил)|официальн\S* партн/i);
    for (const task of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']) {
      const section = new RegExp(`### ${task}\\. [\\s\\S]*?(?=\\n### |\\n---|\\n## )`).exec(RU_DOC);
      expect([task, !!section && /Готово, когда/.test(section[0])]).toEqual([task, true]);
    }
  });
});
