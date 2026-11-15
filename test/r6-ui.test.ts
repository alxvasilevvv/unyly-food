// Round 6 UI guards that need no browser: the palette of the stylesheet and the brand artwork, the shape of
// the Ari eyes, the generated icons, the tags every page must carry in <head>, and a few stylesheet rules
// (keyboard focus, reduced motion, font stack) that the visual audit relies on.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ariEyes, ariIconSvg, ariMark, dotText } from '../src/web/art.js';
import { Harness, startHarness } from './helpers.js';

const file = (p: string) => fileURLToPath(new URL(`../src/web/${p}`, import.meta.url));
const CSS = readFileSync(file('static/app.css'), 'utf8');
const ARI_JS = readFileSync(file('static/ari.js'), 'utf8');

type Hue = 'gray' | 'green' | 'red' | 'amber' | 'other';
/** Black, gray, mint green, red and amber are the whole palette; anything else is a leftover. */
function hue(r: number, g: number, b: number): Hue {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  if (s < 0.14 || max < 0.12) return 'gray';
  let h = 0;
  if (d > 0) {
    if (max === r / 255) h = ((g - b) / 255 / d) % 6;
    else if (max === g / 255) h = (b - r) / 255 / d + 2;
    else h = (r - g) / 255 / d + 4;
  }
  h = (h * 60 + 360) % 360;
  if (h >= 95 && h <= 175) return 'green';
  if (h <= 12 || h >= 345) return 'red';
  if (h >= 25 && h <= 55) return 'amber';
  return 'other';
}
function offPalette(src: string): string[] {
  const bad: string[] = [];
  for (const m of src.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)) {
    let x = m[1]!;
    if (x.length <= 4) x = [...x.slice(0, 3)].map((c) => c + c).join('');
    if (hue(parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)) === 'other') bad.push(m[0]);
  }
  for (const m of src.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/g)) {
    if (hue(Number(m[1]), Number(m[2]), Number(m[3])) === 'other') bad.push(m[0]);
  }
  return bad;
}

describe('palette (round 6)', () => {
  it('app.css uses only black, gray, mint green, red and amber', () => {
    expect(offPalette(CSS)).toEqual([]);
    expect(CSS).not.toMatch(/hsla?\(/);
  });
  it('the brand artwork (eyes, mark, icons, LED digits) stays in the palette', () => {
    const art = [ariEyes('t').value, ariMark().value, ariIconSvg(512), ariIconSvg(32, { solid: true }), dotText('09:41').value].join('\n');
    expect(offPalette(art)).toEqual([]);
  });
  it('the theme colours of the reference are the design tokens', () => {
    expect(CSS).toMatch(/--bg:\s*#050806/);
    expect(CSS).toMatch(/--brand:\s*#34d17a/);
    expect(CSS).toMatch(/--mint:\s*#b9f5d0/);
    expect(CSS).toMatch(/--bubble:\s*#1e4a33/);
    expect(CSS).toMatch(/--radius:\s*18px/);
  });
});

describe('the Ari eyes (round 6)', () => {
  const svg = ariEyes('t').value;
  const dots = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="(#[0-9a-f]{6})"(?: opacity="([\d.]+)")?\/>/g)].map((m) => ({
    cx: Number(m[1]), cy: Number(m[2]), r: Number(m[3]), fill: m[4]!, opacity: m[5] === undefined ? 1 : Number(m[5]),
  }));
  it('are two 7x7 dot matrices', () => {
    expect(dots).toHaveLength(98);
    expect(svg.match(/<g class="eye">/g)).toHaveLength(2);
  });
  it('have a uniformly bright centre and a dimmer, smaller outer ring', () => {
    for (const eye of [dots.slice(0, 49), dots.slice(49)]) {
      const x0 = Math.min(...eye.map((d) => d.cx));
      const x1 = Math.max(...eye.map((d) => d.cx));
      const y0 = Math.min(...eye.map((d) => d.cy));
      const y1 = Math.max(...eye.map((d) => d.cy));
      const ring = eye.filter((d) => d.cx === x0 || d.cx === x1 || d.cy === y0 || d.cy === y1);
      const inner = eye.filter((d) => !ring.includes(d));
      expect(inner).toHaveLength(25);
      expect(ring).toHaveLength(24);
      expect(new Set(inner.map((d) => `${d.fill}/${d.opacity}/${d.r}`)).size).toBe(1);
      expect(inner[0]!.opacity).toBe(1);
      for (const d of ring) {
        expect(d.opacity).toBeLessThan(1);
        expect(d.r).toBeLessThan(inner[0]!.r);
      }
      const corners = ring.filter((d) => (d.cx === x0 || d.cx === x1) && (d.cy === y0 || d.cy === y1));
      expect(corners).toHaveLength(4);
      expect(Math.max(...corners.map((d) => d.opacity))).toBeLessThan(Math.min(...ring.filter((d) => !corners.includes(d)).map((d) => d.opacity)));
    }
  });
  it('sit close together: the gap is about a third of an eye', () => {
    const left = dots.slice(0, 49);
    const right = dots.slice(49);
    const pitch = 10;
    const eyeWidth = Math.max(...left.map((d) => d.cx)) - Math.min(...left.map((d) => d.cx)) + pitch;
    const gap = Math.min(...right.map((d) => d.cx)) - Math.max(...left.map((d) => d.cx)) - pitch;
    expect(gap / eyeWidth).toBeGreaterThan(0.25);
    expect(gap / eyeWidth).toBeLessThan(0.42);
  });
  it('glow softly and are hidden from assistive tech', () => {
    expect(svg).toContain('feGaussianBlur');
    expect(svg).toContain('aria-hidden="true"');
  });
  it('the small mark is two solid mint rounded squares', () => {
    const rects = [...ariMark().value.matchAll(/<rect [^>]*width="(\d+)" height="(\d+)" rx="[\d.]+" fill="(#[0-9a-f]{6})"/g)];
    expect(rects).toHaveLength(2);
    for (const r of rects) {
      expect(r[1]).toBe(r[2]);
      expect(r[3]).toBe('#b9f5d0');
    }
  });
});

describe('LED digits (round 6)', () => {
  it('keep the real text for screen readers next to the dots', () => {
    const h = dotText('12:05').value;
    expect(h).toContain('<span class="sr-only">12:05</span>');
    expect(h).toContain('aria-hidden="true"');
  });
  it('the page script draws the same dots as the server', () => {
    const serverR = /r="(\.\d+)"\/>`;\s*\}\);/.exec(readFileSync(file('art.ts'), 'utf8'))?.[1];
    const clientR = /dot\.setAttribute\('r', '(\.\d+)'\)/.exec(ARI_JS)?.[1];
    expect(serverR).toBeTruthy();
    expect(clientR).toBe(serverR);
    for (const d of '0123456789') expect(ARI_JS).toMatch(new RegExp(`\\b${d}: \\['[01]{5}'`));
  });
});

/** Width and height from a PNG header (IHDR). */
function pngSize(name: string) {
  const b = readFileSync(file(`static/brand/${name}`));
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

describe('generated icons (round 6)', () => {
  const want: [string, number, number, number][] = [
    ['favicon-32.png', 32, 32, 4_000],
    ['apple-touch-icon.png', 180, 180, 40_000],
    ['icon-192.png', 192, 192, 60_000],
    ['icon-512.png', 512, 512, 200_000],
    ['og-1200x630.png', 1200, 630, 200_000],
  ];
  for (const [name, w, h, maxBytes] of want) {
    it(`${name} is ${w}x${h} and not heavier than ${Math.round(maxBytes / 1000)} kB`, () => {
      const s = pngSize(name);
      expect([s.w, s.h]).toEqual([w, h]);
      expect(s.bytes).toBeLessThan(maxBytes);
      expect(s.bytes).toBeGreaterThan(300);
    });
  }
});

describe('stylesheet rules the audit relies on (round 6)', () => {
  it('shows a mint keyboard focus ring and never forces a corner radius on focus', () => {
    expect(CSS).toMatch(/:focus-visible \{ outline: 3px solid var\(--brand\); outline-offset: 2px; \}/);
    expect(CSS).not.toMatch(/summary:focus-visible \{[^}]*border-radius/);
  });
  it('turns motion off for prefers-reduced-motion, including the eyes', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ html \{ scroll-behavior: auto; \} \*, \*::before, \*::after \{ animation: none !important; transition: none !important; \} \}/);
    expect(CSS).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.ari-eyes::before, \.ari-eyes \.eye \{ animation: none !important; \}/);
  });
  it('animates only transform, opacity and other cheap properties', () => {
    const frames = [...CSS.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((m) => m[1]!);
    expect(frames.length).toBeGreaterThan(10);
    for (const f of frames) expect(f).not.toMatch(/\b(width|height|left|right|margin|padding|background-position|filter)\s*:/);
  });
  it('puts the preloaded Inter first in the font stack, and has no unused font faces', () => {
    expect(CSS).toMatch(/--font: "Inter",/);
    expect(CSS).toMatch(/--display: "Inter",/);
    expect(CSS).not.toContain('Manrope');
    expect(CSS.match(/font-display: swap/g)?.length).toBe(CSS.match(/@font-face/g)?.length);
  });
  it('keeps the page from scrolling sideways and styles selection and scrollbars for the dark theme', () => {
    expect(CSS).toMatch(/html, body \{ overflow-x: clip; \}/);
    expect(CSS).toMatch(/::selection \{ background: var\(--bubble\)/);
    expect(CSS).toMatch(/html \{ scrollbar-color:/);
    expect(CSS).toMatch(/color-scheme: dark/);
  });
  it('has 44 px tap targets for the header controls on touch screens', () => {
    expect(CSS).toMatch(/nav\.main a\.cta, nav\.main \.lang-menu > summary, nav\.main \.nav-menu > summary \{ min-height: 44px; min-width: 44px; \}/);
  });
});

describe('page head and shell (round 6)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  const get = async (url: string) => {
    const r = await h.app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: r.body };
  };

  for (const path of ['/', '/ari', '/for-grab', '/developers', '/assistants', '/docs', '/privacy', '/login']) {
    it(`${path} carries the required head tags`, async () => {
      const { status, body } = await get(`${path}?lang=en`);
      expect(status).toBe(200);
      const head = /<head>([\s\S]*?)<\/head>/.exec(body)?.[1] ?? '';
      expect(head).toContain('<meta charset="utf-8">');
      expect(head).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(head).toMatch(/<title>[^<]+ · Ari × Grab<\/title>/);
      expect(head).toContain('<meta name="theme-color" content="#050806">');
      expect(head).toContain('<meta name="color-scheme" content="dark">');
      expect(head).toMatch(/<meta name="description" content="[^"]{40,}">/);
      expect(head).toMatch(/<link rel="icon" type="image\/png" sizes="32x32" href="\/static\/brand\/favicon-32\.png\?v=\w+">/);
      expect(head).toMatch(/<link rel="apple-touch-icon" href="\/static\/brand\/apple-touch-icon\.png\?v=\w+">/);
      expect(head).toContain('<link rel="manifest" href="/manifest.webmanifest">');
      expect(head).toMatch(/<meta property="og:image" content="[^"]*\/static\/brand\/og-1200x630\.png">/);
      expect(head).toContain('<meta property="og:image:width" content="1200">');
      expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(head).toMatch(/<link rel="preload" href="\/static\/fonts\/inter-latin-wght-normal\.woff2" as="font" type="font\/woff2" crossorigin>/);
      expect(head).toMatch(/<link rel="stylesheet" href="\/static\/app\.css\?v=\w+">/);
      // Scripts never block the first paint.
      for (const s of head.matchAll(/<script src="[^"]+"([^>]*)>/g)) expect(s[1]).toContain('defer');
      expect(body).toContain('<html lang="en">');
      expect(body).toContain('class="skip" href="#main"');
    });
  }

  it('serves the icons and the stylesheet with the right types', async () => {
    for (const [url, type] of [
      ['/static/brand/favicon-32.png', 'image/png'],
      ['/static/brand/icon-512.png', 'image/png'],
      ['/static/brand/og-1200x630.png', 'image/png'],
      ['/static/app.css', 'text/css'],
      ['/static/ari.js', 'javascript'],
    ] as const) {
      const r = await h.app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(String(r.headers['content-type'])).toContain(type);
    }
  });

  it('the demo phone keeps the hooks the page script needs and the call controls of the app', async () => {
    const { body } = await get('/ari?lang=en');
    for (const id of ['ari-app', 'ari-clock', 'ari-island', 'la-title', 'la-eta', 'ari-push', 'push-title', 'push-body', 'ari-grab', 'ari-reset', 'ari-chat', 'ari-chips', 'ari-form', 'ari-mic', 'ari-input', 'ari-faceid', 'ari-call', 'call-state', 'call-line', 'call-no', 'call-yes', 'ari-presenter', 'ari-trace', 'trace-count', 'trace-n']) {
      expect(body, id).toContain(`id="${id}"`);
    }
    expect(body).toContain('data-strings="');
    expect(body).toContain('data-examples="');
    expect(body.match(/class="call-tool[ "]/g)).toHaveLength(3);
    expect(body).toContain('class="ari-eyes call-eyes"');
    expect(body.match(/<g class="eye">/g)?.length).toBe(2);
  });

  it('the landing shows the eyes twice (hero and closing panel) with separate glow filters', async () => {
    const { body } = await get('/?lang=en');
    expect(body).toContain('id="eg-hero"');
    expect(body).toContain('id="eg-cta"');
    expect(body.match(/<g class="eye">/g)?.length).toBe(4);
  });

  it('the unknown page answers 404 inside the site shell', async () => {
    const { status, body } = await get('/no-such-page?lang=en');
    expect(status).toBe(404);
    expect(body).toContain('<header class="site">');
    expect(body).toContain('<footer class="site">');
  });
});
