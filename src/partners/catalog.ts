// What Ari can do with each Grab product, and how far the Unyly integration is. Shown on the website
// coverage map and returned by GET /partner/v1/catalog. Statuses:
//   built      Implemented against Grab's public API docs; switches on with Grab credentials.
//   estimate   Real prices and ETAs through a Grab API; booking finishes in the Grab app (deep link).
//   handoff    No consumer API: Ari prepares the order and opens Grab with it.
//   proposed   Needs a partner scope that Grab does not publish yet (our ask in the partnership).
//   designed   Public API exists; adapter designed and documented, built after onboarding.
export type CoverageStatus = 'built' | 'estimate' | 'handoff' | 'proposed' | 'designed';

type Tri = { en: string; ru: string; th: string };

export interface GrabProduct {
  id: string;
  name: string;
  group: 'move' | 'deliver' | 'pay' | 'identity' | 'rewards' | 'more';
  ari: Tri;
  today: CoverageStatus;
  /** Public Grab API used (as named on developer.grab.com). */
  api: string;
  /** What changes once Grab grants access. */
  with_grab: Tri;
}

export const GRAB_PRODUCTS: GrabProduct[] = [
  {
    id: 'rides', name: 'GrabCar · GrabBike · GrabTaxi', group: 'move', today: 'estimate', api: 'Partner Farefeed API (ride.estimate)',
    ari: { en: '"Taxi to the airport": real fares, ETA and surge for every ride type; one tap opens Grab with the trip filled in.', ru: '«Такси в аэропорт»: реальные цены, время подачи и повышенный тариф для всех классов; одно нажатие открывает Grab с готовым маршрутом.', th: '"แท็กซี่ไปสนามบิน": ค่าโดยสารจริง เวลารถมาถึง และช่วงความต้องการสูงของทุกประเภทรถ แตะครั้งเดียวเปิด Grab พร้อมเส้นทาง' },
    with_grab: { en: 'A ride-booking partner scope would let Ari book and track the ride end to end.', ru: 'Партнёрский доступ к бронированию позволит Ari заказывать и отслеживать поездку целиком.', th: 'สิทธิ์จองรถสำหรับพาร์ทเนอร์จะให้ Ari จองและติดตามการเดินทางได้ครบ' },
  },
  {
    id: 'express', name: 'GrabExpress', group: 'deliver', today: 'built', api: 'GrabExpress API (quotes, deliveries, tracking webhook, cancel, tip)',
    ari: { en: '"Send these documents to my office": quote, booking, live courier tracking and cancellation, all inside Ari.', ru: '«Отправь документы в офис»: цена, заказ курьера, отслеживание и отмена прямо в Ari.', th: '"ส่งเอกสารไปออฟฟิศ": ราคา จองไรเดอร์ ติดตามสด และยกเลิกได้ใน Ari' },
    with_grab: { en: 'Goes live after sandbox certification, once Grab issues credentials per city.', ru: 'Запуск после сертификации в песочнице и выдачи ключей по городам.', th: 'เปิดใช้จริงหลังผ่านการทดสอบ sandbox และได้คีย์รายเมืองจาก Grab' },
  },
  {
    id: 'food', name: 'GrabFood', group: 'deliver', today: 'handoff', api: 'No consumer ordering API (POS API is merchant-side)',
    ari: { en: '"Dinner for two under 600 baht, no nuts": Ari picks dishes, checks allergens and budget, then hands the ready cart to Grab.', ru: '«Ужин на двоих до 600 бат без орехов»: Ari подбирает блюда, проверяет аллергены и бюджет и передаёт готовую корзину в Grab.', th: '"มื้อเย็นสองคนไม่เกิน 600 บาท ไม่ใส่ถั่ว": Ari เลือกเมนู ตรวจสารก่อภูมิแพ้และงบ แล้วส่งตะกร้าให้ Grab' },
    with_grab: { en: 'Our main ask: a consumer ordering scope (menus, cart, place order, status) for GrabFood.', ru: 'Наш главный запрос: доступ к заказу GrabFood для потребителя (меню, корзина, заказ, статус).', th: 'คำขอหลัก: สิทธิ์สั่ง GrabFood สำหรับผู้บริโภค (เมนู ตะกร้า สั่ง สถานะ)' },
  },
  {
    id: 'mart', name: 'GrabMart', group: 'deliver', today: 'handoff', api: 'No consumer ordering API (POS API is merchant-side)',
    ari: { en: 'Groceries, flowers, pharmacy and cakes from one sentence, with required options and limits respected.', ru: 'Продукты, цветы, аптека и торты одной фразой, с обязательными опциями и лимитами.', th: 'ของชำ ดอกไม้ ร้านยา และเค้ก ด้วยประโยคเดียว ตามตัวเลือกและข้อจำกัดของร้าน' },
    with_grab: { en: 'Same scope as GrabFood: the order is placed and tracked inside Ari.', ru: 'Тот же доступ, что и для GrabFood: заказ и отслеживание прямо в Ari.', th: 'สิทธิ์เดียวกับ GrabFood: สั่งและติดตามได้ใน Ari' },
  },
  {
    id: 'grabid', name: 'Login with Grab', group: 'identity', today: 'built', api: 'GrabID OAuth 2.0 / OIDC with PKCE',
    ari: { en: 'The user links their Grab account to Ari once. No passwords pass through Ari or Unyly.', ru: 'Пользователь один раз связывает аккаунт Grab с Ari. Пароли не проходят через Ari и Unyly.', th: 'ผู้ใช้เชื่อมบัญชี Grab กับ Ari ครั้งเดียว ไม่มีรหัสผ่านผ่าน Ari หรือ Unyly' },
    with_grab: { en: 'Switches on with GrabID client credentials.', ru: 'Включается с ключами GrabID.', th: 'เปิดใช้งานได้เมื่อมีคีย์ GrabID' },
  },
  {
    id: 'grabpay', name: 'GrabPay', group: 'pay', today: 'built', api: 'GrabPay One-time Charge v2 (refunds, webhooks)',
    ari: { en: 'Orders Ari books (parcels first) are paid with GrabPay; refunds are automatic when a booking fails.', ru: 'Заказы, которые оформляет Ari (сначала посылки), оплачиваются GrabPay; при сбое деньги возвращаются автоматически.', th: 'คำสั่งซื้อที่ Ari จอง (เริ่มจากพัสดุ) ชำระด้วย GrabPay และคืนเงินอัตโนมัติเมื่อจองไม่สำเร็จ' },
    with_grab: { en: 'Switches on with GrabPay merchant credentials.', ru: 'Включается с ключами мерчанта GrabPay.', th: 'เปิดใช้งานได้เมื่อมีคีย์ร้านค้า GrabPay' },
  },
  {
    id: 'tokenisation', name: 'GrabPay Tokenisation', group: 'pay', today: 'designed', api: 'Tokenisation API v4 (bind, charge, refund, unbind; SG, MY, PH)',
    ari: { en: 'Link GrabPay once, then pay by voice with Face ID: no redirect on every order (Singapore, Malaysia, Philippines today).', ru: 'Привязать GrabPay один раз и платить голосом с Face ID, без перехода на каждый заказ (сейчас Сингапур, Малайзия, Филиппины).', th: 'ผูก GrabPay ครั้งเดียว แล้วจ่ายด้วยเสียงและ Face ID ไม่ต้องเปลี่ยนหน้าทุกครั้ง (ตอนนี้สิงคโปร์ มาเลเซีย ฟิลิปปินส์)' },
    with_grab: { en: 'Tokenised charges for orders Ari books as the merchant (Tokenisation does not pay for orders placed in the Grab app).', ru: 'Платежи по токену за заказы, которые Ari оформляет как мерчант (заказы в приложении Grab так оплатить нельзя).', th: 'ชำระแบบโทเค็นสำหรับคำสั่งซื้อที่ Ari จองในฐานะร้านค้า (ใช้จ่ายคำสั่งซื้อในแอป Grab ไม่ได้)' },
  },
  {
    id: 'rewards', name: 'GrabRewards', group: 'rewards', today: 'proposed', api: 'Points Earning API (rewards/v3/events), GrabRewards Tier',
    ari: { en: 'Proposed: GrabRewards points for purchases paid through Ari; Ari can show the user\'s tier.', ru: 'Предлагаем: баллы GrabRewards за покупки, оплаченные через Ari; Ari показывает уровень пользователя.', th: 'ข้อเสนอ: คะแนน GrabRewards สำหรับการซื้อที่ชำระผ่าน Ari และ Ari แสดงระดับสมาชิกได้' },
    with_grab: { en: 'Points on every Ari order: a reason to keep ordering Grab through Ari.', ru: 'Баллы за каждый заказ через Ari: повод заказывать Grab снова.', th: 'คะแนนทุกคำสั่งซื้อผ่าน Ari: เหตุผลให้สั่ง Grab ต่อ' },
  },
  {
    id: 'gifts', name: 'GrabGifts', group: 'more', today: 'designed', api: 'GrabGifts Partner API (orders, gift links, balance)',
    ari: { en: '"Send Mai a lunch voucher for her birthday": Grab gift vouchers by voice.', ru: '«Подари Май обед на день рождения»: подарочные ваучеры Grab голосом.', th: '"ส่งบัตรกำนัลมื้อกลางวันให้คุณใหม่ในวันเกิด": ส่งของขวัญ Grab ด้วยเสียง' },
    with_grab: { en: 'Corporate gifting and vouchers through Ari for teams.', ru: 'Корпоративные подарки и ваучеры через Ari для команд.', th: 'ของขวัญองค์กรและบัตรกำนัลผ่าน Ari สำหรับทีม' },
  },
  {
    id: 'digital', name: 'GrabKios digital products and bills', group: 'more', today: 'designed', api: 'Digital Products API, Biller Gateway API (Indonesia)',
    ari: { en: '"Top up my phone with 50k": mobile credit, data, game vouchers and bills by voice (Indonesia first).', ru: '«Пополни телефон на 50 тысяч»: связь, интернет, игровые ваучеры и счета голосом (сначала Индонезия).', th: '"เติมเงินโทรศัพท์ 50k": เติมเงิน อินเทอร์เน็ต บัตรเกม และจ่ายบิลด้วยเสียง (เริ่มที่อินโดนีเซีย)' },
    with_grab: { en: 'Daily small payments move into Grab through Ari.', ru: 'Ежедневные мелкие платежи идут в Grab через Ari.', th: 'การจ่ายเงินรายวันผ่าน Grab ด้วย Ari' },
  },
  {
    id: 'chat', name: 'GrabChat', group: 'move', today: 'designed', api: 'GrabChat Partner API and Web UI (bookings made through the partner)',
    ari: { en: '"Tell the driver I\'m at gate 3": Ari relays messages to the driver or courier of a booking Ari made, and reads replies aloud.', ru: '«Скажи водителю, что я у выхода 3»: Ari передаёт сообщения водителю или курьеру заказа, оформленного через Ari, и читает ответы вслух.', th: '"บอกคนขับว่าฉันอยู่ประตู 3": Ari ส่งข้อความถึงคนขับหรือไรเดอร์ของการจองผ่าน Ari และอ่านคำตอบให้ฟัง' },
    with_grab: { en: 'Hands-free chat with the driver for every booking made through Ari.', ru: 'Чат с водителем голосом, без рук, для каждого заказа через Ari.', th: 'แชทกับคนขับแบบไม่ต้องใช้มือสำหรับทุกการจองผ่าน Ari' },
  },
  {
    id: 'business', name: 'Grab for Business', group: 'more', today: 'designed', api: 'Grab For Business Partner API (transactions)',
    ari: { en: 'Ari files business rides and meals as expenses and answers "how much did we spend on Grab this month?".', ru: 'Ari учитывает рабочие поездки и обеды как расходы и отвечает на «сколько мы потратили на Grab в этом месяце?».', th: 'Ari บันทึกการเดินทางและอาหารเพื่องานเป็นค่าใช้จ่าย และตอบได้ว่า "เดือนนี้ใช้ Grab ไปเท่าไร"' },
    with_grab: { en: 'Read-only expense export with the company\'s consent.', ru: 'Выгрузка расходов только на чтение с согласия компании.', th: 'ส่งออกค่าใช้จ่ายแบบอ่านอย่างเดียวเมื่อบริษัทยินยอม' },
  },
  {
    id: 'defence', name: 'GrabDefence', group: 'identity', today: 'designed', api: 'Risk Evaluation',
    ari: { en: 'Risk check before each confirmation: helps stop misuse of a linked account.', ru: 'Проверка риска перед каждым подтверждением: защита привязанного аккаунта.', th: 'ตรวจความเสี่ยงก่อนยืนยันทุกครั้ง ป้องกันการใช้บัญชีโดยมิชอบ' },
    with_grab: { en: 'Grab\'s fraud signals on every Ari order.', ru: 'Антифрод Grab на каждом заказе Ari.', th: 'สัญญาณป้องกันการฉ้อโกงของ Grab ในทุกคำสั่งซื้อผ่าน Ari' },
  },
];

export interface Market {
  code: string;
  country: Tri;
  currency: string;
  languages: string[];
  express_cities: string[];
  demo: boolean;
}

export const MARKETS: Market[] = [
  { code: 'TH', country: { en: 'Thailand', ru: 'Таиланд', th: 'ไทย' }, currency: 'THB', languages: ['th', 'en'], express_cities: ['BKK'], demo: true },
  { code: 'SG', country: { en: 'Singapore', ru: 'Сингапур', th: 'สิงคโปร์' }, currency: 'SGD', languages: ['en', 'zh', 'ms'], express_cities: ['SIN'], demo: false },
  { code: 'MY', country: { en: 'Malaysia', ru: 'Малайзия', th: 'มาเลเซีย' }, currency: 'MYR', languages: ['ms', 'en', 'zh'], express_cities: ['KUL'], demo: false },
  { code: 'ID', country: { en: 'Indonesia', ru: 'Индонезия', th: 'อินโดนีเซีย' }, currency: 'IDR', languages: ['id', 'en'], express_cities: ['CGK'], demo: false },
  { code: 'VN', country: { en: 'Vietnam', ru: 'Вьетнам', th: 'เวียดนาม' }, currency: 'VND', languages: ['vi', 'en'], express_cities: ['SGN', 'HAN'], demo: false },
  { code: 'PH', country: { en: 'Philippines', ru: 'Филиппины', th: 'ฟิลิปปินส์' }, currency: 'PHP', languages: ['fil', 'en'], express_cities: ['MNL'], demo: false },
  { code: 'KH', country: { en: 'Cambodia', ru: 'Камбоджа', th: 'กัมพูชา' }, currency: 'USD', languages: ['km', 'en'], express_cities: ['PNH'], demo: false },
  { code: 'MM', country: { en: 'Myanmar', ru: 'Мьянма', th: 'เมียนมา' }, currency: 'MMK', languages: ['my', 'en'], express_cities: ['RGN'], demo: false },
];

export function catalogFor(l: 'en' | 'ru' | 'th' = 'en') {
  return {
    products: GRAB_PRODUCTS.map((p) => ({ id: p.id, name: p.name, group: p.group, status: p.today, api: p.api, what_ari_does: p.ari[l], with_grab: p.with_grab[l] })),
    markets: MARKETS.map((m) => ({ code: m.code, country: m.country[l], currency: m.currency, languages: m.languages, express_cities: m.express_cities, demo_data: m.demo })),
  };
}
