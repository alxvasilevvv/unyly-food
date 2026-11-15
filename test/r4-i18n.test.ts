// Round 4: text produced by the page layout and the Ari demo client must follow the interface language.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCALE_CODES } from '../src/domain/locales.js';
import { CATALOGS } from '../src/i18n/generated.js';
import { html } from '../src/web/html.js';
import { page } from '../src/web/layout.js';

const CATALOG_LANGS = ['vi', 'id', 'ms', 'fil', 'km', 'my', 'zh'] as const;
const render = (l: string, mode: 'demo' | null = null) =>
  page({ title: 'T', locale: l as never, body: html`<p>x</p>`, loggedIn: false, path: '/ari', mode });
const attr = (body: string, re: RegExp) => re.exec(body)?.[1] ?? '';

describe('Layout text follows the interface language', () => {
  it('logo label, language switcher label, share image alt text and the demo pill are translated in all ten languages', () => {
    const en = render('en', 'demo');
    const enLogo = attr(en, /<a class="logo" href="\/" aria-label="([^"]+)"/);
    const enAlt = attr(en, /property="og:image:alt" content="([^"]+)"/);
    expect(enLogo).toBe('Ari × Grab, home');
    expect(en).toContain('<span class="sr-only">Language: </span>');
    expect(enAlt).toContain('Not affiliated with Grab');
    for (const l of LOCALE_CODES) {
      if (l === 'en') continue;
      const b = render(l, 'demo');
      const logo = attr(b, /<a class="logo" href="\/" aria-label="([^"]+)"/);
      const alt = attr(b, /property="og:image:alt" content="([^"]+)"/);
      expect(logo, `${l} logo`).toMatch(/^Ari × Grab/);
      expect(logo, `${l} logo`).not.toBe(enLogo);
      expect(alt, `${l} og alt`).toContain('CSA PROJECT - FZCO');
      expect(alt, `${l} og alt`).not.toBe(enAlt);
      expect(b, `${l} language label`).not.toContain('>Language: <');
      expect(b, `${l} em dash`).not.toContain('—');
      expect(b, `${l} demo pill`).toMatch(/<span class="pill warn">[^<]+<\/span>/);
    }
  });

  it('the catalogs carry the retry, busy and offline lines of the demo', () => {
    const keys = ['Try again', 'The demo is busy right now. Please try again in a minute.', 'No connection to the server. Check the network and try again.', 'Language', 'Ari × Grab, home'];
    for (const l of CATALOG_LANGS) {
      for (const k of keys) {
        expect(CATALOGS[l][k], `${l}: ${k}`).toBeTruthy();
        expect(CATALOGS[l][k], `${l}: ${k}`).not.toBe(k);
      }
    }
  });
});

describe('Ari demo client', () => {
  const js = readFileSync(new URL('../src/web/static/ari.js', import.meta.url), 'utf8');

  it('has a call voice for every interface language', () => {
    const map = /const SPEECH = \{([^}]+)\}/.exec(js)?.[1] ?? '';
    for (const l of LOCALE_CODES) expect(map, l).toMatch(new RegExp(`\\b${l}: '`));
  });

  it('formats distance with Intl instead of a hardcoded unit, and gives up on a request that never answers', () => {
    expect(js).not.toMatch(/distance_km\} km/);
    expect(js).toContain("unit: 'kilometer'");
    expect(js).toContain('AbortController');
  });

  it('shows no English text of its own: every visible string comes from the page', () => {
    // String literals passed straight to say() or used as button text would bypass translation.
    expect(js).not.toMatch(/say\('(ari|note)', '[A-Za-z]/);
    const fallbacks = [...js.matchAll(/S\.\w+ \|\| '([^']+)'/g)].map((m) => m[1]);
    expect(fallbacks.sort()).toEqual(['Try again', 'min', 'min']);
  });
});
