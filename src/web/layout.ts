import { icon } from './art.js';
import { CONTACT } from './contacts.js';
import { LOCALE_CODES, LOCALE_NATIVE } from '../domain/locales.js';
import { ASSET_VERSION } from './assets.js';
import { html, raw, SafeHtml } from './html.js';
import { Locale, msg, tr } from './messages.js';

export interface PageOpts {
  title: string;
  locale: Locale;
  body: SafeHtml;
  loggedIn: boolean;
  guest?: boolean;
  mode?: 'demo' | 'handoff' | 'live' | null;
  csrf?: string;
  path?: string;
  narrow?: boolean;
  description?: string;
  /** Hide the demo/handoff banner (pages that explain the mode themselves). */
  noBanner?: boolean;
}

/** Script-specific font to preload per interface language (Chinese uses system fonts). */
const LOCALE_FONT: Partial<Record<Locale, string>> = {
  th: 'noto-sans-thai-thai-wght-normal.woff2',
  km: 'noto-sans-khmer-khmer-wght-normal.woff2',
  my: 'noto-sans-myanmar-myanmar-wght-normal.woff2',
  vi: 'inter-vietnamese-wght-normal.woff2',
  ru: 'inter-cyrillic-wght-normal.woff2',
};

const ORG_LD = JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Organization', name: 'Unyly', url: CONTACT.site, logo: `${CONTACT.site}/pixel/unicorn/rotations/south.png`,
  email: CONTACT.email, legalName: CONTACT.company, sameAs: [CONTACT.telegramGlobal, CONTACT.telegramCis, CONTACT.github, CONTACT.x],
}).replace(/</g, '\\u003c');

export const REPO_URL = 'https://github.com/alxvasilevvv/unyly-food';

export function page(o: PageOpts): string {
  const m = msg(o.locale);
  const l = o.locale;
  const path = o.path ?? '';
  const langHref = (x: Locale) => `?lang=${x}`;
  const cur = (p: string) => (path === p ? html`aria-current="page"` : '');
  return (
    '<!doctype html>' +
    html`<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} · Unyly</title>
<meta name="description" content="${o.description ?? m.brandTagline}">
<meta name="theme-color" content="#0a8a53">
<meta property="og:title" content="${o.title} · Unyly">
<meta property="og:description" content="${o.description ?? m.brandTagline}">
<link rel="preload" href="/static/fonts/manrope-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/static/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
${LOCALE_FONT[l] ? html`<link rel="preload" href="/static/fonts/${LOCALE_FONT[l]}" as="font" type="font/woff2" crossorigin>` : ''}
<link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}">
<link rel="icon" type="image/png" sizes="32x32" href="/static/brand/favicon-32.png">
<link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<script type="application/ld+json">${raw(ORG_LD)}</script>
<meta property="og:image" content="/static/brand/icon-512.png">
<script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body>
<a class="skip" href="#main">${tr(l, { ru: 'К содержанию', en: 'Skip to content', th: 'ข้ามไปยังเนื้อหา' })}</a>
<div class="concept-bar" role="note"><div class="wrap">
  <span class="dot" aria-hidden="true"></span>
  <span>${tr(l, {
    ru: 'Концепт-демо для партнёрства с Grab. Не связан с Grab и не одобрен Grab.',
    en: 'Concept demo built for a Grab partnership. Not affiliated with or endorsed by Grab.',
    th: 'เดโมแนวคิดสำหรับความร่วมมือกับ Grab ไม่ได้เกี่ยวข้องหรือได้รับการรับรองจาก Grab',
  })} <a href="/for-grab#disclaimer">${tr(l, { ru: 'Подробнее', en: 'Details', th: 'รายละเอียด' })}</a></span>
</div></div>
<header class="site"><div class="wrap">
  <a class="logo" href="/" aria-label="Unyly"><span class="logo-mark" aria-hidden="true"><img src="/static/brand/unicorn.png" width="64" height="64" alt=""></span><span class="logo-text"><span class="logo-word">unyly</span><span class="logo-sub">${tr(l, { ru: 'для Grab · концепт', en: 'for Grab · concept', th: 'สำหรับ Grab · แนวคิด' })}</span></span></a>
  <nav class="main" aria-label="${tr(l, { ru: 'Основная навигация', en: 'Main', th: 'เมนูหลัก' })}">
    <a href="/#how" class="hide-md">${m.navHow}</a>
    <a href="/for-grab" class="hide-md" ${cur('/for-grab')}>${tr(l, { ru: 'Для Grab', en: 'For Grab', th: 'สำหรับ Grab' })}</a>
    <a href="/connect" class="hide-md" ${cur('/connect')}>${m.navConnect}</a>
    ${o.loggedIn && !o.guest ? html`<a href="/app" class="hide-sm" ${cur('/app')}>${m.navApp}</a>` : html`<a href="/login" class="hide-sm" ${cur('/login')}>${m.navLogin}</a>`}
    <a href="/try" class="cta" ${cur('/try')}>${tr(l, { ru: 'Попробовать', en: 'Try the demo', th: 'ลองเดโม' })}</a>
    <details class="lang-menu">
      <summary>${icon('globe')}<span><span class="sr-only">Language: </span>${l.toUpperCase()}</span></summary>
      <ul role="list">
        ${LOCALE_CODES.map((x) => html`<li><a href="${langHref(x)}" ${l === x ? html`aria-current="true"` : ''} lang="${x}" hreflang="${x}"><span class="lang-code">${x.toUpperCase()}</span><span class="lang-name">${LOCALE_NATIVE[x]}</span></a></li>`)}
      </ul>
    </details>
  </nav>
</div></header>
${!o.noBanner && o.mode === 'demo' ? html`<div class="banner demo" role="status"><div class="wrap"><span class="pill warn">DEMO</span><span>${m.demoBanner}${o.guest ? html` <span class="guest-note">${tr(l, { ru: 'Гостевой сеанс удаляется через 24 часа.', en: 'Guest sessions are deleted after 24 hours.', th: 'เซสชันผู้เยี่ยมชมจะถูกลบหลัง 24 ชั่วโมง' })}</span>` : ''}</span></div></div>` : ''}
${!o.noBanner && o.mode === 'handoff' ? html`<div class="banner handoff" role="status"><div class="wrap">${m.handoffBanner}</div></div>` : ''}
<main id="main"><div class="wrap ${o.narrow ? 'narrow' : ''}">${o.body}</div></main>
<footer class="site"><div class="wrap">
  <div class="cols">
    <div class="foot-brand">
      <a class="logo" href="/" aria-label="Unyly"><span class="logo-mark" aria-hidden="true"><img src="/static/brand/unicorn.png" width="64" height="64" alt=""></span><span class="logo-text"><span class="logo-word">unyly</span></span></a>
      <p>${m.footerDisclaimer}</p>
    </div>
    <div class="foot-col"><p class="foot-h">${tr(l, { ru: 'Продукт', en: 'Product', th: 'ผลิตภัณฑ์' })}</p>
      ${o.loggedIn && !o.guest ? html`<a href="/app">${m.navApp}</a>` : html`<a href="/login">${m.navLogin}</a>`}
      <a href="/try">${tr(l, { ru: 'Демо', en: 'Live demo', th: 'เดโม' })}</a>
      <a href="/#how">${m.navHow}</a>
      <a href="/connect">${m.connectTitle}</a>
    </div>
    <div class="foot-col"><p class="foot-h">${tr(l, { ru: 'О проекте', en: 'Project', th: 'โครงการ' })}</p>
      <a href="/for-grab">${tr(l, { ru: 'Предложение для Grab', en: 'Proposal for Grab', th: 'ข้อเสนอสำหรับ Grab' })}</a>
      <a href="${REPO_URL}" rel="noopener">${tr(l, { ru: 'Исходный код', en: 'Source code', th: 'ซอร์สโค้ด' })}</a>
      <a href="/help">${m.navHelp}</a>
      <a href="/privacy">${m.footerPrivacy}</a>
    </div>
    <div class="foot-col"><p class="foot-h">${tr(l, { ru: 'Контакты', en: 'Contacts', th: 'ติดต่อ' })}</p>
      <a href="mailto:${CONTACT.email}">${icon('mail')} ${CONTACT.email}</a>
      <a href="${CONTACT.telegramGlobal}" rel="noopener">${icon('send')} Telegram (EN)</a>
      <a href="${CONTACT.telegramCis}" rel="noopener">${icon('send')} Telegram (RU)</a>
      <a href="/contact">${tr(l, { ru: 'Все контакты', en: 'All contacts', th: 'ช่องทางติดต่อทั้งหมด' })} ${icon('arrow')}</a>
    </div>
  </div>
  <div class="foot-bottom">
    <span>© 2026 Unyly · <a href="${CONTACT.site}" rel="noopener">unyly.org</a> · ${CONTACT.company}</span>
    ${o.loggedIn && o.csrf ? html`<form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${o.csrf}"><button class="linkbtn">${m.navLogout}</button></form>` : ''}
  </div>
</div></footer>
</body></html>`.value
  );
}
