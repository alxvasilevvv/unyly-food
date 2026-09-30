import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJobsOnce } from '../src/jobs/worker.js';
import { parseIntent } from '../src/web/intent.js';
import { acceptLanguage } from '../src/web/routes.js';
import { Harness, startHarness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 100 } });
});
afterAll(async () => {
  await h.close();
});

const ORIGIN = { origin: 'http://localhost:3000' };
const cookieOf = (r: any) => String(r.headers['set-cookie']).split(';')[0];

async function startGuest(q: string) {
  const r = await h.app.inject({ method: 'POST', url: '/try/start', headers: ORIGIN, payload: { q } });
  expect(r.statusCode).toBe(303);
  const cookie = cookieOf(r);
  const page = await h.app.inject({ method: 'GET', url: String(r.headers.location), headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1];
  return { cookie, csrf, page };
}

describe('Intent parser (guided demo)', () => {
  it('reads party size, budget and allergies in three languages', () => {
    expect(parseIntent('Dinner for two under 600 baht, no nuts')).toMatchObject({ party_size: 2, budget_total_major: 600, exclude_allergens: ['peanut', 'tree_nut'] });
    expect(parseIntent('ข้าวเย็นสำหรับ 2 คน ไม่เกิน 500 บาท ไม่ใส่ถั่ว')).toMatchObject({ party_size: 2, budget_total_major: 500, exclude_allergens: ['peanut', 'tree_nut'] });
    expect(parseIntent('Ужин на двоих до 600 бат, без орехов')).toMatchObject({ party_size: 2, budget_total_major: 600, exclude_allergens: ['peanut', 'tree_nut'] });
  });
  it('does not treat a cuisine request as an exclusion', () => {
    const i = parseIntent('Seafood dinner for 4, no nuts');
    expect(i.cuisine).toBe('seafood');
    expect(i.exclude_allergens).not.toContain('shellfish');
  });
  it('handles allergy lists and does not leak cues across commas', () => {
    expect(parseIntent('allergic to shrimp, crab and peanuts').exclude_allergens).toEqual(expect.arrayContaining(['shellfish', 'peanut']));
    expect(parseIntent('Allergy: peanuts').exclude_allergens).toContain('peanut');
    expect(parseIntent('no pork, extra fish please').exclude_allergens).toEqual([]);
    expect(parseIntent('Тайской кухне рыбу').exclude_allergens).toEqual([]);
  });
  it('Thai soy allergy does not exclude peanuts', () => {
    expect(parseIntent('แพ้ถั่วเหลือง 2 คน').exclude_allergens).toEqual(['soy']);
  });
});

describe('Locale', () => {
  it('Accept-Language picks the first supported language, English by default', () => {
    expect(acceptLanguage('th-TH,th;q=0.9,en;q=0.8')).toBe('th');
    expect(acceptLanguage('de-DE,ru;q=0.5')).toBe('ru');
    expect(acceptLanguage('fr-FR')).toBe('en');
  });
  it('rejects inherited property names as a language', async () => {
    for (const bad of ['constructor', 'toString', '__proto__']) {
      const r = await h.app.inject({ method: 'GET', url: `/try?lang=${bad}` });
      expect(r.statusCode).toBe(200);
      expect(String(r.headers['set-cookie'] ?? '')).not.toContain('unyly_lang');
      const c = await h.app.inject({ method: 'GET', url: '/for-grab', headers: { cookie: `unyly_lang=${bad}` } });
      expect(c.statusCode).toBe(200);
    }
  });
  it('serves Thai pages with lang="th"', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/?lang=th' });
    expect(r.body).toContain('<html lang="th">');
    expect(r.body).toContain('ลองเดโม');
  });
  it('every page states it is a concept not affiliated with Grab', async () => {
    for (const lang of ['en', 'th', 'ru']) {
      for (const url of ['/', '/for-grab', '/try', '/connect']) {
        const r = await h.app.inject({ method: 'GET', url: `${url}?lang=${lang}` });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain('class="concept-bar"');
      }
    }
  });
});

describe('Guided demo as a guest', () => {
  it('refuses to create a guest from a cross-site request', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/try/start', headers: { origin: 'https://evil.example' }, payload: { q: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(String(r.headers['set-cookie'] ?? '')).not.toContain('unyly_session');
  });

  it('search → choose → confirm → tracked order, without allergen-declared dishes', async () => {
    const g = await startGuest('Dinner for two under 600 baht, no nuts');
    expect(g.page.body).toContain('opt-card');
    expect(g.page.body).not.toContain('Pad Thai with shrimp'); // declares peanut
    const choose = await h.app.inject({ method: 'POST', url: '/try/choose', headers: { cookie: g.cookie, ...ORIGIN }, payload: { _csrf: g.csrf, q: 'Dinner for two under 600 baht, no nuts', restaurant_id: 'demo-r1' } });
    expect(choose.statusCode).toBe(303);
    const confirmUrl = String(choose.headers.location);
    expect(confirmUrl).toMatch(/^\/confirm\//);
    const page = await h.app.inject({ method: 'GET', url: confirmUrl, headers: { cookie: g.cookie } });
    const total = /name="total_minor" value="(\d+)"/.exec(page.body)![1];
    const post = await h.app.inject({ method: 'POST', url: confirmUrl, headers: { cookie: g.cookie, ...ORIGIN }, payload: { _csrf: g.csrf, total_minor: total } });
    expect(post.statusCode).toBe(302);
    expect(String(post.headers.location)).toMatch(/^\/app\/orders\/[0-9a-f-]+\?placed=1$/);
    const orderId = /orders\/([0-9a-f-]+)/.exec(String(post.headers.location))![1];
    const json = await h.app.inject({ method: 'GET', url: `/app/orders/${orderId}/status.json`, headers: { cookie: g.cookie } });
    expect(json.json()).toMatchObject({ status: 'accepted', is_final: false });
    const speed = await h.db.query('SELECT d.speed FROM demo_sim_orders d JOIN orders o ON o.provider_order_ref = d.ref WHERE o.id = $1', [orderId]);
    expect(Number(speed.rows[0].speed)).toBe(12);
  });

  it('ignores a client-supplied restaurant that is not a valid option', async () => {
    const g = await startGuest('Lunch for 1');
    const r = await h.app.inject({ method: 'POST', url: '/try/choose', headers: { cookie: g.cookie, ...ORIGIN }, payload: { _csrf: g.csrf, q: 'Lunch for 1', restaurant_id: 'demo-r4' } });
    expect(r.statusCode).toBe(409);
    expect((await h.db.query("SELECT count(*)::int n FROM carts c JOIN users u ON u.id = c.user_id WHERE u.is_guest AND c.restaurant_id = 'demo-r4'")).rows[0].n).toBe(0);
  });

  it('ride from the guided demo: route, options, server-side recompute, confirmation shows the route', async () => {
    const q = 'Taxi from Siam Paragon to Suvarnabhumi airport';
    const g = await startGuest(q);
    expect(g.page.body).toContain('route-card');
    expect(g.page.body).toContain('Suvarnabhumi Airport (BKK)');
    const bad = await h.app.inject({ method: 'POST', url: '/try/choose', headers: { cookie: g.cookie, ...ORIGIN }, payload: { _csrf: g.csrf, q, kind: 'trip', item_id: 'express_bike' } });
    expect(bad.statusCode).toBe(409);
    const ok = await h.app.inject({ method: 'POST', url: '/try/choose', headers: { cookie: g.cookie, ...ORIGIN }, payload: { _csrf: g.csrf, q, kind: 'trip', item_id: 'justgrab' } });
    expect(ok.statusCode).toBe(303);
    const page = await h.app.inject({ method: 'GET', url: String(ok.headers.location), headers: { cookie: g.cookie } });
    expect(page.body).toContain('Siam Paragon');
    expect(page.body).toContain('Drop-off');
  });

  it('pharmacy from the guided demo shows the household-remedies notice and builds a basket', async () => {
    const q = 'Paracetamol and plasters';
    const g = await startGuest(q);
    expect(g.page.body).toContain('Household remedies');
    expect(g.page.body).toContain('Paracetamol 500 mg');
    const ok = await h.app.inject({ method: 'POST', url: '/try/choose', headers: { cookie: g.cookie, ...ORIGIN }, payload: { _csrf: g.csrf, q, kind: 'shop', store_id: 'demo-m4' } });
    expect(ok.statusCode).toBe(303);
  });

  it('an ambiguous airport asks which one instead of guessing', async () => {
    const g = await startGuest('Taxi to the airport');
    expect(g.page.body).toContain('Don Mueang Airport (DMK)');
    expect(g.page.body).not.toContain('route-card');
  });

  it('a guest cannot grant OAuth access to an assistant', async () => {
    const g = await startGuest('x');
    const r = await h.app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie: g.cookie, ...ORIGIN }, payload: { _csrf: g.csrf, decision: 'allow' } });
    expect(r.statusCode).toBe(401);
  });

  it('a guest cannot attach a passkey to the temporary account', async () => {
    const g = await startGuest('x');
    const r = await h.app.inject({ method: 'POST', url: '/auth/passkey/register/options', headers: { cookie: g.cookie, ...ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify({ _csrf: g.csrf }) });
    expect(r.statusCode).toBe(403);
  });

  it('guests are deleted after 24 hours', async () => {
    const g = await startGuest('x');
    const before = (await h.db.query('SELECT count(*)::int n FROM users WHERE is_guest')).rows[0].n;
    expect(before).toBeGreaterThan(0);
    await h.db.query(`UPDATE users SET created_at = now() - interval '25 hours' WHERE is_guest`);
    await runJobsOnce(h.ctx);
    expect((await h.db.query('SELECT count(*)::int n FROM users WHERE is_guest')).rows[0].n).toBe(0);
    const after = await h.app.inject({ method: 'GET', url: '/app', headers: { cookie: g.cookie } });
    expect(after.statusCode).toBe(302);
  });
});
