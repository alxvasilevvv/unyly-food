import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePlace } from '../src/providers/demo/places.js';
import { LOCALE_CODES } from '../src/domain/locales.js';
import { CATALOGS, PACKS } from '../src/i18n/generated.js';
import { detectService, parseIntent } from '../src/web/intent.js';
import { acceptLanguage } from '../src/web/routes.js';
import { Harness, startHarness } from './helpers.js';

const source: { en: string }[] = JSON.parse(readFileSync(new URL('../src/i18n/source.json', import.meta.url), 'utf8'));
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
const CATALOG_LANGS = ['vi', 'id', 'ms', 'fil', 'km', 'my', 'zh'];

describe('Translation catalogs', () => {
  it('every catalog language covers every UI string with the same placeholders and no em dashes', () => {
    for (const l of CATALOG_LANGS) {
      const cat = CATALOGS[l];
      expect(cat, l).toBeTruthy();
      const missing = source.filter((s) => !(s.en in cat)).map((s) => s.en);
      expect(missing, `${l} missing`).toEqual([]);
      for (const { en } of source) {
        expect(placeholders(cat[en]), `${l}: ${en}`).toBe(placeholders(en));
        expect(cat[en].includes('—'), `${l} em dash: ${en}`).toBe(false);
      }
    }
  });

  it('Accept-Language picks the Grab-market languages, including legacy tags', () => {
    expect(acceptLanguage('vi-VN,vi;q=0.9')).toBe('vi');
    expect(acceptLanguage('tl-PH')).toBe('fil');
    expect(acceptLanguage('in-ID')).toBe('id');
    expect(acceptLanguage('zh-Hans-SG')).toBe('zh');
    expect(acceptLanguage('my-MM,en;q=0.5')).toBe('my');
  });
});

describe('Demo request parser in every pack language', () => {
  const want = ['food', 'ride', 'groceries', 'flowers', 'pharmacy', 'cakes', 'express'];
  for (const l of CATALOG_LANGS) {
    it(`${l}: all seven examples are understood`, () => {
      const p = PACKS[l];
      expect(p.examples).toHaveLength(7);
      p.examples.forEach((ex, i) => expect(detectService(ex).service, `${l} #${i + 1}: ${ex}`).toBe(want[i]));
      const food = parseIntent(p.examples[0]);
      expect(food).toMatchObject({ party_size: 2, budget_total_major: 600 });
      expect(food.exclude_allergens).toContain('peanut');
      const ride = detectService(p.examples[1]);
      const a = resolvePlace(ride.pickup ?? '');
      const b = resolvePlace(ride.dropoff ?? '');
      expect(a.ok && a.place.name, `${l} pickup ${ride.pickup}`).toBe('Siam Paragon');
      expect(b.ok && b.place.is_airport, `${l} dropoff ${ride.dropoff}`).toBe(true);
      const parcel = detectService(p.examples[6]);
      expect(parcel.weight_kg).toBe(3);
      const c = resolvePlace(parcel.dropoff ?? '');
      expect(c.ok && c.place.name, `${l} parcel ${parcel.dropoff}`).toBe('ICONSIAM');
    });
  }
});

describe('Pages in every language', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ cfg: { guestPerIpHourly: 100 } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('every page renders with the right lang attribute and translated navigation', async () => {
    for (const l of LOCALE_CODES) {
      for (const url of ['/', '/try', '/connect', '/for-grab', '/help', '/privacy', '/login']) {
        const r = await h.app.inject({ method: 'GET', url: `${url}?lang=${l}` });
        expect(r.statusCode, `${l} ${url}`).toBe(200);
        expect(r.body).toContain(`<html lang="${l}">`);
        expect(r.body).toContain('class="concept-bar"');
      }
    }
    const vi = await h.app.inject({ method: 'GET', url: '/?lang=vi' });
    expect(vi.body).toContain(CATALOGS.vi['Try the demo']);
    const zh = await h.app.inject({ method: 'GET', url: '/connect?lang=zh' });
    expect(zh.body).toContain(CATALOGS.zh['Connect your assistant'] ?? '');
  });

  it('static files do not count toward the per-IP request limit', async () => {
    const css = (await h.app.inject({ method: 'GET', url: '/' })).body.match(/\/static\/app\.css\?v=\w+/)![0];
    for (let i = 0; i < 320; i++) {
      const r = await h.app.inject({ method: 'GET', url: css });
      expect(r.statusCode, `request ${i}`).toBe(200);
    }
    expect((await h.app.inject({ method: 'GET', url: '/contact' })).statusCode).toBe(200);
  });

  it('a Khmer guest can order a taxi from the guided demo', async () => {
    const q = PACKS.km.examples[1];
    const start = await h.app.inject({ method: 'POST', url: '/try/start?lang=km', headers: { origin: 'http://localhost:3000' }, payload: { q } });
    expect(start.statusCode).toBe(303);
    const sc = start.headers['set-cookie'];
    const cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
    const page = await h.app.inject({ method: 'GET', url: String(start.headers.location), headers: { cookie } });
    expect(page.body).toContain('route-card');
    expect(page.body).toContain('Suvarnabhumi Airport (BKK)');
  });
});
