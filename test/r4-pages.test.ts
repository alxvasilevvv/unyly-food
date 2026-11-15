// Round 4 copy guards for the three public pitch pages: no em dashes, the fictional-demo disclosure is in the
// page body (not only in the site-wide bar), no leftover English in ru/th, and the numbers quoted match the code.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRAB_PRODUCTS, MARKETS } from '../src/partners/catalog.js';
import { SIGNED_ENDPOINTS } from '../src/web/ari-pages.js';
import { Harness, startHarness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const PAGES = ['/', '/for-grab', '/developers'] as const;
const LANGS = ['en', 'ru', 'th'] as const;
const FICTIONAL: Record<(typeof LANGS)[number], RegExp> = { en: /fictional/i, ru: /вымышлен/i, th: /สมมติ/ };

async function page(url: string, lang: string) {
  const r = await h.app.inject({ method: 'GET', url: `${url}?lang=${lang}` });
  expect(r.statusCode).toBe(200);
  const main = /<main id="main">([\s\S]*)<\/main>/.exec(r.body)?.[1] ?? '';
  expect(main.length).toBeGreaterThan(500);
  return { body: r.body, main };
}
/** Visible text of an HTML fragment: no tags, no code samples. */
const text = (htmlPart: string) => htmlPart.replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<[^>]+>/g, ' ');

describe('pitch pages copy (round 4)', () => {
  for (const url of PAGES) {
    for (const lang of LANGS) {
      it(`${url} [${lang}] has no em dash and discloses the fictional demo in the page body`, async () => {
        const p = await page(url, lang);
        expect(p.body).not.toContain('—');
        expect(p.body).not.toContain('&mdash;');
        expect(p.body).not.toContain('&#8212;');
        expect(text(p.main)).toMatch(FICTIONAL[lang]);
      });
    }
  }

  it('the catalog copy has no em dash in any language', () => {
    expect(JSON.stringify(GRAB_PRODUCTS)).not.toContain('—');
    expect(JSON.stringify(MARKETS)).not.toContain('—');
  });

  it('never claims an existing partnership and says no agreement exists', async () => {
    for (const lang of LANGS) {
      const home = await page('/', lang);
      const pitch = await page('/for-grab', lang);
      const no = { en: /No agreement with Grab exists/, ru: /Договорённости с Grab (пока )?нет/, th: /ยังไม่มีข้อตกลงกับ Grab/ }[lang];
      expect(text(home.main)).toMatch(no);
      expect(text(pitch.main)).toMatch(no);
      for (const p of [home, pitch]) expect(text(p.main)).not.toMatch(/official(ly)? partner|approved by Grab|in partnership with Grab|официальный партн[её]р|พาร์ทเนอร์อย่างเป็นทางการ/i);
    }
  });

  it('ru and th pages translate the architecture nodes, headings and meta description', async () => {
    for (const lang of ['ru', 'th'] as const) {
      const home = await page('/', lang);
      for (const en of ['Ari iPhone app', 'Ari backend', 'Unyly engine', '<b>Grab APIs</b>']) expect(home.main).not.toContain(en);
      const dev = await page('/developers', lang);
      expect(dev.main).not.toContain('>Endpoints<');
      expect(dev.main).toContain('<thead');
      const desc = /<meta name="description" content="([^"]*)"/.exec(dev.body)?.[1] ?? '';
      expect(desc).toMatch(lang === 'ru' ? /[а-яё]{4}/i : /[฀-๿]{4}/);
      const pitch = await page('/for-grab', lang);
      expect(pitch.main).not.toContain('No public consumer ordering API');
    }
  });

  it('quotes numbers that match the code', async () => {
    const routes = readFileSync(new URL('../src/partners/routes.ts', import.meta.url), 'utf8');
    const signed = routes.match(/scope\.(get|put|post|delete|patch)\('\/partner\/v1\//g) ?? [];
    expect(signed.length).toBe(SIGNED_ENDPOINTS);
    expect(MARKETS.length).toBe(8);
    const home = await page('/', 'en');
    expect(text(home.main)).toContain(`${SIGNED_ENDPOINTS} signed endpoints`);
    expect(home.main).toContain(`<b>${GRAB_PRODUCTS.length}</b>`);
    const dev = await page('/developers', 'en');
    expect(text(dev.main)).toContain(`of ${SIGNED_ENDPOINTS} signed endpoints`);
    // The legend counts are computed from the catalog and add up to every product.
    const legend = [...home.main.matchAll(/<li class="st-\w+"><i class="st-dot" aria-hidden="true"><\/i><b>(\d+)<\/b>/g)].map((m) => Number(m[1]));
    expect(legend.reduce((a, b) => a + b, 0)).toBe(GRAB_PRODUCTS.length);
  });

  it('the proposal answers what Grab is asked for, the pilot scope and data handling', async () => {
    const p = text((await page('/for-grab', 'en')).main);
    for (const s of ['grab_express.partner_deliveries', 'ride.estimate', 'openid, profile.read, phone', 'One-Time Charge', '1,000 invited Ari users', 'Week 10', 'AES-256-GCM', 'PDPA', 'kill switch', 'One signed DELETE call']) expect(p).toContain(s);
    // Consumer ordering for food, mart and rides is an ask, never a present capability.
    expect(p).toContain('not public today');
    expect(p).not.toMatch(/Biller Gateway/);
  });
});
