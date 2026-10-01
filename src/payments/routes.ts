// GrabPay routes. All answer 404 while GRABPAY is off.
//   GET  /pay/grab/start/:checkoutId?total_minor=  owner of an awaiting_user or approved checkout (Live: approved only) -> 302 to Grab
//   GET  /pay/grab/callback?code&state | ?error&state  Grab redirect back (registered redirect URI); a paid order -> 303 to the order
//   GET  /pay/grab/payments/:id                    owner: re-check a pending payment (status endpoint)
//   POST /webhooks/grabpay                         Grab -> Unyly, request HMAC, idempotent
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { loadSession, WebSession } from '../auth/session.js';
import { UUID_RE } from '../domain/crypto.js';
import { isDomainError } from '../domain/errors.js';
import { formatMinor } from '../domain/money.js';
import { html, SafeHtml } from '../web/html.js';
import { page } from '../web/layout.js';
import { Locale, tr } from '../web/messages.js';
import { detectLocale } from '../web/routes.js';
import { CallbackResult, getPayment, handleCallback, handleGrabPayWebhook, reconcile, startPayment } from './service.js';

const T = {
  paidTitle: { ru: 'Оплата получена', en: 'Payment received', th: 'ได้รับการชำระเงินแล้ว' },
  paidBody: { ru: 'GrabPay подтвердил оплату {amount}. Мы оформляем заказ.', en: 'GrabPay confirmed your payment of {amount}. We are placing your order.', th: 'GrabPay ยืนยันการชำระเงิน {amount} แล้ว เรากำลังส่งคำสั่งซื้อของคุณ' },
  pendingTitle: { ru: 'Проверяем оплату', en: 'Checking the payment', th: 'กำลังตรวจสอบการชำระเงิน' },
  pendingBody: { ru: 'Мы уточняем статус оплаты в GrabPay. Не платите повторно. Проверьте ещё раз через пару минут.', en: 'We are confirming the payment with GrabPay. Do not pay again. Check again in a couple of minutes.', th: 'เรากำลังยืนยันการชำระเงินกับ GrabPay อย่าชำระซ้ำ โปรดตรวจสอบอีกครั้งในอีกสองสามนาที' },
  checkAgain: { ru: 'Проверить снова', en: 'Check again', th: 'ตรวจสอบอีกครั้ง' },
  failedTitle: { ru: 'Оплата не прошла', en: 'Payment not completed', th: 'การชำระเงินไม่สำเร็จ' },
  failedBody: { ru: 'Деньги не списаны. Если GrabPay зарезервировал сумму, резерв снимется автоматически. Можно вернуться к заказу и попробовать снова.', en: 'You were not charged. If GrabPay reserved the amount, the hold is released automatically. You can go back to the order and try again.', th: 'ไม่มีการตัดเงิน หาก GrabPay กันยอดไว้ ยอดนั้นจะถูกปล่อยคืนโดยอัตโนมัติ คุณกลับไปที่คำสั่งซื้อและลองอีกครั้งได้' },
  cancelledBody: { ru: 'Вы отменили оплату в Grab. Деньги не списаны.', en: 'You cancelled the payment in Grab. You were not charged.', th: 'คุณยกเลิกการชำระเงินใน Grab แล้ว ไม่มีการตัดเงิน' },
  backToOrder: { ru: 'Вернуться к заказу', en: 'Back to the order', th: 'กลับไปที่คำสั่งซื้อ' },
  errorTitle: { ru: 'Оплата недоступна', en: 'Payment unavailable', th: 'ไม่สามารถชำระเงินได้' },
  crossSite: { ru: 'Откройте оплату со страницы подтверждения Unyly.', en: 'Start the payment from the Unyly confirmation page.', th: 'โปรดเริ่มการชำระเงินจากหน้ายืนยันของ Unyly' },
  amountMissing: { ru: 'Не указана сумма, которую вы видели. Вернитесь к подтверждению заказа.', en: 'The amount you saw is missing. Go back to the order confirmation.', th: 'ไม่มีจำนวนเงินที่คุณเห็น โปรดกลับไปที่หน้ายืนยันคำสั่งซื้อ' },
  notFound: { ru: 'Платёж не найден.', en: 'Payment not found.', th: 'ไม่พบการชำระเงิน' },
};

const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store').header('content-type', 'text/html; charset=utf-8');

function view(reply: FastifyReply, s: WebSession, l: Locale, path: string, title: string, body: SafeHtml, status = 200) {
  return noStore(reply).code(status).send(page({ title, locale: l, body, loggedIn: true, guest: !!s.user.is_guest, mode: s.user.mode ?? null, csrf: s.csrf, narrow: true, noindex: true, path }));
}

function resultBody(l: Locale, r: CallbackResult): { title: string; body: SafeHtml } {
  const back = r.checkoutId ? html`<p><a class="btn" href="/confirm/${r.checkoutId}">${tr(l, T.backToOrder)}</a></p>` : '';
  if (r.outcome === 'captured') {
    const amount = (() => {
      try {
        return formatMinor(r.amountMinor, r.currency, l);
      } catch {
        return `${(r.amountMinor / 100).toFixed(2)} ${r.currency}`;
      }
    })();
    return { title: tr(l, T.paidTitle), body: html`<h1>${tr(l, T.paidTitle)}</h1><div class="notice ok" role="status">${tr(l, T.paidBody).replace('{amount}', amount)}</div>${back}` };
  }
  if (r.outcome === 'pending') {
    return { title: tr(l, T.pendingTitle), body: html`<h1>${tr(l, T.pendingTitle)}</h1><p class="notice warn" role="status">${tr(l, T.pendingBody)}</p><p><a class="btn secondary" href="/pay/grab/payments/${r.paymentId}">${tr(l, T.checkAgain)}</a></p>${back}` };
  }
  const text = r.reason === 'user_canceled' ? tr(l, T.cancelledBody) : tr(l, T.failedBody);
  return { title: tr(l, T.failedTitle), body: html`<h1>${tr(l, T.failedTitle)}</h1><p class="notice bad" role="alert">${text}</p>${back}` };
}

/** Registers the GrabPay routes. Call once from buildApp. */
export async function registerGrabPayRoutes(app: FastifyInstance, ctx: Ctx) {
  const on = () => !!ctx.cfg.grabpay?.enabled;

  async function session(req: FastifyRequest, reply: FastifyReply): Promise<{ s: WebSession; l: Locale } | null> {
    const s = await loadSession(ctx, req);
    if (!s) {
      reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
      return null;
    }
    return { s, l: detectLocale(req, s) };
  }

  /**
   * Where a paid order continues: its order page once the order exists, else (Live orders, which are
   * submitted right after capture) the confirmation page, which shows "placing", a rejection with its
   * refund, or the unknown outcome. Other payments keep the payment result page.
   */
  async function afterPayment(userId: string, r: CallbackResult): Promise<string | null> {
    if (r.outcome !== 'captured' || !r.checkoutId) return null;
    const o = (await ctx.db.query('SELECT id FROM orders WHERE checkout_id = $1 AND user_id = $2', [r.checkoutId, userId])).rows[0];
    if (o) return `/app/orders/${o.id}?placed=1`;
    const c = (await ctx.db.query('SELECT mode FROM checkouts WHERE id = $1 AND user_id = $2', [r.checkoutId, userId])).rows[0];
    return c?.mode === 'live' ? `/confirm/${r.checkoutId}` : null;
  }

  const errorPage = (reply: FastifyReply, s: WebSession, l: Locale, path: string, e: unknown, back?: string) => {
    if (isDomainError(e) && e.code === 'NOT_FOUND') return reply.callNotFound();
    const status = isDomainError(e) ? e.httpStatus : 500;
    const msgText = isDomainError(e) ? e.message : 'Unexpected error';
    if (!isDomainError(e)) reply.log?.error?.(e);
    return view(reply, s, l, path, tr(l, T.errorTitle), html`<h1>${tr(l, T.errorTitle)}</h1><p class="notice bad" role="alert">${msgText}</p>${back ? html`<p><a class="btn" href="${back}">${tr(l, T.backToOrder)}</a></p>` : ''}`, status);
  };

  app.get('/pay/grab/start/:checkoutId', async (req, reply) => {
    if (!on()) return reply.callNotFound();
    const id = String((req.params as any).checkoutId ?? '');
    if (!UUID_RE.test(id)) return reply.callNotFound();
    const sl = await session(req, reply);
    if (!sl) return;
    const { s, l } = sl;
    const path = '/pay/grab/start';
    // Starting a payment from another site would be a login-CSRF style nudge into Grab's consent page.
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return view(reply, s, l, path, tr(l, T.errorTitle), html`<h1>${tr(l, T.errorTitle)}</h1><p class="notice warn">${tr(l, T.crossSite)}</p><p><a class="btn" href="/confirm/${id}">${tr(l, T.backToOrder)}</a></p>`, 403);
    }
    const raw = (req.query as any)?.total_minor;
    const seen = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(seen)) {
      return view(reply, s, l, path, tr(l, T.errorTitle), html`<h1>${tr(l, T.errorTitle)}</h1><p class="notice bad">${tr(l, T.amountMissing)}</p><p><a class="btn" href="/confirm/${id}">${tr(l, T.backToOrder)}</a></p>`, 400);
    }
    try {
      const r = await startPayment(ctx, s.user.id, id, { expectedAmountMinor: seen });
      return reply.header('cache-control', 'no-store').redirect(r.redirectUrl ?? `/confirm/${id}`);
    } catch (e) {
      return errorPage(reply, s, l, path, e, `/confirm/${id}`);
    }
  });

  app.get('/pay/grab/callback', async (req, reply) => {
    if (!on()) return reply.callNotFound();
    const sl = await session(req, reply);
    if (!sl) return;
    const { s, l } = sl;
    const q = (req.query ?? {}) as Record<string, unknown>;
    try {
      const r = await handleCallback(ctx, s.user.id, { code: q.code, state: q.state, error: q.error });
      const next = await afterPayment(s.user.id, r);
      if (next) return reply.code(303).header('cache-control', 'no-store').redirect(next);
      const v = resultBody(l, r);
      return view(reply, s, l, '/pay/grab/callback', v.title, v.body);
    } catch (e) {
      return errorPage(reply, s, l, '/pay/grab/callback', e);
    }
  });

  app.get('/pay/grab/payments/:id', async (req, reply) => {
    if (!on()) return reply.callNotFound();
    const id = String((req.params as any).id ?? '');
    if (!UUID_RE.test(id)) return reply.callNotFound();
    const sl = await session(req, reply);
    if (!sl) return;
    const { s, l } = sl;
    try {
      const p0 = await getPayment(ctx, s.user.id, id);
      const p = await reconcile(ctx, p0.id); // at most one Grab status poll per 2 minutes
      const outcome = ['captured', 'refunding', 'refunded'].includes(p.status) ? 'captured' : p.status === 'failed' ? 'failed' : 'pending';
      const res: CallbackResult = { outcome, paymentId: p.id, checkoutId: p.checkout_id, amountMinor: Number(p.amount_minor), currency: p.currency, reason: p.grab_reason ?? undefined };
      const next = await afterPayment(s.user.id, res);
      if (next) return reply.code(303).header('cache-control', 'no-store').redirect(next);
      const v = resultBody(l, res);
      return view(reply, s, l, '/pay/grab/payments', v.title, v.body);
    } catch (e) {
      return errorPage(reply, s, l, '/pay/grab/payments', e);
    }
  });

  // Webhook: raw body (the signature covers the exact bytes), own content-type parser scope.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/grabpay', async (req, reply) => {
      if (!on()) return reply.code(404).send({ error: 'not_found' });
      try {
        const r = await handleGrabPayWebhook(ctx, { path: req.url, headers: req.headers as any, rawBody: String(req.body ?? '') });
        return reply.send({ ok: true, ...r });
      } catch (e) {
        if (isDomainError(e) && e.code === 'AUTH_REQUIRED') return reply.code(401).send({ ok: false, error: 'invalid_signature' });
        if (isDomainError(e) && e.code === 'VALIDATION_FAILED') return reply.code(400).send({ ok: false, error: 'invalid_payload' });
        throw e;
      }
    });
  });
}
