import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { UUID_RE } from '../domain/crypto.js';
import { DomainError, isDomainError } from '../domain/errors.js';
import { formatMinor, money } from '../domain/money.js';
import { checkCsrf, loadSession, logout, requestLoginCode, safeNext, setSessionCookie, verifyLoginCode, WebSession } from '../auth/session.js';
import { revokeGrantForUser } from '../auth/oauth.js';
import { authenticationOptions, deletePasskey, listPasskeys, registrationOptions, verifyAuthentication, verifyRegistration } from '../auth/passkeys.js';
import { approveCheckout, checkoutView, declineCheckout, submitOrder } from '../services/checkout.js';
import {
  approveCancellation, cancelOrder, describeOrder, getOrderStatus, loadCancellation, loadOrder, prepareCancellation,
} from '../services/orders.js';
import {
  addAddress, ALLERGENS, deleteAccount, deleteAddress, DIETS, exportUserData, getPreferences, listAddresses, markOnboarded,
  savePreferences, setDefaultAddress, setLocale, setRegionAndMode,
} from '../services/users.js';
import { DEMO_DISTRICTS } from '../providers/demo/catalog.js';
import type { Mode } from '../providers/types.js';
import { html, SafeHtml } from './html.js';
import { page } from './layout.js';
import { fmt, Locale, LOCALES, Messages, msg } from './messages.js';

const LANG_COOKIE = 'unyly_lang';
const STATUS_FLOW = ['accepted', 'preparing', 'picked_up', 'delivered'] as const;

function detectLocale(req: FastifyRequest, s: WebSession | null): Locale {
  const q = (req.query as any)?.lang;
  if (q && q in LOCALES) return q;
  const c = req.cookies?.[LANG_COOKIE];
  if (c && c in LOCALES) return c as Locale;
  if (s) return s.user.locale;
  return /(^|,)\s*en/i.test(String(req.headers['accept-language'] ?? '')) && !/(^|,)\s*ru/i.test(String(req.headers['accept-language'] ?? '')) ? 'en' : 'ru';
}

interface R {
  s: WebSession | null;
  l: Locale;
  m: Messages;
}

export function registerWebRoutes(app: FastifyInstance, ctx: Ctx) {
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@unyly.org';

  async function base(req: FastifyRequest, reply: FastifyReply): Promise<R> {
    const s = await loadSession(ctx, req);
    const l = detectLocale(req, s);
    const q = (req.query as any)?.lang;
    if (q && q in LOCALES) {
      reply.setCookie(LANG_COOKIE, q, { path: '/', sameSite: 'lax', secure: ctx.cfg.cookieSecure, maxAge: 365 * 86400 });
      if (s && s.user.locale !== q) await setLocale(ctx.db, s.user.id, q);
    }
    return { s, l, m: msg(l) };
  }

  const send = (reply: FastifyReply, r: R, title: string, body: SafeHtml, extra: { narrow?: boolean; status?: number } = {}) =>
    reply
      .code(extra.status ?? 200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(page({ title, locale: r.l, body, loggedIn: !!r.s, mode: r.s?.user.mode ?? null, csrf: r.s?.csrf, narrow: extra.narrow }));

  async function authed(req: FastifyRequest, reply: FastifyReply): Promise<(R & { s: WebSession }) | null> {
    const r = await base(req, reply);
    if (!r.s) {
      reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
      return null;
    }
    return r as R & { s: WebSession };
  }

  const csrfField = (s: WebSession) => html`<input type="hidden" name="_csrf" value="${s.csrf}">`;
  const dt = (d: string | Date, l: Locale) =>
    new Intl.DateTimeFormat(l === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(d)) + ' (ICT)';
  const fsLabel = (m: Messages, s: string) => (m as any)[`fs_${s}`] ?? s;
  const psLabel = (m: Messages, s: string) => (m as any)[`ps_${s}`] ?? s;
  const errorBox = (e: unknown) => html`<div class="notice bad" role="alert">${isDomainError(e) ? e.message : 'Unexpected error'}</div>`;

  // ---------------- Public ----------------
  app.get('/', async (req, reply) => {
    const r = await base(req, reply);
    const m = r.m;
    const cap = (ok: boolean) => html`<span class="pill ${ok ? 'ok' : 'bad'}">${ok ? m.available : m.unavailable}</span>`;
    return send(reply, r, m.brandTagline, html`
<section class="hero">
  <h1>${m.heroTitle}</h1>
  <p class="lead">${m.heroLead}</p>
  <div class="actions">
    <a class="btn" href="/connect">${m.heroCta}</a>
    <a class="btn secondary" href="#how">${m.heroSecondary}</a>
  </div>
  <p class="small muted">${m.heroCtaDemoNote}</p>
</section>
<section aria-labelledby="st">
  <h2 id="st">${m.statusTitle}</h2>
  <div class="card"><ul class="list">
    <li><span>${m.statusDemo}</span>${cap(true)}</li>
    <li><span>${m.statusHandoff}</span>${cap(true)}</li>
    <li><span>${m.statusLive}</span>${cap(false)}</li>
  </ul></div>
</section>
<section id="how" aria-labelledby="how-h">
  <h2 id="how-h">${m.howTitle}</h2>
  <div class="grid four">
    ${[[m.how1t, m.how1d], [m.how2t, m.how2d], [m.how3t, m.how3d], [m.how4t, m.how4d]].map(([t, d], i) => html`<div class="card"><span class="pill accent">${i + 1}</span><h3 style="margin-top:10px">${t}</h3><p class="muted small">${d}</p></div>`)}
  </div>
</section>
<section aria-labelledby="sf">
  <h2 id="sf">${m.safetyTitle}</h2>
  <div class="card"><ul class="list">${[m.safety1, m.safety2, m.safety3, m.safety4, m.safety5].map((x) => html`<li>${x}</li>`)}</ul></div>
</section>
<section aria-labelledby="ex">
  <h2 id="ex">${m.examplePrompt}</h2>
  <p class="prompt">${m.trialPromptDemo}</p>
</section>`);
  });

  app.get('/connect', async (req, reply) => {
    const r = await base(req, reply);
    const m = r.m;
    let connected = 0;
    if (r.s) connected = (await ctx.db.query('SELECT count(*)::int n FROM oauth_grants WHERE user_id=$1 AND revoked_at IS NULL', [r.s.user.id])).rows[0].n;
    const url = ctx.cfg.mcpResourceUrl;
    const ru = r.l === 'ru';
    return send(reply, r, m.connectTitle, html`
<h1>${m.connectTitle}</h1>
<p class="lead">${m.connectLead}</p>
<div class="card stack">
  <label for="mcpurl">${m.mcpUrl}</label>
  <div class="copyrow"><p class="code" id="mcpurl">${url}</p><button class="btn secondary" type="button" data-copy="mcpurl" data-copied="${m.copied}">${m.copy}</button></div>
  ${r.s ? html`<p class="small">${fmt(m.connectedClients, { n: connected })} · <a href="/app/connections">${m.connectionsTitle}</a></p>` : html`<p class="notice warn">${m.connectNotLoggedIn} <a href="/login?next=/connect">${m.navLogin}</a></p>`}
</div>
<h2>${ru ? 'Инструкции по клиентам' : 'Client instructions'}</h2>
<details open><summary>Claude (claude.ai, Desktop, mobile)</summary><div class="stack small">
  <p>${ru ? 'Нужен тариф Pro, Max, Team или Enterprise. На Team/Enterprise коннектор добавляет владелец организации, затем каждый пользователь подключается сам.' : 'Requires a Pro, Max, Team or Enterprise plan. On Team/Enterprise an owner adds the connector, then each user connects individually.'}</p>
  <p>${ru ? 'Настройки → Коннекторы → Добавить свой коннектор → вставьте адрес выше → Подключить. Откроется окно входа Unyly.' : 'Settings → Connectors → Add custom connector → paste the URL above → Connect. The Unyly sign-in window opens.'}</p>
  <p class="muted">${ru ? 'Названия пунктов меню могут отличаться; источник: support.claude.com, статья о custom connectors (проверено 30.09.2026).' : 'Menu labels may differ; source: support.claude.com custom connectors article (checked 2026-09-30).'}</p>
</div></details>
<details><summary>Claude Code</summary><div class="stack small">
  <p class="code" id="cc">claude mcp add --transport http unyly ${url}</p>
  <p>${ru ? 'Затем в Claude Code выполните /mcp и выберите unyly, чтобы пройти вход в браузере.' : 'Then run /mcp in Claude Code and select unyly to sign in via the browser.'}</p>
</div></details>
<details><summary>ChatGPT</summary><div class="stack small">
  <p>${ru ? 'Нужен режим разработчика (Developer mode), доступный на тарифах Plus, Pro, Business, Enterprise и Education в веб-версии; доступность зависит от политики аккаунта и рабочего пространства.' : 'Requires Developer mode, available on Plus, Pro, Business, Enterprise and Education plans on the web; availability depends on account and workspace policy.'}</p>
  <p>${ru ? 'Включите Developer mode в настройках, создайте приложение/коннектор и укажите адрес выше, аутентификация OAuth. Действия записи ChatGPT по умолчанию просит подтвердить.' : 'Enable Developer mode in settings, create an app/connector with the URL above and OAuth authentication. ChatGPT asks for confirmation on write actions by default.'}</p>
  <p class="muted">${ru ? 'Не проверено вручную в этом релизе. Источник: developers.openai.com (developer mode, apps SDK), 30.09.2026.' : 'Not manually verified in this release. Source: developers.openai.com (developer mode, apps SDK), 2026-09-30.'}</p>
</div></details>
<details><summary>OpenAI API (Responses)</summary><div class="stack small">
  <p>${ru ? 'Получите токен Unyly через OAuth в своём приложении и передайте его в поле authorization инструмента mcp:' : 'Obtain an Unyly token via OAuth in your app and pass it in the mcp tool authorization field:'}</p>
  <pre class="code">{"type":"mcp","server_label":"unyly","server_url":"${url}","authorization":"&lt;token&gt;","require_approval":{"always":{"tool_names":["submit_order","cancel_order"]}}}</pre>
</div></details>
<details><summary>${ru ? 'Другой MCP-клиент' : 'Other MCP client'}</summary><div class="stack small">
  <p>${ru ? 'Транспорт Streamable HTTP, OAuth 2.1 с PKCE (S256). Метаданные ресурса: ' : 'Streamable HTTP transport, OAuth 2.1 with PKCE (S256). Resource metadata: '}<span class="code">${new URL(url).origin}/.well-known/oauth-protected-resource${new URL(url).pathname}</span></p>
  <p>${ru ? 'Поддерживаются динамическая регистрация клиентов и Client ID Metadata Documents.' : 'Dynamic client registration and Client ID Metadata Documents are supported.'}</p>
</div></details>
<h2>${m.trialTitle}</h2>
<p>${m.trialLead}</p>
<p class="prompt">${r.s?.user.mode === 'handoff' ? m.trialPromptHandoff : m.trialPromptDemo}</p>`);
  });

  app.get('/help', async (req, reply) => {
    const r = await base(req, reply);
    const ru = r.l === 'ru';
    const qa: [string, string][] = ru
      ? [
          ['Это официальный сервис Grab?', 'Нет. Unyly - независимый сервис. Реальные заказы Grab через Unyly пока недоступны: у Grab нет публичного API для заказа от имени покупателя.'],
          ['Может ли ассистент заказать без меня?', 'Нет. Каждый заказ и каждая отмена подтверждаются вами на странице Unyly после входа. Ассистент не может нажать эту кнопку.'],
          ['Что будет, если цена изменится?', 'Подтверждение перестанет действовать. Ассистент пересчитает заказ, и вы подтвердите новую сумму.'],
          ['Что значит «результат неизвестен»?', 'Связь с провайдером оборвалась после отправки. Unyly сам сверяет статус и никогда не отправляет заказ повторно. Не заказывайте ту же еду в другом месте, пока статус не прояснится.'],
          ['Насколько точны аллергены?', 'Мы показываем только то, что указал ресторан. Если данных нет, так и пишем. Unyly никогда не называет блюдо безопасным.'],
          ['Как отключить ассистента?', 'Кабинет → Подключения → Отозвать доступ. Токен перестаёт работать сразу.'],
        ]
      : [
          ['Is this an official Grab service?', 'No. Unyly is independent. Real Grab orders through Unyly are not available yet: Grab has no public API for ordering on behalf of a customer.'],
          ['Can the assistant order without me?', 'No. You confirm every order and cancellation on an Unyly page after signing in. The assistant cannot press that button.'],
          ['What if the price changes?', 'The confirmation stops being valid. The assistant re-quotes and you confirm the new total.'],
          ['What does "outcome unknown" mean?', 'The connection to the provider dropped after sending. Unyly reconciles the status itself and never resends. Do not order the same food elsewhere until it resolves.'],
          ['How accurate are allergens?', 'We only show what the restaurant declared. If there is no data we say so. Unyly never calls a dish safe.'],
          ['How do I disconnect an assistant?', 'Dashboard → Connections → Revoke access. The token stops working immediately.'],
        ];
    return send(reply, r, r.m.helpTitle, html`<h1>${r.m.helpTitle}</h1>
${qa.map(([q, a]) => html`<details><summary>${q}</summary><p>${a}</p></details>`)}
<h2>${r.m.support}</h2><p>${fmt(r.m.supportLead, { email: supportEmail })}</p>`, { narrow: true });
  });

  app.get('/privacy', async (req, reply) => {
    const r = await base(req, reply);
    const ru = r.l === 'ru';
    const rows: [string, string][] = ru
      ? [
          ['Коды входа', 'удаляются через 1 день'],
          ['Сессии сайта', '14 дней, затем удаляются'],
          ['Токены ассистентов', 'доступ 1 час, обновление 30 дней; удаляются при отзыве'],
          ['Адреса', 'пока вы их не удалите; при удалении текст адреса стирается'],
          ['Корзины, расчёты, заказы', 'пока существует аккаунт (история заказов)'],
          ['Журнал действий', 'при удалении аккаунта отвязывается от вас и очищается'],
        ]
      : [
          ['Sign-in codes', 'deleted after 1 day'],
          ['Website sessions', '14 days, then deleted'],
          ['Assistant tokens', 'access 1 hour, refresh 30 days; deleted on revocation'],
          ['Addresses', 'until you delete them; deletion erases the address text'],
          ['Carts, quotes, orders', 'while the account exists (order history)'],
          ['Audit log', 'unlinked from you and scrubbed when you delete the account'],
        ];
    return send(reply, r, r.m.privacyTitle, html`<h1>${r.m.privacyTitle}</h1>
<p>${ru ? 'Мы храним минимум: email, адреса доставки, предпочтения, корзины и заказы. Мы не храним пароли Grab, коды из SMS и платёжные реквизиты. Ассистенту передаются только название адреса и район.' : 'We store the minimum: email, delivery addresses, preferences, carts and orders. We never store Grab passwords, SMS codes or payment details. Assistants only receive the address name and area.'}</p>
<div class="card"><ul class="list">${rows.map(([a, b]) => html`<li><strong>${a}</strong><span class="muted">${b}</span></li>`)}</ul></div>
<p class="small muted">${ru ? 'Сроки для Таиланда (PDPA) должны быть согласованы с юристом до запуска Live.' : 'Retention for Thailand (PDPA) must be reviewed by counsel before any Live launch.'}</p>`, { narrow: true });
  });

  // ---------------- Auth ----------------
  app.get('/login', async (req, reply) => {
    const r = await base(req, reply);
    const next = safeNext((req.query as any)?.next);
    if (r.s) return reply.redirect(next);
    return send(reply, r, r.m.loginTitle, loginForm(r, next), { narrow: true });
  });

  const pkData = (r: R) =>
    html`data-msg-unsupported="${r.m.pkUnsupported}" data-msg-cancelled="${r.m.pkCancelled}" data-msg-working="${r.m.pkWorking}" data-locale="${r.l}"`;

  function loginForm(r: R, next: string, error?: unknown) {
    const mailOn = ctx.cfg.mail.mode !== 'disabled';
    return html`<h1>${r.m.loginTitle}</h1><p class="lead">${r.m.passkeyLead}</p>${error ? errorBox(error) : ''}
<noscript><p class="notice warn">${r.m.jsNeeded}</p></noscript>
<div class="card stack" id="pk-login-box" data-next="${next}" ${pkData(r)}>
  <button class="btn block" type="button" id="pk-login">${r.m.passkeyLogin}</button>
  <p class="small muted" id="pk-login-status" role="status" aria-live="polite"></p>
</div>
<h2>${r.m.newAccount}</h2>
<form class="card stack" id="pk-register" data-next="/app/mode" ${pkData(r)}>
  <div class="field"><label for="reg-email">${r.m.email}</label><input id="reg-email" name="email" type="email" autocomplete="email" required></div>
  <p class="small muted">${r.m.regNote}</p>
  <button class="btn secondary block" type="submit">${r.m.createPasskey}</button>
  <p class="small muted" id="pk-register-status" role="status" aria-live="polite"></p>
</form>
<details style="margin-top:18px"><summary>${r.m.codeLogin}</summary>
${mailOn
  ? html`<form method="post" action="/login" class="stack" style="margin-top:12px">
  <input type="hidden" name="next" value="${next}">
  <div class="field"><label for="email">${r.m.email}</label><input id="email" name="email" type="email" autocomplete="email" required></div>
  <button class="btn secondary block" type="submit">${r.m.sendCode}</button></form>`
  : html`<p class="small">${r.m.codeBySupport}</p>`}
<p><a href="/login/code?next=${encodeURIComponent(next)}">${r.m.haveCode}</a></p>
</details>`;
  }

  function codeForm(r: R, email: string, next: string, devCode?: string, error?: unknown) {
    return html`<h1>${r.m.codeTitle}</h1>${email ? html`<p class="lead">${fmt(r.m.codeLead, { email })}</p>` : ''}
${devCode ? html`<p class="notice warn">${fmt(r.m.devCode, { code: devCode })}</p>` : ''}${error ? errorBox(error) : ''}
<form method="post" action="/login/verify" class="card stack">
  <input type="hidden" name="next" value="${next}">
  ${email ? html`<input type="hidden" name="email" value="${email}">` : html`<div class="field"><label for="email">${r.m.email}</label><input id="email" name="email" type="email" autocomplete="email" required></div>`}
  <div class="field"><label for="code">${r.m.code}</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required ${email ? html`autofocus` : ''}></div>
  <button class="btn block" type="submit">${r.m.signIn}</button>
</form><p><a href="/login?next=${encodeURIComponent(next)}">${r.m.back}</a></p>`;
  }

  app.get('/login/code', async (req, reply) => {
    const r = await base(req, reply);
    return send(reply, r, r.m.codeTitle, codeForm(r, '', safeNext((req.query as any)?.next)), { narrow: true });
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = await base(req, reply);
    const b = req.body as any;
    const next = safeNext(b?.next);
    try {
      const { devCode } = await requestLoginCode(ctx, String(b?.email ?? ''), r.l);
      return send(reply, r, r.m.codeTitle, codeForm(r, String(b.email).trim().toLowerCase(), next, devCode), { narrow: true });
    } catch (e) {
      return send(reply, r, r.m.loginTitle, loginForm(r, next, e), { narrow: true, status: 400 });
    }
  });

  app.post('/login/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = await base(req, reply);
    const b = req.body as any;
    const next = safeNext(b?.next);
    try {
      const { token, user } = await verifyLoginCode(ctx, String(b?.email ?? ''), String(b?.code ?? ''), r.l);
      setSessionCookie(ctx, reply, token);
      return reply.redirect(user.onboarded_at || next !== '/app' ? next : '/app');
    } catch (e) {
      return send(reply, r, r.m.codeTitle, codeForm(r, '', next, undefined, e), { narrow: true, status: 400 });
    }
  });

  app.post('/logout', async (req, reply) => {
    const s = await loadSession(ctx, req);
    if (s) checkCsrf(ctx, req, s);
    await logout(ctx, reply, s);
    return reply.redirect('/');
  });

  // ---------------- Passkeys (JSON, same-origin only) ----------------
  const sameOrigin = (req: FastifyRequest) => {
    const o = req.headers.origin;
    if (typeof o !== 'string') return false;
    try {
      return new URL(o).origin === ctx.cfg.webOrigin;
    } catch {
      return false;
    }
  };
  const pkError = (reply: FastifyReply, e: unknown) => {
    if (isDomainError(e)) return reply.code(e.httpStatus).send({ error: e.code, message: e.message });
    throw e;
  };
  const pkRate = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post('/auth/passkey/login/options', pkRate, async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send({ error: 'forbidden' });
    return reply.header('cache-control', 'no-store').send(await authenticationOptions(ctx));
  });
  app.post('/auth/passkey/login/verify', pkRate, async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send({ error: 'forbidden' });
    try {
      const out = await verifyAuthentication(ctx, req.body);
      setSessionCookie(ctx, reply, out.token);
      return reply.send({ ok: true, redirect: safeNext((req.body as any)?.next) });
    } catch (e) {
      return pkError(reply, e);
    }
  });
  app.post('/auth/passkey/register/options', pkRate, async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send({ error: 'forbidden' });
    const s = await loadSession(ctx, req);
    try {
      if (s && !(req.body as any)?.email) {
        if ((req.body as any)?._csrf !== s.csrf) return reply.code(403).send({ error: 'forbidden' });
        return reply.send(await registrationOptions(ctx, { sessionUserId: s.user.id, sessionEmail: s.user.email }));
      }
      return reply.header('cache-control', 'no-store').send(await registrationOptions(ctx, { email: (req.body as any)?.email }));
    } catch (e) {
      return pkError(reply, e);
    }
  });
  app.post('/auth/passkey/register/verify', pkRate, async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send({ error: 'forbidden' });
    const s = await loadSession(ctx, req);
    try {
      const out = await verifyRegistration(ctx, req.body, s?.user.id);
      if (out.token) setSessionCookie(ctx, reply, out.token);
      return reply.send({ ok: true, redirect: out.isNew ? '/app/mode' : '/app/data?passkey=added' });
    } catch (e) {
      return pkError(reply, e);
    }
  });

  // ---------------- Dashboard ----------------
  app.get('/app', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    const m = r.m;
    const u = r.s.user;
    const addrs = await listAddresses(ctx.db, u.id);
    const grants = (await ctx.db.query('SELECT count(*)::int n FROM oauth_grants WHERE user_id=$1 AND revoked_at IS NULL', [u.id])).rows[0].n;
    const firstCart = (await ctx.db.query('SELECT 1 FROM carts WHERE user_id=$1 LIMIT 1', [u.id])).rowCount > 0;
    const orders = (await ctx.db.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5', [u.id])).rows;
    const st = (ok: boolean | null) => (ok === null ? html`<span class="pill">${m.notNeeded}</span>` : ok ? html`<span class="pill ok">${m.done}</span>` : html`<span class="pill warn">${m.todo}</span>`);
    const modeName = { demo: m.modeDemo, handoff: m.modeHandoff, live: m.modeLive }[u.mode];
    const steps: [string, SafeHtml, string | null][] = [
      [m.step1, st(true), null],
      [m.step2, st(!!u.onboarded_at), '/app/mode'],
      [m.step3, st(null), '/app/mode'],
      [m.step4, st(addrs.length > 0), '/app/addresses'],
      [m.step5, st(grants > 0), '/connect'],
      [m.step6, st(firstCart), '/connect'],
    ];
    return send(reply, r, m.appTitle, html`<h1>${m.appTitle}</h1>
<p class="muted">${u.email} · ${m.region}: TH · ${m.mode}: <strong>${modeName}</strong></p>
<div class="grid two">
  <section class="card"><h2 style="margin-top:0">${m.setupTitle}</h2><ol class="steps">
    ${steps.map(([t, badge, href]) => html`<li><span class="num" aria-hidden="true"></span><span class="grow">${href ? html`<a href="${href}">${t}</a>` : t}</span>${badge}</li>`)}
  </ol></section>
  <section class="card"><h2 style="margin-top:0">${m.ordersTitle}</h2>
    ${orders.length ? html`<ul class="list">${orders.map((o: any) => orderRow(r, o))}</ul><p><a href="/app/orders">${m.ordersTitle} →</a></p>` : html`<p class="muted">${m.noOrders}</p>`}
    <h3 style="margin-top:18px">${m.trialTitle}</h3><p class="prompt small">${u.mode === 'handoff' ? m.trialPromptHandoff : m.trialPromptDemo}</p>
  </section>
</div>
<div class="actions" style="margin-top:18px">
  <a class="btn secondary" href="/app/preferences">${m.prefsTitle}</a>
  <a class="btn secondary" href="/app/connections">${m.connectionsTitle}</a>
  <a class="btn secondary" href="/app/data">${m.dataTitle}</a>
</div>`);
  });

  function orderRow(r: R, o: any) {
    const d = describeOrder(o, r.l);
    return html`<li><span><strong>${d.restaurant}</strong><br><span class="small muted">${dt(d.placed_at, r.l)} · ${d.total.formatted}</span></span>
<span><span class="pill ${d.fulfillment_status === 'delivered' ? 'ok' : d.fulfillment_status === 'cancelled' || d.fulfillment_status === 'failed' ? 'bad' : 'accent'}">${fsLabel(r.m, d.fulfillment_status)}</span> <a href="/app/orders/${d.order_id}">${r.m.details}</a></span></li>`;
  }

  // ---------------- Region & mode ----------------
  app.get('/app/mode', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    return send(reply, r, r.m.modeTitle, modeForm(r), { narrow: true });
  });

  function modeForm(r: R & { s: WebSession }, note?: SafeHtml) {
    const m = r.m;
    const u = r.s.user;
    const opt = (mode: Mode, title: string, desc: string, enabled: boolean) => html`<label class="radio-card ${enabled ? '' : 'disabled'}">
<input type="radio" name="mode" value="${mode}" ${u.mode === mode ? html`checked` : ''} ${enabled ? '' : html`disabled`}>
<span><strong>${title}</strong> ${enabled ? '' : html`<span class="pill bad">${m.unavailable}</span>`}<br><span class="small muted">${desc}</span></span></label>`;
    const provider = { demo: m.providerDemo, handoff: m.providerHandoff, live: m.providerLive }[u.mode];
    return html`<h1>${m.modeTitle}</h1>${note ?? ''}
<form method="post" action="/app/mode" class="stack">${csrfField(r.s)}
  <div class="field"><label for="region">${m.region}</label><select id="region" name="region"><option value="TH" selected>${m.regionTH}</option></select></div>
  <fieldset style="border:0;padding:0;margin:14px 0 0"><legend class="sr-only">${m.mode}</legend>
    ${opt('demo', m.modeDemo, m.modeDemoDesc, true)}
    ${opt('handoff', m.modeHandoff, m.modeHandoffDesc, true)}
    ${opt('live', m.modeLive, m.modeLiveDesc, ctx.providers.live.capabilities().submit_order.available)}
  </fieldset>
  <button class="btn" type="submit">${m.save}</button>
</form>
<h2>${m.providerTitle}</h2><p class="card">${provider}</p>`;
  }

  app.post('/app/mode', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const b = req.body as any;
    try {
      await setRegionAndMode(ctx, r.s.user.id, String(b.region ?? 'TH'), String(b.mode ?? 'demo') as Mode);
      await markOnboarded(ctx.db, r.s.user.id);
      return reply.redirect('/app/addresses');
    } catch (e) {
      return send(reply, r, r.m.modeTitle, modeForm(r, errorBox(e)), { narrow: true, status: 400 });
    }
  });

  // ---------------- Addresses ----------------
  async function addressesPage(r: R & { s: WebSession }, note?: SafeHtml) {
    const m = r.m;
    const list = await listAddresses(ctx.db, r.s.user.id);
    return html`<h1>${m.addressesTitle}</h1><p class="lead">${m.addressesLead}</p>${note ?? ''}
${list.length ? html`<ul class="list card">${list.map((a) => html`<li><span><strong>${a.label}</strong> ${a.is_default ? html`<span class="pill ok">${m.defaultBadge}</span>` : ''}<br><span class="small muted">${a.line1}, ${a.district}, ${a.city}</span></span>
<span class="actions">${a.is_default ? '' : html`<form method="post" action="/app/addresses/${a.id}/default">${csrfField(r.s)}<button class="btn secondary" type="submit">${m.makeDefault}</button></form>`}
<form method="post" action="/app/addresses/${a.id}/delete">${csrfField(r.s)}<button class="btn secondary" type="submit">${m.delete}</button></form></span></li>`)}</ul>` : html`<p class="muted">${m.noAddresses}</p>`}
<h2>${m.addAddress}</h2>
${r.s.user.mode === 'demo' ? html`<p class="notice small">${m.demoAddressHint}</p>` : ''}
<form method="post" action="/app/addresses" class="card stack">${csrfField(r.s)}
  <div class="field"><label for="label">${m.label}</label><input id="label" name="label" type="text" placeholder="${m.labelPh}" required maxlength="40"></div>
  <div class="field"><label for="line1">${m.line1}</label><input id="line1" name="line1" type="text" placeholder="${m.line1Ph}" required maxlength="200" autocomplete="street-address"></div>
  <div class="grid two">
    <div class="field"><label for="district">${m.district}</label>
      <input id="district" name="district" type="text" list="districts" required maxlength="80"><datalist id="districts">${DEMO_DISTRICTS.map((d) => html`<option value="${d}">`)}</datalist></div>
    <div class="field"><label for="city">${m.city}</label><input id="city" name="city" type="text" value="Bangkok" required maxlength="80"></div>
  </div>
  <input type="hidden" name="country" value="TH">
  <div class="field"><label for="instructions">${m.instructions}</label><input id="instructions" name="instructions" type="text" maxlength="300"></div>
  <label class="checks"><label><input type="checkbox" name="default" value="1"> ${m.makeDefault}</label></label>
  <button class="btn" type="submit">${m.addAddress}</button>
</form>
<p><a href="/app/preferences">${m.prefsTitle} →</a></p>`;
  }

  app.get('/app/addresses', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    return send(reply, r, r.m.addressesTitle, await addressesPage(r), { narrow: true });
  });
  app.post('/app/addresses', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const b = req.body as any;
    try {
      await addAddress(ctx, r.s.user.id, { label: String(b.label ?? ''), line1: String(b.line1 ?? ''), district: String(b.district ?? ''), city: String(b.city ?? ''), country: String(b.country ?? 'TH'), instructions: b.instructions ? String(b.instructions) : undefined }, b.default === '1');
      return reply.redirect('/app/addresses');
    } catch (e) {
      const extra = isDomainError(e) && e.code === 'ADDRESS_AMBIGUOUS' ? html`<div class="notice bad" role="alert">${r.l === 'ru' ? 'Адрес неполный или неоднозначный. Проверьте поля: ' : 'The address is incomplete or ambiguous. Check: '}${((e.details?.fields as string[]) ?? []).join(', ')}</div>` : errorBox(e);
      return send(reply, r, r.m.addressesTitle, await addressesPage(r, extra), { narrow: true, status: 400 });
    }
  });
  app.post('/app/addresses/:id/delete', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const id = (req.params as any).id;
    if (UUID_RE.test(id)) await deleteAddress(ctx, r.s.user.id, id).catch(() => undefined);
    return reply.redirect('/app/addresses');
  });
  app.post('/app/addresses/:id/default', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const id = (req.params as any).id;
    if (UUID_RE.test(id)) await setDefaultAddress(ctx, r.s.user.id, id).catch(() => undefined);
    return reply.redirect('/app/addresses');
  });

  // ---------------- Preferences ----------------
  app.get('/app/preferences', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    return send(reply, r, r.m.prefsTitle, await prefsPage(r), { narrow: true });
  });
  async function prefsPage(r: R & { s: WebSession }, note?: SafeHtml) {
    const m = r.m;
    const p = await getPreferences(ctx.db, r.s.user.id);
    const ru = r.l === 'ru';
    const names: Record<string, string> = ru
      ? { peanut: 'Арахис', tree_nut: 'Орехи (древесные)', milk: 'Молоко', egg: 'Яйца', wheat: 'Пшеница/глютен', soy: 'Соя', fish: 'Рыба', shellfish: 'Морепродукты', sesame: 'Кунжут', vegetarian: 'Вегетарианское', vegan: 'Веганское', halal: 'Халяль', no_pork: 'Без свинины', no_beef: 'Без говядины' }
      : { peanut: 'Peanut', tree_nut: 'Tree nuts', milk: 'Milk', egg: 'Egg', wheat: 'Wheat/gluten', soy: 'Soy', fish: 'Fish', shellfish: 'Shellfish', sesame: 'Sesame', vegetarian: 'Vegetarian', vegan: 'Vegan', halal: 'Halal', no_pork: 'No pork', no_beef: 'No beef' };
    return html`<h1>${m.prefsTitle}</h1>${note ?? ''}
<form method="post" action="/app/preferences" class="stack">${csrfField(r.s)}
  <fieldset class="card"><legend><strong>${m.dietary}</strong></legend><div class="checks">
    ${DIETS.map((d) => html`<label><input type="checkbox" name="dietary" value="${d}" ${p.dietary.includes(d) ? html`checked` : ''}> ${names[d]}</label>`)}</div></fieldset>
  <fieldset class="card"><legend><strong>${m.allergies}</strong></legend><p class="small muted">${m.allergyNote}</p><div class="checks">
    ${ALLERGENS.map((d) => html`<label><input type="checkbox" name="allergies" value="${d}" ${p.allergies.includes(d) ? html`checked` : ''}> ${names[d]}</label>`)}</div></fieldset>
  <div class="field"><label for="ps">${m.partySize}</label><input id="ps" name="party_size" type="number" min="1" max="20" value="${p.default_party_size}"> <span class="small muted">${m.persons}</span></div>
  <button class="btn" type="submit">${m.save}</button>
</form>
<p><a href="/connect">${m.connectTitle} →</a></p>`;
  }
  app.post('/app/preferences', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const b = req.body as any;
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
    await savePreferences(ctx.db, r.s.user.id, { dietary: arr(b.dietary), allergies: arr(b.allergies), default_party_size: Number(b.party_size) || 1 });
    return send(reply, r, r.m.prefsTitle, await prefsPage(r, html`<p class="notice ok" role="status">${r.m.saved}</p>`), { narrow: true });
  });

  // ---------------- Orders ----------------
  app.get('/app/orders', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    const m = r.m;
    const orders = (await ctx.db.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [r.s.user.id])).rows;
    const handoffs = (await ctx.db.query('SELECT h.*, c.restaurant_name FROM handoffs h JOIN carts c ON c.id=h.cart_id WHERE h.user_id=$1 ORDER BY h.created_at DESC LIMIT 20', [r.s.user.id])).rows;
    return send(reply, r, m.ordersTitle, html`<h1>${m.ordersTitle}</h1>
${orders.length ? html`<ul class="list card">${orders.map((o: any) => orderRow(r, o))}</ul>` : html`<p class="muted">${m.noOrders}</p>`}
${handoffs.length ? html`<h2>${m.handoffsTitle}</h2><p class="small muted">${m.handoffNote}</p><ul class="list card">${handoffs.map((h: any) => html`<li><span><strong>${h.restaurant_name}</strong><br><span class="small muted">${dt(h.created_at, r.l)}</span></span><span class="small">${(h.checklist as any[]).map((i) => `${i.quantity}× ${i.name}`).join(', ')}</span></li>`)}</ul>` : ''}`);
  });

  app.get('/app/orders/:id', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    const m = r.m;
    const id = (req.params as any).id;
    if (!UUID_RE.test(id)) return notFound(reply, r);
    let data;
    try {
      data = await getOrderStatus(ctx, { userId: r.s.user.id, via: 'web' }, id);
    } catch (e) {
      if (isDomainError(e) && e.code === 'NOT_FOUND') return notFound(reply, r);
      throw e;
    }
    const o = data.order;
    const idx = STATUS_FLOW.indexOf(o.fulfillment_status as any);
    return send(reply, r, m.orderTitle, html`<h1>${m.orderTitle}: ${o.restaurant}</h1>
${data.notices.map((n) => html`<p class="notice warn" role="status">${n}</p>`)}
<div class="card stack">
  <ol class="timeline" aria-label="${m.status}">
    ${o.fulfillment_status === 'cancelled' || o.fulfillment_status === 'failed'
      ? html`<li class="current">${fsLabel(m, o.fulfillment_status)}</li>`
      : STATUS_FLOW.map((s, i) => html`<li class="${i < idx ? 'done' : i === idx ? 'current' : ''}" ${i === idx ? html`aria-current="step"` : ''}>${fsLabel(m, s)}</li>`)}
  </ol>
  <p class="small muted">${fmt(m.statusAsOf, { time: dt(data.data_as_of, r.l) })} · <a href="/app/orders/${o.order_id}">${m.refresh}</a></p>
  <table class="lines"><tbody>
    ${o.items.map((i: any) => html`<tr><td>${i.quantity}× ${i.name}${i.modifiers?.length ? html`<br><span class="small muted">${i.modifiers.join(', ')}</span>` : ''}</td></tr>`)}
  </tbody></table>
  <p><strong>${m.total}:</strong> ${formatMinor(o.total.amount_minor, o.total.currency, r.l)} · <strong>${m.payment}:</strong> ${psLabel(m, o.payment_status)}</p>
  <p class="small muted">${m.deliveryTo}: ${o.delivery_to} · ${m.providerRef}: ${o.provider_order_ref} · ${m.placed}: ${dt(o.placed_at, r.l)}</p>
  ${o.eta_estimate_at && !o.is_final ? html`<p class="small">${m.eta}: ${dt(o.eta_estimate_at, r.l)}. ${m.etaNote}</p>` : ''}
</div>
${!o.is_final ? html`<form method="post" action="/app/orders/${o.order_id}/cancel" style="margin-top:16px">${csrfField(r.s)}<button class="btn secondary" type="submit">${m.cancelOrder}</button></form>` : ''}`, { narrow: true });
  });

  app.post('/app/orders/:id/cancel', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const id = (req.params as any).id;
    if (!UUID_RE.test(id)) return notFound(reply, r);
    try {
      const c = await prepareCancellation(ctx, { userId: r.s.user.id, via: 'web' }, id);
      return reply.redirect(`/confirm-cancel/${c.id}`);
    } catch (e) {
      return send(reply, r, r.m.cancelOrder, html`${errorBox(e)}<p><a href="/app/orders/${id}">${r.m.back}</a></p>`, { narrow: true, status: 409 });
    }
  });

  // ---------------- Order confirmation (the human approval step) ----------------
  app.get('/confirm/:id', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    const id = (req.params as any).id;
    if (!UUID_RE.test(id)) return notFound(reply, r);
    return renderConfirm(req, reply, r, id);
  });

  async function renderConfirm(_req: FastifyRequest, reply: FastifyReply, r: R & { s: WebSession }, id: string, flash?: SafeHtml, status = 200) {
    const m = r.m;
    let v;
    try {
      v = await checkoutView(ctx, r.s.user.id, id, r.l);
    } catch (e) {
      if (isDomainError(e) && e.code === 'NOT_FOUND') return notFound(reply, r);
      throw e;
    }
    const c = v.checkout;
    const b = v.breakdown;
    let clientName = r.l === 'ru' ? 'ваш ассистент' : 'your assistant';
    if (c.created_by.startsWith('mcp:')) {
      const g = await ctx.db.query('SELECT client_name FROM oauth_clients WHERE client_id=$1', [c.created_by.slice(4)]);
      if (g.rows[0]) clientName = `${g.rows[0].client_name}; ${r.l === 'ru' ? 'имя указал сам клиент' : 'name set by the client itself'}`;
    }
    const state = (() => {
      if (v.attempt) {
        const a = v.attempt;
        if (a.status === 'accepted') return html`<p class="notice ok" role="status">${m.submittedOk} ${v.order ? html`<a href="/app/orders/${v.order.id}">${m.viewOrder}</a>` : ''}</p>`;
        if (a.status === 'in_flight') return html`<p class="notice warn" role="status">${m.submissionInFlight}</p>`;
        if (a.status === 'unknown') return html`<p class="notice warn" role="alert">${m.submissionUnknown}</p>`;
        return html`<p class="notice bad" role="alert">${fmt(m.submissionRejected, { reason: a.error_code ?? '' })}</p>`;
      }
      if (c.status === 'expired') return html`<p class="notice bad" role="alert">${m.confirmExpired}</p>`;
      if (c.status === 'invalidated') return html`<p class="notice bad" role="alert">${fmt(m.confirmInvalid, { reason: (m as any)[`reason_${c.invalid_reason}`] ?? c.invalid_reason ?? '' })}</p>`;
      if (c.status === 'declined') return html`<p class="notice" role="status">${m.confirmDeclined}</p>`;
      return null;
    })();
    const actionable = c.status === 'awaiting_user' || (c.status === 'approved' && !v.attempt);
    const line = (label: string, mm: { amount_minor: number; formatted: string }, always = false) => (always || mm.amount_minor !== 0 ? html`<tr><td>${label}</td><td class="num">${mm.formatted}</td></tr>` : '');
    return send(reply, r, m.confirmTitle, html`<h1>${m.confirmTitle}</h1>
<p class="lead">${m.confirmLead} <span class="small">(${clientName})</span></p>
${c.mode === 'demo' ? html`<p class="notice warn">${m.confirmDemoNote}</p>` : ''}
${flash ?? ''}${state ?? ''}
<div class="card stack">
  <h2 style="margin:0">${v.restaurant_name}</h2>
  <table class="lines"><tbody>
    ${v.lines.map((l: any) => html`<tr><td>${l.quantity}× ${l.name}${l.modifiers_desc?.length ? html`<br><span class="small muted">${l.modifiers_desc.join(', ')}</span>` : ''}</td><td class="num">${formatMinor(l.line_total_minor, c.currency, r.l)}</td></tr>`)}
    ${line(m.subtotal, b.items_subtotal, true)}${line(m.deliveryFee, b.delivery_fee, true)}${line(m.serviceFee, b.service_fee)}${line(m.smallOrderFee, b.small_order_fee)}${line(m.discount, b.discount)}
    <tr class="total"><td>${m.total}</td><td class="num">${b.total.formatted}</td></tr>
  </tbody></table>
  <p><strong>${m.deliveryTo}:</strong> ${v.address ? `${v.address.label}: ${v.address.line1}, ${v.address.district}, ${v.address.city}` : '-'}</p>
  <p><strong>${m.paymentMethod}:</strong> ${c.payment_method_label}</p>
  <p><strong>${m.cancelTerms}:</strong> ${c.cancellation_terms}</p>
  <p class="small">${m.eta}: ${v.eta.min}–${v.eta.max} ${r.l === 'ru' ? 'мин' : 'min'}. ${m.etaNote}</p>
  <p class="small muted">${fmt(m.priceSource, { src: v.price_source, time: dt(v.quote_fetched_at, r.l) })}</p>
  ${actionable ? html`<p class="small"><strong>${fmt(m.validUntil, { time: dt(c.expires_at, r.l) })}</strong></p>` : ''}
</div>
${actionable ? html`<div class="stack" style="margin-top:16px">
  <form method="post" action="/confirm/${c.id}">${csrfField(r.s)}<input type="hidden" name="total_minor" value="${c.total_minor}">
    <button class="btn block" type="submit">${fmt(m.confirmBtn, { total: b.total.formatted })}</button></form>
  <form method="post" action="/confirm/${c.id}/decline">${csrfField(r.s)}<button class="btn secondary block" type="submit">${m.declineBtn}</button></form>
</div>` : ''}`, { narrow: true, status });
  }

  app.post('/confirm/:id', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const id = (req.params as any).id;
    if (!UUID_RE.test(id)) return notFound(reply, r);
    // The page shows a total; if the server-side total differs from what the user saw, refuse.
    const seen = Number((req.body as any)?.total_minor);
    try {
      const v = await checkoutView(ctx, r.s.user.id, id);
      if (!Number.isSafeInteger(seen) || seen !== Number(v.checkout.total_minor)) throw new DomainError('PRICE_CHANGED', 'The total changed; please review again.');
      await approveCheckout(ctx, r.s.user.id, id);
      await submitOrder(ctx, { userId: r.s.user.id, via: 'web' }, id);
      return reply.redirect(`/confirm/${id}`);
    } catch (e) {
      if (isDomainError(e) && e.code === 'NOT_FOUND') return notFound(reply, r);
      if (isDomainError(e) && e.code === 'SUBMISSION_UNKNOWN') return reply.redirect(`/confirm/${id}`);
      return renderConfirm(req, reply, r, id, errorBox(e), 409);
    }
  });

  app.post('/confirm/:id/decline', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const id = (req.params as any).id;
    if (!UUID_RE.test(id)) return notFound(reply, r);
    await declineCheckout(ctx, r.s.user.id, id).catch(() => undefined);
    return reply.redirect(`/confirm/${id}`);
  });

  // ---------------- Cancellation confirmation ----------------
  async function renderCancel(reply: FastifyReply, r: R & { s: WebSession }, id: string, flash?: SafeHtml, status = 200) {
    const m = r.m;
    let c;
    try {
      c = await loadCancellation(ctx.db, r.s.user.id, id);
    } catch {
      return notFound(reply, r);
    }
    const o = describeOrder(await loadOrder(ctx.db, r.s.user.id, c.order_id), r.l);
    const res: Record<string, SafeHtml> = {
      executed: html`<p class="notice ok" role="status">${m.cancelDone}</p>`,
      rejected: html`<p class="notice bad" role="alert">${m.cancelRejected}</p>`,
      unknown: html`<p class="notice warn" role="alert">${m.cancelUnknown}</p>`,
      expired: html`<p class="notice bad" role="alert">${m.confirmExpired}</p>`,
      invalidated: html`<p class="notice bad" role="alert">${fmt(m.confirmInvalid, { reason: m.reason_PRICE_CHANGED })}</p>`,
    };
    return send(reply, r, m.cancelConfirmTitle, html`<h1>${m.cancelConfirmTitle}</h1>${flash ?? ''}${res[c.status] ?? ''}
<div class="card stack"><h2 style="margin:0">${o.restaurant}</h2>
<p>${o.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')} · ${o.total.formatted}</p>
<p><strong>${m.cancelFee}:</strong> ${money(Number(c.fee_minor), c.currency, r.l).formatted}</p>
<p>${c.terms}</p>
${c.status === 'awaiting_user' ? html`<p class="small"><strong>${fmt(m.validUntil, { time: dt(c.expires_at, r.l) })}</strong></p>` : ''}</div>
${c.status === 'awaiting_user' ? html`<div class="stack" style="margin-top:16px">
<form method="post" action="/confirm-cancel/${c.id}">${csrfField(r.s)}<input type="hidden" name="fee_minor" value="${c.fee_minor}"><button class="btn danger block" type="submit">${m.cancelConfirmBtn}</button></form>
<a class="btn secondary block" href="/app/orders/${c.order_id}">${m.keepOrder}</a></div>` : html`<p><a href="/app/orders/${c.order_id}">${m.viewOrder}</a></p>`}`, { narrow: true, status });
  }

  app.get('/confirm-cancel/:id', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    const id = (req.params as any).id;
    if (!UUID_RE.test(id)) return notFound(reply, r);
    return renderCancel(reply, r, id);
  });
  app.post('/confirm-cancel/:id', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const id = (req.params as any).id;
    if (!UUID_RE.test(id)) return notFound(reply, r);
    try {
      const c = await loadCancellation(ctx.db, r.s.user.id, id);
      if (Number((req.body as any)?.fee_minor) !== Number(c.fee_minor)) throw new DomainError('PRICE_CHANGED', 'The fee changed; please review again.');
      await approveCancellation(ctx, r.s.user.id, id);
      await cancelOrder(ctx, { userId: r.s.user.id, via: 'web' }, id);
      return reply.redirect(`/confirm-cancel/${id}`);
    } catch (e) {
      if (isDomainError(e) && e.code === 'NOT_FOUND') return notFound(reply, r);
      return renderCancel(reply, r, id, errorBox(e), 409);
    }
  });

  // ---------------- Connections & data ----------------
  app.get('/app/connections', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    const m = r.m;
    const grants = (await ctx.db.query('SELECT * FROM oauth_grants WHERE user_id=$1 ORDER BY created_at DESC', [r.s.user.id])).rows;
    const scopeName = (s: string) => (m as any)[`scope_${s.replace(':', '_')}`] ?? s;
    const u = r.s.user;
    return send(reply, r, m.connectionsTitle, html`<h1>${m.connectionsTitle}</h1>
<h2>${m.aiClients}</h2>
${grants.length ? html`<ul class="list card">${grants.map((g: any) => html`<li><span><strong>${g.client_name}</strong> ${g.revoked_at ? html`<span class="pill bad">${m.revoked}</span>` : ''}<br>
<span class="small muted">${m.scopes}: ${g.scopes.map(scopeName).join('; ')}</span><br>
<span class="small muted">${m.lastUsed}: ${g.last_used_at ? dt(g.last_used_at, r.l) : '-'}</span></span>
${g.revoked_at ? '' : html`<form method="post" action="/app/connections/${g.id}/revoke">${csrfField(r.s)}<button class="btn secondary" type="submit">${m.revoke}</button></form>`}</li>`)}</ul>` : html`<p class="muted">${m.noClients} <a href="/connect">${m.connectTitle}</a></p>`}
<h2>${m.providers}</h2>
<div class="card"><p><strong>${{ demo: m.modeDemo, handoff: m.modeHandoff, live: m.modeLive }[u.mode]}</strong></p><p class="muted">${{ demo: m.providerDemo, handoff: m.providerHandoff, live: m.providerLive }[u.mode]}</p><a href="/app/mode">${m.modeTitle}</a></div>`, { narrow: true });
  });
  app.post('/app/connections/:id/revoke', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    const id = (req.params as any).id;
    if (UUID_RE.test(id)) await revokeGrantForUser(ctx, r.s.user.id, id);
    return reply.redirect('/app/connections');
  });

  app.get('/app/data', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    const m = r.m;
    const pks = await listPasskeys(ctx, r.s.user.id);
    const added = (req.query as any)?.passkey === 'added';
    return send(reply, r, m.dataTitle, html`<h1>${m.dataTitle}</h1>
<h2>${m.passkeysTitle}</h2>${added ? html`<p class="notice ok" role="status">${m.pkAdded}</p>` : ''}
${pks.length ? html`<ul class="list card">${pks.map((p: any) => html`<li><span><strong>${p.label || (p.device_type === 'multiDevice' ? 'Synced passkey' : 'Device passkey')}</strong><br><span class="small muted">${dt(p.created_at, r.l)}${p.last_used_at ? html` · ${m.lastUsed}: ${dt(p.last_used_at, r.l)}` : ''}</span></span>
${pks.length > 1 ? html`<form method="post" action="/app/passkeys/delete">${csrfField(r.s)}<input type="hidden" name="id" value="${p.id}"><button class="btn secondary" type="submit">${m.delete}</button></form>` : ''}</li>`)}</ul>` : html`<p class="muted">${m.noPasskeys}</p>`}
<div class="stack" id="pk-add-box" data-csrf="${r.s.csrf}" ${pkData(r)}><button class="btn secondary" type="button" id="pk-add">${m.addPasskey}</button><p class="small muted" id="pk-add-status" role="status" aria-live="polite"></p></div>
<h2>${m.exportData}</h2><p class="lead">${m.dataLead} <a href="/privacy">${m.footerPrivacy}</a></p>
<p><a class="btn secondary" href="/app/data/export">${m.exportData}</a></p>
<h2>${m.deleteAccount}</h2>
<form method="post" action="/app/data/delete" class="card stack">${csrfField(r.s)}
  <div class="field"><label for="confirm">${m.deleteConfirm}</label><input id="confirm" name="confirm" type="text" required autocomplete="off"></div>
  <button class="btn danger" type="submit">${m.deleteAccount}</button></form>`, { narrow: true });
  });
  app.post('/app/passkeys/delete', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    await deletePasskey(ctx, r.s.user.id, String((req.body as any)?.id ?? '')).catch(() => undefined);
    return reply.redirect('/app/data');
  });
  app.get('/app/data/export', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    const data = await exportUserData(ctx.db, r.s.user.id);
    return reply.header('content-type', 'application/json').header('content-disposition', 'attachment; filename="unyly-export.json"').header('cache-control', 'no-store').send(JSON.stringify(data, null, 2));
  });
  app.post('/app/data/delete', async (req, reply) => {
    const r = await authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    if ((req.body as any)?.confirm !== 'DELETE') return reply.redirect('/app/data');
    await deleteAccount(ctx, r.s.user.id);
    await logout(ctx, reply, null);
    return send(reply, { s: null, l: r.l, m: r.m }, r.m.deleted, html`<h1>${r.m.deleted}</h1><p><a href="/">unyly.org</a></p>`, { narrow: true });
  });

  function notFound(reply: FastifyReply, r: R) {
    return send(reply, r, r.m.notFound, html`<h1>${r.m.notFound}</h1><p><a href="/">${r.m.back}</a></p>`, { narrow: true, status: 404 });
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/mcp') || req.url.startsWith('/oauth') || req.url.startsWith('/.well-known') || req.url.startsWith('/webhooks')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const r = await base(req, reply);
    return notFound(reply, r);
  });
}
