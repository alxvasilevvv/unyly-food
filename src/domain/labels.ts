// Human wording of the shared fulfilment states, per service and language.
import type { FulfillmentStatus } from '../providers/types.js';
import type { Service } from './regions.js';

import { lookup } from '../i18n/index.js';
import type { Locale } from './locales.js';

type L = Locale;
type Tri = { ru: string; en: string; th: string };

const COMMON: Partial<Record<FulfillmentStatus, Tri>> = {
  submitted: { en: 'Sent', ru: 'Отправлен', th: 'ส่งแล้ว' },
  cancelled: { en: 'Cancelled', ru: 'Отменён', th: 'ยกเลิกแล้ว' },
  failed: { en: 'Failed', ru: 'Не выполнен', th: 'ไม่สำเร็จ' },
};

const BY_SERVICE: Record<Service, Partial<Record<FulfillmentStatus, Tri>>> = {
  food: {
    accepted: { en: 'Restaurant accepted', ru: 'Ресторан принял заказ', th: 'ร้านรับออร์เดอร์แล้ว' },
    preparing: { en: 'Preparing', ru: 'Готовится', th: 'กำลังเตรียมอาหาร' },
    picked_up: { en: 'On the way', ru: 'Курьер в пути', th: 'ไรเดอร์กำลังไปส่ง' },
    delivered: { en: 'Delivered', ru: 'Доставлен', th: 'ส่งถึงแล้ว' },
  },
  mart: {
    accepted: { en: 'Store accepted', ru: 'Магазин принял заказ', th: 'ร้านรับออร์เดอร์แล้ว' },
    preparing: { en: 'Picking items', ru: 'Собирают заказ', th: 'กำลังจัดสินค้า' },
    picked_up: { en: 'On the way', ru: 'Курьер в пути', th: 'ไรเดอร์กำลังไปส่ง' },
    delivered: { en: 'Delivered', ru: 'Доставлен', th: 'ส่งถึงแล้ว' },
  },
  ride: {
    accepted: { en: 'Driver assigned', ru: 'Водитель назначен', th: 'ได้คนขับแล้ว' },
    preparing: { en: 'Driver arriving', ru: 'Водитель едет к вам', th: 'คนขับกำลังมารับ' },
    picked_up: { en: 'On trip', ru: 'В пути', th: 'กำลังเดินทาง' },
    delivered: { en: 'Arrived', ru: 'Поездка завершена', th: 'ถึงที่หมายแล้ว' },
  },
  express: {
    accepted: { en: 'Courier assigned', ru: 'Курьер назначен', th: 'ได้ผู้ส่งแล้ว' },
    preparing: { en: 'Courier heading to pickup', ru: 'Курьер едет за посылкой', th: 'ผู้ส่งกำลังไปรับพัสดุ' },
    picked_up: { en: 'Parcel in transit', ru: 'Посылка в пути', th: 'พัสดุกำลังจัดส่ง' },
    delivered: { en: 'Parcel delivered', ru: 'Посылка доставлена', th: 'ส่งพัสดุถึงแล้ว' },
  },
};

export function statusLabel(service: Service, status: FulfillmentStatus, l: L = 'en'): string {
  const t = BY_SERVICE[service]?.[status] ?? COMMON[status];
  if (!t) return status;
  return (t as Record<string, string>)[l] ?? lookup(l, t.en) ?? t.en;
}

export const SERVICE_NAME: Record<Service, Tri> = {
  food: { en: 'Food', ru: 'Еда', th: 'อาหาร' },
  mart: { en: 'Mart', ru: 'Магазины', th: 'มาร์ท' },
  ride: { en: 'Ride', ru: 'Поездка', th: 'เดินทาง' },
  express: { en: 'Parcel', ru: 'Посылка', th: 'ส่งพัสดุ' },
};
