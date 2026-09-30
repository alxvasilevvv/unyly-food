// Multi-service part of the /try guided demo: shops (groceries, flowers, pharmacy, cakes) and
// trips (ride, parcel). It calls the same services the MCP tools call. The keyword lists only stand
// in for what an assistant would pick from the user's words.
import type { Actor, Ctx } from '../context.js';
import { DomainError } from '../domain/errors.js';
import { findRestaurant } from '../providers/demo/catalog.js';
import type { CartLine } from '../providers/types.js';
import { estimateTrip } from '../services/catalog.js';
import { callProvider } from '../services/common.js';
import { getDefaultAddress, toDeliveryAddress } from '../services/users.js';
import { packs } from '../i18n/index.js';
import type { DemoService, ServiceIntent } from './intent.js';

export const SHOP_STORE: Record<Exclude<DemoService, 'food' | 'ride' | 'express'>, string> = {
  groceries: 'demo-m1',
  flowers: 'demo-m3',
  pharmacy: 'demo-m4',
  cakes: 'demo-m5',
};

/** [item id, keywords in EN/RU/TH]. The first entry per store is the default pick. */
const PICKS: Record<string, [string, RegExp][]> = {
  'demo-m1': [
    ['m1-rice', /\brice\b|\bрис|ข้าวสาร/u],
    ['m1-eggs', /\beggs?\b|яйц|ไข่/u],
    ['m1-water', /water|\bвод|น้ำดื่ม/u],
    ['m1-milk', /\bmilk\b|молок|นม/u],
    ['m1-banana', /banana|банан|กล้วย/u],
    ['m1-mango', /mango|манго|มะม่วง/u],
    ['m1-chicken', /chicken|куриц|ไก่(?!ไข่)/u],
    ['m1-noodles', /noodle|лапш|บะหมี่|มาม่า/u],
    ['m1-coffee', /coffee|кофе|กาแฟ/u],
    ['m1-veg', /vegetable|greens|овощ|зелень|ผัก/u],
  ],
  'demo-m3': [
    ['m3-seasonal', /seasonal|mixed|сезонн|ดอกไม้รวม/u],
    ['m3-roses', /rose|роз|กุหลาบ/u],
    ['m3-lilies', /lil(?:y|ies)|лили|ลิลลี่/u],
    ['m3-orchid', /orchid|орхиде|กล้วยไม้/u],
    ['m3-malai', /garland|malai|гирлянд|พวงมาลัย/u],
  ],
  'demo-m4': [
    ['m4-paracetamol', /paracetamol|fever|headache|парацетамол|температур|голов|พาราเซตามอล|ไข้|ปวดหัว/u],
    ['m4-plasters', /plaster|band-?aid|пластыр|พลาสเตอร์/u],
    ['m4-ors', /rehydration|\bors\b|регидр|электролит|เกลือแร่/u],
    ['m4-lozenges', /throat|lozenge|горл|леденц|เจ็บคอ|ยาอม/u],
    ['m4-antiseptic', /antiseptic|антисепт|ฆ่าเชื้อ/u],
    ['m4-thermometer', /thermometer|градусник|термометр|ปรอท/u],
    ['m4-masks', /mask|маск|หน้ากาก/u],
    ['m4-repellent', /mosquito|repellent|комар|репеллент|กันยุง/u],
    ['m4-sunscreen', /sunscreen|spf|солнцезащ|กันแดด/u],
  ],
  'demo-m5': [
    ['m5-choc', /chocolate|шоколад|ช็อกโกแลต/u],
    ['m5-birthday', /birthday|день рождения|วันเกิด/u],
    ['m5-mango', /cheesecake|чизкейк|ชีสเค้ก/u],
    ['m5-pandan', /pandan|пандан|ใบเตย/u],
  ],
};

/** Item words from the language packs, keyed by item id (substring match on lowercased text). */
const SHOP_WORDS: Record<string, string[]> = {};
for (const [, p] of packs()) for (const [id, words] of Object.entries(p.shop_items ?? {})) (SHOP_WORDS[id] ??= []).push(...words.map((w) => w.toLowerCase()).filter((w) => w.length >= 2));

export interface ShopPlan {
  store_id: string;
  store_name: string;
  category: string;
  notice?: string;
  lines: { item_id: string; name: string; quantity: number; unit_minor: number; modifiers: { group_id: string; option_ids: string[] }[]; option_note?: string }[];
  total_minor: number;
  delivery_fee_minor: number;
  service_fee_minor: number;
  eta: [number, number];
  blocking: string[];
}

/** Pick items for a shop request and price them with the provider (same as quote_cart would). */
export async function shopPlan(ctx: Ctx, actor: Actor, service: keyof typeof SHOP_STORE, q: string): Promise<ShopPlan> {
  const storeId = SHOP_STORE[service];
  const text = q.toLowerCase();
  const table = PICKS[storeId];
  let ids = table.filter(([id, re]) => re.test(text) || (SHOP_WORDS[id] ?? []).some((w) => text.includes(w))).map(([id]) => id);
  if (!ids.length) ids = service === 'groceries' ? ['m1-rice', 'm1-eggs', 'm1-water'] : [table[0][0]];
  ids = ids.slice(0, 5);
  const addr = await getDefaultAddress(ctx.db, actor.userId);
  const provider = ctx.provider('demo');
  const menu = await callProvider(() => provider.getMenu(storeId, addr ? toDeliveryAddress(addr) : null));
  const lines: ShopPlan['lines'] = [];
  for (const id of ids) {
    const it = menu.items.find((x) => x.id === id);
    if (!it || !it.available) continue;
    // Required choices default to the first free option (e.g. kraft paper wrapping).
    const modifiers = it.modifier_groups.filter((g) => g.min_select > 0).map((g) => ({ group_id: g.id, option_ids: [g.options.find((o) => o.available)!.id] }));
    const optNote = it.modifier_groups.filter((g) => g.min_select > 0).map((g) => `${g.name}: ${g.options.find((o) => o.available)!.name}`).join(', ');
    lines.push({ item_id: it.id, name: it.name, quantity: 1, unit_minor: it.price_minor, modifiers, option_note: optNote || undefined });
  }
  if (!lines.length) throw new DomainError('OUT_OF_STOCK', 'Nothing from this request is available right now.');
  const cartLines: CartLine[] = lines.map((l) => ({ line_id: l.item_id, item_id: l.item_id, name: l.name, quantity: l.quantity, modifiers: l.modifiers }));
  const quote = addr
    ? await callProvider(() => provider.quote({ restaurant_id: storeId, lines: cartLines, address: toDeliveryAddress(addr) }))
    : null;
  const st = findRestaurant(storeId)!;
  return {
    store_id: storeId,
    store_name: menu.restaurant.name,
    category: menu.restaurant.category,
    notice: menu.restaurant.notice,
    lines,
    total_minor: quote?.total_minor ?? 0,
    delivery_fee_minor: quote?.delivery_fee_minor ?? st.delivery_fee_minor,
    service_fee_minor: quote?.service_fee_minor ?? 0,
    eta: [quote?.eta_min_minutes ?? st.eta[0], quote?.eta_max_minutes ?? st.eta[1]],
    blocking: quote?.issues.map((i) => i.message) ?? ['No delivery address'],
  };
}

export interface TripPlan {
  service: 'ride' | 'express';
  pickup: string;
  dropoff: string;
  weight_kg?: number;
  result: Awaited<ReturnType<typeof estimateTrip>>;
}

/** Fare options for a ride or parcel. Pickup defaults to the user's default address label. */
export async function tripPlan(ctx: Ctx, actor: Actor, si: ServiceIntent): Promise<TripPlan> {
  const service = si.service === 'express' ? 'express' : 'ride';
  const addr = await getDefaultAddress(ctx.db, actor.userId);
  const pickup = si.pickup || addr?.label || '';
  const dropoff = si.dropoff || '';
  if (!dropoff) throw new DomainError('TRIP_REQUIRED', 'Where to? Add a destination, for example "to Suvarnabhumi airport".');
  const weight = service === 'express' ? si.weight_kg ?? 2 : undefined;
  const result = await estimateTrip(ctx, actor, { service, pickup, dropoff, parcel_weight_kg: weight, passengers: si.passengers });
  return { service, pickup, dropoff, weight_kg: weight, result };
}
