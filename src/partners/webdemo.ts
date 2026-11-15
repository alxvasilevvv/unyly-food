// The website's live Ari demo (/ari). The browser plays the Ari app; this file plays Ari's backend:
// a tiny rule-based "brain" turns the user's sentence into the same Partner API calls Ari makes
// (tools with cards, native confirmation, order events). Demo mode only: synthetic stores and fares.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.js';
import { hmac, safeEqual, UUID_RE } from '../domain/crypto.js';
import { DomainError, isDomainError } from '../domain/errors.js';
import type { Locale } from '../domain/locales.js';
import { addAddress } from '../services/users.js';
import { detectService, parseIntent } from '../web/intent.js';
import { SHOP_STORE, shopPlan } from '../web/try-services.js';
import { tr } from '../web/messages.js';
import type { Card } from './cards.js';
import { WEB_DEMO_PARTNER } from './config.js';
import {
  cancellationCard, checkoutCard, confirmCancelPartner, confirmCheckout, declineCheckoutPartner, grabLinkStatus, orderCard, prepareCancelPartner, runTool, startGrabLink,
} from './core.js';
import { loadPartnerUser, partnerActor, PartnerUser, upsertPartnerUser } from './users.js';
import { listPartnerEvents } from './webhooks.js';

const P = WEB_DEMO_PARTNER;
const COOKIE = 'ari_demo';
const ALLOWED_TOOLS = new Set(['create_cart', 'update_cart', 'search_stores', 'get_store', 'estimate_trip', 'get_order_status']);

export interface TraceEntry { call: string; grab: string | null; ms: number; ok: boolean }
export interface AriTurn { reply: string; card?: Card | null; chips?: string[]; trace: TraceEntry[] }

type Tri = { en: string; ru: string; th: string };
const t = (l: Locale, x: Tri) => tr(l, x);

/** The Grab API a live deployment would call for the same step. */
function grabFor(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'estimate_trip') return args.service === 'express' ? 'GrabExpress · POST /v1/deliveries/quotes' : 'Grab Farefeed · POST /farefeed/v1/estimate';
  if (tool === 'create_cart' && args.service === 'express') return 'GrabExpress · POST /v1/deliveries/quotes';
  if (tool === 'create_cart' && args.service === 'ride') return 'Grab Farefeed · fare + deep link';
  if (tool === 'search_stores') return 'GrabFood / GrabMart · consumer scope requested from Grab';
  if (tool === 'get_order_status') return 'GrabExpress · GET /v1/deliveries/{id}';
  return null;
}

async function traced<T>(trace: TraceEntry[], call: string, grab: string | null, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    trace.push({ call, grab, ms: Date.now() - t0, ok: (r as any)?.ok !== false });
    return r;
  } catch (e) {
    trace.push({ call, grab, ms: Date.now() - t0, ok: false });
    throw e;
  }
}

const EXAMPLES: Record<'en' | 'ru' | 'th', string[]> = {
  en: ['Taxi from Siam Paragon to Suvarnabhumi airport', 'Dinner for two under 600 baht, no nuts', 'Send a 3 kg parcel to ICONSIAM', 'Red roses with a gift box', 'Paracetamol and plasters', 'Groceries: rice, eggs and water', 'Chocolate cake for a birthday'],
  ru: ['Такси от Сиам Парагона до аэропорта Суварнабхуми', 'Ужин на двоих до 600 бат, без орехов', 'Отправить посылку 3 кг в Айконсиам', 'Букет роз в подарочной коробке', 'Парацетамол и пластыри', 'Продукты: рис, яйца и вода', 'Шоколадный торт на день рождения'],
  th: ['เรียกแท็กซี่จากสยามพารากอนไปสนามบินสุวรรณภูมิ', 'มื้อเย็นสำหรับ 2 คน ไม่เกิน 600 บาท ไม่ใส่ถั่ว', 'ส่งพัสดุ 3 กก ไปไอคอนสยาม', 'ช่อดอกกุหลาบพร้อมกล่องของขวัญ', 'พาราเซตามอลกับพลาสเตอร์', 'ของชำ ข้าวสาร ไข่ไก่ น้ำดื่ม', 'เค้กช็อกโกแลตวันเกิด'],
};
export const ariExamples = (l: Locale) => (EXAMPLES as Record<string, string[]>)[l] ?? EXAMPLES.en;

const GREET = /^(hi|hello|hey|привет|здравств|добр|สวัสดี|หวัดดี)/iu;

/** One user message: decide what Ari would do and run it through the Partner API path. */
export async function ariRespond(ctx: Ctx, u: PartnerUser, text: string): Promise<AriTurn> {
  const l = u.locale;
  const trace: TraceEntry[] = [];
  const base = `/partner/v1/users/${u.external_user_id}`;
  const q = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!q || GREET.test(q)) {
    return {
      reply: t(l, { en: 'Hi! I can order any Grab service for you: a ride, food, groceries, flowers, pharmacy or a parcel. What do you need?', ru: 'Здравствуйте! Я закажу любой сервис Grab: поездку, еду, продукты, цветы, аптеку или посылку. Что нужно?', th: 'สวัสดีค่ะ Ari สั่งบริการ Grab ได้ทุกอย่าง ทั้งเรียกรถ อาหาร ของชำ ดอกไม้ ร้านยา หรือส่งพัสดุ ให้ Ari ช่วยอะไรดีคะ' }),
      chips: ariExamples(l).slice(0, 4), trace,
    };
  }
  const si = detectService(q);
  try {
    if (si.service === 'ride' || si.service === 'express') {
      const addr = (await ctx.db.query(`SELECT label FROM addresses WHERE user_id = $1 AND is_default`, [u.user_id])).rows[0];
      const pickup = si.pickup || addr?.label || '';
      if (!si.dropoff) {
        return { reply: t(l, { en: 'Where to? For example "to Suvarnabhumi airport".', ru: 'Куда едем? Например, «до аэропорта Суварнабхуми».', th: 'ไปที่ไหนคะ เช่น "ไปสนามบินสุวรรณภูมิ"' }), chips: [ariExamples(l)[0]], trace };
      }
      const args: Record<string, unknown> = { service: si.service, pickup, dropoff: si.dropoff };
      if (si.service === 'express') args.parcel_weight_kg = si.weight_kg ?? 2;
      if (si.passengers) args.passengers = si.passengers;
      const r = await traced(trace, `POST ${base}/tools/estimate_trip`, grabFor('estimate_trip', args), () => runTool(ctx, P, u, 'estimate_trip', args));
      if (!r.ok) return errorTurn(l, r.error, trace);
      const res = r.result;
      const from = res.trip?.pickup?.name;
      const to = res.trip?.dropoff?.name;
      const reply = si.service === 'ride'
        ? t(l, { en: `From ${from} to ${to}, about ${res.trip?.drive_minutes_estimate} min. Pick a ride:`, ru: `От ${from} до ${to}, примерно ${res.trip?.drive_minutes_estimate} мин в пути. Выберите машину:`, th: `จาก ${from} ไป ${to} ประมาณ ${res.trip?.drive_minutes_estimate} นาที เลือกประเภทรถได้เลยค่ะ` })
        : t(l, { en: `Parcel ${args.parcel_weight_kg} kg from ${from} to ${to}. Pick a courier:`, ru: `Посылка ${args.parcel_weight_kg} кг от ${from} до ${to}. Выберите курьера:`, th: `พัสดุ ${args.parcel_weight_kg} กก. จาก ${from} ไป ${to} เลือกประเภทการส่งได้เลยค่ะ` });
      return { reply, card: r.card, trace };
    }
    if (si.service === 'food') {
      const intent = parseIntent(q);
      const args: Record<string, unknown> = {
        service: 'food', limit: 3, party_size: intent.party_size ?? 2,
        ...(intent.budget_total_major ? { budget_total_major: intent.budget_total_major } : {}),
        ...(intent.exclude_allergens.length ? { exclude_allergens: intent.exclude_allergens } : {}),
        ...(intent.dietary.length ? { dietary: intent.dietary } : {}),
        ...(intent.cuisine ? { cuisine: intent.cuisine } : {}),
      };
      const r = await traced(trace, `POST ${base}/tools/search_stores`, grabFor('search_stores', args), () => runTool(ctx, P, u, 'search_stores', args));
      if (!r.ok) return errorTurn(l, r.error, trace);
      const n = r.card?.options?.length ?? 0;
      const people = Number(args.party_size);
      const budget = args.budget_total_major ? ` ${t(l, { en: `under ฿${args.budget_total_major}`, ru: `до ${args.budget_total_major} бат`, th: `ไม่เกิน ${args.budget_total_major} บาท` })}` : '';
      const allergy = intent.exclude_allergens.length
        ? t(l, { en: ' Restaurants did not declare the allergens you excluded, but I never mark a dish as safe.', ru: ' Рестораны не заявили исключённые аллергены, но я никогда не называю блюдо безопасным.', th: ' ร้านไม่ได้ระบุสารก่อภูมิแพ้ที่คุณยกเว้น แต่ Ari จะไม่รับรองว่าปลอดภัย' })
        : '';
      const reply = n
        ? t(l, { en: `${n} options for ${people}${budget}.${allergy} Tap one:`, ru: `Вариантов: ${n} (на ${people} чел.${budget}).${allergy} Выберите:`, th: `${n} ตัวเลือกสำหรับ ${people} คน${budget}${allergy} เลือกได้เลยค่ะ` })
        : t(l, { en: 'Nothing matches right now. Try a bigger budget or fewer restrictions.', ru: 'Сейчас ничего не подходит. Попробуйте увеличить бюджет или убрать ограничения.', th: 'ยังไม่มีร้านที่ตรง ลองเพิ่มงบหรือลดเงื่อนไขค่ะ' });
      return { reply, card: r.card, trace };
    }
    // Shops: pick the items from the sentence, then build the cart (one step, like an assistant would).
    const service = si.service as keyof typeof SHOP_STORE;
    const plan = await traced(trace, `POST ${base}/tools/search_stores`, grabFor('search_stores', {}), () => shopPlan(ctx, partnerActor(P, u.user_id), service, q));
    const args = { store_id: plan.store_id, items: plan.lines.map((x) => ({ item_id: x.item_id, quantity: x.quantity, ...(x.modifiers.length ? { modifiers: x.modifiers } : {}) })) };
    const r = await traced(trace, `POST ${base}/tools/create_cart`, grabFor('create_cart', args), () => runTool(ctx, P, u, 'create_cart', args));
    if (!r.ok) return errorTurn(l, r.error, trace);
    const names = plan.lines.map((x) => x.name).join(', ');
    return {
      reply: t(l, { en: `${plan.store_name}: ${names}. Here is the total with every fee. Confirm when ready.`, ru: `${plan.store_name}: ${names}. Вот итог со всеми сборами. Подтвердите, когда будете готовы.`, th: `${plan.store_name}: ${names} นี่คือยอดรวมพร้อมค่าธรรมเนียมทั้งหมด กดยืนยันเมื่อพร้อมค่ะ` }),
      card: r.card, trace,
    };
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return errorTurn(l, { code: e.code, message: e.message, details: e.details }, trace);
  }
}

function errorTurn(l: Locale, err: any, trace: TraceEntry[]): AriTurn {
  const code = err?.code;
  if (code === 'PLACE_NOT_FOUND' || code === 'PLACE_AMBIGUOUS') {
    const sug: string[] = (err.details?.suggestions ?? []).slice(0, 4);
    return {
      reply: code === 'PLACE_AMBIGUOUS'
        ? t(l, { en: 'Which one do you mean?', ru: 'Какое место вы имеете в виду?', th: 'หมายถึงที่ไหนคะ' })
        : t(l, { en: 'I could not find that place on the Bangkok demo map. Try one of these:', ru: 'Не нашла это место на демо-карте Бангкока. Например:', th: 'ไม่พบสถานที่นี้บนแผนที่เดโมกรุงเทพฯ ลองเลือกจากนี้ค่ะ' }),
      chips: sug.map((s) => t(l, { en: `Taxi to ${s}`, ru: `Такси до ${s}`, th: `แท็กซี่ไป ${s}` })), trace,
    };
  }
  return { reply: String(err?.message ?? 'Something went wrong.'), chips: [], trace };
}

// ---------------------------------------------------------------- HTTP

const sealExt = (ctx: Ctx, ext: string) => `${ext}.${hmac(`${ctx.cfg.demoWebhookSecret}:ari-demo`, ext).slice(0, 32)}`;
function openExt(ctx: Ctx, v: string | undefined): string | null {
  if (!v) return null;
  const i = v.lastIndexOf('.');
  if (i < 0) return null;
  const ext = v.slice(0, i);
  return /^web-[0-9a-f-]{36}$/.test(ext) && safeEqual(sealExt(ctx, ext), v) ? ext : null;
}

async function createDemoUser(ctx: Ctx, ip: string, locale: Locale): Promise<PartnerUser> {
  const ipHash = hmac(ctx.cfg.demoWebhookSecret, `guest-ip:${ip}`).slice(0, 32);
  // Count and create under one lock so parallel requests cannot exceed the per-IP and global caps.
  const u = await ctx.db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext('unyly.guest_create'))");
    const c = (await q.query(
      `SELECT count(*)::int total, count(*) FILTER (WHERE guest_ip_hash = $1)::int mine FROM users WHERE is_guest AND created_at > now() - interval '1 hour'`,
      [ipHash],
    )).rows[0];
    if (c.mine >= ctx.cfg.guestPerIpHourly || c.total >= ctx.cfg.guestHourlyLimit) return null;
    // Same lifetime as other demo guests: deleted after 24 hours by the job worker.
    return upsertPartnerUser(ctx, P, `web-${randomUUID()}`, { locale }, { q, guestIpHash: ipHash });
  });
  if (!u) throw new DomainError('RATE_LIMITED', 'The demo is busy right now. Please try again in a few minutes.');
  await addAddress(ctx, u.user_id, {
    label: tr(locale, { ru: 'Дом', en: 'Home', th: 'บ้าน' }), line1: '88 Sukhumvit Soi 24 (demo)', district: 'Watthana', city: 'Bangkok', country: 'TH',
  }, true);
  return u;
}

export function registerAriDemo(app: FastifyInstance, ctx: Ctx, detectLocale: (req: FastifyRequest) => Locale) {
  const guard = (req: FastifyRequest) => {
    // JSON API for our own page only: custom header (forces a CORS preflight cross-site) plus same origin.
    if (req.headers['x-ari-demo'] !== '1') throw new DomainError('AUTH_REQUIRED', 'Cross-site request blocked');
    const origin = req.headers.origin;
    if (origin && origin !== ctx.cfg.webOrigin) throw new DomainError('AUTH_REQUIRED', 'Cross-site request blocked');
  };
  const send = (reply: FastifyReply, data: unknown, status = 200) => reply.code(status).header('cache-control', 'no-store').send(data);
  const fail = (reply: FastifyReply, e: unknown) => {
    const err = isDomainError(e) ? e : new DomainError('INTERNAL', 'Something went wrong. Please try again.');
    if (!isDomainError(e)) console.error('[ari-demo]', e);
    return send(reply, { ok: false, error: { code: err.code, message: err.message, details: err.details } }, err.httpStatus);
  };
  const current = async (req: FastifyRequest): Promise<PartnerUser> => {
    const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
    if (!ext) throw new DomainError('AUTH_REQUIRED', 'Start the demo first.');
    const u = await loadPartnerUser(ctx, P, ext).catch(() => null);
    if (!u) throw new DomainError('AUTH_REQUIRED', 'The demo session ended. Start again.');
    const l = detectLocale(req);
    if (l !== u.locale) {
      await ctx.db.query('UPDATE users SET locale = $2 WHERE id = $1', [u.user_id, l]);
      u.locale = l;
    }
    return u;
  };
  const rl = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.post('/ari/api/session', rl(20), async (req, reply) => {
    try {
      guard(req);
      const l = detectLocale(req);
      let u: PartnerUser | null = null;
      const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
      if (ext) u = await loadPartnerUser(ctx, P, ext).catch(() => null);
      if (!u) {
        u = await createDemoUser(ctx, req.ip, l);
        reply.setCookie(COOKIE, sealExt(ctx, u.external_user_id), { httpOnly: true, secure: ctx.cfg.cookieSecure, sameSite: 'lax', path: '/ari', maxAge: 24 * 3600 });
      }
      const ev = await listPartnerEvents(ctx, u.user_id, 0, 100);
      return send(reply, {
        ok: true, user: { id: u.external_user_id }, grab: await grabLinkStatus(ctx, u), examples: ariExamples(l), last_event: ev.at(-1)?.seq ?? 0,
        greeting: tr(l, { en: 'Hi, I\'m Ari. Tell me what you need from Grab and I\'ll take care of it. Nothing is ordered until you confirm.', ru: 'Здравствуйте, я Ari. Скажите, что нужно от Grab, и я всё сделаю. Ничего не заказывается без вашего подтверждения.', th: 'สวัสดีค่ะ Ari เองค่ะ บอกได้เลยว่าต้องการอะไรจาก Grab ไม่มีการสั่งจนกว่าคุณจะยืนยันค่ะ' }),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/message', rl(40), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const text = String((req.body as any)?.text ?? '');
      return send(reply, { ok: true, ...(await ariRespond(ctx, u, text)) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/action', rl(40), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body ?? {}) as any;
      const name = String(b.tool ?? '');
      if (!ALLOWED_TOOLS.has(name)) throw new DomainError('VALIDATION_FAILED', 'Unknown action');
      const args = b.arguments && typeof b.arguments === 'object' ? b.arguments : {};
      const trace: TraceEntry[] = [];
      const r = await traced(trace, `POST /partner/v1/users/${u.external_user_id}/tools/${name}`, grabFor(name, args), () => runTool(ctx, P, u, name, args));
      if (!r.ok) return send(reply, { ok: true, ...errorTurn(u.locale, r.error, trace) });
      const l = u.locale;
      const reply2 = r.card?.type === 'checkout'
        ? tr(l, { en: 'Here is everything with the final price. Tap Confirm when you are ready.', ru: 'Вот всё с итоговой ценой. Нажмите «Подтвердить», когда будете готовы.', th: 'นี่คือรายละเอียดพร้อมราคาสุดท้าย กดยืนยันเมื่อพร้อมค่ะ' })
        : '';
      return send(reply, { ok: true, reply: reply2, card: r.card, trace });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/confirm', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body ?? {}) as any;
      const id = String(b.checkout_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Checkout not found');
      const trace: TraceEntry[] = [];
      const card = await checkoutCard(ctx, P, u, id);
      const live = card.service === 'express' ? 'GrabPay · charge/init + GrabExpress · POST /v1/deliveries' : card.service === 'ride' ? 'Ride booking scope (requested) · today: Grab deep link' : 'GrabFood / GrabMart order scope (requested)';
      const r = await traced(trace, `POST /partner/v1/users/${u.external_user_id}/checkouts/${id}/confirm`, live, () => confirmCheckout(ctx, P, u, id, {
        confirm_hash: b.confirm_hash, user_verification: 'biometric', confirmed_at: new Date().toISOString(), device_id: 'web-demo',
      }));
      const l = u.locale;
      return send(reply, {
        ok: true,
        reply: tr(l, { en: 'Done! I\'ll keep you posted and call you when it matters.', ru: 'Готово! Я буду сообщать о статусе и позвоню, когда это важно.', th: 'เรียบร้อยค่ะ Ari จะแจ้งสถานะและโทรหาเมื่อถึงเวลาสำคัญ' }),
        card: r.order?.card ?? null, order_id: r.order?.id ?? null, trace,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/decline', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const id = String((req.body as any)?.checkout_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Checkout not found');
      await declineCheckoutPartner(ctx, P, u, id);
      return send(reply, { ok: true, reply: tr(u.locale, { en: 'No problem, nothing was ordered.', ru: 'Хорошо, ничего не заказано.', th: 'ได้ค่ะ ไม่มีการสั่งซื้อ' }), card: await checkoutCard(ctx, P, u, id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/ari/api/orders/:id', rl(120), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const id = String((req.params as any).id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Order not found');
      return send(reply, { ok: true, card: await orderCard(ctx, P, u, id, { refresh: true }) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/ari/api/events', rl(120), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const after = Math.max(Number((req.query as any)?.after ?? 0) || 0, 0);
      return send(reply, { ok: true, events: await listPartnerEvents(ctx, u.user_id, after) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/cancel', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const id = String((req.body as any)?.order_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Order not found');
      const r = await prepareCancelPartner(ctx, P, u, id);
      return send(reply, { ok: true, reply: tr(u.locale, { en: 'Here are the cancellation terms:', ru: 'Условия отмены:', th: 'เงื่อนไขการยกเลิก:' }), card: r.card });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/cancel/confirm', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body ?? {}) as any;
      const id = String(b.cancellation_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Cancellation not found');
      const r = await confirmCancelPartner(ctx, P, u, id, { confirm_hash: b.confirm_hash, user_verification: 'tap', confirmed_at: new Date().toISOString() });
      const done = r.cancellation.status === 'executed';
      return send(reply, {
        ok: true,
        reply: done
          ? tr(u.locale, { en: 'Cancelled.', ru: 'Заказ отменён.', th: 'ยกเลิกแล้วค่ะ' })
          : tr(u.locale, { en: 'The cancellation did not go through; the order continues.', ru: 'Отменить не получилось, заказ продолжается.', th: 'ยกเลิกไม่สำเร็จค่ะ คำสั่งซื้อยังดำเนินต่อ' }),
        card: r.order.card,
        cancel_card: await cancellationCard(ctx, P, u, id),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/grab-link', rl(10), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const r = await startGrabLink(ctx, P, u);
      return send(reply, { ok: true, grab: r });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
