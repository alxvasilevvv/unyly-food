import { html, SafeHtml } from './html.js';
import { Locale, msg } from './messages.js';

export interface PageOpts {
  title: string;
  locale: Locale;
  body: SafeHtml;
  loggedIn: boolean;
  mode?: 'demo' | 'handoff' | 'live' | null;
  csrf?: string;
  path?: string;
  narrow?: boolean;
  description?: string;
}

export function page(o: PageOpts): string {
  const m = msg(o.locale);
  const other = (l: Locale) => `?lang=${l}`;
  return (
    '<!doctype html>' +
    html`<html lang="${o.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} · Unyly</title>
<meta name="description" content="${o.description ?? m.brandTagline}">
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%234b3fd1'/%3E%3Ctext x='16' y='22' font-family='Arial' font-weight='700' font-size='18' text-anchor='middle' fill='white'%3Eu%3C/text%3E%3C/svg%3E">
<script src="/static/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">${o.locale === 'ru' ? 'К содержанию' : 'Skip to content'}</a>
<header class="site"><div class="wrap">
  <a class="logo" href="/"><span class="logo-mark" aria-hidden="true">u</span>unyly</a>
  <nav class="main" aria-label="${o.locale === 'ru' ? 'Основная навигация' : 'Main'}">
    <a href="/#how" class="hide-sm">${m.navHow}</a>
    <a href="/connect">${m.navConnect}</a>
    <a href="/help">${m.navHelp}</a>
    ${o.loggedIn ? html`<a href="/app">${m.navApp}</a>` : html`<a href="/login">${m.navLogin}</a>`}
    <span class="lang" role="group" aria-label="Language">
      <a href="${other('ru')}" aria-current="${o.locale === 'ru'}" lang="ru">RU</a><a href="${other('en')}" aria-current="${o.locale === 'en'}" lang="en">EN</a>
    </span>
  </nav>
</div></header>
${o.mode === 'demo' ? html`<div class="banner demo" role="status"><div class="wrap">${m.demoBanner}</div></div>` : ''}
${o.mode === 'handoff' ? html`<div class="banner handoff" role="status"><div class="wrap">${m.handoffBanner}</div></div>` : ''}
<main id="main"><div class="wrap ${o.narrow ? 'narrow' : ''}">${o.body}</div></main>
<footer class="site"><div class="wrap stack">
  <p>${m.footerDisclaimer}</p>
  <p><a href="/privacy">${m.footerPrivacy}</a> · <a href="/help">${m.navHelp}</a>
  ${o.loggedIn && o.csrf ? html` · <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${o.csrf}"><button class="linkbtn">${m.navLogout}</button></form>` : ''}</p>
</div></footer>
</body></html>`.value
  );
}
