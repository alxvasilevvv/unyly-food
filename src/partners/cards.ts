// Cards: a small, stable JSON shape that a partner app (Ari) renders natively. One schema for every
// Grab service: options to choose from, a checkout to confirm, an order to track, a cancellation.
import { createHash } from 'node:crypto';
import type { Locale } from '../domain/locales.js';
import { statusLabel } from '../domain/labels.js';
import type { Service } from '../domain/regions.js';
import type { FulfillmentStatus } from '../providers/types.js';
import { tr } from '../web/messages.js';

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
  notNow: { en: 'Not now', ru: 'Не сейчас', th: 'ไม่ใช่ตอนนี้' },
  total: { en: 'Total', ru: 'Итого', th: 'รวม' },
  items: { en: 'Items', ru: 'Товары', th: 'สินค้า' },
  delivery: { en: 'Delivery', ru: 'Доставка', th: 'ค่าส่ง' },
  service: { en: 'Service fee', ru: 'Сервисный сбор', th: 'ค่าบริการ' },
  smallOrder: { en: 'Small order fee', ru: 'Сбор за малый заказ', th: 'ค่าธรรมเนียมสั่งน้อย' },
  discount: { en: 'Discount', ru: 'Скидка', th: 'ส่วนลด' },
  min: { en: 'min', ru: 'мин', th: 'นาที' },
  choose: { en: 'Choose', ru: 'Выбрать', th: 'เลือก' },
  cancelOrder: { en: 'Cancel order', ru: 'Отменить заказ', th: 'ยกเลิกคำสั่งซื้อ' },
  confirmCancel: { en: 'Confirm cancellation', ru: 'Подтвердить отмену', th: 'ยืนยันการยกเลิก' },
  keep: { en: 'Keep order', ru: 'Оставить заказ', th: 'เก็บคำสั่งซื้อไว้' },
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
export function demoCourier(ref: string, service: Service, l: Locale) {
  const h = createHash('sha256').update(ref).digest();
  const bike = service === 'food' || service === 'mart' || (service === 'express' && h[4] % 2 === 0);
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
