// Cards: a small, stable JSON shape that a partner app (Ari) renders natively. One schema for every
// Grab service: options to choose from, a checkout to confirm, an order to track, a cancellation.
import { createHash } from 'node:crypto';
import { isLocaleCode, type Locale } from '../domain/locales.js';
import { lookup } from '../i18n/index.js';
import { statusLabel } from '../domain/labels.js';
import type { Service } from '../domain/regions.js';
import type { FulfillmentStatus } from '../providers/types.js';
import { fmt, tr, type Tri } from '../web/messages.js';
import { demoName } from './demo-names.js';

export type CardType = 'options' | 'checkout' | 'order' | 'orders' | 'cancellation' | 'handoff' | 'message';

export interface CardAction {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'destructive' | 'link';
  kind: 'confirm' | 'decline' | 'tool' | 'open_url' | 'prepare_cancel' | 'refresh';
  /** confirm actions: how the app must verify the user before calling the endpoint. */
  requires_user_verification?: 'tap' | 'biometric';
  endpoint?: { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> };
  tool?: { name: string; arguments: Record<string, unknown> };
  url?: string;
}

export interface CardOption {
  id: string;
  title: string;
  subtitle?: string;
  price?: string;
  eta?: string;
  badges?: string[];
  disabled_reason?: string;
  action?: CardAction;
}

export interface Card {
  schema: 'unyly.card.v1';
  type: CardType;
  id: string;
  service?: Service;
  title: string;
  subtitle?: string;
  demo: boolean;
  badges?: string[];
  route?: { from: string; to: string; distance_km?: number; minutes?: number };
  options?: CardOption[];
  lines?: { title: string; quantity?: number; detail?: string; value: string }[];
  breakdown?: { label: string; value: string }[];
  total?: { label: string; value: string; amount_minor: number; currency: string };
  status?: { code: string; label: string; progress: number; is_final: boolean; eta_at: string | null; steps: { code: string; label: string; done: boolean }[] };
  courier?: { name: string; vehicle: string; plate: string; rating: number; fictional: boolean };
  actions: CardAction[];
  footnote?: string;
  expires_at?: string;
}

export const T = {
  demo: { en: 'Demo: nothing is delivered or charged', ru: 'Демо: ничего не доставляется и не списывается', th: 'เดโม: ไม่มีการจัดส่งหรือเรียกเก็บเงินจริง' },
  confirmOrder: { en: 'Confirm order', ru: 'Подтвердить заказ', th: 'ยืนยันคำสั่งซื้อ' },
  confirmRide: { en: 'Confirm ride', ru: 'Заказать поездку', th: 'ยืนยันการเรียกรถ' },
  confirmParcel: { en: 'Send parcel', ru: 'Отправить посылку', th: 'ส่งพัสดุ' },
  notNow: { en: 'Not now', ru: 'Не сейчас', th: 'ไว้ก่อน' },
  total: { en: 'Total', ru: 'Итого', th: 'รวม' },
  items: { en: 'Items', ru: 'Товары', th: 'สินค้า' },
  delivery: { en: 'Delivery', ru: 'Доставка', th: 'ค่าส่ง' },
  service: { en: 'Service fee', ru: 'Сервисный сбор', th: 'ค่าบริการ' },
  smallOrder: { en: 'Small order fee', ru: 'Доплата за небольшой заказ', th: 'ค่าธรรมเนียมคำสั่งซื้อขนาดเล็ก' },
  discount: { en: 'Discount', ru: 'Скидка', th: 'ส่วนลด' },
  min: { en: 'min', ru: 'мин', th: 'นาที' },
  choose: { en: 'Choose', ru: 'Выбрать', th: 'เลือก' },
  cancelOrder: { en: 'Cancel order', ru: 'Отменить заказ', th: 'ยกเลิกคำสั่งซื้อ' },
  confirmCancel: { en: 'Confirm cancellation', ru: 'Подтвердить отмену', th: 'ยืนยันการยกเลิก' },
  keep: { en: 'Keep order', ru: 'Оставить заказ', th: 'ไม่ยกเลิก' },
  biometric: { en: 'Face ID required for this amount', ru: 'Для этой суммы нужен Face ID', th: 'ยอดนี้ต้องยืนยันด้วย Face ID' },
  estimate: { en: 'Times and fares are estimates', ru: 'Время и цены ориентировочные', th: 'เวลาและค่าโดยสารเป็นค่าประมาณ' },
  openGrab: { en: 'Open in Grab', ru: 'Открыть в Grab', th: 'เปิดใน Grab' },
} as const;

const STEPS: Record<Service, FulfillmentStatus[]> = {
  food: ['accepted', 'preparing', 'picked_up', 'delivered'],
  mart: ['accepted', 'preparing', 'picked_up', 'delivered'],
  ride: ['accepted', 'preparing', 'picked_up', 'delivered'],
  express: ['accepted', 'preparing', 'picked_up', 'delivered'],
};
const PROGRESS: Record<FulfillmentStatus, number> = { submitted: 0.1, accepted: 0.3, preparing: 0.5, picked_up: 0.75, delivered: 1, cancelled: 1, failed: 1 };

export function statusBlock(service: Service, status: FulfillmentStatus, isFinal: boolean, etaAt: string | null, l: Locale) {
  const order = STEPS[service];
  const idx = order.indexOf(status);
  return {
    code: status,
    label: statusLabel(service, status, l),
    progress: PROGRESS[status],
    is_final: isFinal,
    eta_at: etaAt,
    steps: order.map((s, i) => ({ code: s, label: statusLabel(service, s, l), done: idx >= 0 && i <= idx })),
  };
}

const FIRST = ['Somchai', 'Niran', 'Anan', 'Kittisak', 'Pimchanok', 'Wanida', 'Thanakorn', 'Supaporn'];
const LAST = ['K.', 'P.', 'S.', 'W.', 'T.', 'R.', 'C.', 'M.'];
const THAI_LETTERS = ['กข', 'ขค', 'งจ', 'ฉช', 'ฒณ', 'ทน', 'บป', 'ผฝ'];

/** A fictional, deterministic courier for demo orders (never shown for real orders). */
export function demoCourier(ref: string, service: Service, l: Locale, itemId?: string) {
  const h = createHash('sha256').update(ref).digest();
  // The vehicle follows what was booked: a bike ride or bike courier never shows a car.
  const bike = service === 'food' || service === 'mart' || /bike/i.test(itemId ?? '');
  const vehicle = bike
    ? tr(l, { en: 'Honda Wave 125, red', ru: 'Honda Wave 125, красный', th: 'Honda Wave 125 สีแดง' })
    : tr(l, { en: 'Toyota Corolla Altis, silver', ru: 'Toyota Corolla Altis, серебристый', th: 'Toyota Corolla Altis สีเงิน' });
  return {
    name: `${FIRST[h[0] % FIRST.length]} ${LAST[h[1] % LAST.length]}`,
    vehicle,
    plate: `${(h[2] % 9) + 1}${THAI_LETTERS[h[3] % THAI_LETTERS.length]} ${String(1000 + ((h[5] << 8) + h[6]) % 9000)}`,
    rating: Math.round((4.7 + (h[7] % 30) / 100) * 100) / 100,
    fictional: true,
  };
}

export const minutes = (l: Locale, a: number, b?: number) => `${a}${b && b !== a ? `-${b}` : ''} ${tr(l, T.min)}`;

/** The fixed demo provider sentences shown on cards, in every interface language (other text passes through). */
const DEMO_TEXTS: Tri[] = [
  { en: 'Demo wallet (no real charge)', ru: 'Демо-кошелёк (без реального списания)', th: 'กระเป๋าเงินเดโม (ไม่มีการเรียกเก็บจริง)' },
  { en: 'Demo terms: free cancellation before the restaurant starts preparing; 50% of the total after that; not possible once picked up.', ru: 'Демо-условия: бесплатная отмена, пока ресторан не начал готовить; потом 50% суммы; после передачи курьеру отмена невозможна.', th: 'เงื่อนไขเดโม: ยกเลิกฟรีก่อนร้านเริ่มทำอาหาร หลังจากนั้นคิด 50% ของยอดรวม ยกเลิกไม่ได้หลังไรเดอร์รับของแล้ว' },
  { en: 'Demo terms: free cancellation before the store starts picking; 50% of the total after that; not possible once picked up.', ru: 'Демо-условия: бесплатная отмена, пока магазин не начал собирать заказ; потом 50% суммы; после передачи курьеру отмена невозможна.', th: 'เงื่อนไขเดโม: ยกเลิกฟรีก่อนร้านเริ่มจัดสินค้า หลังจากนั้นคิด 50% ของยอดรวม ยกเลิกไม่ได้หลังไรเดอร์รับของแล้ว' },
  { en: 'Demo terms: free cancellation right after a driver is assigned; 30 THB once the driver is on the way; not possible after pickup.', ru: 'Демо-условия: бесплатная отмена сразу после назначения водителя; 30 бат, когда водитель уже едет; после посадки отмена невозможна.', th: 'เงื่อนไขเดโม: ยกเลิกฟรีทันทีหลังได้คนขับ คิด 30 บาทหากคนขับกำลังเดินทางมา ยกเลิกไม่ได้หลังขึ้นรถ' },
  { en: 'Demo terms: free cancellation right after a courier is assigned; 20 THB once the courier is on the way; not possible after pickup.', ru: 'Демо-условия: бесплатная отмена сразу после назначения курьера; 20 бат, когда курьер уже едет; после забора посылки отмена невозможна.', th: 'เงื่อนไขเดโม: ยกเลิกฟรีทันทีหลังได้ไรเดอร์ คิด 20 บาทหากไรเดอร์กำลังเดินทางมา ยกเลิกไม่ได้หลังไรเดอร์รับพัสดุ' },
  { en: 'Allergen data comes from restaurants and may be missing or incomplete. Unyly never marks a dish as safe. Confirm with the restaurant.', ru: 'Данные об аллергенах дают рестораны, они могут быть неполными. Мы никогда не называем блюдо безопасным. Уточните у ресторана.', th: 'ข้อมูลสารก่อภูมิแพ้มาจากร้านและอาจไม่ครบถ้วน เราไม่รับรองว่าเมนูใดปลอดภัย โปรดสอบถามร้าน' },
  // Vehicle and courier types (demo catalog descriptions).
  { en: 'Motorbike taxi, 1 passenger, helmet provided.', ru: 'Мототакси, 1 пассажир, шлем выдаётся.', th: 'มอเตอร์ไซค์รับจ้าง ผู้โดยสาร 1 คน มีหมวกกันน็อกให้' },
  { en: 'Nearest available car or taxi, up to 4 passengers.', ru: 'Ближайшая свободная машина или такси, до 4 пассажиров.', th: 'รถหรือแท็กซี่ที่ใกล้ที่สุด นั่งได้สูงสุด 4 คน' },
  { en: 'Licensed metered taxi, up to 4 passengers.', ru: 'Лицензированное такси со счётчиком, до 4 пассажиров.', th: 'แท็กซี่มิเตอร์จดทะเบียนถูกต้อง นั่งได้สูงสุด 4 คน' },
  { en: 'Newer, larger cars with top-rated drivers.', ru: 'Новые просторные машины, водители с высоким рейтингом.', th: 'รถรุ่นใหม่ กว้างขวาง คนขับคะแนนรีวิวสูง' },
  { en: 'Up to 6 passengers or extra luggage.', ru: 'До 6 пассажиров или много багажа.', th: 'นั่งได้สูงสุด 6 คน หรือมีสัมภาระเยอะ' },
  { en: 'Van for groups of up to 10.', ru: 'Минивэн для компании до 10 человек.', th: 'รถตู้สำหรับกลุ่มสูงสุด 10 คน' },
  { en: 'Documents and parcels up to 20 kg.', ru: 'Документы и посылки до 20 кг.', th: 'เอกสารและพัสดุไม่เกิน 20 กก.' },
  { en: 'Bulky parcels up to 100 kg.', ru: 'Крупные посылки до 100 кг.', th: 'พัสดุขนาดใหญ่ไม่เกิน 100 กก.' },
  { en: 'Large items up to 200 kg.', ru: 'Крупногабаритные вещи до 200 кг.', th: 'ของชิ้นใหญ่ไม่เกิน 200 กก.' },
  { en: 'Furniture and moves up to 300 kg.', ru: 'Мебель и переезды до 300 кг.', th: 'เฟอร์นิเจอร์และขนย้ายไม่เกิน 300 กก.' },
  { en: 'Metered: the final fare may differ from the estimate.', ru: 'По счётчику: итоговая цена может отличаться от оценки.', th: 'คิดตามมิเตอร์ ค่าโดยสารจริงอาจต่างจากที่ประเมิน' },
  { en: 'Airport pickup fee', ru: 'Сбор за посадку в аэропорту', th: 'ค่าธรรมเนียมรับที่สนามบิน' },
  // Store notes and refusals.
  { en: 'Does not deliver to your default address', ru: 'Не доставляет по вашему адресу', th: 'ไม่จัดส่งไปยังที่อยู่ของคุณ' },
  { en: 'No delivery address set: availability and fees unknown', ru: 'Адрес доставки не задан: доступность и сборы неизвестны', th: 'ยังไม่ได้ตั้งที่อยู่จัดส่ง จึงยังไม่ทราบว่าส่งได้หรือไม่และค่าธรรมเนียมเท่าไร' },
  { en: 'Pickup and drop-off are the same place', ru: 'Точка отправления и пункт назначения совпадают', th: 'จุดรับและจุดส่งเป็นที่เดียวกัน' },
  { en: 'Cannot cancel: the trip has started or ended.', ru: 'Отменить нельзя: поездка уже началась или завершилась.', th: 'ยกเลิกไม่ได้ การเดินทางเริ่มหรือสิ้นสุดแล้ว' },
  { en: 'Cannot cancel: the parcel has been picked up.', ru: 'Отменить нельзя: посылку уже забрали.', th: 'ยกเลิกไม่ได้ ไรเดอร์รับพัสดุไปแล้ว' },
];
const DEMO_TEXT = new Map(DEMO_TEXTS.map((x) => [x.en, x]));

/**
 * Signed Partner API (the documented contract): cards and notifications are written in English, Russian and
 * Thai; every other locale gets English throughout, never a mix.
 */
export const cardLocale = (l: Locale | string | null | undefined): Locale => (l === 'ru' || l === 'th' ? l : 'en');
/** The website demo chat (/ari) speaks every interface language: replies, cards, statuses and notifications. */
export const chatLocale = (l: Locale | string | null | undefined): Locale => (isLocaleCode(l) ? l : 'en');

/** tr() for a sentence with {placeholders}: the template comes from the language, the values are data. */
export const trf = (l: Locale, t: Tri, vars: Record<string, string | number>): string => fmt(tr(l, t), vars);

export const seatsBadge = (l: Locale, n: number) => (n === 1
  ? trf(l, { en: '{n} seat', ru: 'Мест: {n}', th: '{n} ที่นั่ง' }, { n })
  : trf(l, { en: '{n} seats', ru: 'Мест: {n}', th: '{n} ที่นั่ง' }, { n }));

/**
 * Names and notes from the demo catalog (dishes, goods, vehicles, options) in the card language. The catalog
 * languages have them translated; Russian and Thai show them as the store wrote them, and so does unknown text.
 */
export function dataText(text: string | null | undefined, l: Locale): string {
  if (!text) return '';
  if (l === 'en') return text;
  const exact = DEMO_TEXT.get(text);
  if (exact) return tr(l, exact);
  const own = demoName(l, text) ?? lookup(l, text);
  if (own) return own;
  // "Wrapping: Gift box": the option group and the option are translated separately.
  const m = /^([^:]{1,40}): (.+)$/.exec(text);
  if (m) {
    const a = demoName(l, m[1]) ?? lookup(l, m[1]);
    const b = demoName(l, m[2]) ?? lookup(l, m[2]);
    if (a || b) return `${a ?? m[1]}: ${b ?? m[2]}`;
  }
  return text;
}

export function localText(text: string | null | undefined, l: Locale): string | undefined {
  if (!text) return undefined;
  if (l === 'en') return text;
  const exact = DEMO_TEXT.get(text);
  if (exact) return tr(l, exact);
  if (/^Cannot cancel: /.test(text)) return tr(l, { en: 'This order can no longer be cancelled.', ru: 'Этот заказ уже нельзя отменить.', th: 'ยกเลิกคำสั่งซื้อนี้ไม่ได้แล้ว' });
  if (/^Closed: /.test(text)) return tr(l, { en: 'Closed right now', ru: 'Сейчас закрыто', th: 'ร้านปิดอยู่' });
  const seats = /^Seats (\d+), passengers (\d+)$/.exec(text);
  if (seats) return trf(l, { en: 'Seats {seats}, passengers {passengers}', ru: 'Мест: {seats}, пассажиров: {passengers}', th: '{seats} ที่นั่ง ผู้โดยสาร {passengers} คน' }, { seats: seats[1], passengers: seats[2] });
  const m = /^(Free cancellation: the (driver|courier|restaurant|store) (?:has just been assigned|has not started preparing) \(demo\)\.)$/.exec(text);
  if (m) return tr(l, { en: 'Free cancellation (demo).', ru: 'Бесплатная отмена (демо).', th: 'ยกเลิกฟรี (เดโม)' });
  const fee = /^The (driver|courier) is on the way: (\d+) THB cancellation fee \(demo, not charged\)\.$/.exec(text);
  if (fee) {
    return fee[1] === 'driver'
      ? trf(l, { en: 'The driver is on the way: {fee} THB cancellation fee (demo, not charged).', ru: 'Водитель уже едет: плата за отмену {fee} бат (демо, не списывается).', th: 'คนขับกำลังเดินทางมา ค่าธรรมเนียมการยกเลิก {fee} บาท (เดโม ไม่เรียกเก็บจริง)' }, { fee: fee[2] })
      : trf(l, { en: 'The courier is on the way: {fee} THB cancellation fee (demo, not charged).', ru: 'Курьер уже едет: плата за отмену {fee} бат (демо, не списывается).', th: 'ไรเดอร์กำลังเดินทางมา ค่าธรรมเนียมการยกเลิก {fee} บาท (เดโม ไม่เรียกเก็บจริง)' }, { fee: fee[2] });
  }
  if (/is preparing the order: 50% cancellation fee/.test(text)) return tr(l, { en: 'The order is being prepared: 50% cancellation fee (demo, not charged).', ru: 'Заказ уже готовят: плата за отмену 50% (демо, не списывается).', th: 'ร้านกำลังเตรียมคำสั่งซื้อ ค่าธรรมเนียมการยกเลิก 50% (เดโม ไม่เรียกเก็บจริง)' });
  // Russian and Thai keep provider text they have no wording for; the catalog languages may know it (store notices).
  return demoName(l, text) ?? (l === 'ru' || l === 'th' ? text : lookup(l, text) ?? text);
}

/**
 * A place name or a route ("A → B") in the card language: the demo home label and Bangkok landmarks have
 * Russian and Thai names, the catalog languages translate what their catalogs know, anything else (a street
 * address the user typed) stays as written.
 */
export function placeText(text: string | null | undefined, l: Locale): string | undefined {
  if (!text) return text ?? undefined;
  if (l === 'en') return text;
  return text.split(' → ').map((p) => demoName(l, p) ?? (p === 'Home' ? lookup(l, p) : undefined) ?? p).join(' → ');
}
