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
    ['m1-rice', /\brice\b|(?<!\p{L})рис(?!\p{L})|ข้าวสาร/u],
    ['m1-eggs', /\beggs?\b|яйц|ไข่/u],
    ['m1-water', /water|(?<!\p{L})вод[аыуе](?!\p{L})|น้ำดื่ม/u],
    ['m1-milk', /\bmilk\b|молок|(?<!ข)นม/u],
    ['m1-banana', /banana|банан|กล้วย/u],
    ['m1-mango', /mango|манго|มะม่วง/u],
    ['m1-chicken', /chicken|куриц|(?<!ไข่)ไก่/u],
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
    ['m4-paracetamol', /paracetamol|fever|headache|парацетамол|температур|голов|พาราเซตามอล|ยาพารา|ไข้|ปวดหัว/u],
    ['m4-plasters', /plaster|band-?aid|пластыр|พลาสเตอร์/u],
    ['m4-ors', /rehydration|\bors\b|регидр|электролит|เกลือแร่/u],
    ['m4-lozenges', /throat|lozenge|горл|леденц|เจ็บคอ|ยาอม/u],
    ['m4-antiseptic', /antiseptic|антисепт|ฆ่าเชื้อ/u],
    ['m4-thermometer', /thermometer|градусник|термометр|ปรอท/u],
    ['m4-masks', /mask|маск|หน้ากาก/u],
    ['m4-repellent', /mosquito|repellent|комар|репеллент|กันยุง/u],
    ['m4-sunscreen', /sunscreen|spf|солнцезащ|от солнца|กันแดด/u],
  ],
  'demo-m5': [
    ['m5-choc', /chocolate|шоколад|ช็อกโกแลต/u],
    ['m5-birthday', /birthday|день рождения|วันเกิด/u],
    ['m5-mango', /cheesecake|чизкейк|ชีสเค้ก/u],
    ['m5-pandan', /pandan|пандан|ใบเตย/u],
  ],
};

/** Words for modifier options (gift box, candles), keyed by option id. */
const OPTION_WORDS: Record<string, RegExp> = {
  box: /gift box|\bbox\b|коробк|กล่อง/u,
  paper: /kraft|paper|крафт|бумаг|กระดาษ/u,
  candles: /candle|свеч|เทียน/u,
  knife: /knife|plates|нож|тарел|มีด|จาน/u,
};

/** Item words from the language packs, keyed by item id (substring match on lowercased text). */
const SHOP_WORDS: Record<string, string[]> = {};
for (const [, p] of packs()) for (const [id, words] of Object.entries(p.shop_items ?? {})) (SHOP_WORDS[id] ??= []).push(...words.map((w) => w.toLowerCase()).filter((w) => w.length >= 2));

export interface ShopPlan {
  store_id: string;
  store_name: string;
  category: string;
  notice?: string;
  lines: { item_id: string; name: string; quantity: number; unit_minor: number; modifiers: { group_id: string; option_ids: string[] }[]; option_note?: string; /** The number asked for, when the store limit cut it down. */ limited_from?: number }[];
  total_minor: number;
  delivery_fee_minor: number;
  service_fee_minor: number;
  eta: [number, number];
  blocking: string[];
}

const NUM_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, couple: 2, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'пару': 2, 'สอง': 2, 'สาม': 3, 'สี่': 4, 'ห้า': 5,
};
const NUM_ALT = Object.keys(NUM_WORDS).join('|');
/** Thai counters for whole things ("เค้ก 2 ก้อน", "พารา 2 แผง"); weights and sizes are not counts. */
const TH_COUNTER = 'ก้อน|ชิ้น|อัน|กล่อง|แผง|ซอง|ขวด|หลอด|ช่อ';

/**
 * How many of an item the sentence asks for: a number right before the item word ("2 chocolate cakes",
 * "три пластыря"), or a Thai number with a counter right after it. Only for things sold one by one;
 * groceries and stems come in store packs, so a number there is not multiplied.
 */
function askedQuantity(text: string, at: number, len: number): number {
  const before = new RegExp(`(?<![\\p{L}\\d.,])(\\d{1,2}|${NUM_ALT})\\s*(?:x\\s*|×\\s*)?(?:[\\p{L}\\p{M}]+\\s+){0,2}$`, 'u').exec(text.slice(Math.max(0, at - 40), at));
  const after = new RegExp(`^[\\p{L}\\p{M}]*\\s*(\\d{1,2}|${NUM_ALT})\\s*(?:${TH_COUNTER})`, 'u').exec(text.slice(at + len, at + len + 30));
  const k = before?.[1] ?? after?.[1];
  if (!k) return 1;
  const n = /^\d+$/.test(k) ? Number(k) : NUM_WORDS[k];
  return n >= 1 && n <= 20 ? n : 1;
}

/** The items a shop request names. `matched` is false when nothing was named and the store default would be used. */
export function shopPicks(service: keyof typeof SHOP_STORE, q: string): { ids: string[]; matched: boolean; quantity: Record<string, number> } {
  const storeId = SHOP_STORE[service];
  const text = q.toLowerCase();
  const table = PICKS[storeId];
  let ids = table.filter(([id, re]) => re.test(text) || (SHOP_WORDS[id] ?? []).some((w) => text.includes(w))).map(([id]) => id);
  // "A cake with candles" without a flavour is the birthday cake (the one that comes with candles).
  if (!ids.length && service === 'cakes' && OPTION_WORDS.candles.test(text)) ids = ['m5-birthday'];
  const matched = ids.length > 0;
  const quantity: Record<string, number> = {};
  if (service === 'cakes' || service === 'pharmacy') {
    for (const id of ids) {
      const m = table.find(([x]) => x === id)![1].exec(text);
      if (m) quantity[id] = askedQuantity(text, m.index, m[0].length);
    }
  }
  return { ids, matched, quantity };
}

/** Pick items for a shop request and price them with the provider (same as quote_cart would). */
export async function shopPlan(ctx: Ctx, actor: Actor, service: keyof typeof SHOP_STORE, q: string): Promise<ShopPlan> {
  const storeId = SHOP_STORE[service];
  const text = q.toLowerCase();
  const table = PICKS[storeId];
  const picked = shopPicks(service, q);
  let ids = picked.ids;
  if (!ids.length) ids = service === 'groceries' ? ['m1-rice', 'm1-eggs', 'm1-water'] : [table[0][0]];
  // One cake per request: the cake named first in the sentence ("chocolate cake for a birthday" is one chocolate cake).
  if (service === 'cakes' && ids.length > 1) {
    const at = (id: string) => {
      const m = table.find(([x]) => x === id)![1].exec(text);
      const w = (SHOP_WORDS[id] ?? []).map((x) => text.indexOf(x)).filter((i) => i >= 0);
      return Math.min(m ? m.index : Infinity, ...w);
    };
    ids = [ids.slice().sort((a, b) => at(a) - at(b))[0]];
  }
  ids = ids.slice(0, 5);
  const addr = await getDefaultAddress(ctx.db, actor.userId);
  const provider = ctx.provider('demo');
  const menu = await callProvider(() => provider.getMenu(storeId, addr ? toDeliveryAddress(addr) : null));
  const lines: ShopPlan['lines'] = [];
  for (const id of ids) {
    const it = menu.items.find((x) => x.id === id);
    if (!it || !it.available) continue;
    // Choices named in the request win ("in a gift box", "with candles"); a required choice nobody
    // named defaults to the first free option (e.g. kraft paper wrapping).
    const modifiers: { group_id: string; option_ids: string[] }[] = [];
    const notes: string[] = [];
    for (const g of it.modifier_groups) {
      const free = g.options.filter((o) => o.available);
      const named = free.filter((o) => OPTION_WORDS[o.id]?.test(text) || text.includes(o.name.toLowerCase())).slice(0, Math.max(g.max_select, 1));
      const picked = named.length ? named : g.min_select > 0 && free[0] ? [free[0]] : [];
      if (!picked.length) continue;
      modifiers.push({ group_id: g.id, option_ids: picked.map((o) => o.id) });
      notes.push(`${g.name}: ${picked.map((o) => o.name).join(', ')}`);
    }
    const optNote = notes.join(', ');
    // The store's per-order limit wins over the number asked for (household remedies: two or three packs).
    const asked = picked.quantity[it.id] ?? 1;
    const quantity = Math.max(1, Math.min(asked, it.max_quantity ?? 20));
    lines.push({ item_id: it.id, name: it.name, quantity, unit_minor: it.price_minor, modifiers, option_note: optNote || undefined, ...(quantity < asked ? { limited_from: asked } : {}) });
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
  // "Home" in any language is the saved default place.
  const pickup = (si.pickup_home ? addr?.label : si.pickup) || addr?.label || '';
  const dropoff = (si.dropoff_home ? addr?.label : si.dropoff) || '';
  if (si.dropoff_home && addr && !si.pickup) throw new DomainError('TRIP_REQUIRED', 'Where from? Add a pickup place, for example "from Siam Paragon home".');
  if (!dropoff) throw new DomainError('TRIP_REQUIRED', 'Where to? Add a destination, for example "to Suvarnabhumi airport".');
  const weight = service === 'express' ? si.weight_kg ?? 2 : undefined;
  const result = await estimateTrip(ctx, actor, { service, pickup, dropoff, parcel_weight_kg: weight, passengers: si.passengers });
  return { service, pickup, dropoff, weight_kg: weight, result };
}
