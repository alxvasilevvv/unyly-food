// Partner operations (Ari): tools with cards, native confirmation, orders, cancellations, events.
// Every function takes the partner and the partner user; authentication happened before (signed
// request, or the in-process website demo).
import type { Ctx } from '../context.js';
import { audit } from '../context.js';
import { hmac, safeEqual } from '../domain/crypto.js';
import { DomainError, isDomainError } from '../domain/errors.js';
import type { Locale } from '../domain/locales.js';
import { money } from '../domain/money.js';
import { isTripService, Service } from '../domain/regions.js';
import { statusLabel } from '../domain/labels.js';
import type { FulfillmentStatus } from '../providers/types.js';
import { TERMINAL } from '../providers/types.js';
import {
  approveCheckout, CheckoutRow, checkoutStatus, checkoutView, declineCheckout, loadCheckoutWithQuoteExpiry, paymentRequired, stepUpPolicy, submitOrder,
} from '../services/checkout.js';
import {
  approveCancellation, cancelOrder, CancellationRow, describeCancellation, listOrders, loadCancellation, loadOrder, prepareCancellation, OrderRow, refreshOrder,
} from '../services/orders.js';
import type { AddressRow } from '../services/users.js';
import { tr } from '../web/messages.js';
import { Card, CardAction, CardOption, cardLocale, demoCourier, localText, minutes, seatsBadge, statusBlock, T } from './cards.js';
import type { PartnerConfig } from './config.js';
import { adaptForPartner, callPartnerTool, ToolEnvelope } from './tools.js';
import { partnerActor, PartnerUser } from './users.js';
import { enqueuePartnerEvent } from './webhooks.js';

const base = (u: PartnerUser) => `/partner/v1/users/${encodeURIComponent(u.external_user_id)}`;

/** Binds a confirmation to exactly what the card showed: cart version, quote, total, address, payment method. */
export function confirmHash(ctx: Ctx, c: Pick<CheckoutRow, 'id' | 'cart_version' | 'quote_id' | 'total_minor' | 'currency' | 'address_fingerprint' | 'payment_method_label'>): string {
  const data = ['checkout', c.id, c.cart_version, c.quote_id, Number(c.total_minor), c.currency, c.address_fingerprint, c.payment_method_label ?? ''].join('|');
  return hmac(`${ctx.cfg.demoWebhookSecret}:partner-confirm`, data).slice(0, 40);
}

function cancelHash(ctx: Ctx, c: { id: string; order_id: string; fee_minor: number | string; currency: string; expires_at: string | Date }): string {
  return hmac(`${ctx.cfg.demoWebhookSecret}:partner-cancel`, ['cancel', c.id, c.order_id, Number(c.fee_minor), c.currency, new Date(c.expires_at).toISOString()].join('|')).slice(0, 40);
}

// ---------------------------------------------------------------- cards from tool results

function optionsFromStores(env: ToolEnvelope, args: Record<string, unknown>, l: Locale): Card | null {
  const r = env.result;
  if (!r || !Array.isArray(r.stores)) return null;
  const service: Service = r.service === 'mart' ? 'mart' : 'food';
  const options: CardOption[] = [];
  for (const s of r.stores) {
    const st = s.store ?? {};
    const notes: string[] = s.availability_notes ?? [];
    if (service === 'food') {
      const sug = s.suggestion;
      const badges: string[] = [];
      if (sug?.within_budget === true) badges.push(tr(l, { en: 'Within budget', ru: 'В бюджете', th: 'อยู่ในงบ' }));
      const excluded: string[] = r.applied_filters?.exclude_allergens ?? [];
      if (sug && excluded.length && sug.items.every((i: any) => i.allergen_check?.status === 'not_declared')) {
        badges.push(tr(l, { en: 'Excluded allergens not declared', ru: 'Исключённые аллергены не заявлены', th: 'ร้านไม่ได้ระบุสารก่อภูมิแพ้ที่ยกเว้น' }));
      }
      const blocked = !sug || notes.length || (sug.blocking_issues ?? []).length;
      options.push({
        id: st.store_id,
        title: st.name,
        subtitle: sug ? sug.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ') : (st.cuisines ?? []).join(', '),
        price: sug?.estimated_total ? money(Number(sug.estimated_total.amount_minor), sug.estimated_total.currency, l).formatted : undefined,
        eta: st.eta_estimate_minutes ? minutes(l, st.eta_estimate_minutes.min, st.eta_estimate_minutes.max) : undefined,
        badges,
        disabled_reason: blocked ? (localText(notes[0], l) ?? tr(l, { en: 'Not available right now', ru: 'Сейчас недоступно', th: 'ไม่พร้อมให้บริการขณะนี้' })) : undefined,
        action: blocked ? undefined : {
          id: `choose:${st.store_id}`, label: tr(l, T.choose), style: 'primary', kind: 'tool',
          tool: { name: 'create_cart', arguments: { store_id: st.store_id, items: sug.items.map((i: any) => ({ item_id: i.item_id, quantity: i.quantity })) } },
        },
      });
    } else {
      // Best match for the query: the available item whose name shares the most query words (first one on a tie).
      const words: string[] = String(args.query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
      const score = (i: any) => words.filter((w) => String(i.name ?? '').toLowerCase().includes(w)).length;
      const item = (s.matching_items ?? []).filter((i: any) => i.available).reduce((best: any, i: any) => (!best || score(i) > score(best) ? i : best), null);
      const blocked = !item || notes.length;
      options.push({
        id: st.store_id,
        title: st.name,
        subtitle: item ? item.name : undefined,
        price: item?.price ? money(Number(item.price.amount_minor), item.price.currency, l).formatted : undefined,
        eta: st.eta_estimate_minutes ? minutes(l, st.eta_estimate_minutes.min, st.eta_estimate_minutes.max) : undefined,
        disabled_reason: blocked ? (localText(notes[0], l) ?? tr(l, { en: 'Not available right now', ru: 'Сейчас недоступно', th: 'ไม่พร้อมให้บริการขณะนี้' })) : undefined,
        action: blocked ? undefined : {
          id: `choose:${st.store_id}:${item.item_id}`, label: tr(l, T.choose), style: 'primary', kind: 'tool',
          tool: {
            name: 'create_cart',
            arguments: {
              store_id: st.store_id,
              items: [{ item_id: item.item_id, quantity: 1, ...(item.required_options?.length ? { modifiers: item.required_options.map((g: any) => ({ group_id: g.group_id, option_ids: [g.options[0]?.option_id].filter(Boolean) })) } : {}) }],
            },
          },
        },
      });
    }
  }
  return {
    schema: 'unyly.card.v1', type: 'options', id: `search:${Date.now()}`, service,
    title: service === 'food' ? tr(l, { en: 'Restaurants for you', ru: 'Рестораны для вас', th: 'ร้านอาหารสำหรับคุณ' }) : tr(l, { en: 'Shops near you', ru: 'Магазины рядом', th: 'ร้านค้าใกล้คุณ' }),
    subtitle: r.delivery_address ? `${r.delivery_address.label} · ${r.delivery_address.area ?? ''}`.trim() : undefined,
    demo: env.mode === 'demo', options, actions: [],
    footnote: localText(r.allergen_disclaimer, l),
  };
}

/** Why a vehicle cannot take this trip, in the card language. */
function tripMisfit(o: any, args: Record<string, unknown>, l: Locale): string {
  const w = Number(args.parcel_weight_kg);
  if (o.max_weight_kg !== undefined && Number.isFinite(w) && w > Number(o.max_weight_kg)) {
    return tr(l, { en: `Up to ${o.max_weight_kg} kg only`, ru: `Только до ${o.max_weight_kg} кг`, th: `รับได้ไม่เกิน ${o.max_weight_kg} กก.` });
  }
  const p = Number(args.passengers);
  if (o.seats !== undefined && Number.isFinite(p) && p > Number(o.seats)) {
    return tr(l, { en: `Seats ${o.seats} only`, ru: `Мест всего ${o.seats}`, th: `นั่งได้ ${o.seats} คนเท่านั้น` });
  }
  const first = Array.isArray(o.issues) ? o.issues[0] : undefined;
  const text = typeof first === 'string' ? first : first?.message;
  return (l === 'en' ? text : undefined) ?? tr(l, { en: 'Does not fit', ru: 'Не подходит', th: 'ไม่รองรับ' });
}

function optionsFromTrip(env: ToolEnvelope, args: Record<string, unknown>, l: Locale): Card | null {
  const r = env.result;
  if (!r || !Array.isArray(r.options) || !r.trip) return null;
  const service: Service = r.service === 'express' ? 'express' : 'ride';
  return {
    schema: 'unyly.card.v1', type: 'options', id: `trip:${Date.now()}`, service,
    title: service === 'ride' ? tr(l, { en: 'Choose a ride', ru: 'Выберите поездку', th: 'เลือกประเภทรถ' }) : tr(l, { en: 'Choose a courier', ru: 'Выберите курьера', th: 'เลือกประเภทการส่ง' }),
    route: { from: r.trip.pickup?.name, to: r.trip.dropoff?.name, distance_km: r.trip.distance_km_estimate, minutes: r.trip.drive_minutes_estimate },
    demo: env.mode === 'demo',
    options: r.options.map((o: any): CardOption => ({
      id: o.item_id, title: o.name, subtitle: localText(o.description, l), price: o.estimated_total ? money(Number(o.estimated_total.amount_minor), o.estimated_total.currency, l).formatted : undefined,
      eta: o.eta_estimate_minutes ? minutes(l, o.eta_estimate_minutes.min, o.eta_estimate_minutes.max) : undefined,
      badges: o.seats ? [seatsBadge(l, Number(o.seats))] : undefined,
      disabled_reason: o.fits === false ? tripMisfit(o, args, l) : undefined,
      action: o.fits === false ? undefined : {
        id: `choose:${o.item_id}`, label: tr(l, T.choose), style: 'primary', kind: 'tool',
        tool: {
          name: 'create_cart',
          arguments: {
            service, pickup: args.pickup, dropoff: args.dropoff, items: [{ item_id: o.item_id, quantity: 1 }],
            ...(args.parcel_weight_kg !== undefined ? { parcel_weight_kg: args.parcel_weight_kg } : {}),
            ...(typeof args.parcel_description === 'string' && args.parcel_description ? { parcel_description: args.parcel_description } : {}),
          },
        },
      },
    })),
    actions: [],
    footnote: tr(l, T.estimate),
  };
}

function issuesCard(env: ToolEnvelope, l: Locale): Card | null {
  const r = env.result;
  if (!r?.cart_id || r.checkout) return null;
  const issues: { message: string }[] = r.quote?.issues ?? [];
  const blocked = r.checkout_blocked?.message;
  if (!issues.length && !blocked) return null;
  return {
    schema: 'unyly.card.v1', type: 'message', id: `cart:${r.cart_id}`, service: r.service,
    title: tr(l, { en: 'Needs a change before ordering', ru: 'Нужно поправить заказ', th: 'ต้องแก้ไขก่อนสั่งซื้อ' }),
    subtitle: [blocked, ...issues.map((i) => i.message)].filter(Boolean).join(' '),
    demo: env.mode === 'demo', actions: [],
  };
}

/** Builds the card for a tool result. Checkout and order cards are read from the database (single source of truth). */
export async function cardForTool(ctx: Ctx, p: PartnerConfig, u: PartnerUser, tool: string, args: Record<string, unknown>, env: ToolEnvelope): Promise<Card | null> {
  if (!env.ok) return null;
  const l = cardLocale(u.locale);
  const r = env.result ?? {};
  if (tool === 'search_stores') return optionsFromStores(env, args, l);
  if (tool === 'estimate_trip') return optionsFromTrip(env, args, l);
  if (r.checkout?.checkout_id) return checkoutCard(ctx, p, u, r.checkout.checkout_id);
  if (['create_cart', 'update_cart', 'quote_cart'].includes(tool)) return issuesCard(env, l);
  // Both results are flat: the id sits at the top level.
  if (tool === 'get_order_status' && (r.order_id ?? r.order?.order_id)) return orderCard(ctx, p, u, r.order_id ?? r.order.order_id);
  if (tool === 'prepare_checkout' && r.checkout_id) return checkoutCard(ctx, p, u, r.checkout_id);
  if (tool === 'prepare_cancellation' && r.cancellation_id) return cancellationCard(ctx, p, u, r.cancellation_id);
  if (tool === 'create_handoff' && r.open_url) {
    return {
      schema: 'unyly.card.v1', type: 'handoff', id: `handoff:${r.cart_id ?? Date.now()}`, title: tr(l, { en: 'Finish in Grab', ru: 'Завершите в Grab', th: 'ดำเนินการต่อใน Grab' }),
      subtitle: (r.instructions ?? []).join(' '), demo: false,
      actions: [{ id: 'open_grab', label: tr(l, T.openGrab), style: 'primary', kind: 'open_url', url: r.open_url }],
    };
  }
  return null;
}

export async function runTool(ctx: Ctx, p: PartnerConfig, u: PartnerUser, tool: string, args: Record<string, unknown>, known: { addresses?: AddressRow[] } = {}) {
  // The user row came with the partner user; `known.addresses` is the address list when this request already read it.
  const env = await callPartnerTool(ctx, p, u.user_id, tool, args, { user: u.row, addresses: known.addresses });
  let card: Card | null = null;
  try {
    card = await cardForTool(ctx, p, u, tool, args, env);
  } catch (e) {
    if (!isDomainError(e)) console.error('[partner] card failed', tool, e);
  }
  return { ...env, card };
}

// ---------------------------------------------------------------- checkout

export async function checkoutCard(ctx: Ctx, p: PartnerConfig, u: PartnerUser, checkoutId: string): Promise<Card> {
  const l = cardLocale(u.locale);
  const v = await checkoutView(ctx, u.user_id, checkoutId, l);
  const c = v.checkout;
  const service = v.service as Service;
  const trip = isTripService(service);
  const policy = await stepUpPolicy(ctx, u.user_id, c);
  const verification: 'tap' | 'biometric' = policy.large ? 'biometric' : 'tap';
  const open = c.status === 'awaiting_user';
  const hash = confirmHash(ctx, c);
  const label = trip ? tr(l, service === 'ride' ? T.confirmRide : T.confirmParcel) : tr(l, T.confirmOrder);
  const actions: CardAction[] = open
    ? [
      {
        id: 'confirm', label: `${label} · ${v.breakdown.total.formatted}`, style: 'primary', kind: 'confirm', requires_user_verification: verification,
        endpoint: { method: 'POST', path: `${base(u)}/checkouts/${c.id}/confirm`, body: { confirm_hash: hash } },
      },
      { id: 'decline', label: tr(l, T.notNow), style: 'secondary', kind: 'decline', endpoint: { method: 'POST', path: `${base(u)}/checkouts/${c.id}/decline` } },
    ]
    : [];
  const bd = v.breakdown;
  const breakdown = [
    { label: tr(l, T.items), value: bd.items_subtotal.formatted },
    ...(Number(bd.delivery_fee.amount_minor) ? [{ label: tr(l, T.delivery), value: bd.delivery_fee.formatted }] : []),
    ...(Number(bd.service_fee.amount_minor) ? [{ label: tr(l, T.service), value: bd.service_fee.formatted }] : []),
    ...(Number(bd.small_order_fee.amount_minor) ? [{ label: tr(l, T.smallOrder), value: bd.small_order_fee.formatted }] : []),
    ...(Number(bd.discount.amount_minor) ? [{ label: tr(l, T.discount), value: bd.discount.formatted }] : []),
  ];
  const pay = paymentRequired(ctx, c);
  // A parcel shows what the courier will carry: the weight and the note given with it ("Fragile").
  const parcel = service === 'express' ? (v.trip as any)?.parcel : undefined;
  const parcelDetail: string | undefined = parcel
    ? [parcel.weight_kg ? `${parcel.weight_kg} ${tr(l, { en: 'kg', ru: 'кг', th: 'กก.' })}` : null, parcel.description || null].filter(Boolean).join(' · ') || undefined
    : undefined;
  return {
    schema: 'unyly.card.v1', type: 'checkout', id: c.id, service,
    title: trip ? (v.lines[0]?.name ?? '') : (v.restaurant_name ?? ''),
    subtitle: trip ? undefined : v.address ? `${v.address.label}` : undefined,
    demo: c.mode === 'demo',
    badges: [
      ...(c.mode === 'demo' ? [tr(l, T.demo)] : []),
      ...(policy.large ? [tr(l, T.biometric)] : []),
      ...(pay ? ['GrabPay'] : []),
    ],
    route: trip && v.trip ? { from: (v.trip as any).pickup?.name, to: (v.trip as any).dropoff?.name, distance_km: (v.trip as any).distance_km_estimate, minutes: (v.trip as any).drive_minutes_estimate } : undefined,
    lines: (v.lines as any[]).map((x) => ({ title: x.name, quantity: x.quantity, detail: (x.modifiers_desc ?? []).join?.(', ') || parcelDetail, value: money(Number(x.line_total_minor), c.currency, l).formatted })),
    breakdown,
    total: { label: tr(l, T.total), value: bd.total.formatted, amount_minor: Number(c.total_minor), currency: c.currency },
    actions,
    footnote: [localText(c.payment_method_label, l), localText(c.cancellation_terms, l), v.eta.min ? `${tr(l, { en: 'ETA', ru: 'Время', th: 'เวลาโดยประมาณ' })} ${minutes(l, v.eta.min, v.eta.max)}` : null].filter(Boolean).join(' · '),
    expires_at: open ? new Date(c.expires_at).toISOString() : undefined,
  };
}

const VERIFICATIONS = new Set(['tap', 'biometric', 'passcode']);

export interface ConfirmBody {
  confirm_hash?: unknown;
  user_verification?: unknown;
  confirmed_at?: unknown;
  device_id?: unknown;
}

function parseConfirm(ctx: Ctx, b: ConfirmBody) {
  const hash = typeof b.confirm_hash === 'string' ? b.confirm_hash : '';
  const ver = typeof b.user_verification === 'string' && VERIFICATIONS.has(b.user_verification) ? (b.user_verification as 'tap' | 'biometric' | 'passcode') : null;
  if (!hash || !ver) throw new DomainError('VALIDATION_FAILED', 'confirm_hash and user_verification (tap, biometric or passcode) are required.');
  const now = ctx.clock.now().getTime();
  const at = typeof b.confirmed_at === 'string' ? Date.parse(b.confirmed_at) : now;
  if (!Number.isFinite(at) || at > now + 60_000 || at < now - 10 * 60_000) throw new DomainError('VALIDATION_FAILED', 'confirmed_at must be the time of the user\'s tap (within the last 10 minutes).');
  const device = typeof b.device_id === 'string' ? b.device_id.slice(0, 80) : null;
  return { hash, ver, at: new Date(at), device };
}

/**
 * The user tapped Confirm on the card in the partner app (and, for a large total, passed Face ID or
 * the device passcode). Approves and submits in one call. Idempotent: repeating it returns the same order.
 */
export async function confirmCheckout(ctx: Ctx, p: PartnerConfig, u: PartnerUser, checkoutId: string, body: ConfirmBody) {
  const actor = partnerActor(p, u.user_id);
  const via = `partner:${p.id}`;
  const c = await loadCheckoutWithQuoteExpiry(ctx.db, u.user_id, checkoutId);
  // Replay of a confirmation that already went through: report the current state.
  if (c.status === 'consumed' || c.status === 'approved') {
    const prior = (await ctx.db.query('SELECT 1 FROM partner_confirmations WHERE entity = $1 AND entity_id = $2', ['checkout', c.id])).rows[0];
    if (prior) {
      // Confirmed earlier but never sent (new orders were paused, or the process stopped in between):
      // send it now. submitOrder is idempotent, so this can never create a second order.
      const attempt = (await ctx.db.query('SELECT 1 FROM submission_attempts WHERE checkout_id = $1', [c.id])).rows[0];
      if (c.status === 'approved' && !attempt && !paymentRequired(ctx, c)) {
        try {
          await submitOrder(ctx, actor, c.id);
        } catch (e) {
          if (!(isDomainError(e) && e.code === 'SUBMISSION_UNKNOWN')) throw e;
        }
        return resultAfterSubmit(ctx, p, u, c);
      }
      return confirmResult(ctx, p, u, c.id);
    }
  }
  // Prepaid Live orders (GrabPay before the courier is booked) need a payment hand-off for partner apps,
  // which is switched on together with the GrabPay merchant account. Refuse before anything is approved.
  if (paymentRequired(ctx, c)) {
    throw new DomainError('NOT_CONFIGURED', 'GrabPay prepayment for partner apps is not switched on yet. Nothing was ordered or charged.');
  }
  const { hash, ver, at, device } = parseConfirm(ctx, body);
  if (!safeEqual(hash, confirmHash(ctx, c))) {
    throw new DomainError('CONFIRM_HASH_MISMATCH', 'The order changed after the card was shown. Fetch the checkout card again and ask the user to confirm the new details.',
      { card_path: `${base(u)}/checkouts/${c.id}` });
  }
  const policy = await stepUpPolicy(ctx, u.user_id, c);
  if (policy.large && ver === 'tap') {
    throw new DomainError('STEP_UP_REQUIRED', 'This total needs Face ID or the device passcode. Verify the user and confirm again with user_verification "biometric".',
      { required: 'biometric', threshold_minor: policy.threshold_minor });
  }
  await ctx.db.query(
    `INSERT INTO partner_confirmations (partner_id, user_id, entity, entity_id, confirm_hash, user_verification, device_id, confirmed_at)
     VALUES ($1,$2,'checkout',$3,$4,$5,$6,$7) ON CONFLICT (entity, entity_id) DO NOTHING`,
    [p.id, u.user_id, c.id, hash, ver, device, at],
  );
  // `c` was read a moment ago in this request: both steps re-read the checkout under its row lock before acting.
  await approveCheckout(ctx, u.user_id, c.id, { via, partnerVerification: ver, pre: c });
  try {
    await submitOrder(ctx, actor, c.id, { pre: c });
  } catch (e) {
    if (!(isDomainError(e) && e.code === 'SUBMISSION_UNKNOWN')) throw e;
  }
  const res = await resultAfterSubmit(ctx, p, u, c);
  await enqueuePartnerEvent(ctx.db, u.user_id, 'checkout.confirmed', { checkout_id: c.id, order_id: res.order?.id ?? null, user_verification: ver }, { dedupeKey: `checkout:${c.id}:confirmed` });
  return res;
}

/**
 * Demo orders from partner apps move at presentation speed (the whole trip in a couple of minutes).
 * One statement: speed the simulation up, shorten the ETA shown in the app by the same factor (never
 * under 30 seconds) and keep the Live Activity hint of the stored order.created event in step with it.
 */
async function speedUpDemo(ctx: Ctx, checkoutId: string) {
  const speed = Math.max(ctx.cfg.demoGuestSpeed * 2, 1);
  await ctx.db.query(
    `WITH o AS (SELECT id, provider_order_ref FROM orders WHERE checkout_id = $1 AND mode = 'demo'),
          sim AS (UPDATE demo_sim_orders d SET speed = GREATEST(d.speed, $2::real) FROM o WHERE d.ref = o.provider_order_ref),
          eta AS (
            UPDATE orders x SET eta_at = x.created_at + make_interval(secs => GREATEST(30, round(extract(epoch FROM (x.eta_at - x.created_at)) / $2::numeric)))
              FROM o WHERE x.id = o.id AND x.eta_at IS NOT NULL
            RETURNING x.id, x.eta_at)
     UPDATE partner_webhooks w
        SET payload = jsonb_set(w.payload, '{notify,live_activity,eta_at}', to_jsonb(to_char(eta.eta_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
       FROM eta
      WHERE w.dedupe_key = 'order:' || eta.id || ':created' AND w.payload #> '{notify,live_activity}' IS NOT NULL`,
    [checkoutId, speed],
  );
}

/** The confirm result right after a submission. The demo speed-up runs first so the first order card already shows the ETA the app will keep seeing. */
async function resultAfterSubmit(ctx: Ctx, p: PartnerConfig, u: PartnerUser, c: Pick<CheckoutRow, 'id' | 'mode'>) {
  if (c.mode === 'demo') await speedUpDemo(ctx, c.id);
  return confirmResult(ctx, p, u, c.id);
}

const CONFIRM_WAIT_STEPS_MS = [100, 150, 250, 400, 500, 600];
const CONFIRM_WAITERS_MAX = 50;
let confirmWaiters = 0;

async function confirmResult(ctx: Ctx, p: PartnerConfig, u: PartnerUser, checkoutId: string) {
  let st = await checkoutStatus(ctx, partnerActor(p, u.user_id), checkoutId);
  // A parallel confirmation of the same checkout is sending the order right now: wait a moment for it so
  // every caller gets the same order. If the provider is slow the answer stays "in_flight" with order null.
  // Bounded: at most two seconds and six status reads per request (growing pauses, no connection is held while
  // waiting), and at most CONFIRM_WAITERS_MAX requests wait at once; beyond that the "in_flight" answer goes out at once.
  if (!st.order_id && (st as any).submission?.status === 'in_flight' && confirmWaiters < CONFIRM_WAITERS_MAX) {
    confirmWaiters++;
    try {
      for (const ms of CONFIRM_WAIT_STEPS_MS) {
        await new Promise((r) => setTimeout(r, ms));
        st = await checkoutStatus(ctx, partnerActor(p, u.user_id), checkoutId);
        if (st.order_id || (st as any).submission?.status !== 'in_flight') break;
      }
    } finally {
      confirmWaiters--;
    }
  }
  // Partner wording: the user confirms in the app, not on a web page.
  const { confirm_url: _c, user_action: _ua, ...status } = adaptForPartner(st) as any;
  const order = st.order_id ? { id: st.order_id, card: await orderCard(ctx, p, u, st.order_id) } : null;
  return { checkout: status, order };
}

export async function declineCheckoutPartner(ctx: Ctx, p: PartnerConfig, u: PartnerUser, checkoutId: string) {
  await declineCheckout(ctx, u.user_id, checkoutId, `partner:${p.id}`);
  const st = await checkoutStatus(ctx, partnerActor(p, u.user_id), checkoutId);
  const { confirm_url: _c, ...status } = adaptForPartner(st) as any;
  return { checkout: status };
}

// ---------------------------------------------------------------- orders

export async function orderCard(ctx: Ctx, p: PartnerConfig, u: PartnerUser, orderId: string, opts: { refresh?: boolean } = {}): Promise<Card> {
  const l = cardLocale(u.locale);
  // With refresh the provider is asked first; the row it leaves behind is the one shown (no second read).
  const fresh = opts.refresh ? await refreshOrder(ctx, partnerActor(p, u.user_id), orderId).catch(() => undefined) : undefined;
  const o: OrderRow = fresh?.row ?? (await loadOrder(ctx.db, u.user_id, orderId));
  const trip = isTripService(o.service);
  const isFinal = TERMINAL.includes(o.fulfillment_status);
  const eta = o.eta_at ? new Date(o.eta_at).toISOString() : null;
  const showCourier = o.mode === 'demo' && ['accepted', 'preparing', 'picked_up'].includes(o.fulfillment_status);
  // Offered only while the provider can still cancel: after pickup a cancel request is always refused.
  const canCancel = o.mode !== 'handoff' && ['submitted', 'accepted', 'preparing'].includes(o.fulfillment_status);
  return {
    schema: 'unyly.card.v1', type: 'order', id: o.id, service: o.service,
    title: trip ? `${o.items[0]?.name ?? ''}` : o.restaurant_name,
    subtitle: o.address_label,
    demo: o.mode === 'demo',
    badges: o.mode === 'demo' ? [tr(l, T.demo)] : [],
    lines: trip ? undefined : o.items.map((i: any) => ({ title: i.name, quantity: i.quantity, value: i.line_total_minor !== undefined ? money(Number(i.line_total_minor), o.currency, l).formatted : '' })),
    total: { label: tr(l, T.total), value: money(Number(o.total_minor), o.currency, l).formatted, amount_minor: Number(o.total_minor), currency: o.currency },
    status: statusBlock(o.service, o.fulfillment_status as FulfillmentStatus, isFinal, eta, l),
    courier: showCourier ? demoCourier(o.provider_order_ref, o.service, l, o.items[0]?.item_id) : undefined,
    actions: canCancel
      ? [{ id: 'cancel', label: tr(l, T.cancelOrder), style: 'destructive', kind: 'prepare_cancel', endpoint: { method: 'POST', path: `${base(u)}/orders/${o.id}/cancel` } }]
      : [],
    footnote: !showCourier ? undefined : trip && o.service === 'ride'
      ? tr(l, { en: 'Driver and plate are fictional in the demo.', ru: 'Водитель и номер машины в демо вымышлены.', th: 'คนขับและทะเบียนรถในเดโมเป็นข้อมูลสมมติ' })
      : tr(l, { en: 'Courier and plate are fictional in the demo.', ru: 'Курьер и номер в демо вымышлены.', th: 'ไรเดอร์และทะเบียนรถในเดโมเป็นข้อมูลสมมติ' }),
  };
}

export async function listOrdersPartner(ctx: Ctx, p: PartnerConfig, u: PartnerUser, limit = 10) {
  const r = await listOrders(ctx, partnerActor(p, u.user_id), { limit });
  return r;
}

export async function prepareCancelPartner(ctx: Ctx, p: PartnerConfig, u: PartnerUser, orderId: string) {
  let c;
  try {
    c = await prepareCancellation(ctx, partnerActor(p, u.user_id), orderId);
  } catch (e) {
    // The provider's refusal ("the trip has started") in the card language.
    if (isDomainError(e) && e.code === 'CANCELLATION_NOT_ALLOWED') throw new DomainError(e.code, localText(e.message, cardLocale(u.locale)) ?? e.message, e.details, e.userAction);
    throw e;
  }
  return { cancellation: adaptForPartner(describeCancellation(c)), card: await cancellationCard(ctx, p, u, c.id, c) };
}

export async function cancellationCard(ctx: Ctx, p: PartnerConfig, u: PartnerUser, cancellationId: string, known?: CancellationRow): Promise<Card> {
  const l = cardLocale(u.locale);
  // `known`: the request this call just created for this user (no need to read it back).
  const c = known && known.id === cancellationId && known.user_id === u.user_id ? known : await loadCancellation(ctx.db, u.user_id, cancellationId);
  const o = await loadOrder(ctx.db, u.user_id, c.order_id);
  const open = c.status === 'awaiting_user';
  const fee = money(Number(c.fee_minor), c.currency, l).formatted;
  return {
    schema: 'unyly.card.v1', type: 'cancellation', id: c.id, service: o.service,
    title: tr(l, { en: 'Cancel this order?', ru: 'Отменить заказ?', th: 'ยกเลิกคำสั่งซื้อนี้ใช่ไหม' }),
    subtitle: `${isTripService(o.service) ? o.items[0]?.name ?? '' : o.restaurant_name} · ${tr(l, { en: 'Cancellation fee', ru: 'Плата за отмену', th: 'ค่าธรรมเนียมการยกเลิก' })}: ${fee}`,
    demo: o.mode === 'demo',
    actions: open
      ? [
        { id: 'confirm_cancel', label: tr(l, T.confirmCancel), style: 'destructive', kind: 'confirm', requires_user_verification: 'tap', endpoint: { method: 'POST', path: `${base(u)}/cancellations/${c.id}/confirm`, body: { confirm_hash: cancelHash(ctx, c) } } },
        { id: 'keep', label: tr(l, T.keep), style: 'secondary', kind: 'decline' },
      ]
      : [],
    footnote: localText(c.terms, l),
    expires_at: open ? new Date(c.expires_at).toISOString() : undefined,
  };
}

export async function confirmCancelPartner(ctx: Ctx, p: PartnerConfig, u: PartnerUser, cancellationId: string, body: ConfirmBody) {
  const c = await loadCancellation(ctx.db, u.user_id, cancellationId);
  if (c.status === 'awaiting_user') {
    const { hash, ver, at, device } = parseConfirm(ctx, body);
    if (!safeEqual(hash, cancelHash(ctx, c))) throw new DomainError('CONFIRM_HASH_MISMATCH', 'The cancellation terms changed. Prepare the cancellation again.');
    await ctx.db.query(
      `INSERT INTO partner_confirmations (partner_id, user_id, entity, entity_id, confirm_hash, user_verification, device_id, confirmed_at)
       VALUES ($1,$2,'cancellation',$3,$4,$5,$6,$7) ON CONFLICT (entity, entity_id) DO NOTHING`,
      [p.id, u.user_id, c.id, hash, ver, device, at],
    );
    await approveCancellation(ctx, u.user_id, c.id, `partner:${p.id}`);
  }
  const res = await cancelOrder(ctx, partnerActor(p, u.user_id), c.id);
  await enqueuePartnerEvent(ctx.db, u.user_id, 'cancellation.confirmed', { cancellation_id: c.id, order_id: c.order_id, status: res.status }, { dedupeKey: `cancel:${c.id}:confirmed` });
  return { cancellation: adaptForPartner(res) as typeof res, order: { id: c.order_id, card: await orderCard(ctx, p, u, c.order_id) } };
}

// ---------------------------------------------------------------- Grab account (Login with Grab)

export async function grabLinkStatus(ctx: Ctx, u: PartnerUser) {
  const r = (await ctx.db.query(
    `SELECT external_ref, created_at FROM provider_connections WHERE user_id = $1 AND provider = 'grab_account' AND status = 'connected' ORDER BY created_at DESC LIMIT 1`,
    [u.user_id],
  )).rows[0];
  return { linked: !!r, linked_at: r ? new Date(r.created_at).toISOString() : null, simulated: !!r?.external_ref?.startsWith('demo:') };
}

/**
 * Starts Login with Grab for this user. Live: needs GrabID onboarding (GRABID=on) and returns the Grab
 * authorize URL. Demo: links a simulated Grab account at once so the full flow can be shown.
 */
export async function startGrabLink(ctx: Ctx, p: PartnerConfig, u: PartnerUser) {
  if (u.mode === 'demo') {
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE provider_connections SET status = 'revoked', revoked_at = now() WHERE user_id = $1 AND provider = 'grab_account' AND status = 'connected'`, [u.user_id]);
      await q.query(`INSERT INTO provider_connections (user_id, provider, mode, status, external_ref) VALUES ($1,'grab_account','demo','connected',$2)`, [u.user_id, `demo:${u.user_id.slice(0, 8)}`]);
      await audit(q, { userId: u.user_id, actor: `partner:${p.id}`, action: 'grab.linked', mode: 'demo', details: { simulated: true } });
    });
    await enqueuePartnerEvent(ctx.db, u.user_id, 'grab.linked', { simulated: true }, { dedupeKey: `grab:${u.user_id}:${Date.now()}` });
    return { status: 'linked', ...(await grabLinkStatus(ctx, u)) };
  }
  if (!ctx.cfg.grabId.enabled) {
    throw new DomainError('NOT_CONFIGURED', 'Login with Grab is not switched on yet: it needs GrabID partner credentials from Grab.');
  }
  // The GrabID redirect for partner users (state bound to this user, return to the partner app) is
  // enabled together with the GrabID client registration for the partner's redirect URI.
  throw new DomainError('NOT_CONFIGURED', 'Login with Grab for partner apps is not switched on yet: the partner redirect URI has to be registered with GrabID first.');
}

export async function unlinkGrab(ctx: Ctx, p: PartnerConfig, u: PartnerUser) {
  await ctx.db.query(`UPDATE provider_connections SET status = 'revoked', revoked_at = now() WHERE user_id = $1 AND provider = 'grab_account' AND status = 'connected'`, [u.user_id]);
  await enqueuePartnerEvent(ctx.db, u.user_id, 'grab.unlinked', {}, { dedupeKey: `grab:${u.user_id}:unlink:${Date.now()}` });
  return grabLinkStatus(ctx, u);
}

export function statusText(service: Service, s: FulfillmentStatus, l: Locale) {
  return statusLabel(service, s, l);
}
