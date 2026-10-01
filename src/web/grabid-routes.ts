// Login with Grab: web routes and the small UI pieces used by /login and /app/data.
// Registered only when GRABID=on, so with the feature off every /auth/grab/* URL is a plain 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { isDomainError } from '../domain/errors.js';
import { checkCsrf, safeNext, setSessionCookie } from '../auth/session.js';
import { completeGrabAuth, getGrabIdentity, GRAB_STATE_COOKIE, GrabRefusal, startGrabAuth, unlinkGrab } from '../auth/grabid.js';
import { icon } from './art.js';
import { html, SafeHtml } from './html.js';
import { tr } from './messages.js';
import type { Kit, R } from './routes.js';

const T = {
  continue: { ru: 'Продолжить с Grab', en: 'Continue with Grab', th: 'ดำเนินการต่อด้วย Grab' },
  title: { ru: 'Вход через Grab', en: 'Sign in with Grab', th: 'ลงชื่อเข้าใช้ด้วย Grab' },
  section: { ru: 'Аккаунт Grab', en: 'Grab account', th: 'บัญชี Grab' },
  sectionLead: {
    ru: 'Входите в Unyly через свой аккаунт Grab. Мы получаем только идентификатор, имя и email; пароль Grab и токены не хранятся.',
    en: 'Sign in to Unyly with your Grab account. We receive only an identifier, name and email; no Grab password or tokens are stored.',
    th: 'ลงชื่อเข้าใช้ Unyly ด้วยบัญชี Grab ของคุณ เราได้รับเพียงรหัสระบุตัวตน ชื่อ และอีเมล ไม่มีการเก็บรหัสผ่านหรือโทเคนของ Grab',
  },
  connect: { ru: 'Подключить аккаунт Grab', en: 'Connect Grab account', th: 'เชื่อมต่อบัญชี Grab' },
  disconnect: { ru: 'Отключить', en: 'Disconnect', th: 'ยกเลิกการเชื่อมต่อ' },
  connected: { ru: 'Аккаунт Grab подключён', en: 'Grab account connected', th: 'เชื่อมต่อบัญชี Grab แล้ว' },
  connectedSince: { ru: 'Подключён', en: 'Connected', th: 'เชื่อมต่อเมื่อ' },
  linkedOk: { ru: 'Аккаунт Grab подключён. Теперь можно входить через Grab.', en: 'Grab account connected. You can now sign in with Grab.', th: 'เชื่อมต่อบัญชี Grab แล้ว ตอนนี้ลงชื่อเข้าใช้ด้วย Grab ได้' },
  unlinkedOk: { ru: 'Аккаунт Grab отключён.', en: 'Grab account disconnected.', th: 'ยกเลิกการเชื่อมต่อบัญชี Grab แล้ว' },
  backLogin: { ru: 'Вернуться ко входу', en: 'Back to sign-in', th: 'กลับไปหน้าลงชื่อเข้าใช้' },
  backData: { ru: 'Вернуться к настройкам', en: 'Back to settings', th: 'กลับไปที่การตั้งค่า' },
  failed: { ru: 'Не удалось войти через Grab. Попробуйте ещё раз.', en: 'Grab sign-in failed. Please try again.', th: 'ลงชื่อเข้าใช้ด้วย Grab ไม่สำเร็จ โปรดลองอีกครั้ง' },
} as const;

const REFUSAL: Record<GrabRefusal, { ru: string; en: string; th: string }> = {
  cancelled: { ru: 'Вход через Grab отменён.', en: 'Grab sign-in was cancelled.', th: 'ยกเลิกการลงชื่อเข้าใช้ด้วย Grab แล้ว' },
  bad_state: {
    ru: 'Запрос входа устарел или открыт в другом браузере. Начните заново.',
    en: 'The sign-in request expired or was opened in another browser. Please start again.',
    th: 'คำขอลงชื่อเข้าใช้หมดอายุหรือถูกเปิดในเบราว์เซอร์อื่น โปรดเริ่มใหม่',
  },
  session_changed: {
    ru: 'Вы вышли или сменили аккаунт во время подключения. Войдите и подключите Grab ещё раз.',
    en: 'You signed out or switched accounts while connecting. Sign in and connect Grab again.',
    th: 'คุณออกจากระบบหรือเปลี่ยนบัญชีระหว่างการเชื่อมต่อ โปรดลงชื่อเข้าใช้แล้วเชื่อมต่อ Grab อีกครั้ง',
  },
  linked_elsewhere: {
    ru: 'Этот аккаунт Grab уже подключён к другому аккаунту Unyly.',
    en: 'This Grab account is already connected to another Unyly account.',
    th: 'บัญชี Grab นี้เชื่อมต่อกับบัญชี Unyly อื่นอยู่แล้ว',
  },
  already_has_grab: {
    ru: 'К вашему аккаунту уже подключён другой аккаунт Grab. Сначала отключите его.',
    en: 'Another Grab account is already connected to your account. Disconnect it first.',
    th: 'บัญชีของคุณเชื่อมต่อกับบัญชี Grab อื่นอยู่แล้ว โปรดยกเลิกการเชื่อมต่อก่อน',
  },
  email_exists: {
    ru: 'Аккаунт Unyly с этим email уже есть. Войдите обычным способом (passkey или код из письма), затем подключите Grab в разделе «Данные».',
    en: 'An Unyly account with this email already exists. Sign in with your usual method (passkey or email code), then connect Grab under Data.',
    th: 'มีบัญชี Unyly ที่ใช้อีเมลนี้อยู่แล้ว โปรดลงชื่อเข้าใช้ด้วยวิธีเดิม (พาสคีย์หรือรหัสทางอีเมล) แล้วเชื่อมต่อ Grab ในหน้าข้อมูล',
  },
  no_verified_email: {
    ru: 'Grab не передал подтверждённый email, поэтому новый аккаунт создать нельзя. Создайте аккаунт с passkey или кодом из письма, затем подключите Grab в разделе «Данные».',
    en: 'Grab did not share a verified email, so a new account cannot be created. Create an account with a passkey or an email code, then connect Grab under Data.',
    th: 'Grab ไม่ได้ส่งอีเมลที่ยืนยันแล้ว จึงสร้างบัญชีใหม่ไม่ได้ โปรดสร้างบัญชีด้วยพาสคีย์หรือรหัสทางอีเมล แล้วเชื่อมต่อ Grab ในหน้าข้อมูล',
  },
};

const enabled = (ctx: Ctx) => ctx.cfg.grabId.enabled;

/** "Continue with Grab" on /login. Plain text button with a neutral icon: no Grab logo or brand colours. */
export function grabLoginButton(ctx: Ctx, r: R, next: string): SafeHtml | '' {
  if (!enabled(ctx)) return '';
  return html`<p style="margin-top:12px"><a class="btn secondary block" id="grab-login" href="/auth/grab/start?next=${encodeURIComponent(next)}" rel="nofollow">${icon('arrow')} ${tr(r.l, T.continue)}</a></p>`;
}

/** Connect / disconnect block for /app/data (signed-in, non-guest users only). */
export async function grabAccountSection(ctx: Ctx, r: R, csrf: SafeHtml, query: unknown): Promise<SafeHtml | ''> {
  if (!enabled(ctx) || !r.s || r.s.user.is_guest) return '';
  const l = r.l;
  const q = (query ?? {}) as Record<string, unknown>;
  const id = await getGrabIdentity(ctx.db, r.s.user.id);
  const flash = q.grab === 'linked' ? html`<p class="notice ok" role="status">${tr(l, T.linkedOk)}</p>` : q.grab === 'unlinked' ? html`<p class="notice ok" role="status">${tr(l, T.unlinkedOk)}</p>` : '';
  return html`<h2 id="grab">${tr(l, T.section)}</h2>${flash}
<p class="small muted">${tr(l, T.sectionLead)}</p>
${id
    ? html`<ul class="list card"><li><span><strong>${tr(l, T.connected)}</strong><br><span class="small muted">${tr(l, T.connectedSince)}: ${new Date(id.created_at).toISOString().slice(0, 10)}</span></span>
<form method="post" action="/app/grab/unlink">${csrf}<button class="btn secondary" type="submit">${tr(l, T.disconnect)}</button></form></li></ul>`
    : html`<form method="post" action="/auth/grab/link">${csrf}<button class="btn secondary" type="submit">${icon('plug')} ${tr(l, T.connect)}</button></form>`}`;
}

export function registerGrabIdRoutes(app: FastifyInstance, kit: Kit) {
  const { ctx } = kit;
  if (!enabled(ctx)) return;
  const rate = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const stateCookie = (reply: FastifyReply, state: string) =>
    reply.setCookie(GRAB_STATE_COOKIE, state, { httpOnly: true, secure: ctx.cfg.cookieSecure, sameSite: 'lax', path: '/auth/grab', maxAge: 600 });

  const page = (reply: FastifyReply, r: R, body: SafeHtml, status: number) =>
    kit.send(reply, r, tr(r.l, T.title), html`<div class="page-head center"><span class="auth-ico">${icon('lock')}</span><h1>${tr(r.l, T.title)}</h1></div>${body}`, { narrow: true, status });

  // Sign-in. A signed-in user connects Grab from /app/data instead (POST with CSRF token).
  app.get('/auth/grab/start', rate, async (req, reply) => {
    const r = await kit.base(req, reply);
    const next = safeNext((req.query as any)?.next);
    if (r.s && !r.s.user.is_guest) return reply.redirect('/app/data#grab');
    try {
      const { url, state } = await startGrabAuth(ctx, { next, userId: null, locale: r.l });
      stateCookie(reply, state);
      return reply.header('cache-control', 'no-store').redirect(url);
    } catch (e) {
      return page(reply, r, kit.errorBox(e), isDomainError(e) ? e.httpStatus : 500);
    }
  });

  // Connect Grab to the signed-in account (CSRF-protected form on /app/data).
  app.post('/auth/grab/link', rate, async (req, reply) => {
    const r = await kit.authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    if (r.s.user.is_guest) return reply.code(403).send('Guest accounts cannot connect Grab');
    try {
      const { url, state } = await startGrabAuth(ctx, { next: '/app/data', userId: r.s.user.id, locale: r.l });
      stateCookie(reply, state);
      return reply.header('cache-control', 'no-store').redirect(url);
    } catch (e) {
      return page(reply, r, kit.errorBox(e), isDomainError(e) ? e.httpStatus : 500);
    }
  });

  app.get('/auth/grab/callback', rate, async (req: FastifyRequest, reply) => {
    const r = await kit.base(req, reply);
    const q = (req.query ?? {}) as Record<string, unknown>;
    reply.clearCookie(GRAB_STATE_COOKIE, { path: '/auth/grab' });
    reply.header('cache-control', 'no-store');
    try {
      const out = await completeGrabAuth(ctx, {
        state: q.state, cookieState: req.cookies?.[GRAB_STATE_COOKIE], code: q.code, error: q.error,
        session: r.s, locale: r.l,
      });
      if (out.kind === 'login') {
        setSessionCookie(ctx, reply, out.token);
        return reply.redirect(out.isNew ? '/app/mode' : out.next);
      }
      if (out.kind === 'linked') return reply.redirect('/app/data?grab=linked#grab');
      const back = out.linkFlow ? html`<a href="/app/data#grab">${tr(r.l, T.backData)}</a>` : html`<a href="/login">${tr(r.l, T.backLogin)}</a>`;
      const status = out.reason === 'cancelled' ? 200 : out.reason === 'bad_state' || out.reason === 'session_changed' ? 400 : 409;
      return page(reply, r, html`<div class="notice ${out.reason === 'cancelled' ? 'warn' : 'bad'}" role="alert">${tr(r.l, REFUSAL[out.reason])}</div><p>${back}</p>`, status);
    } catch (e) {
      const status = isDomainError(e) ? e.httpStatus : 500;
      if (!isDomainError(e)) console.error('[grabid] callback failed:', (e as Error)?.message ?? e);
      return page(reply, r, html`<div class="notice bad" role="alert">${isDomainError(e) ? e.message : tr(r.l, T.failed)}</div><p><a href="/login">${tr(r.l, T.backLogin)}</a></p>`, status);
    }
  });

  app.post('/app/grab/unlink', rate, async (req, reply) => {
    const r = await kit.authed(req, reply);
    if (!r) return;
    checkCsrf(ctx, req, r.s);
    try {
      await unlinkGrab(ctx, r.s.user.id);
      return reply.redirect('/app/data?grab=unlinked#grab');
    } catch (e) {
      return page(reply, r, html`${kit.errorBox(e)}<p><a href="/app/data#grab">${tr(r.l, T.backData)}</a></p>`, isDomainError(e) ? e.httpStatus : 500);
    }
  });
}

