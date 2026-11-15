// What Ari can do with each Grab product, and how far the Unyly integration is. Shown on the website
// coverage map and returned by GET /partner/v1/catalog. Statuses:
//   built      Implemented against Grab's public API docs; switches on with Grab credentials.
//   estimate   Real prices and ETAs through a Grab API; booking finishes in the Grab app (deep link).
//   handoff    No consumer API: Ari prepares a checklist and opens Grab; the user orders in the Grab app.
//   proposed   Needs access beyond Grab's public docs (a new scope or a bespoke enablement; our ask in the partnership).
//   designed   Public API exists; adapter designed and documented, built after onboarding.
export type CoverageStatus = 'built' | 'estimate' | 'handoff' | 'proposed' | 'designed';

type Tri = { en: string; ru: string; th: string };

export interface GrabProduct {
  id: string;
  name: string;
  group: 'move' | 'deliver' | 'pay' | 'identity' | 'rewards' | 'more';
  ari: Tri;
  today: CoverageStatus;
  /** Public Grab API used (as named on developer.grab.com). English; also returned by GET /partner/v1/catalog. */
  api: string;
  /** Website-only translation of `api` where it is a sentence, not a product name. */
  api_local?: { ru: string; th: string };
  /** What changes once Grab grants access. */
  with_grab: Tri;
}

export const GRAB_PRODUCTS: GrabProduct[] = [
  {
    id: 'rides', name: 'GrabCar · GrabBike · GrabTaxi', group: 'move', today: 'estimate', api: 'Partner Farefeed API (ride.estimate)',
    ari: { en: '"Taxi to the airport": fare range, pickup time and surge notice for each ride type Farefeed returns; one tap opens the Grab app with the trip filled in, and the user books there.', ru: '«Такси в аэропорт»: диапазон цены, время подачи и отметка о повышенном спросе для каждого класса из Farefeed; одно нажатие открывает приложение Grab с готовым маршрутом, бронирует пользователь уже там.', th: '"แท็กซี่ไปสนามบิน": ช่วงค่าโดยสาร เวลารอรถ และการแจ้งช่วงราคาสูงของรถแต่ละประเภทที่ Farefeed ส่งกลับ แตะครั้งเดียวก็เปิดแอป Grab พร้อมเส้นทางที่กรอกไว้แล้ว และผู้ใช้กดจองในแอป Grab' },
    with_grab: { en: 'A ride-booking partner scope (not public today) would let Ari book and track the ride end to end.', ru: 'Партнёрский доступ к бронированию (в публичной документации его нет) позволит Ari заказывать и отслеживать поездку целиком.', th: 'สิทธิ์จองรถสำหรับพาร์ทเนอร์ (ยังไม่มีในเอกสารสาธารณะ) จะให้ Ari จองและติดตามการเดินทางได้ครบทุกขั้นตอน' },
  },
  {
    id: 'express', name: 'GrabExpress', group: 'deliver', today: 'built', api: 'GrabExpress API (quotes, deliveries, tracking webhook, cancel, tip)',
    ari: { en: '"Send these documents to my office": quote, booking, live courier tracking and cancellation, all inside Ari.', ru: '«Отправь документы в офис»: цена, заказ курьера, отслеживание и отмена прямо в Ari.', th: '"ส่งเอกสารไปออฟฟิศ": เช็กราคา จองไรเดอร์ ติดตามแบบเรียลไทม์ และยกเลิก ทั้งหมดทำได้ใน Ari' },
    with_grab: { en: 'Goes live after sandbox certification, once Grab issues credentials per city. Unyly is the shipper of record; the user pays the fee Grab quotes.', ru: 'Запуск после сертификации в песочнице и выдачи ключей по городам. Отправителем по договору выступает Unyly, пользователь платит цену из расчёта Grab.', th: 'เปิดใช้งานจริงหลังผ่านการรับรองบน sandbox และได้รับคีย์รายเมืองจาก Grab โดย Unyly เป็นผู้ส่งตามสัญญา และผู้ใช้จ่ายค่าส่งตามราคาที่ Grab เสนอ' },
  },
  {
    id: 'food', name: 'GrabFood', group: 'deliver', today: 'handoff', api: 'No public consumer ordering API (GrabFood Partner API is merchant-side POS)',
    api_local: { ru: 'Публичного API для заказа от имени покупателя нет (GrabFood Partner API предназначен для POS мерчантов)', th: 'ไม่มี API สาธารณะสำหรับสั่งแทนผู้บริโภค (GrabFood Partner API เป็น API ฝั่งร้านค้าสำหรับ POS)' },
    ari: { en: '"Dinner for two under 600 baht, no nuts": Ari turns the request into a short checklist (dishes, budget, allergy note) and opens Grab; the user chooses and orders in the Grab app.', ru: '«Ужин на двоих до 600 бат без орехов»: Ari превращает просьбу в короткий чек-лист (блюда, бюджет, пометка об аллергии) и открывает Grab; выбирает и заказывает пользователь в приложении Grab.', th: '"มื้อเย็นสองคนไม่เกิน 600 บาท ไม่ใส่ถั่ว": Ari สรุปคำขอเป็นเช็กลิสต์สั้น ๆ (เมนู งบ หมายเหตุเรื่องแพ้อาหาร) แล้วเปิด Grab ให้ ผู้ใช้เลือกและสั่งเองในแอป Grab' },
    with_grab: { en: 'Our main ask: a consumer ordering scope (menus, cart, place order, status) for GrabFood.', ru: 'Наш главный запрос: доступ к заказу GrabFood для потребителя (меню, корзина, заказ, статус).', th: 'คำขอหลักของเรา: สิทธิ์สั่ง GrabFood สำหรับผู้บริโภค (เมนู ตะกร้า สั่ง สถานะ)' },
  },
  {
    id: 'mart', name: 'GrabMart', group: 'deliver', today: 'handoff', api: 'No public consumer ordering API (GrabMart Partner API is merchant-side POS)',
    api_local: { ru: 'Публичного API для заказа от имени покупателя нет (GrabMart Partner API предназначен для POS мерчантов)', th: 'ไม่มี API สาธารณะสำหรับสั่งแทนผู้บริโภค (GrabMart Partner API เป็น API ฝั่งร้านค้าสำหรับ POS)' },
    ari: { en: 'Groceries, flowers, pharmacy items and cakes: Ari builds the shopping list from one sentence and opens Grab; the order is placed in the Grab app.', ru: 'Продукты, цветы, товары из аптеки и торты: Ari собирает список покупок из одной фразы и открывает Grab; заказ оформляется в приложении Grab.', th: 'ของชำ ดอกไม้ ยาสามัญประจำบ้าน และเค้ก: Ari ทำรายการซื้อจากประโยคเดียวแล้วเปิด Grab ให้ การสั่งซื้อทำในแอป Grab' },
    with_grab: { en: 'Same scope as GrabFood: the order would be placed and tracked inside Ari.', ru: 'Тот же доступ, что и для GrabFood: заказ и отслеживание станут возможны прямо в Ari.', th: 'สิทธิ์เดียวกับ GrabFood: จะสั่งและติดตามคำสั่งซื้อได้ใน Ari' },
  },
  {
    id: 'grabid', name: 'Login with Grab', group: 'identity', today: 'built', api: 'GrabID OAuth 2.0 / OIDC with PKCE',
    ari: { en: 'The user links their Grab account to Ari once. No passwords pass through Ari or Unyly.', ru: 'Пользователь один раз привязывает аккаунт Grab к Ari. Пароли не проходят через Ari и Unyly.', th: 'ผู้ใช้เชื่อมบัญชี Grab กับ Ari เพียงครั้งเดียว รหัสผ่านไม่ผ่านระบบของ Ari หรือ Unyly' },
    with_grab: { en: 'Switches on with GrabID client credentials.', ru: 'Включается после выдачи ключей GrabID.', th: 'เปิดใช้งานได้เมื่อได้รับคีย์ GrabID' },
  },
  {
    id: 'grabpay', name: 'GrabPay', group: 'pay', today: 'built', api: 'GrabPay One-Time Charge API v2 (charge, refund, webhook)',
    ari: { en: 'Orders Ari books (parcels first) are paid with GrabPay; refunds are automatic when a booking fails.', ru: 'Заказы, которые оформляет Ari (сначала посылки), оплачиваются GrabPay; при сбое деньги возвращаются автоматически.', th: 'คำสั่งซื้อที่ Ari จอง (เริ่มจากพัสดุ) ชำระด้วย GrabPay และคืนเงินอัตโนมัติเมื่อจองไม่สำเร็จ' },
    with_grab: { en: 'Switches on with GrabPay merchant credentials.', ru: 'Включается после выдачи ключей мерчанта GrabPay.', th: 'เปิดใช้งานได้เมื่อได้รับคีย์ร้านค้า GrabPay' },
  },
  {
    id: 'tokenisation', name: 'GrabPay Tokenisation', group: 'pay', today: 'designed', api: 'Tokenisation API v4 (bind, charge, refund, unbind; SG, MY, PH)',
    ari: { en: 'Link GrabPay once, then pay by voice with Face ID: no redirect on every order (Singapore, Malaysia, Philippines today).', ru: 'Привязать GrabPay один раз и платить голосом с Face ID, без редиректа при каждом заказе (сейчас Сингапур, Малайзия, Филиппины).', th: 'เชื่อม GrabPay ครั้งเดียว แล้วจ่ายด้วยเสียงพร้อม Face ID ไม่ต้องสลับหน้าทุกครั้งที่สั่ง (ปัจจุบันรองรับสิงคโปร์ มาเลเซีย และฟิลิปปินส์)' },
    with_grab: { en: 'Tokenised charges for orders Ari books as the merchant (Tokenisation does not pay for orders placed in the Grab app).', ru: 'Платежи по токену за заказы, которые Ari оформляет как мерчант (заказы в приложении Grab так оплатить нельзя).', th: 'ชำระแบบโทเค็นสำหรับคำสั่งซื้อที่ Ari จองในฐานะร้านค้า (Tokenisation ใช้ชำระคำสั่งซื้อที่สั่งในแอป Grab ไม่ได้)' },
  },
  {
    id: 'rewards', name: 'GrabRewards', group: 'rewards', today: 'proposed', api: 'Points Earning API (rewards/v3/events), GrabRewards Tier API',
    ari: { en: 'Proposed: GrabRewards points for purchases paid through Ari; Ari can show the user\'s tier.', ru: 'Предлагаем: баллы GrabRewards за покупки, оплаченные через Ari; Ari показывает уровень пользователя.', th: 'ข้อเสนอ: คะแนน GrabRewards สำหรับการซื้อที่ชำระผ่าน Ari และ Ari แสดงระดับสมาชิกได้' },
    with_grab: { en: 'Needs a rewards partnership: Grab configures the source and the points formula for purchases paid through Ari.', ru: 'Нужно партнёрство по GrabRewards: Grab настраивает источник и формулу начисления за покупки, оплаченные через Ari.', th: 'ต้องเป็นพาร์ทเนอร์ GrabRewards: Grab กำหนดแหล่งที่มาและสูตรคะแนนสำหรับการซื้อที่ชำระผ่าน Ari' },
  },
  {
    id: 'gifts', name: 'GrabGifts', group: 'more', today: 'designed', api: 'GrabGifts API (issue gifts, gift links, cancel, balance; ID, MY, PH, SG, TH, VN)',
    ari: { en: '"Send Mai a lunch voucher for her birthday": Ari issues a Grab gift and sends the redemption link.', ru: '«Подари Май обед на день рождения»: Ari выпускает подарок Grab и отправляет ссылку для активации.', th: '"ส่งบัตรกำนัลมื้อกลางวันให้คุณใหม่ในวันเกิด": Ari ออกบัตรกำนัล Grab แล้วส่งลิงก์รับสิทธิ์ให้ผู้รับ' },
    with_grab: { en: 'Needs a GrabGifts business account with a prepaid balance. Available in Thailand, so it can follow the pilot.', ru: 'Нужен бизнес-аккаунт GrabGifts с предоплаченным балансом. Работает в Таиланде, поэтому может стать следующим шагом после пилота.', th: 'ต้องมีบัญชีธุรกิจ GrabGifts พร้อมยอดเงินเติมล่วงหน้า ใช้ได้ในประเทศไทย จึงทำต่อจากโครงการนำร่องได้' },
  },
  {
    id: 'digital', name: 'GrabKios', group: 'more', today: 'designed', api: 'GrabKios Digital Products API v2 (Indonesia)',
    ari: { en: '"Top up my phone with 50k": mobile credit, data packages, game vouchers and bill payments by voice (Indonesia only).', ru: '«Пополни телефон на 50 тысяч»: баланс телефона, интернет-пакеты, игровые ваучеры и оплата счетов голосом (только Индонезия).', th: '"เติมเงินมือถือ 50k": เติมเงินมือถือ แพ็กเกจเน็ต บัตรเติมเกม และจ่ายบิลด้วยเสียง (เฉพาะอินโดนีเซีย)' },
    with_grab: { en: 'Ari becomes a GrabKios B2C partner: Grab is the wholesaler, Ari sells to its own users.', ru: 'Ari становится B2C-партнёром GrabKios: Grab выступает оптовым поставщиком, Ari продаёт своим пользователям.', th: 'Ari เป็นพาร์ทเนอร์ B2C ของ GrabKios: Grab เป็นผู้ค้าส่ง และ Ari ขายให้ผู้ใช้ของตัวเอง' },
  },
  {
    id: 'chat', name: 'GrabChat', group: 'move', today: 'proposed', api: 'GrabChat Partner API and Web UI (comms.chat.partner)',
    ari: { en: '"Tell the driver I\'m at gate 3": Ari would relay messages to the driver or courier of a booking made through Ari and read the replies aloud.', ru: '«Скажи водителю, что я у выхода 3»: Ari сможет передавать сообщения водителю или курьеру заказа, оформленного через Ari, и читать ответы вслух.', th: '"บอกคนขับว่าฉันอยู่ประตู 3": Ari จะส่งข้อความถึงคนขับหรือไรเดอร์ของการจองที่ทำผ่าน Ari และอ่านข้อความตอบกลับให้ฟัง' },
    with_grab: { en: 'Chat rooms exist only for bookings Grab links to the partner. We ask Grab to enable them for GrabExpress deliveries booked through Ari.', ru: 'Чат открывается только для заказов, которые Grab связывает с партнёром. Просим включить его для доставок GrabExpress, оформленных через Ari.', th: 'ห้องแชทมีเฉพาะการจองที่ Grab ผูกกับพาร์ทเนอร์ เราขอให้ Grab เปิดใช้กับงานส่ง GrabExpress ที่จองผ่าน Ari' },
  },
  {
    id: 'business', name: 'Grab for Business', group: 'more', today: 'designed', api: 'Grab For Business Partner API (GET transactions, read-only)',
    ari: { en: 'Ari reads a company\'s Grab for Business transactions and answers "how much did we spend on Grab this month?".', ru: 'Ari читает транзакции компании в Grab for Business и отвечает на вопрос «сколько мы потратили на Grab в этом месяце?».', th: 'Ari อ่านรายการธุรกรรม Grab for Business ของบริษัท และตอบได้ว่า "เดือนนี้ใช้ Grab ไปเท่าไร"' },
    with_grab: { en: 'Read-only expense export with the company\'s consent.', ru: 'Экспорт расходов в режиме «только чтение», с согласия компании.', th: 'ส่งออกค่าใช้จ่ายแบบอ่านอย่างเดียวเมื่อบริษัทยินยอม' },
  },
  {
    id: 'defence', name: 'GrabDefence', group: 'identity', today: 'designed', api: 'GrabDefence Risk Evaluation API',
    ari: { en: 'A Grab risk score before high-value confirmations: one more signal against misuse of a linked account.', ru: 'Оценка риска от Grab перед крупными подтверждениями: ещё один сигнал против злоупотребления привязанным аккаунтом.', th: 'คะแนนความเสี่ยงจาก Grab ก่อนยืนยันรายการมูลค่าสูง เป็นอีกสัญญาณหนึ่งช่วยป้องกันการใช้บัญชีที่เชื่อมไว้โดยมิชอบ' },
    with_grab: { en: 'Grab\'s risk signal on orders placed through Ari.', ru: 'Сигнал риска Grab для заказов, оформленных через Ari.', th: 'สัญญาณความเสี่ยงของ Grab สำหรับคำสั่งซื้อที่ทำผ่าน Ari' },
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
