import { icon } from './art.js';
import { CONTACT, instagramUrl, whatsappUrl } from './contacts.js';
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
  /** Ask search engines not to index the page. Private paths (see NOINDEX_PREFIXES) get it automatically. */
  noindex?: boolean;
  /** Extra page scripts from /static (loaded deferred after app.js). */
  scripts?: string[];
  /** Full-bleed page body (no .wrap container): the page lays out its own sections. */
  wide?: boolean;
}

/** Public, indexable pages: listed in the sitemap and given hreflang alternates. */
export const PUBLIC_PATHS = ['/', '/ari', '/for-grab', '/developers', '/assistants', '/try', '/connect', '/help', '/contact', '/privacy', '/docs'] as const;
/** Pages behind sign-in or single-use flows: always noindex. */
export const NOINDEX_PREFIXES = ['/app', '/confirm', '/login', '/oauth', '/auth'];
/** Open Graph locale per interface language. */
export const OG_LOCALE = Object.fromEntries(
  'en_US th_TH vi_VN id_ID ms_MY fil_PH km_KH my_MM zh_CN ru_RU'.split(' ').map((t) => [t.split('_')[0], t]),
) as Record<Locale, string>;
export const OG_IMAGE_PATH = '/static/brand/og-1200x630.png';
/** Public origin for absolute URLs in <head>; set once at startup from config (see registerDiscoveryRoutes). */
let SITE_ORIGIN = '';
export function setSiteOrigin(origin: string) {
  SITE_ORIGIN = origin.replace(/\/$/, '');
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
  email: CONTACT.email, legalName: CONTACT.company, sameAs: [CONTACT.telegramGlobal, CONTACT.telegramCis, `https://instagram.com/${CONTACT.owner.instagram}`, CONTACT.owner.linkedin].filter(Boolean),
}).replace(/</g, '\\u003c');

export const REPO_URL = 'https://github.com/alxvasilevvv/unyly-food';

export function page(o: PageOpts): string {
  const m = msg(o.locale);
  const l = o.locale;
  const path = o.path ?? '';
  const langHref = (x: Locale) => `?lang=${x}`;
  const cur = (p: string) => (path === p ? html`aria-current="page"` : '');
  const abs = (p: string) => `${SITE_ORIGIN}${p}`;
  const isPublic = (PUBLIC_PATHS as readonly string[]).includes(path);
  const desc = o.description ?? tr(l, {
    en: 'Ari × Grab: a partnership proposal by CSA PROJECT - FZCO to bring Grab into the Ari assistant. Demo with fictional data.',
    ru: 'Ari × Grab: предложение о партнёрстве от CSA PROJECT - FZCO. Grab внутри ассистента Ari. Демо на вымышленных данных.',
    th: 'Ari × Grab: ข้อเสนอความร่วมมือจาก CSA PROJECT - FZCO เพื่อนำ Grab เข้าสู่ผู้ช่วย Ari เดโมใช้ข้อมูลสมมติ',
  });
  const ogAlt = tr(l, {
    en: 'Ari mark, a white letter A on a violet to pink gradient. Ari × Grab: Say it once. Ari orders Grab. Partnership proposal by CSA PROJECT - FZCO. Not affiliated with Grab.',
    ru: 'Знак Ari: белая буква A на градиенте от фиолетового к розовому. Ari × Grab: скажите один раз, и Ari закажет Grab. Предложение о партнёрстве от CSA PROJECT - FZCO. Проект не связан с Grab.',
    th: 'สัญลักษณ์ Ari ตัวอักษร A สีขาวบนพื้นไล่สีจากม่วงไปชมพู Ari × Grab: พูดครั้งเดียว Ari สั่ง Grab ให้ ข้อเสนอความร่วมมือจาก CSA PROJECT - FZCO ไม่มีส่วนเกี่ยวข้องกับ Grab',
  });
  const navLinks: [string, string][] = [
    ['/#how', m.navHow],
    ['/for-grab', tr(l, { ru: 'Для Grab', en: 'For Grab', th: 'สำหรับ Grab' })],
    ['/developers', tr(l, { ru: 'Разработчикам', en: 'Developers', th: 'นักพัฒนา' })],
    ['/docs', tr(l, { ru: 'Документация', en: 'Docs', th: 'เอกสาร' })],
  ];
  const noindex = o.noindex || NOINDEX_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}-`));
  return (
    '<!doctype html>' +
    html`<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} · Ari × Grab</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#6b4ef6">
<meta property="og:title" content="${o.title} · Ari × Grab">
<meta property="og:description" content="${desc}">
${noindex ? html`<meta name="robots" content="noindex">` : ''}
${isPublic && !noindex ? html`<link rel="canonical" href="${abs(`${path}?lang=${l}`)}">` : ''}
${isPublic && !noindex ? html`${LOCALE_CODES.map((x) => html`<link rel="alternate" hreflang="${x}" href="${abs(`${path}?lang=${x}`)}">\n`)}<link rel="alternate" hreflang="x-default" href="${abs(path)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Ari × Grab">
${path ? html`<meta property="og:url" content="${abs(`${path}?lang=${l}`)}">` : ''}
<meta property="og:locale" content="${OG_LOCALE[l]}">
<meta property="og:image" content="${abs(OG_IMAGE_PATH)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${ogAlt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${o.title} · Ari × Grab">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${abs(OG_IMAGE_PATH)}">
<link rel="preload" href="/static/fonts/manrope-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/static/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
${LOCALE_FONT[l] ? html`<link rel="preload" href="/static/fonts/${LOCALE_FONT[l]}" as="font" type="font/woff2" crossorigin>` : ''}
<link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}">
<link rel="icon" type="image/png" sizes="32x32" href="/static/brand/favicon-32.png?v=${ASSET_VERSION}">
<link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png?v=${ASSET_VERSION}">
<link rel="manifest" href="/manifest.webmanifest">
<script type="application/ld+json">${raw(ORG_LD)}</script>
<script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
${(o.scripts ?? []).map((x) => html`<script src="/static/${x}?v=${ASSET_VERSION}" defer></script>`)}
</head>
<body>
<a class="skip" href="#main">${tr(l, { ru: 'К содержанию', en: 'Skip to content', th: 'ข้ามไปยังเนื้อหา' })}</a>
<aside class="concept-bar" aria-label="${tr(l, { ru: 'О демо', en: 'About this demo', th: 'เกี่ยวกับเดโมนี้' })}"><div class="wrap">
  <span class="dot" aria-hidden="true"></span>
  <span>${tr(l, {
    ru: 'Ari × Grab: предложение о партнёрстве от CSA PROJECT - FZCO. Договорённости с Grab нет. Проект не связан с Grab и не одобрен Grab. Демо-данные вымышлены.',
    en: 'Ari × Grab is a partnership proposal by CSA PROJECT - FZCO. No agreement with Grab exists. Not affiliated with or endorsed by Grab. Demo data is fictional.',
    th: 'Ari × Grab เป็นข้อเสนอความร่วมมือจาก CSA PROJECT - FZCO ยังไม่มีข้อตกลงกับ Grab ไม่มีส่วนเกี่ยวข้องกับ Grab และไม่ได้รับการรับรองจาก Grab ข้อมูลเดโมเป็นข้อมูลสมมติ',
  })} <a href="/for-grab#disclaimer">${tr(l, { ru: 'Подробнее', en: 'Details', th: 'รายละเอียด' })}</a></span>
</div></aside>
<header class="site"><div class="wrap">
  <a class="logo" href="/" aria-label="${tr(l, { ru: 'Ari × Grab, на главную', en: 'Ari × Grab, home', th: 'Ari × Grab หน้าแรก' })}"><span class="ari-mark" aria-hidden="true">A</span><span class="logo-text"><span class="logo-word">Ari <span class="x">×</span> Grab</span><span class="logo-sub">${tr(l, { ru: 'на движке Unyly', en: 'powered by Unyly', th: 'ขับเคลื่อนโดย Unyly' })}</span></span></a>
  <nav class="main" aria-label="${tr(l, { ru: 'Основная навигация', en: 'Main', th: 'เมนูหลัก' })}">
    ${navLinks.map(([href, label]) => html`<a href="${href}" class="hide-md" ${cur(href)}>${label}</a>`)}
    ${o.loggedIn && !o.guest ? html`<a href="/app" class="hide-sm" ${cur('/app')}>${m.navApp}</a>` : ''}
    <a href="/ari" class="cta" ${cur('/ari')}>${tr(l, { ru: 'Живое демо', en: 'Live demo', th: 'เดโมสด' })}</a>
    <details class="lang-menu nav-menu">
      <summary>${raw('<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>')}<span class="nm-label">${tr(l, { ru: 'Меню', en: 'Menu', th: 'เมนู' })}</span></summary>
      <ul role="list">
        ${navLinks.map(([href, label]) => html`<li><a href="${href}" ${cur(href)}>${label}</a></li>`)}
        ${o.loggedIn && !o.guest ? html`<li class="nm-app"><a href="/app" ${cur('/app')}>${m.navApp}</a></li>` : ''}
      </ul>
    </details>
    <details class="lang-menu">
      <summary>${icon('globe')}<span><span class="sr-only">${tr(l, { ru: 'Язык', en: 'Language', th: 'ภาษา' })}: </span>${l.toUpperCase()}</span></summary>
      <ul role="list">
        ${LOCALE_CODES.map((x) => html`<li><a href="${langHref(x)}" ${l === x ? html`aria-current="true"` : ''} lang="${x}" hreflang="${x}"><span class="lang-code">${x.toUpperCase()}</span><span class="lang-name">${LOCALE_NATIVE[x]}</span></a></li>`)}
      </ul>
    </details>
  </nav>
</div></header>
${!o.noBanner && o.mode === 'demo' ? html`<div class="banner demo" role="status"><div class="wrap"><span class="pill warn">${tr(l, { ru: 'ДЕМО', en: 'DEMO', th: 'เดโม' })}</span><span>${m.demoBanner}${o.guest ? html` <span class="guest-note">${tr(l, { ru: 'Гостевой сеанс удаляется через 24 часа.', en: 'Guest sessions are deleted after 24 hours.', th: 'เซสชันผู้เยี่ยมชมจะถูกลบหลัง 24 ชั่วโมง' })}</span>` : ''}</span></div></div>` : ''}
${!o.noBanner && o.mode === 'handoff' ? html`<div class="banner handoff" role="status"><div class="wrap">${m.handoffBanner}</div></div>` : ''}
<main id="main">${o.wide ? o.body : html`<div class="wrap ${o.narrow ? 'narrow' : ''}">${o.body}</div>`}</main>
<footer class="site"><div class="wrap">
  <div class="cols">
    <div class="foot-brand">
      <a class="logo" href="/"><span class="ari-mark" aria-hidden="true">A</span><span class="logo-text"><span class="logo-word">Ari <span class="x">×</span> Grab</span><span class="logo-sub">${tr(l, { ru: 'на движке Unyly', en: 'powered by Unyly', th: 'ขับเคลื่อนโดย Unyly' })}</span></span></a>
      <p>${m.footerDisclaimer}</p>
    </div>
    <div class="foot-col"><p class="foot-h">${tr(l, { ru: 'Продукт', en: 'Product', th: 'ผลิตภัณฑ์' })}</p>
      ${o.loggedIn && !o.guest ? html`<a href="/app">${m.navApp}</a>` : html`<a href="/login">${m.navLogin}</a>`}
      <a href="/ari">${tr(l, { ru: 'Живое демо Ari', en: 'Ari live demo', th: 'เดโมสดของ Ari' })}</a>
      <a href="/#how">${m.navHow}</a>
      <a href="/developers">${tr(l, { ru: 'Partner API', en: 'Partner API', th: 'Partner API' })}</a>
      <a href="/assistants">${tr(l, { ru: 'Другие ИИ-ассистенты (MCP)', en: 'Other AI assistants (MCP)', th: 'ผู้ช่วย AI อื่น ๆ (MCP)' })}</a>
      <a href="/connect">${m.connectTitle}</a>
      <a href="/docs">${tr(l, { ru: 'Документация', en: 'Documentation', th: 'เอกสาร' })}</a>
    </div>
    <div class="foot-col"><p class="foot-h">${tr(l, { ru: 'О проекте', en: 'Project', th: 'โครงการ' })}</p>
      <a href="/for-grab">${tr(l, { ru: 'Предложение для Grab', en: 'Proposal for Grab', th: 'ข้อเสนอสำหรับ Grab' })}</a>
      <a href="https://apps.apple.com/app/id6831932629" rel="noopener">${tr(l, { ru: 'Ari в App Store', en: 'Ari on the App Store', th: 'Ari บน App Store' })}</a>
      <a href="${REPO_URL}" rel="noopener">${tr(l, { ru: 'Исходный код', en: 'Source code', th: 'ซอร์สโค้ด' })}</a>
      <a href="/help">${m.navHelp}</a>
      <a href="/privacy">${m.footerPrivacy}</a>
    </div>
    <div class="foot-col"><p class="foot-h">${tr(l, { ru: 'Контакты', en: 'Contacts', th: 'ติดต่อ' })}</p>
      <a href="mailto:${CONTACT.email}">${icon('mail')} ${CONTACT.email}</a>
      <a href="${whatsappUrl(CONTACT.owner.whatsapp)}" rel="noopener">${icon('chat')} WhatsApp</a>
      <a href="tel:+${CONTACT.owner.line}">${icon('chat')} LINE</a>
      <a href="${instagramUrl(CONTACT.owner.instagram)}" rel="noopener">${icon('users')} Instagram</a>
      <a href="${CONTACT.telegramGlobal}" rel="noopener">${icon('send')} Telegram</a>
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
