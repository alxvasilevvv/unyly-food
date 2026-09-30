import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCALE_CODES } from '../src/domain/locales.js';
import { PUBLIC_PATHS } from '../src/web/layout.js';
import { Harness, startHarness } from './helpers.js';

const ORIGIN = 'http://localhost:3000';

/** Minimal XML well-formedness check: every element is closed in order, one root, declaration first. */
function parseXml(xml: string): { name: string; attrs: Record<string, string>; children: any[]; text: string } {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  const body = xml.replace(/^<\?xml[^>]*\?>/, '');
  const root: any = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    expect(m.index, 'unexpected markup').toBe(consumed);
    consumed = re.lastIndex;
    const [, close, name, attrStr, selfClose, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      expect(text.includes('&') ? /&(amp|lt|gt|quot|apos);/.test(text) : true).toBe(true);
      top.text += text.trim();
    } else if (close) {
      expect(top.name, `closing </${name}>`).toBe(name);
      stack.pop();
    } else {
      const attrs: Record<string, string> = {};
      for (const a of attrStr.matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&amp;/g, '&');
      const el = { name, attrs, children: [], text: '' };
      top.children.push(el);
      if (!selfClose) stack.push(el);
    }
  }
  expect(consumed).toBe(body.length);
  expect(stack.length, 'unclosed elements').toBe(1);
  expect(root.children.length).toBe(1);
  return root.children[0];
}

describe('Discovery files and head metadata', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ cfg: { guestPerIpHourly: 100 } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('robots.txt allows public pages, blocks private paths and points to the sitemap', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/robots.txt' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
    const lines = r.body.split('\n');
    expect(lines).toContain('User-agent: *');
    expect(lines).toContain('Allow: /');
    for (const p of ['/app', '/confirm', '/confirm-cancel', '/oauth', '/login/code', '/mcp', '/auth']) expect(lines).toContain(`Disallow: ${p}`);
    for (const p of ['/try', '/connect', '/for-grab', '/docs', '/']) expect(lines).not.toContain(`Disallow: ${p}`);
    expect(lines).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it('sitemap.xml is well-formed with every public page and all language alternates', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/sitemap.xml' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/xml/);
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
    const root = parseXml(r.body);
    expect(root.name).toBe('urlset');
    expect(root.attrs.xmlns).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(root.attrs['xmlns:xhtml']).toBe('http://www.w3.org/1999/xhtml');
    expect(root.children).toHaveLength(8);
    const paths = root.children.map((u: any) => new URL(u.children.find((c: any) => c.name === 'loc').text).pathname);
    expect(paths.sort()).toEqual([...PUBLIC_PATHS].sort());
    for (const u of root.children) {
      const loc = u.children.find((c: any) => c.name === 'loc').text;
      expect(loc.startsWith(`${ORIGIN}/`)).toBe(true);
      expect(u.children.find((c: any) => c.name === 'lastmod').text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const alts = u.children.filter((c: any) => c.name === 'xhtml:link');
      expect(alts).toHaveLength(11);
      const byLang = Object.fromEntries(alts.map((a: any) => [a.attrs.hreflang, a.attrs.href]));
      const path = new URL(loc).pathname;
      for (const l of LOCALE_CODES) expect(byLang[l]).toBe(`${ORIGIN}${path}?lang=${l}`);
      expect(byLang['x-default']).toBe(`${ORIGIN}${path}`);
      for (const a of alts) expect(a.attrs.rel).toBe('alternate');
    }
  });

  it('llms.txt describes the service, the MCP endpoint and the disclaimer', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/llms.txt' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
    const t = r.body;
    expect(t.startsWith('# Unyly\n\n> ')).toBe(true);
    expect(t).toContain(h.cfg.mcpResourceUrl);
    expect(t).toContain('not affiliated with');
    expect(t).toContain(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(t).toContain(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(t).toContain(`${ORIGIN}/.well-known/mcp/server-card.json`);
    for (const f of ['en', 'ru', 'th']) expect(t).toContain(`${ORIGIN}/docs/unyly-docs-${f}.md`);
    expect(t).toContain(`](${ORIGIN}/connect)`);
    expect(t).toMatch(/^## /m);
    expect(t).not.toContain('\u2014');
  });

  it('public pages carry canonical, hreflang alternates and absolute social previews', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/?lang=th' });
    expect(r.statusCode).toBe(200);
    const b = r.body;
    expect(b).toContain(`<link rel="canonical" href="${ORIGIN}/?lang=th">`);
    const alts = [...b.matchAll(/<link rel="alternate" hreflang="([\w-]+)" href="([^"]+)">/g)];
    expect(alts).toHaveLength(11);
    expect(alts.map((a) => a[1]).sort()).toEqual([...LOCALE_CODES, 'x-default'].sort());
    expect(b).toContain(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">`);
    expect(b).toContain(`<meta property="og:url" content="${ORIGIN}/?lang=th">`);
    expect(b).toContain(`<meta property="og:image" content="${ORIGIN}/static/brand/og-1200x630.png">`);
    expect(b).toContain('<meta property="og:image:width" content="1200">');
    expect(b).toContain('<meta property="og:image:height" content="630">');
    expect(b).toMatch(/<meta property="og:image:alt" content="[^"]+">/);
    expect(b).toContain('<meta property="og:locale" content="th_TH">');
    expect(b).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(b).not.toContain('name="robots"');

    const img = await h.app.inject({ method: 'GET', url: '/static/brand/og-1200x630.png' });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    const png = img.rawPayload;
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.length).toBeLessThan(200 * 1024);
    expect(readFileSync(new URL('../src/web/static/brand/og-1200x630.png', import.meta.url)).equals(png)).toBe(true);
  });

  it('signed-in and single-use pages are noindex and have no hreflang', async () => {
    const login = await h.app.inject({ method: 'GET', url: '/login' });
    expect(login.body).toContain('<meta name="robots" content="noindex">');

    const start = await h.app.inject({ method: 'POST', url: '/try/start?lang=en', headers: { origin: ORIGIN }, payload: { q: 'pad thai' } });
    const sc = start.headers['set-cookie'];
    const cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
    for (const url of ['/app', '/app/orders', '/app/connections']) {
      const r = await h.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toContain('<meta name="robots" content="noindex">');
      expect(r.body, url).not.toContain('hreflang="x-default"');
    }
  });
});
