// The website's live Ari demo (/ari). The browser plays the Ari app; this file plays Ari's backend:
// a tiny rule-based "brain" turns the user's sentence into the same Partner API calls Ari makes
// (tools with cards, native confirmation, order events). Demo mode only: synthetic stores and fares.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.js';
import { hmac, safeEqual, UUID_RE } from '../domain/crypto.js';
import { DomainError, isDomainError } from '../domain/errors.js';
import type { Locale } from '../domain/locales.js';
import { addFirstAddress, listAddresses } from '../services/users.js';
import { detectService, hasFoodCue, parseIntent } from '../web/intent.js';
import { SHOP_STORE, shopPlan } from '../web/try-services.js';
import { tr } from '../web/messages.js';
import { Card, cardLocale, localText } from './cards.js';
import { WEB_DEMO_PARTNER } from './config.js';
import {
  cancellationCard, checkoutCard, confirmCancelPartner, confirmCheckout, declineCheckoutPartner, grabLinkStatus, orderCard, prepareCancelPartner, runTool, startGrabLink,
} from './core.js';
import { loadPartnerUser, partnerActor, PartnerUser, upsertPartnerUser } from './users.js';
import { lastPartnerEventSeq, listPartnerEventsFor } from './webhooks.js';

const P = WEB_DEMO_PARTNER;
const COOKIE = 'ari_demo';
const ALLOWED_TOOLS = new Set(['create_cart', 'update_cart', 'search_stores', 'get_store', 'estimate_trip', 'get_order_status']);

export interface TraceEntry { call: string; grab: string | null; ms: number; ok: boolean }
export interface AriTurn { reply: string; card?: Card | null; chips?: string[]; order_id?: string; trace: TraceEntry[] }

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
  th: ['เรียกแท็กซี่จากสยามพารากอนไปสนามบินสุวรรณภูมิ', 'มื้อเย็นสำหรับ 2 คน ไม่เกิน 600 บาท ไม่ใส่ถั่ว', 'ส่งพัสดุ 3 กก. ไปไอคอนสยาม', 'ช่อดอกกุหลาบพร้อมกล่องของขวัญ', 'พาราเซตามอลกับพลาสเตอร์', 'ของชำ ข้าวสาร ไข่ไก่ น้ำดื่ม', 'เค้กช็อกโกแลตวันเกิด'],
};
export const ariExamples = (l: Locale) => (EXAMPLES as Record<string, string[]>)[l] ?? EXAMPLES.en;

const GREET = /^(hi|hello|hey|привет|здравств|добр|สวัสดี|หวัดดี)(?![a-z])/iu;
const THANKS = /^(?:ok(?:ay)?[,! ]*)?(?:thanks?|thank you|thx|cheers|great|perfect|спасибо|благодар|отлично|супер|хорошо|ок|ขอบคุณ|ขอบใจ|โอเค)(?![a-zа-яё])/iu;
const HELP = /what can you (?:do|order)|what do you do|^help\b|how does (?:this|it) work|что (?:ты )?(?:умеешь|можешь)|что вы (?:умеете|можете)|^помо(?:щь|ги)|как это работает|ทำอะไรได้|ช่วยอะไร|ใช้งานยังไง/iu;
const CANCEL = /\bcancel\b|отмен|ยกเลิก/iu;
const TRACK = /where(?: i|')s my|\b(?:order|delivery|ride) status\b|\btrack\b|how long (?:until|till)|где (?:мой|моя|мое|моё|мои|сейчас)|статус заказа|когда (?:приедет|привезут|доставят)|(?:ออเดอร์|คำสั่งซื้อ|รถ|ไรเดอร์|พัสดุ)(?:ของฉัน)?(?:อยู่|ถึง)(?:ที่)?ไหน|สถานะ(?:ออเดอร์|คำสั่งซื้อ)|ถึงไหนแล้ว/iu;

const HELP_TEXT: Tri = {
  en: 'I can order any Grab service for you: a ride, food, groceries, flowers, pharmacy items, a cake or a parcel. Say it in your own words, pick an option, then confirm on the card. Nothing is ordered until you confirm.',
  ru: 'Я закажу любой сервис Grab: поездку, еду, продукты, цветы, товары из аптеки, торт или посылку. Скажите своими словами, выберите вариант и подтвердите на карточке. Без подтверждения ничего не заказывается.',
  th: 'Ari สั่งบริการของ Grab ให้ได้ทุกอย่างค่ะ ทั้งเรียกรถ สั่งอาหาร ของชำ ดอกไม้ ยาสามัญ เค้ก หรือส่งพัสดุ บอก Ari ด้วยคำพูดของคุณเอง เลือกตัวเลือก แล้วแตะยืนยันบนการ์ด Ari จะยังไม่สั่งอะไรจนกว่าคุณจะยืนยันค่ะ',
};

/** "Where is my order" and "cancel my order" act on the latest order, like the buttons on its card. */
async function latestOrderTurn(ctx: Ctx, u: PartnerUser, l: Locale, cancel: boolean, trace: TraceEntry[]): Promise<AriTurn> {
  const base = `/partner/v1/users/${u.external_user_id}`;
  const o = (await ctx.db.query(
    `SELECT id FROM orders WHERE user_id = $1 ORDER BY (fulfillment_status IN ('submitted','accepted','preparing','picked_up')) DESC, created_at DESC LIMIT 1`,
    [u.user_id],
  )).rows[0];
  if (!o) {
    return {
      reply: cancel
        ? t(l, { en: 'There is nothing to cancel: you have no orders yet.', ru: 'Отменять нечего: заказов пока нет.', th: 'ยังไม่มีคำสั่งซื้อให้ยกเลิกค่ะ' })
        : t(l, { en: 'You have no orders yet. What would you like from Grab?', ru: 'Заказов пока нет. Что заказать в Grab?', th: 'ยังไม่มีคำสั่งซื้อค่ะ ต้องการอะไรจาก Grab ดีคะ' }),
      chips: ariExamples(l).slice(0, 3), trace,
    };
  }
  const card = await traced(trace, `GET ${base}/orders/${o.id}`, 'GrabExpress · GET /v1/deliveries/{id}', () => orderCard(ctx, P, u, o.id, { refresh: true }));
  if (!cancel) {
    return { reply: t(l, { en: `Your latest order: ${card.status?.label ?? ''}.`, ru: `Ваш последний заказ: ${card.status?.label ?? ''}.`, th: `คำสั่งซื้อล่าสุด: ${card.status?.label ?? ''}ค่ะ` }), card, order_id: o.id, trace };
  }
  if (!card.actions.some((a) => a.kind === 'prepare_cancel')) {
    return { reply: t(l, { en: 'This order can no longer be cancelled.', ru: 'Этот заказ уже нельзя отменить.', th: 'คำสั่งซื้อนี้ยกเลิกไม่ได้แล้วค่ะ' }), card, order_id: o.id, trace };
  }
  const r = await traced(trace, `POST ${base}/orders/${o.id}/cancel`, null, () => prepareCancelPartner(ctx, P, u, o.id));
  return { reply: t(l, { en: 'Here are the cancellation terms:', ru: 'Условия отмены:', th: 'นี่คือเงื่อนไขการยกเลิกค่ะ' }), card: r.card, trace };
}

interface TripAsk { service: string; pickup?: string; dropoff?: string; weight_kg?: number }

/** Example chips after an unknown or ambiguous place: the same request with the suggested place in the slot that failed. */
function placeChip(l: Locale, ask: TripAsk | undefined, field: string | undefined, place: string): string {
  const from = field === 'pickup' ? place : ask?.pickup;
  const to = field === 'pickup' ? ask?.dropoff ?? '' : place;
  const kg = ask?.weight_kg;
  if (ask?.service === 'express') {
    return from
      ? t(l, { en: `Send a ${kg ? `${kg} kg ` : ''}parcel from ${from} to ${to}`, ru: `Отправить посылку${kg ? ` ${kg} кг` : ''} от ${from} до ${to}`, th: `ส่งพัสดุ${kg ? ` ${kg} กก.` : ''} จาก ${from} ไป ${to}` })
      : t(l, { en: `Send a ${kg ? `${kg} kg ` : ''}parcel to ${to}`, ru: `Отправить посылку${kg ? ` ${kg} кг` : ''} в ${to}`, th: `ส่งพัสดุ${kg ? ` ${kg} กก.` : ''} ไป ${to}` });
  }
  return from
    ? t(l, { en: `Taxi from ${from} to ${to}`, ru: `Такси от ${from} до ${to}`, th: `แท็กซี่จาก ${from} ไป ${to}` })
    : t(l, { en: `Taxi to ${to}`, ru: `Такси до ${to}`, th: `แท็กซี่ไป ${to}` });
}

/** One user message: decide what Ari would do and run it through the Partner API path. */
export async function ariRespond(ctx: Ctx, u: PartnerUser, text: string): Promise<AriTurn> {
  const l = cardLocale(u.locale);
  const trace: TraceEntry[] = [];
  const base = `/partner/v1/users/${u.external_user_id}`;
  const q = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!q || (GREET.test(q) && q.split(' ').length <= 3)) {
    return {
      reply: t(l, { en: 'Hi! I can order any Grab service for you: a ride, food, groceries, flowers, pharmacy or a parcel. What do you need?', ru: 'Здравствуйте! Я закажу любой сервис Grab: поездку, еду, продукты, цветы, товары из аптеки или посылку. Что нужно?', th: 'สวัสดีค่ะ Ari สั่งบริการของ Grab ให้ได้ทุกอย่าง ทั้งเรียกรถ สั่งอาหาร ของชำ ดอกไม้ ยาสามัญ หรือส่งพัสดุ ให้ Ari ช่วยอะไรดีคะ' }),
      chips: ariExamples(l).slice(0, 4), trace,
    };
  }
  if (THANKS.test(q) && q.length < 40) {
    return { reply: t(l, { en: 'You\'re welcome! Anything else from Grab?', ru: 'Пожалуйста! Заказать в Grab что-нибудь ещё?', th: 'ยินดีค่ะ ต้องการอะไรจาก Grab อีกไหมคะ' }), chips: ariExamples(l).slice(0, 3), trace };
  }
  if (HELP.test(q)) return { reply: t(l, HELP_TEXT), chips: ariExamples(l).slice(0, 4), trace };
  const si = detectService(q);
  try {
    if (TRACK.test(q) || (CANCEL.test(q) && q.length < 60)) return await latestOrderTurn(ctx, u, l, !TRACK.test(q), trace);
    if (si.service === 'ride' || si.service === 'express') {
      // The saved places are read once here and handed to the tool call below, which resolves pickup and drop-off against them.
      const places = await listAddresses(ctx.db, u.user_id);
      const addr = places.find((a) => a.is_default);
      // "Home" in any language is the saved default place, whatever language its label was saved in.
      const pickup = (si.pickup_home ? addr?.label : si.pickup) || addr?.label || '';
      if (si.dropoff_home && addr) si.dropoff = addr.label;
      if (si.dropoff_home && addr && pickup === addr.label) {
        // Home to home: the pickup is missing, not the destination.
        return si.service === 'express'
          ? { reply: t(l, { en: 'Where should the courier pick the parcel up? For example "from Siam Paragon".', ru: 'Откуда забрать посылку? Например, «от Сиам Парагона».', th: 'ให้ไปรับพัสดุที่ไหนคะ เช่น "จากสยามพารากอน"' }), chips: [t(l, { en: 'Send a parcel from Siam Paragon to home', ru: 'Отправить посылку от Сиам Парагона до дома', th: 'ส่งพัสดุจากสยามพารากอนไปบ้าน' })], trace }
          : { reply: t(l, { en: 'Where should I pick you up? For example "from Siam Paragon".', ru: 'Откуда вас забрать? Например, «от Сиам Парагона».', th: 'ให้ไปรับที่ไหนคะ เช่น "จากสยามพารากอน"' }), chips: [t(l, { en: 'Taxi from Siam Paragon to home', ru: 'Такси от Сиам Парагона до дома', th: 'แท็กซี่จากสยามพารากอนไปบ้าน' }), t(l, { en: 'Taxi from Suvarnabhumi airport to home', ru: 'Такси от аэропорта Суварнабхуми до дома', th: 'แท็กซี่จากสนามบินสุวรรณภูมิไปบ้าน' })], trace };
      }
      if (!si.dropoff) {
        if (si.service === 'express') {
          return { reply: t(l, { en: 'Where should the parcel go? For example "to ICONSIAM".', ru: 'Куда доставить посылку? Например, «в Айконсиам».', th: 'ส่งพัสดุไปที่ไหนคะ เช่น "ไปไอคอนสยาม"' }), chips: [ariExamples(l)[2]], trace };
        }
        return { reply: t(l, { en: 'Where to? For example "to Suvarnabhumi airport".', ru: 'Куда едем? Например, «до аэропорта Суварнабхуми».', th: 'ไปที่ไหนคะ เช่น "ไปสนามบินสุวรรณภูมิ"' }), chips: [ariExamples(l)[0]], trace };
      }
      const args: Record<string, unknown> = { service: si.service, pickup, dropoff: si.dropoff };
      // What the user said, for "did you mean" chips: home stays the word "home" in the chat language.
      const homeWord = t(l, { en: 'home', ru: 'дома', th: 'บ้าน' });
      const ask: TripAsk = { service: si.service, pickup: si.pickup_home ? homeWord : si.pickup, dropoff: si.dropoff_home ? homeWord : si.dropoff, weight_kg: si.weight_kg };
      if (si.service === 'express') args.parcel_weight_kg = si.weight_kg ?? 2;
      if (si.passengers) args.passengers = Math.min(si.passengers, 10);
      const r = await traced(trace, `POST ${base}/tools/estimate_trip`, grabFor('estimate_trip', args), () => runTool(ctx, P, u, 'estimate_trip', args, { addresses: places }));
      if (!r.ok) return errorTurn(l, r.error, trace, ask);
      const res = r.result;
      const from = res.trip?.pickup?.name;
      const to = res.trip?.dropoff?.name;
      // The reply has to say what the card shows: when no vehicle can take the trip, say why.
      if (r.card?.options?.length && r.card.options.every((o) => !o.action)) {
        const maxKg = Math.max(0, ...(res.options ?? []).map((o: any) => Number(o.max_weight_kg) || 0));
        const maxSeats = Math.max(0, ...(res.options ?? []).map((o: any) => Number(o.seats) || 0));
        const why = si.service === 'express'
          ? t(l, { en: `A ${args.parcel_weight_kg} kg parcel is too heavy: the largest vehicle here carries up to ${maxKg} kg. Try a lighter parcel or split it.`, ru: `Посылка ${args.parcel_weight_kg} кг слишком тяжёлая: самая большая машина берёт до ${maxKg} кг. Уменьшите вес или разделите посылку.`, th: `พัสดุ ${args.parcel_weight_kg} กก. หนักเกินไปค่ะ รถคันใหญ่ที่สุดรับได้ไม่เกิน ${maxKg} กก. ลองลดน้ำหนักหรือแบ่งส่งนะคะ` })
          : t(l, { en: `No vehicle here takes ${si.passengers ?? ''} passengers: the largest seats ${maxSeats}. Try a smaller group or two cars.`, ru: `Машины на ${si.passengers ?? ''} пассажиров нет: в самой большой мест ${maxSeats}. Попробуйте меньшую компанию или две машины.`, th: `ไม่มีรถที่รับผู้โดยสาร ${si.passengers ?? ''} คนได้ค่ะ คันใหญ่ที่สุดนั่งได้ ${maxSeats} คน ลองแบ่งเป็นสองคันนะคะ` });
        return { reply: why, card: r.card, trace };
      }
      const reply = si.service === 'ride'
        ? t(l, { en: `From ${from} to ${to}, about ${res.trip?.drive_minutes_estimate} min. Pick a ride:`, ru: `Маршрут: ${from} → ${to}, примерно ${res.trip?.drive_minutes_estimate} мин в пути. Выберите машину:`, th: `จาก ${from} ไป ${to} ประมาณ ${res.trip?.drive_minutes_estimate} นาที เลือกประเภทรถได้เลยค่ะ` })
        : t(l, { en: `Parcel ${args.parcel_weight_kg} kg from ${from} to ${to}. Pick a courier:`, ru: `Посылка ${args.parcel_weight_kg} кг: ${from} → ${to}. Выберите курьера:`, th: `พัสดุ ${args.parcel_weight_kg} กก. จาก ${from} ไป ${to} เลือกประเภทการส่งได้เลยค่ะ` });
      return { reply, card: r.card, trace };
    }
    if (si.service === 'food') {
      // Nothing in the sentence names a service or a meal: say what Ari can do instead of guessing restaurants.
      if (!hasFoodCue(q)) {
        return {
          reply: t(l, { en: 'I did not catch which Grab service you need. I can book a ride, order food, groceries, flowers or pharmacy items, or send a parcel. Try one of these:', ru: 'Не поняла, какой сервис Grab нужен. Могу вызвать такси, заказать еду, продукты, цветы, товары из аптеки или отправить посылку. Например:', th: 'Ari ยังไม่แน่ใจว่าคุณต้องการบริการไหนของ Grab ค่ะ Ari เรียกรถ สั่งอาหาร ของชำ ดอกไม้ ยาสามัญ หรือส่งพัสดุให้ได้ ลองแบบนี้ดูนะคะ' }),
          chips: ariExamples(l).slice(0, 4), trace,
        };
      }
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
      const n = (r.card?.options ?? []).filter((o) => o.action).length;
      const people = Number(args.party_size);
      const budget = args.budget_total_major ? ` ${t(l, { en: `under ฿${args.budget_total_major}`, ru: `до ${args.budget_total_major} бат`, th: `ไม่เกิน ${args.budget_total_major} บาท` })}` : '';
      const allergy = intent.exclude_allergens.length
        ? t(l, { en: ' Restaurants did not declare the allergens you excluded, but I never mark a dish as safe.', ru: ' Рестораны не заявили исключённые аллергены, но я никогда не называю блюдо безопасным.', th: ' ร้านไม่ได้ระบุว่ามีสารก่อภูมิแพ้ที่คุณยกเว้น แต่ Ari ไม่รับรองว่าเมนูใดปลอดภัยนะคะ' })
        : '';
      const fits = (r.result?.stores ?? []).some((s: any) => s.suggestion?.within_budget === true);
      const reply = n && args.budget_total_major && !fits
        ? t(l, { en: `Nothing fits ฿${args.budget_total_major} for ${people}. These are the closest options:`, ru: `В ${args.budget_total_major} бат на ${people} чел. уложиться не получится. Вот самые близкие варианты:`, th: `ยังไม่มีร้านที่อยู่ในงบ ${args.budget_total_major} บาทสำหรับ ${people} คนค่ะ นี่คือตัวเลือกที่ใกล้เคียงที่สุดค่ะ` })
        : n
        ? t(l, { en: `${n} ${n === 1 ? 'option' : 'options'} for ${people}${budget}.${allergy} Tap one:`, ru: `Вариантов: ${n} (на ${people} чел.${budget}).${allergy} Выберите:`, th: `${n} ตัวเลือกสำหรับ ${people} คน${budget}${allergy} เลือกได้เลยค่ะ` })
        : t(l, { en: 'Nothing matches right now. Try a bigger budget or fewer restrictions.', ru: 'Сейчас ничего не подходит. Попробуйте увеличить бюджет или убрать ограничения.', th: 'ตอนนี้ยังไม่มีร้านที่ตรงกับเงื่อนไขค่ะ ลองเพิ่มงบหรือลดเงื่อนไขดูนะคะ' });
      // No selectable restaurant: a card of greyed-out rows would only confuse.
      return { reply, card: n ? r.card : null, chips: n ? undefined : ariExamples(l).slice(1, 2), trace };
    }
    // Shops: pick the items from the sentence, then build the cart (one step, like an assistant would).
    const service = si.service as keyof typeof SHOP_STORE;
    const plan = await traced(trace, `POST ${base}/tools/search_stores`, grabFor('search_stores', {}), () => shopPlan(ctx, partnerActor(P, u.user_id), service, q));
    const args = { store_id: plan.store_id, items: plan.lines.map((x) => ({ item_id: x.item_id, quantity: x.quantity, ...(x.modifiers.length ? { modifiers: x.modifiers } : {}) })) };
    const r = await traced(trace, `POST ${base}/tools/create_cart`, grabFor('create_cart', args), () => runTool(ctx, P, u, 'create_cart', args));
    if (!r.ok) return errorTurn(l, r.error, trace);
    const names = plan.lines.map((x) => x.name).join(', ');
    return {
      reply: t(l, { en: `${plan.store_name}: ${names}. Here is the total with every fee. Confirm when ready.`, ru: `${plan.store_name}: ${names}. Вот итог со всеми сборами. Подтвердите, когда будете готовы.`, th: `${plan.store_name}: ${names} นี่คือยอดรวมที่รวมค่าธรรมเนียมทุกรายการแล้ว แตะยืนยันเมื่อพร้อมนะคะ` }),
      card: r.card, trace,
    };
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return errorTurn(l, { code: e.code, message: e.message, details: e.details }, trace, { service: si.service });
  }
}

function errorTurn(l: Locale, err: any, trace: TraceEntry[], ask?: TripAsk): AriTurn {
  const code = err?.code;
  if (code === 'PLACE_NOT_FOUND' || code === 'PLACE_AMBIGUOUS') {
    const sug: string[] = (err.details?.suggestions ?? []).slice(0, 4);
    return {
      reply: code === 'PLACE_AMBIGUOUS'
        ? t(l, { en: 'Which one do you mean?', ru: 'Какое место вы имеете в виду?', th: 'หมายถึงที่ไหนคะ' })
        : t(l, { en: 'I could not find that place on the Bangkok demo map. Try one of these:', ru: 'Не нашла это место на демо-карте Бангкока. Например:', th: 'Ari หาสถานที่นี้บนแผนที่เดโมของกรุงเทพฯ ไม่พบค่ะ ลองเลือกจากรายการนี้นะคะ' }),
      chips: sug.map((s) => placeChip(l, ask, err.details?.field, s)), trace,
    };
  }
  // Protocol-level text (argument validation) is for developers, not for the chat.
  const msg = String(err?.message ?? '');
  return { reply: (/^MCP error/.test(msg) ? undefined : localText(msg, l)) ?? t(l, { en: 'Something went wrong. Please try again.', ru: 'Что-то пошло не так. Попробуйте ещё раз.', th: 'เกิดข้อผิดพลาด กรุณาลองอีกครั้งค่ะ' }), chips: [], trace };
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
  // The user and the demo home address are written in the same transaction (one BEGIN/COMMIT).
  const u = await ctx.db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext('unyly.guest_create'))");
    const c = (await q.query(
      `SELECT count(*)::int total, count(*) FILTER (WHERE guest_ip_hash = $1)::int mine FROM users WHERE is_guest AND created_at > now() - interval '1 hour'`,
      [ipHash],
    )).rows[0];
    if (c.mine >= ctx.cfg.guestPerIpHourly || c.total >= ctx.cfg.guestHourlyLimit) return null;
    // Same lifetime as other demo guests: deleted after 24 hours by the job worker.
    // A new random id: nothing to look up or lock for it (the unique key still guards the insert).
    const created = await upsertPartnerUser(ctx, P, `web-${randomUUID()}`, { locale }, { q, guestIpHash: ipHash, fresh: true });
    await addFirstAddress(q, created.user_id, demoHome(locale));
    return created;
  });
  if (!u) throw new DomainError('RATE_LIMITED', 'The demo is busy right now. Please try again in a few minutes.');
  return u;
}

function demoHome(locale: Locale) {
  return ({
    label: tr(locale, { ru: 'Дом', en: 'Home', th: 'บ้าน' }), line1: '88 Sukhumvit Soi 24 (demo)', district: 'Watthana', city: 'Bangkok', country: 'TH',
  });
}

/** The demo user of a sealed cookie value, or null when it no longer exists. Database errors are not "no user": they propagate. */
async function demoUser(ctx: Ctx, ext: string): Promise<PartnerUser | null> {
  try {
    return await loadPartnerUser(ctx, P, ext);
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') return null;
    throw e;
  }
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
    const u = await demoUser(ctx, ext);
    if (!u) throw new DomainError('AUTH_REQUIRED', 'The demo session ended. Start again.');
    const l = detectLocale(req);
    if (l !== u.locale) {
      await ctx.db.query('UPDATE users SET locale = $2 WHERE id = $1', [u.user_id, l]);
      u.locale = l;
      if (u.row) u.row.locale = l;
    }
    return u;
  };
  const rl = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.post('/ari/api/session', rl(60), async (req, reply) => {
    try {
      guard(req);
      const l = detectLocale(req);
      let u: PartnerUser | null = null;
      const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
      if (ext) u = await demoUser(ctx, ext);
      if (!u) {
        u = await createDemoUser(ctx, req.ip, l);
        reply.setCookie(COOKIE, sealExt(ctx, u.external_user_id), { httpOnly: true, secure: ctx.cfg.cookieSecure, sameSite: 'lax', path: '/ari', maxAge: 24 * 3600 });
      }
      // A user created by this request has no Grab link and no events yet; for a returning one both are read together.
      const [grab, lastEvent] = u.created
        ? [{ linked: false, linked_at: null, simulated: false }, 0]
        : await Promise.all([grabLinkStatus(ctx, u), lastPartnerEventSeq(ctx, u.user_id)]);
      return send(reply, {
        ok: true, user: { id: u.external_user_id }, grab, examples: ariExamples(l), last_event: lastEvent,
        greeting: tr(l, { en: 'Hi, I\'m Ari. Tell me what you need from Grab and I\'ll take care of it. Nothing is ordered until you confirm.', ru: 'Здравствуйте, я Ari. Скажите, что нужно от Grab, и я всё сделаю. Ничего не заказывается без вашего подтверждения.', th: 'สวัสดีค่ะ Ari เองค่ะ บอกได้เลยว่าต้องการอะไรจาก Grab เดี๋ยว Ari จัดการให้ และจะยังไม่สั่งอะไรจนกว่าคุณจะยืนยันค่ะ' }),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/message', rl(90), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const text = String((req.body as any)?.text ?? '');
      return send(reply, { ok: true, ...(await ariRespond(ctx, u, text)) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/action', rl(90), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body ?? {}) as any;
      const name = String(b.tool ?? '');
      if (!ALLOWED_TOOLS.has(name)) throw new DomainError('VALIDATION_FAILED', 'Unknown action');
      const args = b.arguments && typeof b.arguments === 'object' ? b.arguments : {};
      const trace: TraceEntry[] = [];
      const r = await traced(trace, `POST /partner/v1/users/${u.external_user_id}/tools/${name}`, grabFor(name, args), () => runTool(ctx, P, u, name, args));
      if (!r.ok) return send(reply, { ok: true, ...errorTurn(cardLocale(u.locale), r.error, trace) });
      const l = cardLocale(u.locale);
      const reply2 = r.card?.type === 'checkout'
        ? tr(l, { en: 'Here is everything with the final price. Tap Confirm when you are ready.', ru: 'Вот всё с итоговой ценой. Нажмите «Подтвердить», когда будете готовы.', th: 'นี่คือรายละเอียดทั้งหมดพร้อมราคาสุทธิ แตะยืนยันเมื่อพร้อมนะคะ' })
        : '';
      return send(reply, { ok: true, reply: reply2, card: r.card, trace });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/confirm', rl(60), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body ?? {}) as any;
      const id = String(b.checkout_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Checkout not found');
      const trace: TraceEntry[] = [];
      const r = await traced(trace, `POST /partner/v1/users/${u.external_user_id}/checkouts/${id}/confirm`, null, () => confirmCheckout(ctx, P, u, id, {
        confirm_hash: b.confirm_hash, user_verification: 'biometric', confirmed_at: ctx.clock.now().toISOString(), device_id: 'web-demo',
      }));
      // The service for the trace line comes from the order card of the result; only when there is no order yet is it looked up.
      const service = r.order?.card.service
        ?? (await ctx.db.query('SELECT k.service FROM checkouts c JOIN carts k ON k.id = c.cart_id WHERE c.id = $1 AND c.user_id = $2', [id, u.user_id])).rows[0]?.service;
      trace[0].grab = service === 'express' ? 'GrabPay · charge/init + GrabExpress · POST /v1/deliveries' : service === 'ride' ? 'Ride booking scope (requested) · today: Grab deep link' : 'GrabFood / GrabMart order scope (requested)';
      const l = cardLocale(u.locale);
      return send(reply, {
        ok: true,
        reply: tr(l, { en: 'Done! I\'ll keep you posted and call you when it matters.', ru: 'Готово! Буду сообщать о статусе и позвоню, когда будет важно.', th: 'เรียบร้อยค่ะ Ari จะคอยแจ้งสถานะ และโทรหาเมื่อถึงจังหวะสำคัญนะคะ' }),
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
      return send(reply, { ok: true, reply: tr(cardLocale(u.locale),{ en: 'No problem, nothing was ordered.', ru: 'Хорошо, ничего не заказано.', th: 'ได้ค่ะ ยังไม่ได้สั่งอะไรนะคะ' }), card: await checkoutCard(ctx, P, u, id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/ari/api/orders/:id', rl(240), async (req, reply) => {
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

  app.get('/ari/api/events', rl(240), async (req, reply) => {
    try {
      guard(req);
      // The poll: the user check and the events in one statement.
      const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
      if (!ext) throw new DomainError('AUTH_REQUIRED', 'Start the demo first.');
      const after = Math.max(Number((req.query as any)?.after ?? 0) || 0, 0);
      const events = await listPartnerEventsFor(ctx, P.id, ext, after);
      if (!events) throw new DomainError('AUTH_REQUIRED', 'The demo session ended. Start again.');
      return send(reply, { ok: true, events });
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
      return send(reply, { ok: true, reply: tr(cardLocale(u.locale),{ en: 'Here are the cancellation terms:', ru: 'Условия отмены:', th: 'นี่คือเงื่อนไขการยกเลิกค่ะ' }), card: r.card });
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
      const r = await confirmCancelPartner(ctx, P, u, id, { confirm_hash: b.confirm_hash, user_verification: 'tap', confirmed_at: ctx.clock.now().toISOString() });
      const done = r.cancellation.status === 'executed';
      return send(reply, {
        ok: true,
        reply: done
          ? tr(cardLocale(u.locale),{ en: 'Cancelled.', ru: 'Заказ отменён.', th: 'ยกเลิกแล้วค่ะ' })
          : tr(cardLocale(u.locale),{ en: 'The cancellation did not go through; the order continues.', ru: 'Отменить не получилось, заказ продолжается.', th: 'ยกเลิกไม่สำเร็จค่ะ คำสั่งซื้อยังดำเนินต่อ' }),
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
