import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPersonalToken } from '../src/auth/oauth.js';
import { DOCS_LANGS, docsFor } from '../src/web/docs/index.js';
import { DOCS_EN, META_EN } from '../src/web/docs/en.js';
import { DOCS_RU, META_RU } from '../src/web/docs/ru.js';
import { DOCS_TH, META_TH } from '../src/web/docs/th.js';
import { docsMarkdown, inlineHtml, inlineLinks } from '../src/web/docs/render.js';
import type { Block, DocSection } from '../src/web/docs/types.js';
import { addHomeAddress, Harness, startHarness, webLogin } from './helpers.js';

const SETS = { en: { meta: META_EN, sections: DOCS_EN }, ru: { meta: META_RU, sections: DOCS_RU }, th: { meta: META_TH, sections: DOCS_TH } };

/** Site paths the docs may link to (checked against the running app below as well). */
const KNOWN_ROUTES = [
  '/', '/try', '/login', '/connect', '/contact', '/help', '/privacy', '/for-grab', '/docs',
  '/app', '/app/mode', '/app/addresses', '/app/preferences', '/app/orders', '/app/connections', '/app/data',
];

function blockStrings(b: Block): string[] {
  switch (b.type) {
    case 'paragraph':
    case 'callout':
      return [b.text];
    case 'list':
      return b.items;
    case 'table':
      return [...b.header, ...b.rows.flat()];
    case 'code':
      return [b.text];
    case 'steps':
      return b.items.flatMap((s) => [s.title, s.text]);
    case 'subheading':
      return [b.text];
  }
}
const allStrings = (sections: DocSection[]) => sections.flatMap((s) => [s.id, s.title, s.summary ?? '', ...s.blocks.flatMap(blockStrings)]);
const anchorIds = (sections: DocSection[]) => [
  ...sections.map((s) => s.id),
  ...sections.flatMap((s) => s.blocks.flatMap((b) => (b.type === 'subheading' && b.id ? [b.id] : []))),
];

describe('Docs content', () => {
  it('has no em dash anywhere, in any language', () => {
    for (const [l, d] of Object.entries(SETS)) {
      for (const s of [...allStrings(d.sections), d.meta.title, d.meta.description, ...Object.values(d.meta.labels)]) {
        expect(s.includes('\u2014'), `${l}: ${s.slice(0, 80)}`).toBe(false);
      }
    }
  });

  it('section and subheading ids are unique URL slugs', () => {
    for (const [l, d] of Object.entries(SETS)) {
      const ids = anchorIds(d.sections);
      expect(new Set(ids).size, `${l} duplicate ids`).toBe(ids.length);
      for (const id of ids) expect(id, l).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('Russian and Thai have the same section and subheading ids as English', () => {
    expect(anchorIds(DOCS_RU)).toEqual(anchorIds(DOCS_EN));
    expect(anchorIds(DOCS_TH)).toEqual(anchorIds(DOCS_EN));
    expect(META_RU.updated).toBe(META_EN.updated);
    expect(META_TH.updated).toBe(META_EN.updated);
  });

  it('every link points to a known route, an existing anchor, https or mailto', () => {
    for (const [l, d] of Object.entries(SETS)) {
      const ids = new Set(anchorIds(d.sections));
      for (const s of allStrings(d.sections)) {
        for (const href of inlineLinks(s)) {
          if (href.startsWith('#')) expect(ids.has(href.slice(1)), `${l}: ${href}`).toBe(true);
          else if (href.startsWith('/')) expect(KNOWN_ROUTES, `${l}: ${href}`).toContain(href.split(/[?#]/)[0]);
          else expect(href, l).toMatch(/^(https:\/\/|mailto:)/);
        }
      }
    }
  });

  it('never links to the private source repository', () => {
    for (const s of allStrings(DOCS_EN)) expect(s.includes('github.com'), s).toBe(false);
  });

  it('inline markup is escaped before it is converted', () => {
    expect(inlineHtml('**a** `<b>` [x](/try) <script>').value).toBe('<strong>a</strong> <code>&lt;b&gt;</code> <a href="/try">x</a> &lt;script&gt;');
    expect(inlineHtml('[bad](javascript:alert(1))').value).not.toContain('<a');
    expect(inlineHtml('`**not bold**`').value).toBe('<code>**not bold**</code>');
  });

  it('other interface languages fall back to English', () => {
    expect(docsFor('vi')).toMatchObject({ lang: 'en', translated: false });
    expect(docsFor('ru')).toMatchObject({ lang: 'ru', translated: true });
    expect(docsFor('th').docs.sections.length).toBe(DOCS_EN.length);
  });
});

describe('Docs pages', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  for (const l of ['en', 'ru', 'th', 'vi'] as const) {
    it(`/docs renders in ${l} with a table of contents that matches the sections`, async () => {
      const r = await h.app.inject({ method: 'GET', url: `/docs?lang=${l}` });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toContain(`<html lang="${l}">`);
      const { docs } = docsFor(l);
      for (const s of docs.sections) {
        expect(r.body, s.id).toContain(`<section class="doc-section" id="${s.id}"`);
        expect(r.body, s.id).toContain(`<a href="#${s.id}">`);
      }
      const toc = /<aside class="docs-side">([\s\S]*?)<\/aside>/.exec(r.body)![1];
      const tocIds = [...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
      expect(tocIds).toEqual(docs.sections.map((s) => s.id));
      for (const x of DOCS_LANGS) expect(r.body).toContain(`href="/docs/unyly-docs-${x}.md"`);
      expect(r.body).toContain('href="/docs" class="hide-md" aria-current="page"');
      if (l === 'vi') expect(r.body).toContain('class="notice docs-lang-note"');
      else expect(r.body).not.toContain('docs-lang-note');
    });
  }

  it('Markdown downloads return text/markdown with the title and every section', async () => {
    for (const x of DOCS_LANGS) {
      const r = await h.app.inject({ method: 'GET', url: `/docs/unyly-docs-${x}.md` });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(String(r.headers['content-disposition'])).toContain(`inline; filename="unyly-docs-${x}.md"`);
      const d = SETS[x];
      expect(r.body.startsWith(`# ${d.meta.title}\n`)).toBe(true);
      for (const s of d.sections) expect(r.body).toContain(`<a id="${s.id}"></a>`);
      expect(r.body).toContain('```json');
      expect(r.body.includes('\u2014')).toBe(false);
      expect(r.body).toBe(docsMarkdown(d, h.cfg.webOrigin));
    }
  });

  it('every site path linked from the docs exists', async () => {
    const paths = new Set<string>();
    for (const s of allStrings(DOCS_EN)) for (const href of inlineLinks(s)) if (href.startsWith('/')) paths.add(href.split(/[?#]/)[0]);
    expect(paths.size).toBeGreaterThan(5);
    for (const p of paths) {
      const r = await h.app.inject({ method: 'GET', url: p });
      expect(r.statusCode, p).toBeLessThan(400);
    }
  });

  it('help, connect and the footer link to the docs', async () => {
    const help = await h.app.inject({ method: 'GET', url: '/help?lang=en' });
    expect(help.body).toContain('class="card docs-promo" href="/docs"');
    const connect = await h.app.inject({ method: 'GET', url: '/connect?lang=en' });
    expect(connect.body).toContain('href="/docs#connect"');
    expect(connect.body).toMatch(/<footer[\s\S]*href="\/docs"/);
  });

  it('the documented sample tools/call works as written', async () => {
    const s = await webLogin(h, 'docs@example.com');
    await addHomeAddress(h, s.userId);
    const t = await createPersonalToken(h.ctx, s.userId, 'Docs test', ['orders:read']);
    const r = await fetch(`${h.baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_stores', arguments: { party_size: 2, budget_total_major: 600, exclude_allergens: ['peanut', 'tree_nut'], limit: 3 } } }),
    });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    const sc = j.result.structuredContent;
    expect(sc).toMatchObject({ ok: true, mode: 'demo' });
    expect(Object.keys(sc).sort()).toEqual(['data_as_of', 'mode', 'next_actions', 'notices', 'ok', 'result']);
  });
});
