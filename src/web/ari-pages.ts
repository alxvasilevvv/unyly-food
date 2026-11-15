// Ari × Grab public pages: landing, live demo (/ari), proposal for Grab (/for-grab) and the Partner API page (/developers).
import type { FastifyInstance } from 'fastify';
import { GRAB_PRODUCTS, MARKETS, CoverageStatus } from '../partners/catalog.js';
import { ariExamples } from '../partners/webdemo.js';
import { icon } from './art.js';
import { CONTACT, instagramUrl, phoneLabel, whatsappUrl } from './contacts.js';
import { html, SafeHtml } from './html.js';
import { fmt, Locale, tr } from './messages.js';
import type { Kit } from './routes.js';

type Tri = { en: string; ru: string; th: string };
const APP_STORE = 'https://apps.apple.com/app/id6831932629';
/** Signed routes under /partner/v1 in partners/routes.ts (openapi.json is public and not counted). Checked by test/r4-pages.test.ts. */
export const SIGNED_ENDPOINTS = 22;
const k3 = (l: Locale): 'en' | 'ru' | 'th' => (l === 'ru' || l === 'th' ? l : 'en');

export const STATUS_LABEL: Record<CoverageStatus, Tri> = {
  built: { en: 'Built, tested on mocks, needs Grab keys', ru: 'Готово, проверено на моках, нужны ключи Grab', th: 'พร้อมแล้ว ทดสอบกับระบบจำลอง รอคีย์ Grab' },
  estimate: { en: 'Fares via Farefeed, booking in the Grab app', ru: 'Цены через Farefeed, заказ в приложении Grab', th: 'ค่าโดยสารผ่าน Farefeed จองในแอป Grab' },
  handoff: { en: 'Ari prepares a checklist, the user orders in the Grab app', ru: 'Ari готовит чек-лист, пользователь заказывает в приложении Grab', th: 'Ari เตรียมเช็กลิสต์ ผู้ใช้สั่งเองในแอป Grab' },
  designed: { en: 'Designed, built after onboarding', ru: 'Спроектировано, разработка после подключения', th: 'ออกแบบแล้ว พัฒนาหลังเริ่มออนบอร์ด' },
  proposed: { en: 'Needs access beyond Grab\'s public docs', ru: 'Нужен доступ сверх публичной документации Grab', th: 'ต้องการสิทธิ์นอกเหนือจากเอกสารสาธารณะของ Grab' },
};
/** One-word status for pills; the legend next to it carries the full STATUS_LABEL. */
export const STATUS_SHORT: Record<CoverageStatus, Tri> = {
  built: { en: 'Built', ru: 'Готово', th: 'พร้อมแล้ว' },
  estimate: { en: 'Fares only', ru: 'Только цены', th: 'เฉพาะค่าโดยสาร' },
  handoff: { en: 'Hand-off', ru: 'Передача в Grab', th: 'ส่งต่อให้ Grab' },
  designed: { en: 'Designed', ru: 'Спроектировано', th: 'ออกแบบแล้ว' },
  proposed: { en: 'Proposed', ru: 'Предложено', th: 'เสนอไว้' },
};
/** Legend and sort order: from the most finished status to the least. */
const STATUS_ORDER: CoverageStatus[] = ['built', 'estimate', 'handoff', 'designed', 'proposed'];
const GROUP_ICON: Record<string, string> = { move: 'car', deliver: 'box', pay: 'wallet', identity: 'shield', rewards: 'star', more: 'gift' };
const PRODUCT_ICON: Record<string, string> = { rides: 'car', express: 'box', food: 'bowl', mart: 'basket', grabid: 'lock', grabpay: 'wallet', tokenisation: 'faceid', rewards: 'star', gifts: 'gift', digital: 'smartphone', chat: 'chat', business: 'receipt', defence: 'shield' };
const productIcon = (p: { id: string; group: string }) => PRODUCT_ICON[p.id] ?? GROUP_ICON[p.group] ?? 'check';
/** Status pill with a coloured dot: readable without relying on colour alone (the word is always there). */
const statusPill = (l: Locale, s: CoverageStatus): SafeHtml =>
  html`<span class="st st-${s}" title="${tr(l, STATUS_LABEL[s])}"><i class="st-dot" aria-hidden="true"></i>${tr(l, STATUS_SHORT[s])}</span>`;
/** Legend with live counts per status, computed from the catalog (never hardcoded). */
function statusLegend(l: Locale, opts: { detailed?: boolean } = {}): SafeHtml {
  const counts = STATUS_ORDER.map((s) => [s, GRAB_PRODUCTS.filter((p) => p.today === s).length] as const).filter(([, n]) => n > 0);
  return html`<ul class="cov-legend${opts.detailed ? ' detailed' : ''}" role="list" aria-label="${tr(l, { en: 'Status legend', ru: 'Обозначения статусов', th: 'คำอธิบายสถานะ' })}">${counts.map(([s, n]) =>
    html`<li class="st-${s}"><i class="st-dot" aria-hidden="true"></i><b>${n}</b><span class="st-name">${tr(l, STATUS_SHORT[s])}</span><small>${tr(l, STATUS_LABEL[s])}</small></li>`)}</ul>`;
}

/** Static phone mock for the hero: Ari chat with a ride card, Live Activity and an incoming call chip. */
function heroPhone(l: Locale): SafeHtml {
  return html`<div class="ari-phone hero-phone" aria-hidden="true">
  <div class="ari-screen">
    <div class="ari-status"><span>9:41</span><span class="ari-island live"><span class="la-dot"></span><b>${tr(l, { en: 'Driver arriving', ru: 'Водитель едет', th: 'คนขับกำลังมา' })}</b><span>4 ${tr(l, { en: 'min', ru: 'мин', th: 'นาที' })}</span></span><span>5G</span></div>
    <div class="ari-head"><span class="ari-avatar">A</span><span><b>Ari</b><small>${tr(l, { en: 'online', ru: 'онлайн', th: 'ออนไลน์' })}</small></span></div>
    <div class="ari-chat">
      <div class="ari-msg me">${ariExamples(l)[0]}</div>
      <div class="ari-msg ari">${tr(l, { en: 'JustGrab, about 52 min. Here is the fare:', ru: 'JustGrab, около 52 минут. Вот цена:', th: 'JustGrab ประมาณ 52 นาที นี่คือค่าโดยสารค่ะ' })}</div>
      <div class="ari-card mini">
        <div class="ac-route"><span>Siam Paragon</span>${icon('arrow')}<span>BKK ${tr(l, { en: 'airport', ru: 'аэропорт', th: 'สนามบิน' })}</span></div>
        <div class="ac-row"><span>JustGrab · 4 ${tr(l, { en: 'seats', ru: 'места', th: 'ที่นั่ง' })}</span><b>฿421</b></div>
        <div class="ac-btn">${icon('faceid')} ${tr(l, { en: 'Confirm ride · ฿421', ru: 'Заказать · ฿421', th: 'ยืนยัน · ฿421' })}</div>
      </div>
      <div class="ari-msg ari">${tr(l, { en: 'Booked. I will call you when the driver is outside.', ru: 'Заказано. Позвоню, когда водитель будет у входа.', th: 'จองแล้วค่ะ Ari จะโทรบอกเมื่อคนขับมาถึงนะคะ' })}</div>
      <div class="ari-card mini">
        <div class="ac-status"><b>${tr(l, { en: 'Driver arriving', ru: 'Водитель едет к вам', th: 'คนขับกำลังมารับ' })}</b><small>~4 ${tr(l, { en: 'min', ru: 'мин', th: 'นาที' })}</small></div>
        <div class="ac-steps"><span class="done"></span><span class="done"></span><span class="now"></span><span></span></div>
      </div>
    </div>
  </div>
</div>`;
}

export function registerAriPages(app: FastifyInstance, kit: Kit) {
  const { base, send } = kit;

  // ---------------------------------------------------------------- landing
  app.get('/', async (req, reply) => {
    const r = await base(req, reply);
    const l = r.l;
    const L = k3(l);
    const step = (n: number, ic: string, t: Tri, d: Tri) => html`<li class="step-card"><span class="step-n">${n}</span><span class="ico">${icon(ic)}</span><h3>${tr(l, t)}</h3><p>${tr(l, d)}</p></li>`;
    const safety: [string, Tri, Tri][] = [
      ['tap', { en: 'Only the user confirms', ru: 'Подтверждает только пользователь', th: 'ผู้ใช้เท่านั้นที่ยืนยัน' }, { en: 'A card with the exact price is bound to a one-time hash. A chat "yes" can never place an order.', ru: 'Карточка с точной ценой привязана к одноразовому хешу. «Да» в чате никогда не оформит заказ.', th: 'การ์ดที่แสดงราคาจริงผูกกับแฮชแบบใช้ครั้งเดียว การตอบ "ตกลง" ในแชทไม่ทำให้เกิดคำสั่งซื้อ' }],
      ['faceid', { en: 'Face ID for large orders', ru: 'Face ID для крупных заказов', th: 'Face ID สำหรับยอดสูง' }, { en: 'Above a per-currency threshold the confirmation needs Face ID or the passcode.', ru: 'Если сумма выше порога (свой для каждой валюты), нужен Face ID или код-пароль.', th: 'ยอดที่เกินเกณฑ์ของแต่ละสกุลเงินต้องยืนยันด้วย Face ID หรือรหัสปลดล็อกเครื่อง' }],
      ['keyoff', { en: 'No passwords, no cards', ru: 'Без паролей и карт', th: 'ไม่ใช้รหัสผ่าน ไม่เก็บบัตร' }, { en: 'Login with Grab and GrabPay run on Grab\'s pages. Documented Grab APIs only.', ru: 'Login with Grab и GrabPay работают на страницах Grab. Только документированные API Grab.', th: 'Login with Grab และ GrabPay ทำงานบนหน้าเว็บของ Grab ใช้เฉพาะ API ที่ Grab เผยแพร่เป็นทางการ' }],
      ['repeat', { en: 'Never a duplicate order', ru: 'Без дублей', th: 'ไม่มีคำสั่งซื้อซ้ำ' }, { en: 'Every submission is idempotent; unknown outcomes are reconciled, never resent.', ru: 'Каждая отправка идемпотентна; неизвестный исход сверяем и повторно не отправляем.', th: 'ส่งคำขอซ้ำก็ไม่เกิดคำสั่งซื้อซ้ำ ผลที่ยังไม่แน่ชัดจะถูกตรวจสอบก่อน ไม่ส่งซ้ำ' }],
      ['shield', { en: 'Signed server to server', ru: 'Подписанные запросы', th: 'คำขอลงนามระหว่างเซิร์ฟเวอร์' }, { en: 'HMAC on every request, single-use nonces, signed webhooks, full audit trail.', ru: 'HMAC на каждом запросе, одноразовые nonce, подписанные вебхуки, полный аудит.', th: 'HMAC ทุกคำขอ nonce ใช้ครั้งเดียว webhook ลงนาม และบันทึกตรวจสอบครบ' }],
      ['power', { en: 'Kill switch and PDPA', ru: 'Стоп-кран и PDPA', th: 'ปุ่มหยุดฉุกเฉินและ PDPA' }, { en: 'New orders stop instantly while tracking continues. One call deletes a user\'s data.', ru: 'Новые заказы останавливаются мгновенно, отслеживание продолжается. Один вызов удаляет данные пользователя.', th: 'หยุดคำสั่งซื้อใหม่ได้ทันทีโดยยังติดตามได้ ลบข้อมูลผู้ใช้ได้ในคำสั่งเดียว' }],
    ];
    const gets: [string, Tri, Tri][] = [
      ['mic', { en: 'A new front door', ru: 'Новый вход в Grab', th: 'ประตูบานใหม่สู่ Grab' }, { en: 'Voice, Siri and the Lock Screen become a way to order Grab, in the moment of need.', ru: 'Голос, Siri и экран блокировки становятся способом заказать Grab ровно тогда, когда он нужен.', th: 'คำสั่งเสียง Siri และหน้าจอล็อก กลายเป็นช่องทางสั่ง Grab ได้ทันทีที่ต้องการ' }],
      ['users', { en: 'Every order runs on GrabID and GrabPay', ru: 'Каждый заказ идёт через GrabID и GrabPay', th: 'ทุกคำสั่งซื้อผ่าน GrabID และ GrabPay' }, { en: 'To order, an Ari user links a Grab account and pays with GrabPay. The customer relationship stays with Grab.', ru: 'Чтобы заказывать, пользователь Ari привязывает аккаунт Grab и платит через GrabPay. Клиент остаётся клиентом Grab.', th: 'ผู้ใช้ Ari ต้องเชื่อมบัญชี Grab และจ่ายด้วย GrabPay เพื่อสั่งซื้อ ลูกค้ายังเป็นลูกค้าของ Grab' }],
      ['repeat', { en: 'Repeat orders from routines', ru: 'Повторные заказы из привычек', th: 'คำสั่งซื้อซ้ำจากกิจวัตร' }, { en: 'Ari remembers routines ("Friday dinner?", "airport at 6?") and suggests them. The user still confirms every order.', ru: 'Ari помнит привычки («ужин в пятницу?», «в аэропорт к 6?») и сама предлагает их. Каждый заказ всё равно подтверждает пользователь.', th: 'Ari จำกิจวัตรได้ ("มื้อเย็นวันศุกร์ไหม" "ไปสนามบิน 6 โมงเช้าไหม") แล้วเสนอให้ก่อน แต่ผู้ใช้ยังต้องยืนยันทุกคำสั่งซื้อเอง' }],
      ['globe', { en: '8 markets, 10 languages', ru: '8 рынков, 10 языков', th: '8 ตลาด 10 ภาษา' }, { en: 'Interface in 10 languages; designed for all 8 Grab markets, Thailand first.', ru: 'Интерфейс на 10 языках; рассчитано на 8 рынков Grab, начинаем с Таиланда.', th: 'อินเทอร์เฟซ 10 ภาษา ออกแบบรองรับ 8 ตลาดของ Grab เริ่มที่ประเทศไทย' }],
    ];
    const coverage = GRAB_PRODUCTS.map((p) => html`<li class="cov is-${p.today}">
  <div class="cov-head"><span class="ico">${icon(productIcon(p))}</span><b>${p.name}</b></div>
  <p>${p.ari[L]}</p>
  ${statusPill(l, p.today)}
</li>`);
    return send(reply, r, tr(l, { en: 'Partnership proposal', ru: 'Предложение о партнёрстве', th: 'ข้อเสนอความร่วมมือ' }), html`
<section class="ari-hero"><div class="wrap ari-hero-grid">
  <div class="ari-hero-copy">
    <span class="eyebrow">${icon('handshake')} ${tr(l, { en: 'Partnership proposal · Thailand first', ru: 'Предложение о партнёрстве · старт в Таиланде', th: 'ข้อเสนอความร่วมมือ · เริ่มที่ประเทศไทย' })}</span>
    <h1>${tr(l, { en: 'Say it once.', ru: 'Скажите один раз.', th: 'พูดครั้งเดียว' })} <span class="grad h1-line">${tr(l, { en: 'Ari orders Grab.', ru: 'Ari закажет Grab.', th: 'Ari สั่ง Grab ให้' })}</span></h1>
    <p class="lead">${tr(l, {
      en: 'Ari is a personal assistant on iPhone that calls, reminds and gets things done. With Grab inside, one sentence becomes a ride, a meal, groceries or a courier: real prices, one tap or Face ID to confirm, live tracking, and a call from Ari when the driver is outside.',
      ru: 'Ari, персональный ассистент на iPhone, звонит, напоминает и берёт дела на себя. С Grab внутри одна фраза превращается в поездку, ужин, продукты или курьера: реальные цены, подтверждение одним нажатием или Face ID, отслеживание и звонок от Ari, когда водитель уже у входа.',
      th: 'Ari คือผู้ช่วยส่วนตัวบน iPhone ที่โทรหาคุณ คอยเตือน และจัดการธุระให้ เมื่อมี Grab อยู่ใน Ari ประโยคเดียวก็กลายเป็นการเรียกรถ สั่งอาหาร ซื้อของชำ หรือเรียกไรเดอร์ส่งของ เห็นราคาจริง ยืนยันด้วยการแตะครั้งเดียวหรือ Face ID ติดตามสถานะแบบเรียลไทม์ และ Ari โทรบอกเมื่อคนขับมาถึง',
    })}</p>
    <div class="actions">
      <a class="btn lg ari" href="/ari">${icon('sparkle')} ${tr(l, { en: 'Try the interactive demo', ru: 'Попробовать интерактивное демо', th: 'ลองเดโมแบบโต้ตอบ' })}</a>
      <a class="btn lg secondary" href="/for-grab">${tr(l, { en: 'Proposal for Grab', ru: 'Предложение для Grab', th: 'ข้อเสนอสำหรับ Grab' })} ${icon('arrow')}</a>
    </div>
    <p class="small hero-note">${icon('smartphone')} <a href="${APP_STORE}" rel="noopener">${tr(l, { en: 'Ari is live on the App Store', ru: 'Ari уже в App Store', th: 'Ari พร้อมใน App Store แล้ว' })}</a></p>
    <p class="small muted">${tr(l, { en: 'Target experience, shown with fictional data. No agreement with Grab exists yet. Grab cards and Face ID confirmation are proposed features and are not in the App Store version of Ari. With today\'s public Grab APIs Ari could book parcels and quote rides; ride, food and grocery ordering need the access we are asking for.', ru: 'Это целевой сценарий на вымышленных данных. Договорённости с Grab пока нет. Карточки Grab и подтверждение по Face ID предлагаются и в версии Ari из App Store отсутствуют. На публичных API Grab сегодня возможны заказ посылок и расчёт цены поездки; для заказа поездок, еды и продуктов нужен доступ, о котором мы просим.', th: 'นี่คือประสบการณ์เป้าหมาย แสดงด้วยข้อมูลสมมติ ยังไม่มีข้อตกลงกับ Grab การ์ด Grab และการยืนยันด้วย Face ID เป็นฟีเจอร์ที่เสนอ ยังไม่มีใน Ari บน App Store ด้วย API สาธารณะของ Grab ในปัจจุบัน Ari จองส่งพัสดุและแสดงค่าโดยสารได้ ส่วนการเรียกรถ สั่งอาหาร และสั่งของชำต้องใช้สิทธิ์ที่เรากำลังขอ' })}</p>
  </div>
  <div class="ari-hero-art">
    <div class="glow"></div>
    ${heroPhone(l)}
    <div class="float-chip f1" aria-hidden="true"><span class="fc-ico call">${icon('phone')}</span><span><b>${tr(l, { en: 'Ari is calling', ru: 'Звонит Ari', th: 'Ari กำลังโทร' })}</b><small>${tr(l, { en: '"Your driver is outside"', ru: '«Водитель у входа»', th: '"คนขับมาถึงแล้ว"' })}</small></span></div>
    <div class="float-chip f2" aria-hidden="true"><span class="fc-ico ari">${icon('faceid')}</span><span><b>${tr(l, { en: 'Confirmed with Face ID', ru: 'Подтверждено по Face ID', th: 'ยืนยันด้วย Face ID' })}</b><small>${tr(l, { en: 'price locked', ru: 'цена зафиксирована', th: 'ล็อกราคาแล้ว' })}</small></span></div>
  </div>
</div></section>

<section class="ari-band"><div class="wrap kpis ari-kpis">
  <div><b>1</b><span>${tr(l, { en: 'sentence to a Grab order', ru: 'фраза до заказа в Grab', th: 'ประโยคสู่คำสั่งซื้อ Grab' })}</span></div>
  <div><b>${GRAB_PRODUCTS.length}</b><span>${tr(l, { en: 'Grab products mapped', ru: 'продуктов Grab разобрано', th: 'ผลิตภัณฑ์ Grab ที่วางแผนรองรับ' })}</span></div>
  <div><b>8</b><span>${tr(l, { en: 'Grab markets, 10 languages', ru: 'рынков Grab, 10 языков', th: 'ตลาด Grab 10 ภาษา' })}</span></div>
  <div><b>0</b><span>${tr(l, { en: 'passwords or cards shared', ru: 'паролей и карт передано', th: 'รหัสผ่านหรือข้อมูลบัตรที่ต้องแชร์' })}</span></div>
</div></section>

<section class="sec" id="how"><div class="wrap">
  <span class="eyebrow">${icon('route')} ${tr(l, { en: 'How it works', ru: 'Как это работает', th: 'ทำงานอย่างไร' })}</span>
  <h2>${tr(l, { en: 'From a sentence to a tracked order in four steps', ru: 'От фразы до заказа с отслеживанием за четыре шага', th: 'จากประโยคเดียวสู่คำสั่งซื้อที่ติดตามได้ใน 4 ขั้นตอน' })}</h2>
  <ol class="steps4" role="list">
    ${step(1, 'mic', { en: 'Say it', ru: 'Скажите', th: 'พูดออกมา' }, { en: 'By voice, Siri, the Lock Screen or chat: "Taxi to the airport", "dinner for two under 600 baht, no nuts".', ru: 'Голосом, через Siri, экран блокировки или чат: «такси в аэропорт», «ужин на двоих до 600 бат без орехов».', th: 'ด้วยเสียง Siri หน้าจอล็อก หรือแชท: "แท็กซี่ไปสนามบิน" "มื้อเย็นสองคนไม่เกิน 600 บาท ไม่ใส่ถั่ว"' })}
    ${step(2, 'receipt', { en: 'See the real card', ru: 'Карточка с ценой', th: 'ดูการ์ดราคาจริง' }, { en: 'Ari shows options, then a card with every fee and the total; in live mode, from Grab\'s APIs.', ru: 'Ari показывает варианты, затем карточку со всеми сборами и итогом; в рабочем режиме цены приходят из API Grab.', th: 'Ari แสดงตัวเลือก ตามด้วยการ์ดที่แจกแจงค่าธรรมเนียมทุกรายการและยอดรวม ในโหมดใช้งานจริง ราคามาจาก API ของ Grab' })}
    ${step(3, 'faceid', { en: 'One tap or Face ID', ru: 'Нажатие или Face ID', th: 'แตะครั้งเดียวหรือ Face ID' }, { en: 'The confirmation is bound to that exact price. Large orders need Face ID.', ru: 'Подтверждение привязано к этой цене. Крупные заказы требуют Face ID.', th: 'การยืนยันผูกกับราคานั้น ยอดสูงต้องใช้ Face ID' })}
    ${step(4, 'phone', { en: 'Ari keeps watch', ru: 'Ari следит за заказом', th: 'Ari คอยติดตาม' }, { en: 'Live Activity in the Dynamic Island, pushes, and a call from Ari when the driver arrives.', ru: 'Live Activity в Dynamic Island, уведомления и звонок от Ari, когда водитель приехал.', th: 'Live Activity ใน Dynamic Island การแจ้งเตือน และ Ari โทรเมื่อคนขับมาถึง' })}
  </ol>
  <p class="center"><a class="btn ari" href="/ari">${tr(l, { en: 'Try it in the browser', ru: 'Попробовать в браузере', th: 'ลองในเบราว์เซอร์' })} ${icon('arrow')}</a></p>
</div></section>

<section class="sec alt" id="coverage"><div class="wrap">
  <span class="eyebrow">${icon('globe')} ${tr(l, { en: 'Grab\'s products, one assistant', ru: 'Продукты Grab в одном ассистенте', th: 'ผลิตภัณฑ์ของ Grab ในผู้ช่วยเดียว' })}</span>
  <h2>${tr(l, { en: 'What Ari does with each Grab product', ru: 'Что Ari делает с каждым продуктом Grab', th: 'Ari ทำอะไรกับแต่ละผลิตภัณฑ์ของ Grab' })}</h2>
  <p class="lead">${tr(l, { en: 'Mapped against the public APIs on developer.grab.com. The status shows how far each integration is today. None is live: Grab has not issued credentials to us.', ru: 'Сверено с публичными API на developer.grab.com. Статус показывает готовность каждой интеграции сегодня. В рабочем режиме пока ничего не запущено: ключей от Grab у нас нет.', th: 'เทียบกับ API สาธารณะบน developer.grab.com สถานะแสดงความพร้อมของแต่ละการเชื่อมต่อในวันนี้ ยังไม่มีรายการใดเปิดใช้งานจริง เพราะ Grab ยังไม่ได้ออกคีย์ให้เรา' })}</p>
  ${statusLegend(l)}
  <ul class="cov-grid" role="list">${coverage}
    <li class="cov cov-more"><b>${tr(l, { en: 'Every product, mapped to its Grab API', ru: 'Каждый продукт сопоставлен с API Grab', th: 'ทุกผลิตภัณฑ์จับคู่กับ API ของ Grab แล้ว' })}</b><p>${tr(l, { en: 'The proposal lists the exact API behind each card and what changes once Grab grants access.', ru: 'В предложении указаны API для каждой карточки и то, что изменится после выдачи доступа.', th: 'ข้อเสนอระบุ API ของแต่ละการ์ด และสิ่งที่เปลี่ยนไปเมื่อ Grab ให้สิทธิ์' })}</p><a class="btn secondary" href="/for-grab#coverage">${tr(l, { en: 'See the full table', ru: 'Открыть всю таблицу', th: 'ดูตารางทั้งหมด' })} ${icon('arrow')}</a></li>
  </ul>
</div></section>

<section class="sec" id="architecture"><div class="wrap">
  <span class="eyebrow">${icon('server')} ${tr(l, { en: 'Architecture', ru: 'Архитектура', th: 'สถาปัตยกรรม' })}</span>
  <h2>${tr(l, { en: 'Ari talks to Grab through one signed engine', ru: 'Ari общается с Grab через один защищённый движок', th: 'Ari เชื่อมต่อ Grab ผ่านเอนจินเดียวที่ลงนามทุกคำขอ' })}</h2>
  <div class="arch">
    <div class="arch-node user"><span class="ico">${icon('smartphone')}</span><b>${tr(l, { en: 'Ari iPhone app', ru: 'Приложение Ari для iPhone', th: 'แอป Ari บน iPhone' })}</b><small>${tr(l, { en: 'voice, cards, Face ID, Live Activity, calls', ru: 'голос, карточки, Face ID, Live Activity, звонки', th: 'เสียง การ์ด Face ID Live Activity การโทร' })}</small></div>
    <div class="arch-arrow">${icon('arrow')}</div>
    <div class="arch-node"><span class="ico">${icon('sparkle')}</span><b>${tr(l, { en: 'Ari backend', ru: 'Бэкенд Ari', th: 'แบ็กเอนด์ของ Ari' })}</b><small>${tr(l, { en: 'LLM, memory, reminders, tool calling', ru: 'LLM, память, напоминания, вызов инструментов', th: 'LLM ความจำ การเตือน การเรียกเครื่องมือ' })}</small></div>
    <div class="arch-arrow">${icon('arrow')}</div>
    <div class="arch-node engine"><span class="ico">${icon('shield')}</span><b>${tr(l, { en: 'Unyly engine', ru: 'Движок Unyly', th: 'เอนจิน Unyly' })}</b><small>${tr(l, { en: 'CSA PROJECT\'s integration layer between Ari and Grab\'s APIs', ru: 'Интеграционный слой CSA PROJECT между Ari и API Grab', th: 'ชั้นเชื่อมต่อของ CSA PROJECT ระหว่าง Ari กับ API ของ Grab' })}</small></div>
    <div class="arch-arrow">${icon('arrow')}</div>
    <div class="arch-node grab"><span class="ico">${icon('plug')}</span><b>${tr(l, { en: 'Grab APIs', ru: 'API Grab', th: 'API ของ Grab' })}</b><em class="arch-tag">developer.grab.com</em><small>GrabID · Farefeed · GrabExpress · GrabPay · Tokenisation · Rewards · GrabChat</small></div>
  </div>
  <div class="grid3 small-cards">
    <div class="card flat"><h3>${icon('code')} ${tr(l, { en: 'One API for Ari', ru: 'Один API для Ari', th: 'API เดียวสำหรับ Ari' })}</h3><p>${fmt(tr(l, { en: '{n} signed endpoints, model-neutral tool definitions and a card schema the app renders natively.', ru: '{n} подписанных эндпоинта, описания инструментов для любой модели и схема карточек для нативного отображения.', th: '{n} เอนด์พอยต์ที่ลงนาม คำอธิบายเครื่องมือสำหรับทุกโมเดล และสคีมาการ์ดสำหรับแสดงผลในแอป' }), { n: SIGNED_ENDPOINTS })}</p><a href="/developers">${tr(l, { en: 'Partner API', ru: 'Partner API', th: 'Partner API' })} ${icon('arrow')}</a></div>
    <div class="card flat"><h3>${icon('bell')} ${tr(l, { en: 'Events instead of polling', ru: 'События вместо опроса', th: 'รับอีเวนต์ ไม่ต้อง polling' })}</h3><p>${tr(l, { en: 'Signed webhooks carry ready-to-show notifications: push, Live Activity state, or "call the user now".', ru: 'Подписанные вебхуки несут готовые уведомления: push, состояние Live Activity или «позвонить пользователю».', th: 'webhook ที่ลงนามส่งการแจ้งเตือนพร้อมใช้: push สถานะ Live Activity หรือ "โทรหาผู้ใช้ตอนนี้"' })}</p></div>
    <div class="card flat"><h3>${icon('globe')} ${tr(l, { en: 'Any assistant, same rules', ru: 'Любой ассистент, те же правила', th: 'ผู้ช่วยใดก็ได้ กฎเดียวกัน' })}</h3><p>${tr(l, { en: 'The same engine has an MCP server, so ChatGPT, Claude, Gemini and other assistants follow the same confirmation rules.', ru: 'У того же движка есть MCP-сервер, поэтому ChatGPT, Claude, Gemini и другие ассистенты работают по тем же правилам подтверждения.', th: 'เอนจินเดียวกันมี MCP server ทำให้ ChatGPT, Claude, Gemini และผู้ช่วยอื่น ๆ ใช้กฎการยืนยันชุดเดียวกัน' })}</p><a href="/assistants">MCP ${icon('arrow')}</a></div>
  </div>
</div></section>

<section class="sec alt" id="safety"><div class="wrap">
  <span class="eyebrow">${icon('shield')} ${tr(l, { en: 'Built for Grab\'s risk teams', ru: 'С расчётом на службу рисков Grab', th: 'ออกแบบมาเพื่อทีมบริหารความเสี่ยงของ Grab' })}</span>
  <h2>${tr(l, { en: 'Six controls a platform team can check', ru: 'Шесть механизмов, которые может проверить команда платформы', th: 'หกกลไกที่ทีมแพลตฟอร์มตรวจสอบได้' })}</h2>
  <div class="feature-grid">${safety.map(([ic, t, d]) => html`<div class="feature"><span class="ico">${icon(ic)}</span><h3>${tr(l, t)}</h3><p>${tr(l, d)}</p></div>`)}</div>
</div></section>

<section class="sec" id="grab"><div class="wrap">
  <span class="eyebrow">${icon('chart')} ${tr(l, { en: 'Why Grab', ru: 'Зачем это Grab', th: 'ประโยชน์ต่อ Grab' })}</span>
  <h2>${tr(l, { en: 'The assistant: a new ordering channel for Grab', ru: 'Ассистент как новый канал заказов для Grab', th: 'ผู้ช่วยส่วนตัว: ช่องทางสั่งซื้อใหม่ของ Grab' })}</h2>
  <div class="feature-grid four">${gets.map(([ic, t, d]) => html`<div class="feature"><span class="ico">${icon(ic)}</span><h3>${tr(l, t)}</h3><p>${tr(l, d)}</p></div>`)}</div>
  <div class="markets">${MARKETS.map((m) => html`<span class="market ${m.demo ? 'on' : ''}"><b>${m.country[L]}</b><small>${m.currency} · ${m.languages.join(', ')}</small>${m.demo ? html`<em>${tr(l, { en: 'demo', ru: 'демо', th: 'เดโม' })}</em>` : ''}</span>`)}</div>
</div></section>

<section class="sec cta-band"><div class="wrap"><div class="cta-panel center">
  <span class="ari-mark lg" aria-hidden="true">A</span>
  <h2>${tr(l, { en: 'Let\'s launch a pilot in Bangkok', ru: 'Запустим пилот в Бангкоке', th: 'มาเริ่มโครงการนำร่องที่กรุงเทพฯ ด้วยกัน' })}</h2>
  <p class="lead">${tr(l, { en: 'GrabExpress, Login with Grab and GrabPay are built from Grab\'s public docs and tested against mocks. With sandbox keys we start certification on day one.', ru: 'GrabExpress, Login with Grab и GrabPay написаны по публичной документации Grab и проверены на моках. С ключами песочницы начнём сертификацию в первый же день.', th: 'GrabExpress, Login with Grab และ GrabPay พัฒนาตามเอกสารสาธารณะของ Grab และทดสอบกับระบบจำลองแล้ว เมื่อได้คีย์ sandbox เราพร้อมเริ่มกระบวนการรับรองได้ตั้งแต่วันแรก' })}</p>
  <div class="actions center"><a class="btn lg ari" href="/for-grab">${tr(l, { en: 'Read the proposal', ru: 'Читать предложение', th: 'อ่านข้อเสนอ' })} ${icon('arrow')}</a><a class="btn lg secondary" href="mailto:${CONTACT.owner.email}">${icon('mail')} ${CONTACT.owner.email}</a></div>
</div></div></section>`, { wide: true, noBanner: true, description: tr(l, { en: 'Proposal: Ari, the personal assistant on iPhone, as a voice channel for Grab. Interactive demo with fictional data.', ru: 'Предложение: Ari, персональный ассистент на iPhone, как голосовой канал для Grab. Интерактивное демо на вымышленных данных.', th: 'ข้อเสนอ: Ari ผู้ช่วยส่วนตัวบน iPhone เป็นช่องทางสั่งงานด้วยเสียงสำหรับ Grab เดโมใช้ข้อมูลสมมติ' }) });
  });

  // ---------------------------------------------------------------- live demo
  app.get('/ari', async (req, reply) => {
    const r = await base(req, reply);
    const l = r.l;
    const ex = ariExamples(l);
    const strings = {
      placeholder: tr(l, { en: 'Message Ari…', ru: 'Сообщение для Ari…', th: 'ส่งข้อความถึง Ari…' }),
      typing: tr(l, { en: 'Ari is typing', ru: 'Ari печатает', th: 'Ari กำลังพิมพ์' }),
      faceid: tr(l, { en: 'Face ID', ru: 'Face ID', th: 'Face ID' }),
      faceidHint: tr(l, { en: 'Confirm with Face ID', ru: 'Подтвердите по Face ID', th: 'ยืนยันด้วย Face ID' }),
      calling: tr(l, { en: 'Ari is calling…', ru: 'Звонит Ari…', th: 'Ari กำลังโทร…' }),
      accept: tr(l, { en: 'Accept', ru: 'Ответить', th: 'รับสาย' }),
      decline: tr(l, { en: 'Decline', ru: 'Отклонить', th: 'ปฏิเสธ' }),
      endCall: tr(l, { en: 'End', ru: 'Завершить', th: 'วางสาย' }),
      demoBadge: tr(l, { en: 'Demo', ru: 'Демо', th: 'เดโม' }),
      eta: tr(l, { en: 'ETA', ru: 'Прибытие', th: 'ถึงประมาณ' }),
      cancel: tr(l, { en: 'Cancel order', ru: 'Отменить заказ', th: 'ยกเลิกคำสั่งซื้อ' }),
      reset: tr(l, { en: 'New chat', ru: 'Новый чат', th: 'แชทใหม่' }),
      error: tr(l, { en: 'Something went wrong. Please try again.', ru: 'Что-то пошло не так. Попробуйте ещё раз.', th: 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง' }),
      linkGrab: tr(l, { en: 'Link Grab', ru: 'Привязать Grab', th: 'เชื่อม Grab' }),
      linked: tr(l, { en: 'Grab linked', ru: 'Grab привязан', th: 'เชื่อม Grab แล้ว' }),
      linkedNote: tr(l, { en: 'Grab account linked (simulated in the demo; live uses Login with Grab).', ru: 'Аккаунт Grab привязан (в демо это симуляция; в рабочем режиме используется Login with Grab).', th: 'เชื่อมบัญชี Grab แล้ว (จำลองในเดโม โหมดใช้งานจริงใช้ Login with Grab)' }),
      confirmed: tr(l, { en: 'Confirmed with Face ID', ru: 'Подтверждено по Face ID', th: 'ยืนยันด้วย Face ID แล้ว' }),
      declined: tr(l, { en: 'Not ordered', ru: 'Не заказано', th: 'ไม่ได้สั่ง' }),
      callLine: tr(l, { en: 'Hi, it\'s Ari. {status}. {courier} {vehicle}, plate {plate}. I\'ll stay on it until you arrive.', ru: 'Здравствуйте, это Ari. {status}. {courier}, {vehicle}, номер {plate}. Я слежу за поездкой до самого конца.', th: 'สวัสดีค่ะ Ari เองค่ะ {status} {courier} {vehicle} ทะเบียน {plate} Ari จะติดตามจนถึงที่หมายค่ะ' }),
      under: tr(l, { en: 'Under the hood', ru: 'Что происходит внутри', th: 'เบื้องหลังการทำงาน' }),
      liveCall: tr(l, { en: 'live Grab API', ru: 'рабочий API Grab', th: 'API จริงของ Grab' }),
      seats: tr(l, { en: 'Choose', ru: 'Выбрать', th: 'เลือก' }),
      voiceNote: tr(l, { en: 'Voice input is simulated in the browser: pick an example.', ru: 'В браузере голосовой ввод имитируется: выберите пример.', th: 'การป้อนเสียงในเบราว์เซอร์เป็นการจำลอง โปรดเลือกตัวอย่าง' }),
      min: tr(l, { en: 'min', ru: 'мин', th: 'นาที' }),
      busy: tr(l, { en: 'The demo is busy right now. Please try again in a minute.', ru: 'Демо сейчас перегружено. Попробуйте ещё раз через минуту.', th: 'เดโมมีผู้ใช้งานมากในขณะนี้ กรุณาลองอีกครั้งในอีกสักครู่' }),
      offline: tr(l, { en: 'No connection to the server. Check the network and try again.', ru: 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз.', th: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองอีกครั้ง' }),
      retry: tr(l, { en: 'Try again', ru: 'Попробовать ещё раз', th: 'ลองอีกครั้ง' }),
      lang: l,
    };
    // Presenter shortcuts: the first four examples are ride, dinner, parcel and flowers, in that order.
    const scenarios: [string, Tri][] = [
      ['car', { en: 'Ride', ru: 'Поездка', th: 'เรียกรถ' }],
      ['bowl', { en: 'Dinner', ru: 'Ужин', th: 'มื้อเย็น' }],
      ['box', { en: 'Parcel', ru: 'Посылка', th: 'พัสดุ' }],
      ['flower', { en: 'Flowers', ru: 'Цветы', th: 'ดอกไม้' }],
    ];
    const scenLabel = tr(l, { en: 'One-tap scenarios', ru: 'Сценарии в одно нажатие', th: 'ตัวอย่างสถานการณ์ แตะครั้งเดียว' });
    return send(reply, r, tr(l, { en: 'Ari live demo', ru: 'Живое демо Ari', th: 'เดโมสดของ Ari' }), html`
<section class="ari-demo-page"><div class="wrap ari-demo-grid">
  <div class="ari-demo-left">
    <div class="ari-phone big" id="ari-app" data-strings="${JSON.stringify(strings)}" data-examples="${JSON.stringify(ex)}">
      <div class="ari-screen">
        <div class="ari-status"><span class="clock" id="ari-clock">9:41</span><span class="ari-island" id="ari-island"><span class="la-dot"></span><b id="la-title"></b><span id="la-eta"></span></span><span>5G ${icon('bolt')}</span></div>
        <div class="ari-push" id="ari-push" role="status" aria-live="polite"><span class="ari-avatar sm">A</span><span><b id="push-title"></b><small id="push-body"></small></span></div>
        <div class="ari-head"><span class="ari-avatar">A</span><span><b>Ari</b><small id="ari-sub">${tr(l, { en: 'online', ru: 'онлайн', th: 'ออนไลน์' })}</small></span>
          <button class="ari-link" type="button" id="ari-grab" aria-pressed="false">${icon('plug')} <span>${strings.linkGrab}</span></button>
          <button class="ari-icon-btn" type="button" id="ari-reset" title="${strings.reset}" aria-label="${strings.reset}">${icon('repeat')}</button></div>
        <div class="ari-chat" id="ari-chat" role="log" aria-live="polite" aria-label="${tr(l, { en: 'Conversation with Ari', ru: 'Диалог с Ari', th: 'บทสนทนากับ Ari' })}"></div>
        <div class="ari-chips" id="ari-chips" role="group" aria-label="${tr(l, { en: 'Example requests', ru: 'Примеры запросов', th: 'ตัวอย่างคำขอ' })}"></div>
        <form class="ari-composer" id="ari-form" autocomplete="off">
          <button type="button" class="ari-mic" id="ari-mic" aria-label="${tr(l, { en: 'Voice', ru: 'Голос', th: 'เสียง' })}">${icon('mic')}</button>
          <label class="sr-only" for="ari-input">${strings.placeholder}</label>
          <input id="ari-input" name="text" maxlength="300" placeholder="${strings.placeholder}">
          <button class="ari-send" type="submit" aria-label="${tr(l, { en: 'Send', ru: 'Отправить', th: 'ส่ง' })}">${icon('send')}</button>
        </form>
        <div class="ari-sheet" id="ari-faceid" role="dialog" aria-modal="true" aria-label="${strings.faceidHint}" tabindex="-1" hidden><div class="fid">${icon('faceid')}${icon('check', 'fid-ok')}</div><b>${strings.faceidHint}</b></div>
        <div class="ari-call" id="ari-call" role="dialog" aria-modal="true" aria-label="${strings.calling}" tabindex="-1" hidden>
          <div class="call-top"><span class="call-ring"><span class="ari-avatar xl">A</span></span><b>Ari</b><small id="call-state">${strings.calling}</small><span class="call-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div>
          <p class="call-line" id="call-line"></p>
          <div class="call-btns"><button type="button" class="call-no" id="call-no">${icon('phone')}<span>${strings.decline}</span></button><button type="button" class="call-yes" id="call-yes">${icon('phone')}<span>${strings.accept}</span></button></div>
        </div>
      </div>
    </div>
    <a class="trace-hint" href="#under-the-hood">${icon('code')}<span>${strings.under}</span><b id="trace-count" hidden></b>${icon('arrow')}</a>
    <noscript><p class="notice warn">${tr(l, { en: 'The live demo needs JavaScript.', ru: 'Для живого демо нужен JavaScript.', th: 'เดโมสดต้องใช้ JavaScript' })}</p></noscript>
  </div>
  <aside class="ari-demo-right">
    <span class="eyebrow">${icon('sparkle')} ${tr(l, { en: 'Live demo · fictional Bangkok data', ru: 'Живое демо · вымышленные данные Бангкока', th: 'เดโมสด · ข้อมูลสมมติกรุงเทพฯ' })}</span>
    <h1>${tr(l, { en: 'How Ari would order Grab', ru: 'Так Ari могла бы заказывать Grab', th: 'Ari จะสั่ง Grab อย่างไร' })}</h1>
    <p class="lead">${tr(l, { en: 'Type or tap an example. Every step runs through the Unyly Partner API built for the Ari app: options, a priced card, your confirmation, then live status, pushes and a call from Ari.', ru: 'Напишите или выберите пример. Каждый шаг идёт через Partner API Unyly, созданный для приложения Ari: варианты, карточка с ценой, ваше подтверждение, затем статус, уведомления и звонок от Ari.', th: 'พิมพ์หรือแตะตัวอย่าง ทุกขั้นตอนผ่าน Unyly Partner API ที่สร้างไว้สำหรับแอป Ari: ตัวเลือก การ์ดราคา การยืนยันของคุณ ตามด้วยสถานะแบบเรียลไทม์ การแจ้งเตือน และสายโทรจาก Ari' })}</p>
    <div class="presenter" id="ari-presenter" role="group" aria-label="${scenLabel}">
      <span class="presenter-h">${icon('bolt')} ${scenLabel}</span>
      <div class="presenter-btns">${scenarios.map(([ic, t], i) => html`<button type="button" data-ex="${i}" title="${ex[i] ?? ''}">${icon(ic)}<span>${tr(l, t)}</span></button>`)}</div>
    </div>
    <div class="trace card flat" id="under-the-hood"><div class="trace-h"><b>${icon('code')} ${strings.under}</b><span class="trace-n" id="trace-n" hidden></span><span class="pill accent">Partner API</span></div><ol class="trace-list" id="ari-trace" role="list"><li class="muted small">${tr(l, { en: 'API calls appear here as you talk to Ari.', ru: 'Здесь появятся вызовы API по ходу диалога.', th: 'การเรียก API จะแสดงที่นี่ระหว่างคุยกับ Ari' })}</li></ol></div>
    <ul class="ari-legend small muted" role="list">
      <li>${icon('check')} ${tr(l, { en: 'Demo mode: nothing is driven, delivered or charged; drivers and plates are fictional.', ru: 'Демо: никто никуда не едет, ничего не доставляется и не списывается; водители и номера вымышлены.', th: 'โหมดเดโม: ไม่มีการเดินทาง จัดส่ง หรือเรียกเก็บเงินจริง คนขับและทะเบียนเป็นข้อมูลสมมติ' })}</li>
      <li>${icon('plug')} ${tr(l, { en: 'The "Under the hood" panel shows which Grab API a live system would call for the same step.', ru: 'В блоке «Что происходит внутри» видно, какой API Grab вызывался бы на этом шаге в рабочем режиме.', th: 'แผง "เบื้องหลังการทำงาน" แสดง API ของ Grab ที่จะถูกเรียกในขั้นตอนเดียวกันเมื่อใช้งานจริง' })}</li>
      <li>${icon('clock')} ${tr(l, { en: 'Trips run at demo speed: a whole ride takes about two minutes.', ru: 'Поездки идут в ускоренном режиме: вся поездка занимает около двух минут.', th: 'การเดินทางในเดโมถูกเร่งความเร็ว ทั้งเที่ยวใช้เวลาประมาณ 2 นาที' })}</li>
    </ul>
    <div class="actions"><a class="btn secondary" href="/for-grab">${tr(l, { en: 'Proposal for Grab', ru: 'Предложение для Grab', th: 'ข้อเสนอสำหรับ Grab' })}</a><a class="btn ghost" href="/developers">${tr(l, { en: 'Partner API', ru: 'Partner API', th: 'Partner API' })} ${icon('arrow')}</a></div>
  </aside>
</div></section>`, { wide: true, noBanner: true, scripts: ['ari.js'], description: tr(l, { en: 'Interactive demo with fictional data: how Ari would order a Grab ride, food or a parcel, from options and a priced card to Face ID, live status and a call.', ru: 'Интерактивное демо на вымышленных данных: как Ari могла бы заказывать поездку, еду или посылку Grab, от вариантов и карточки с ценой до Face ID, статуса и звонка.', th: 'เดโมแบบโต้ตอบด้วยข้อมูลสมมติ: Ari จะเรียกรถ สั่งอาหาร หรือส่งพัสดุผ่าน Grab อย่างไร ตั้งแต่ตัวเลือกและการ์ดราคา ไปจนถึง Face ID สถานะ และสายโทรจาก Ari' }) });
  });

  // ---------------------------------------------------------------- proposal for Grab
  app.get('/for-grab', async (req, reply) => {
    const r = await base(req, reply);
    const l = r.l;
    const L = k3(l);
    const phases: [Tri, Tri, Tri][] = [
      [{ en: 'Weeks 1-3', ru: 'Недели 1-3', th: 'สัปดาห์ 1-3' }, { en: 'Certification', ru: 'Сертификация', th: 'การรับรอง' }, { en: 'GrabExpress on sandbox, Login with Grab on staging, GrabPay on test credentials. We run Grab\'s happy and unhappy paths and go through Grab\'s security review. No real users yet.', ru: 'GrabExpress в песочнице, Login with Grab на стейджинге, GrabPay на тестовых ключах. Проходим позитивные и негативные сценарии Grab и проверку безопасности со стороны Grab. Реальных пользователей пока нет.', th: 'GrabExpress บน sandbox, Login with Grab บน staging และ GrabPay ด้วยคีย์ทดสอบ เราทดสอบทั้งกรณีปกติและกรณีผิดพลาดตามที่ Grab กำหนด และผ่านการตรวจความปลอดภัยของ Grab ช่วงนี้ยังไม่มีผู้ใช้จริง' }],
      [{ en: 'Weeks 4-9', ru: 'Недели 4-9', th: 'สัปดาห์ 4-9' }, { en: 'Bangkok pilot', ru: 'Пилот в Бангкоке', th: 'นำร่องกรุงเทพฯ' }, { en: 'One market, one city, up to 1,000 invited Ari users. GrabExpress deliveries paid with GrabPay, plus Farefeed ride estimates that hand off to the Grab app. Grab can pause the pilot at any moment.', ru: 'Один рынок, один город, не более 1 000 приглашённых пользователей Ari. Доставки GrabExpress с оплатой через GrabPay и расчёт цены поездки через Farefeed с переходом в приложение Grab. Grab может остановить пилот в любой момент.', th: 'หนึ่งตลาด หนึ่งเมือง ผู้ใช้ Ari ที่ได้รับเชิญไม่เกิน 1,000 คน ส่งของด้วย GrabExpress ชำระผ่าน GrabPay และประมาณการค่าโดยสารจาก Farefeed แล้วส่งต่อไปจองในแอป Grab โดย Grab สั่งหยุดโครงการนำร่องได้ทุกเมื่อ' }],
      [{ en: 'Every week', ru: 'Каждую неделю', th: 'ทุกสัปดาห์' }, { en: 'Report to Grab', ru: 'Отчёт для Grab', th: 'รายงานถึง Grab' }, { en: 'Completed deliveries, quote-to-order conversion, cancellations and failures, new GrabID links, GrabPay volume, Farefeed deep-link opens, incidents.', ru: 'Выполненные доставки, конверсия из расчёта в заказ, отмены и сбои, новые привязки GrabID, объём GrabPay, переходы по ссылкам Farefeed, инциденты.', th: 'จำนวนงานส่งที่สำเร็จ อัตราจากใบเสนอราคาเป็นคำสั่งซื้อ การยกเลิกและงานที่ล้มเหลว การเชื่อม GrabID ใหม่ ยอดชำระผ่าน GrabPay จำนวนการเปิด deep link ของ Farefeed และเหตุขัดข้อง' }],
      [{ en: 'Week 10', ru: 'Неделя 10', th: 'สัปดาห์ 10' }, { en: 'Joint review', ru: 'Совместный разбор', th: 'ทบทวนร่วมกัน' }, { en: 'Go or no-go against targets agreed before the start. If the result is positive: design consumer scopes for GrabFood, GrabMart and ride booking together, then add markets one by one, each with Grab\'s approval.', ru: 'Решение о продолжении по целям, согласованным до старта. При положительном итоге вместе проектируем доступ к заказу GrabFood, GrabMart и поездок, затем подключаем рынки по одному, каждый с одобрения Grab.', th: 'ตัดสินใจไปต่อหรือหยุดตามเป้าหมายที่ตกลงกันก่อนเริ่ม หากผลเป็นบวก จะออกแบบสิทธิ์ผู้บริโภคสำหรับ GrabFood, GrabMart และการจองรถร่วมกัน แล้วขยายทีละตลาดเมื่อ Grab อนุมัติ' }],
    ];
    // Each ask: the access, then what we build with it.
    const asks: [string, Tri, Tri][] = [
      ['box', { en: 'GrabExpress: sandbox, then production for Bangkok (scope grab_express.partner_deliveries)', ru: 'GrabExpress: песочница, затем продакшен для Бангкока (scope grab_express.partner_deliveries)', th: 'GrabExpress: sandbox แล้วตามด้วย production สำหรับกรุงเทพฯ (scope grab_express.partner_deliveries)' },
        { en: 'Parcel delivery by voice: quote, booking, tracking, cancellation. We also ask Grab to confirm that an assistant may book for its users, with Unyly as the shipper of record.', ru: 'Доставка посылок голосом: цена, заказ, отслеживание, отмена. Просим также подтвердить, что ассистент может оформлять доставки для своих пользователей, а отправителем по договору выступает Unyly.', th: 'ส่งพัสดุด้วยเสียง: เช็กราคา จอง ติดตาม และยกเลิก เราขอให้ Grab ยืนยันด้วยว่าผู้ช่วยจองแทนผู้ใช้ได้ โดย Unyly เป็นผู้ส่งตามสัญญา' }],
      ['shield', { en: 'GrabID client for Login with Grab (openid, profile.read, phone)', ru: 'Клиент GrabID для Login with Grab (openid, profile.read, phone)', th: 'GrabID client สำหรับ Login with Grab (openid, profile.read, phone)' },
        { en: 'Account linking with PKCE on Grab\'s pages. We keep the user identifier only, no Grab tokens.', ru: 'Привязка аккаунта с PKCE на страницах Grab. Храним только идентификатор пользователя, токены Grab не сохраняем.', th: 'เชื่อมบัญชีด้วย PKCE บนหน้าเว็บของ Grab เราเก็บเฉพาะตัวระบุผู้ใช้ ไม่เก็บโทเค็นของ Grab' }],
      ['wallet', { en: 'GrabPay merchant account for One-Time Charge in THB', ru: 'Мерчант-аккаунт GrabPay для One-Time Charge в THB', th: 'บัญชีร้านค้า GrabPay สำหรับ One-Time Charge สกุลเงิน THB' },
        { en: 'Payment for deliveries Ari books, on Grab\'s hosted checkout, with automatic refunds. Tokenisation (SG, MY, PH) is a later step.', ru: 'Оплата доставок, оформленных через Ari, на платёжной странице Grab, с автоматическим возвратом. Tokenisation (SG, MY, PH) оставляем на следующий этап.', th: 'ชำระค่าส่งที่จองผ่าน Ari บนหน้าชำระเงินของ Grab พร้อมคืนเงินอัตโนมัติ ส่วน Tokenisation (SG, MY, PH) เป็นขั้นถัดไป' }],
      ['car', { en: 'Partner Farefeed (scope ride.estimate) with its display terms', ru: 'Partner Farefeed (scope ride.estimate) и правила показа цен', th: 'Partner Farefeed (scope ride.estimate) พร้อมเงื่อนไขการแสดงราคา' },
        { en: 'Fare ranges and pickup times in Ari, then a deep link: the user books in the Grab app. A ride-booking scope is a separate conversation.', ru: 'Диапазон цены и время подачи в Ari, затем диплинк: бронирует пользователь в приложении Grab. Доступ к бронированию поездок обсуждаем отдельно.', th: 'ช่วงค่าโดยสารและเวลารอรถใน Ari แล้วตามด้วย deep link ให้ผู้ใช้จองในแอป Grab ส่วนสิทธิ์จองรถเป็นเรื่องที่หารือแยกต่างหาก' }],
      ['bowl', { en: 'A consumer ordering scope for GrabFood and GrabMart (not public today)', ru: 'Доступ к заказу GrabFood и GrabMart для потребителя (в публичных API его нет)', th: 'สิทธิ์สั่ง GrabFood และ GrabMart สำหรับผู้บริโภค (ยังไม่มีใน API สาธารณะ)' },
        { en: 'Menus, cart, order and status inside Ari under the same confirmation rules. A design discussion, outside the pilot.', ru: 'Меню, корзина, заказ и статус прямо в Ari по тем же правилам подтверждения. Это обсуждение дизайна за рамками пилота.', th: 'เมนู ตะกร้า การสั่ง และสถานะใน Ari ภายใต้กฎการยืนยันเดียวกัน เป็นการหารือด้านการออกแบบ อยู่นอกขอบเขตโครงการนำร่อง' }],
      ['handshake', { en: 'A business contact (PIC) and a shared channel with the integration team', ru: 'Контактное лицо (PIC) и общий канал с командой интеграции', th: 'ผู้ประสานงานฝ่ายธุรกิจ (PIC) และช่องทางสื่อสารร่วมกับทีมอินทิเกรชัน' },
        { en: 'One thread for certification, incidents and the weekly pilot report.', ru: 'Единый канал для сертификации, инцидентов и еженедельного отчёта по пилоту.', th: 'ช่องทางเดียวสำหรับการรับรอง เหตุขัดข้อง และรายงานนำร่องรายสัปดาห์' }],
    ];
    const ready: Tri[] = [
      { en: 'Partner API for Ari: signed requests, user mapping, cards, native confirmation, events and webhooks (tested end to end against mocks; not yet run in Grab\'s sandbox).', ru: 'Partner API для Ari: подписанные запросы, привязка пользователей, карточки, нативное подтверждение, события и вебхуки (проверено целиком на моках; в песочнице Grab ещё не запускалось).', th: 'Partner API สำหรับ Ari: คำขอลงนาม การจับคู่ผู้ใช้ การ์ด การยืนยันในแอป อีเวนต์ และ webhook (ทดสอบครบทั้งกระบวนการกับระบบจำลอง ยังไม่ได้ทดสอบบน sandbox ของ Grab)' },
      { en: 'GrabExpress client: quotes, create, status, cancel, tracking webhook, unknown-outcome reconciliation.', ru: 'Клиент GrabExpress: цены, создание, статус, отмена, вебхук отслеживания, сверка неизвестных исходов.', th: 'GrabExpress client: ราคา สร้าง สถานะ ยกเลิก webhook ติดตาม และการกระทบยอดผลที่ไม่แน่ชัด' },
      { en: 'GrabPay One-Time Charge with HMAC and proof-of-possession, automatic idempotent refunds.', ru: 'GrabPay One-Time Charge с HMAC и proof-of-possession, автоматические идемпотентные возвраты.', th: 'GrabPay One-Time Charge พร้อม HMAC และ proof-of-possession คืนเงินอัตโนมัติแบบ idempotent' },
      { en: 'Login with Grab (OIDC, PKCE S256) with protection against account pre-hijacking; Farefeed estimates with deep links.', ru: 'Login with Grab (OIDC, PKCE S256) с защитой от перехвата аккаунта; расчёт цен через Farefeed с диплинками.', th: 'Login with Grab (OIDC, PKCE S256) พร้อมการป้องกันการยึดบัญชี และประมาณการค่าโดยสารจาก Farefeed พร้อม deep link' },
      { en: '400+ automated tests, 10 interface languages, audit trail, kill switch, data export and deletion.', ru: '400+ автотестов, 10 языков интерфейса, аудит, стоп-кран, экспорт и удаление данных.', th: 'การทดสอบอัตโนมัติ 400+ รายการ อินเทอร์เฟซ 10 ภาษา บันทึกตรวจสอบ ปุ่มหยุดฉุกเฉิน การส่งออกและลบข้อมูล' },
    ];
    const gets: [Tri, Tri][] = [
      [{ en: 'Incremental orders', ru: 'Дополнительные заказы', th: 'คำสั่งซื้อเพิ่มขึ้น' }, { en: 'Orders that start in a voice assistant at the moment of intent and are fulfilled by Grab. The pilot measures how many of them are new.', ru: 'Заказы, которые начинаются в голосовом ассистенте в момент потребности и исполняются Grab. Пилот покажет, сколько из них новые.', th: 'คำสั่งซื้อที่เริ่มในผู้ช่วยเสียงในจังหวะที่ผู้ใช้ต้องการ และ Grab เป็นผู้ให้บริการ โครงการนำร่องจะวัดว่ามีกี่รายการที่เป็นคำสั่งซื้อใหม่' }],
      [{ en: 'Customer stays with Grab', ru: 'Клиент остаётся у Grab', th: 'ลูกค้ายังเป็นของ Grab' }, { en: 'Pricing, fulfilment, support and the brand remain Grab\'s. Users sign in with GrabID and pay with GrabPay.', ru: 'Цены, исполнение, поддержка и бренд остаются у Grab. Пользователи входят через GrabID и платят через GrabPay.', th: 'ราคา การให้บริการ การดูแลลูกค้า และแบรนด์ยังเป็นของ Grab ผู้ใช้เข้าสู่ระบบด้วย GrabID และจ่ายด้วย GrabPay' }],
      [{ en: 'Confirmation stays on the device', ru: 'Подтверждение остаётся на устройстве', th: 'การยืนยันอยู่บนอุปกรณ์ของผู้ใช้' }, { en: 'Every order needs the user\'s tap on a card with the final price; above a per-currency threshold, Face ID. The assistant cannot confirm for the user.', ru: 'Каждый заказ требует нажатия пользователя на карточке с итоговой ценой, а выше порога для валюты нужен Face ID. Ассистент не может подтвердить заказ за пользователя.', th: 'ทุกคำสั่งซื้อต้องให้ผู้ใช้แตะยืนยันบนการ์ดที่แสดงราคาสุดท้าย หากเกินเกณฑ์ของสกุลเงินต้องใช้ Face ID ผู้ช่วยยืนยันแทนผู้ใช้ไม่ได้' }],
      [{ en: 'One narrow integration surface', ru: 'Одна узкая точка интеграции', th: 'จุดเชื่อมต่อเดียวที่แคบ' }, { en: 'One partner client, server to server, with a short list of scopes. No scraping, no unofficial endpoints, no Grab credentials on the phone.', ru: 'Один партнёрский клиент, сервер-сервер, с коротким списком scope. Никакого скрейпинга, неофициальных эндпоинтов и ключей Grab на телефоне.', th: 'พาร์ทเนอร์ client เดียว เชื่อมต่อระหว่างเซิร์ฟเวอร์ พร้อม scope ไม่กี่รายการ ไม่มีการ scrape ไม่ใช้เอนด์พอยต์ที่ไม่เป็นทางการ และไม่มีคีย์ Grab อยู่บนโทรศัพท์' }],
      [{ en: 'Control stays with Grab', ru: 'Контроль остаётся у Grab', th: 'Grab ยังเป็นผู้ควบคุม' }, { en: 'Per-user rate limits, an audit trail, Grab request IDs in our logs and a kill switch that stops new orders while tracking continues. Grab can revoke the keys at any time.', ru: 'Лимиты запросов на пользователя, журнал аудита, идентификаторы запросов Grab в наших логах и стоп-кран, который останавливает новые заказы, не прерывая отслеживание. Grab может отозвать ключи в любой момент.', th: 'จำกัดอัตราคำขอต่อผู้ใช้ บันทึกตรวจสอบ รหัสคำขอของ Grab ใน log ของเรา และปุ่มหยุดฉุกเฉินที่หยุดคำสั่งซื้อใหม่โดยยังติดตามงานเดิมได้ Grab เพิกถอนคีย์ได้ทุกเมื่อ' }],
      [{ en: 'A blueprint for AI channels', ru: 'Шаблон для ИИ-каналов', th: 'ต้นแบบสำหรับช่องทาง AI' }, { en: 'The same engine has an MCP server, so ChatGPT, Claude, Gemini and other assistants can follow one set of safety rules.', ru: 'У того же движка есть MCP-сервер, поэтому ChatGPT, Claude, Gemini и другие ассистенты могут работать по единым правилам безопасности.', th: 'เอนจินเดียวกันมี MCP server ทำให้ ChatGPT, Claude, Gemini และผู้ช่วยอื่นใช้กฎความปลอดภัยชุดเดียวกันได้' }],
    ];
    // Answers to what a platform security team asks first. Every line is backed by the code (jobs/worker.ts retention, auth/grabid.ts, payments/service.ts).
    const security: [Tri, Tri][] = [
      [{ en: 'What we store', ru: 'Что мы храним', th: 'เราเก็บข้อมูลอะไร' }, { en: 'Email, saved addresses, preferences, carts, orders and an audit log. From Login with Grab: the account identifier (sub) only.', ru: 'Email, сохранённые адреса, предпочтения, корзины, заказы и журнал аудита. От Login with Grab: только идентификатор аккаунта (sub).', th: 'อีเมล ที่อยู่ที่บันทึกไว้ ความชอบ ตะกร้า คำสั่งซื้อ และบันทึกตรวจสอบ จาก Login with Grab เก็บเฉพาะตัวระบุบัญชี (sub)' }],
      [{ en: 'What we never see', ru: 'Чего мы не видим', th: 'สิ่งที่เราไม่เห็น' }, { en: 'Grab passwords, SMS codes, card numbers and wallet credentials. Sign-in and checkout run on Grab\'s own pages.', ru: 'Пароли Grab, коды из SMS, номера карт и данные кошелька. Вход и оплата проходят на страницах Grab.', th: 'รหัสผ่าน Grab รหัส SMS หมายเลขบัตร และข้อมูลกระเป๋าเงิน การเข้าสู่ระบบและการชำระเงินทำบนหน้าเว็บของ Grab เอง' }],
      [{ en: 'Tokens and secrets', ru: 'Токены и секреты', th: 'โทเค็นและข้อมูลลับ' }, { en: 'Grab credentials stay on the server. GrabPay tokens are sealed with AES-256-GCM. For production, secrets move to a KMS, as Grab\'s partner rules require.', ru: 'Ключи Grab хранятся только на сервере. Токены GrabPay шифруются AES-256-GCM. Для продакшена секреты переносим в KMS, как требуют правила Grab для партнёров.', th: 'คีย์ของ Grab อยู่บนเซิร์ฟเวอร์เท่านั้น โทเค็น GrabPay เข้ารหัสด้วย AES-256-GCM สำหรับ production เราจะย้ายข้อมูลลับไปไว้ใน KMS ตามข้อกำหนดพาร์ทเนอร์ของ Grab' }],
      [{ en: 'Retention and deletion', ru: 'Сроки хранения и удаление', th: 'ระยะเวลาจัดเก็บและการลบ' }, { en: 'Webhook and provider event logs are deleted after 30 days. Orders stay while the account exists. One signed DELETE call erases a user and their data.', ru: 'Журналы вебхуков и событий провайдера удаляются через 30 дней. Заказы хранятся, пока существует аккаунт. Один подписанный вызов DELETE удаляет пользователя и его данные.', th: 'log ของ webhook และอีเวนต์จากผู้ให้บริการถูกลบหลัง 30 วัน คำสั่งซื้อเก็บไว้ตลอดอายุบัญชี คำขอ DELETE ที่ลงนามเพียงครั้งเดียวลบผู้ใช้และข้อมูลของผู้ใช้ได้' }],
      [{ en: 'PDPA (Thailand)', ru: 'PDPA (Таиланд)', th: 'PDPA (ประเทศไทย)' }, { en: 'Data is used only to fulfil the order the user confirmed. Before any live launch, retention periods and consent texts go through Thai counsel review.', ru: 'Данные используются только для исполнения заказа, который подтвердил пользователь. До рабочего запуска сроки хранения и тексты согласий проходят проверку у тайского юриста.', th: 'ข้อมูลใช้เพื่อดำเนินการตามคำสั่งซื้อที่ผู้ใช้ยืนยันเท่านั้น ก่อนเปิดใช้งานจริง ระยะเวลาจัดเก็บและข้อความขอความยินยอมจะผ่านการตรวจสอบจากที่ปรึกษากฎหมายไทย' }],
      [{ en: 'Open to review', ru: 'Открыты для проверки', th: 'พร้อมให้ตรวจสอบ' }, { en: 'Grab\'s security team gets the OpenAPI document, the test suite and a staging environment before any production key is issued.', ru: 'Служба безопасности Grab получает документ OpenAPI, набор тестов и стейджинг до выдачи любых продакшен-ключей.', th: 'ทีมความปลอดภัยของ Grab จะได้รับเอกสาร OpenAPI ชุดทดสอบ และสภาพแวดล้อม staging ก่อนออกคีย์ production ใด ๆ' }],
    ];
    const covCols = [
      tr(l, { en: 'Product', ru: 'Продукт', th: 'ผลิตภัณฑ์' }), tr(l, { en: 'What Ari does', ru: 'Что делает Ari', th: 'Ari ทำอะไร' }), tr(l, { en: 'Grab API', ru: 'API Grab', th: 'API ของ Grab' }),
      tr(l, { en: 'Today', ru: 'Сегодня', th: 'ปัจจุบัน' }), tr(l, { en: 'With Grab', ru: 'С Grab', th: 'เมื่อร่วมกับ Grab' }),
    ];
    return send(reply, r, tr(l, { en: 'Proposal for Grab', ru: 'Предложение для Grab', th: 'ข้อเสนอสำหรับ Grab' }), html`<div class="ari-doc proposal">
<section class="pitch-hero">
  <span class="eyebrow">${icon('handshake')} ${tr(l, { en: 'Ari × Grab · partnership proposal', ru: 'Ari × Grab · предложение о партнёрстве', th: 'Ari × Grab · ข้อเสนอความร่วมมือ' })}</span>
  <h1>${tr(l, { en: 'Grab, inside the assistant people already talk to', ru: 'Grab внутри ассистента, с которым люди уже разговаривают', th: 'Grab อยู่ในผู้ช่วยที่ผู้คนคุยด้วยอยู่แล้ว' })}</h1>
  <p class="lead">${tr(l, { en: 'Ari (iPhone, App Store) is a voice-first personal assistant by CSA PROJECT - FZCO. We propose to make Grab the way Ari users move, eat and send things in Southeast Asia, starting with a Bangkok pilot on Grab\'s public partner APIs.', ru: 'Ari (iPhone, App Store): голосовой персональный ассистент от CSA PROJECT - FZCO. Мы предлагаем, чтобы пользователи Ari в Юго-Восточной Азии ездили, заказывали еду и отправляли посылки через Grab. Начать хотим с пилота в Бангкоке на публичных партнёрских API Grab.', th: 'Ari (iPhone, App Store) คือผู้ช่วยส่วนตัวที่สั่งงานด้วยเสียงเป็นหลักจาก CSA PROJECT - FZCO เราเสนอให้ Grab เป็นวิธีที่ผู้ใช้ Ari เดินทาง สั่งอาหาร และส่งของในเอเชียตะวันออกเฉียงใต้ เริ่มจากโครงการนำร่องที่กรุงเทพฯ บน API พาร์ทเนอร์สาธารณะของ Grab' })}</p>
  <div class="actions"><a class="btn lg ari" href="/ari">${icon('sparkle')} ${tr(l, { en: 'Live demo', ru: 'Живое демо', th: 'เดโมสด' })}</a><a class="btn lg secondary" href="/developers">${tr(l, { en: 'Partner API', ru: 'Partner API', th: 'Partner API' })} ${icon('arrow')}</a></div>
</section>

<section class="sec-block"><h2>${icon('check')} ${tr(l, { en: 'Ready today', ru: 'Готово сегодня', th: 'พร้อมแล้ววันนี้' })}</h2>
  <ul class="checklist" role="list">${ready.map((x) => html`<li>${icon('check')}<span>${tr(l, x)}</span></li>`)}</ul>
</section>

<section class="sec-block" id="coverage"><h2>${icon('globe')} ${tr(l, { en: 'Coverage of Grab products', ru: 'Покрытие продуктов Grab', th: 'ความครอบคลุมผลิตภัณฑ์ Grab' })}</h2>
  ${statusLegend(l, { detailed: true })}
  <div class="table-wrap" tabindex="0" role="region" aria-label="${tr(l, { en: 'Coverage of Grab products', ru: 'Покрытие продуктов Grab', th: 'ความครอบคลุมผลิตภัณฑ์ Grab' })}"><table class="cov-table">
    <thead><tr><th scope="col">${covCols[0]}</th><th scope="col">${covCols[1]}</th><th scope="col">${covCols[2]}</th><th scope="col">${covCols[3]}</th><th scope="col">${covCols[4]}</th></tr></thead>
    <tbody>${GRAB_PRODUCTS.map((p) => html`<tr><th scope="row">${p.name}</th><td data-label="${covCols[1]}">${p.ari[L]}</td><td class="mono small" data-label="${covCols[2]}">${(L === 'en' ? undefined : p.api_local?.[L]) ?? p.api}</td><td data-label="${covCols[3]}">${statusPill(l, p.today)}</td><td data-label="${covCols[4]}">${p.with_grab[L]}</td></tr>`)}</tbody>
  </table></div>
</section>

<section class="sec-block"><h2>${icon('route')} ${tr(l, { en: 'Pilot proposal: Bangkok, 10 weeks', ru: 'Предложение по пилоту: Бангкок, 10 недель', th: 'ข้อเสนอโครงการนำร่อง: กรุงเทพฯ 10 สัปดาห์' })}</h2>
  <ol class="pilot-plan" role="list">${phases.map(([w, t, d]) => html`<li><span class="tl-when">${tr(l, w)}</span><div><b>${tr(l, t)}</b><p>${tr(l, d)}</p></div></li>`)}</ol>
</section>

<section class="sec-block"><h2>${icon('handshake')} ${tr(l, { en: 'What we ask from Grab, and what we build with it', ru: 'Что мы просим у Grab и что с этим построим', th: 'สิ่งที่เราขอจาก Grab และสิ่งที่เราจะสร้าง' })}</h2>
  <ul class="asks" role="list">${asks.map(([ic, t, d]) => html`<li><span class="ico">${icon(ic)}</span><span><b>${tr(l, t)}</b><span class="small muted" style="display:block;margin-top:4px">${tr(l, d)}</span></span></li>`)}</ul>
</section>

<section class="sec-block"><h2>${icon('chart')} ${tr(l, { en: 'What Grab gets', ru: 'Что получает Grab', th: 'สิ่งที่ Grab ได้รับ' })}</h2>
  <div class="grid3">${gets.map(([t, d], i) => html`<div class="card flat"><h3>${tr(l, t)}</h3><p>${tr(l, d)}</p>${i === gets.length - 1 ? html`<a href="/for-grab/assistants">MCP ${icon('arrow')}</a>` : ''}</div>`)}</div>
</section>

<section class="sec-block" id="security"><h2>${icon('shield')} ${tr(l, { en: 'Security and data', ru: 'Безопасность и данные', th: 'ความปลอดภัยและข้อมูล' })}</h2>
  <div class="grid3">${security.map(([t, d]) => html`<div class="card flat"><h3>${tr(l, t)}</h3><p>${tr(l, d)}</p></div>`)}</div>
  <p class="small muted"><a href="/privacy">${tr(l, { en: 'Full retention table', ru: 'Полная таблица сроков хранения', th: 'ตารางระยะเวลาจัดเก็บทั้งหมด' })}</a></p>
</section>

<section class="sec-block" id="disclaimer"><div class="notice small">${tr(l, {
      en: 'Ari × Grab is a proposal by CSA PROJECT - FZCO (Dubai), the developer of Ari and Unyly. It is not affiliated with, endorsed by or sponsored by Grab. No agreement with Grab exists. The Grab features shown are proposed and are not in the released Ari app. Integrations were tested only against mocks. Grab and its service names are trademarks of their respective owners and are used only to describe the proposed integration; no Grab logos are used. The demo uses fictional stores, drivers, plates and fares; no real orders, rides or payments are created.',
      ru: 'Ari × Grab: предложение CSA PROJECT - FZCO (Дубай), разработчика Ari и Unyly. Оно не связано с Grab, не одобрено и не спонсируется Grab. Договорённости с Grab нет. Показанные функции Grab предлагаются и в выпущенном приложении Ari отсутствуют. Интеграции проверены только на моках. Названия Grab и его сервисов являются товарными знаками их правообладателей и используются только для описания предлагаемой интеграции; логотипы Grab не используются. В демо вымышлены магазины, водители, номера и цены; реальные заказы, поездки и платежи не создаются.',
      th: 'Ari × Grab เป็นข้อเสนอจาก CSA PROJECT - FZCO (ดูไบ) ผู้พัฒนา Ari และ Unyly ข้อเสนอนี้ไม่มีส่วนเกี่ยวข้องกับ Grab และไม่ได้รับการรับรองหรือสนับสนุนจาก Grab ยังไม่มีข้อตกลงกับ Grab ฟีเจอร์ Grab ที่แสดงเป็นฟีเจอร์ที่เสนอ ยังไม่มีในแอป Ari ที่เผยแพร่แล้ว การเชื่อมต่อผ่านการทดสอบกับระบบจำลองเท่านั้น ชื่อ Grab และชื่อบริการเป็นเครื่องหมายการค้าของเจ้าของสิทธิ์ ใช้เพื่ออธิบายการเชื่อมต่อที่เสนอเท่านั้น ไม่ใช้โลโก้ Grab ร้านค้า คนขับ ทะเบียน และราคาในเดโมเป็นข้อมูลสมมติ ไม่มีการสร้างคำสั่งซื้อ การเดินทาง หรือการชำระเงินจริง',
    })}</div></section>

<section class="sec-block"><div class="card stack pitch-contact">
  <div><span class="eyebrow">${icon('handshake')} ${tr(l, { en: 'Partnership contact', ru: 'Контакт по партнёрству', th: 'ผู้ติดต่อด้านความร่วมมือ' })}</span>
    <div class="who">${CONTACT.owner.name}</div>
    <p class="small muted"><a href="mailto:${CONTACT.owner.email}">${CONTACT.owner.email}</a> · LINE <a href="tel:+${CONTACT.owner.line}">${phoneLabel(CONTACT.owner.line)}</a> · <a href="/contact">${tr(l, { en: 'All contacts', ru: 'Все контакты', th: 'ช่องทางติดต่อทั้งหมด' })}</a></p></div>
  <div class="actions"><a class="btn ari" href="mailto:${CONTACT.owner.email}">${icon('mail')} ${tr(l, { en: 'Email', ru: 'Написать', th: 'อีเมล' })}</a><a class="btn secondary" href="${whatsappUrl(CONTACT.owner.whatsapp)}" rel="noopener">${icon('chat')} WhatsApp</a><a class="btn secondary" href="${instagramUrl(CONTACT.owner.instagram)}" rel="noopener">${icon('users')} Instagram</a></div>
</div></section></div>`, { noBanner: true, description: tr(l, { en: 'Ari × Grab: a partnership proposal to make Grab the way Ari users move, eat and send things, starting with a Bangkok pilot.', ru: 'Ari × Grab: предложение, чтобы пользователи Ari ездили, заказывали еду и отправляли посылки через Grab. Старт с пилота в Бангкоке.', th: 'Ari × Grab: ข้อเสนอให้ Grab เป็นวิธีที่ผู้ใช้ Ari เดินทาง สั่งอาหาร และส่งของ เริ่มจากนำร่องที่กรุงเทพฯ' }) });
  });

  // ---------------------------------------------------------------- developers
  app.get('/developers/ari-integration-ru.md', async (_req, reply) => reply.redirect('/static/docs/ari-integration-ru.md', 302));
  app.get('/developers', async (req, reply) => {
    const r = await base(req, reply);
    const l = r.l;
    const endpoints: [string, string, Tri][] = [
      ['GET', '/partner/v1/tools', { en: 'Tool definitions and system instructions for your LLM', ru: 'Описания инструментов и инструкции для вашей LLM', th: 'คำอธิบายเครื่องมือและคำสั่งระบบสำหรับ LLM' }],
      ['PUT', '/partner/v1/users/{uid}', { en: 'Create or update a user (locale, region)', ru: 'Создать или обновить пользователя (язык, регион)', th: 'สร้างหรืออัปเดตผู้ใช้ (ภาษา ภูมิภาค)' }],
      ['POST', '/partner/v1/users/{uid}/places', { en: 'Save Home, Work and delivery addresses', ru: 'Сохранить Дом, Работу и адреса доставки', th: 'บันทึกบ้าน ที่ทำงาน และที่อยู่จัดส่ง' }],
      ['POST', '/partner/v1/users/{uid}/tools/{name}', { en: 'Run a tool: search_stores, estimate_trip, create_cart… returns a card', ru: 'Вызвать инструмент: search_stores, estimate_trip, create_cart… возвращает карточку', th: 'เรียกเครื่องมือ: search_stores, estimate_trip, create_cart… ส่งคืนเป็นการ์ด' }],
      ['POST', '/partner/v1/users/{uid}/checkouts/{id}/confirm', { en: 'The user tapped Confirm (Face ID above the threshold)', ru: 'Пользователь нажал «Подтвердить» (Face ID выше порога)', th: 'ผู้ใช้แตะยืนยัน (Face ID เมื่อเกินเกณฑ์)' }],
      ['GET', '/partner/v1/users/{uid}/orders/{id}', { en: 'Order card with live status, courier and ETA', ru: 'Карточка заказа со статусом, курьером и временем прибытия', th: 'การ์ดคำสั่งซื้อพร้อมสถานะ ไรเดอร์ และเวลาถึง' }],
      ['POST', '/partner/v1/users/{uid}/orders/{id}/cancel', { en: 'Prepare a cancellation card with the fee', ru: 'Подготовить карточку отмены с платой за отмену', th: 'เตรียมการ์ดยกเลิกพร้อมค่าธรรมเนียม' }],
      ['GET', '/partner/v1/users/{uid}/events', { en: 'Events (same as webhooks) for polling and recovery', ru: 'События (как вебхуки) для опроса и восстановления', th: 'อีเวนต์ (ชุดเดียวกับ webhook) สำหรับ polling และการกู้คืน' }],
      ['POST', '/partner/v1/users/{uid}/grab/link', { en: 'Start Login with Grab for this user', ru: 'Запустить Login with Grab для пользователя', th: 'เริ่ม Login with Grab สำหรับผู้ใช้' }],
    ];
    const sample = `{
  "schema": "unyly.card.v1",
  "type": "checkout",
  "service": "ride",
  "title": "JustGrab",
  "route": { "from": "Siam Paragon", "to": "Suvarnabhumi Airport (BKK)", "distance_km": 32.5 },
  "total": { "label": "Total", "value": "฿421.00", "amount_minor": 42100, "currency": "THB" },
  "actions": [{
    "id": "confirm", "kind": "confirm", "style": "primary",
    "label": "Confirm ride · ฿421.00",
    "requires_user_verification": "tap",
    "endpoint": { "method": "POST", "path": "/partner/v1/users/u_123/checkouts/…/confirm",
                  "body": { "confirm_hash": "3439d5c9…" } }
  }]
}`;
    const sign = `canonical = "v1\\n" + METHOD + "\\n" + PATH_WITH_QUERY + "\\n"
          + X-Unyly-Timestamp + "\\n" + X-Unyly-Nonce + "\\n"
          + hex(sha256(raw_body))
X-Unyly-Signature: v1=hex(HMAC_SHA256(partner_secret, canonical))`;
    const event = `{
  "event_id": "4f2c…", "type": "order.status_changed", "user_id": "u_123",
  "data": { "order_id": "…", "service": "ride", "status": "preparing", "eta_at": "…" },
  "notify": { "title": "Driver arriving", "body": "Your driver is on the way to the pickup point.",
              "level": "urgent", "suggest_call": true,
              "live_activity": { "state": "preparing", "progress": 0.5, "eta_at": "…" } }
}`;
    const code = (id: string, text: string) => html`<div class="code-block"><button class="code-copy" type="button" data-copy="${id}" data-copied="${r.m.copied}">${r.m.copy}</button><pre class="code" tabindex="0"><code id="${id}">${text}</code></pre></div>`;
    return send(reply, r, tr(l, { en: 'Partner API for Ari', ru: 'Partner API для Ari', th: 'Partner API สำหรับ Ari' }), html`<div class="ari-doc">
<section class="pitch-hero">
  <span class="eyebrow">${icon('code')} ${tr(l, { en: 'Developers', ru: 'Разработчикам', th: 'นักพัฒนา' })}</span>
  <h1>${tr(l, { en: 'Unyly Partner API', ru: 'Unyly Partner API', th: 'Unyly Partner API' })}</h1>
  <p class="lead">${tr(l, { en: 'Server-to-server API between the Ari backend and the Unyly engine. Your LLM calls tools; every result comes with a card the app renders natively; the user confirms in the app; events arrive by signed webhook. Today it runs in demo mode with fictional data.', ru: 'Серверный API между бэкендом Ari и движком Unyly. Ваша LLM вызывает инструменты, каждый результат приходит с карточкой для нативного отображения, пользователь подтверждает в приложении, события приходят подписанным вебхуком. Сейчас API работает в демо-режиме на вымышленных данных.', th: 'API ระหว่างเซิร์ฟเวอร์ของแบ็กเอนด์ Ari กับเอนจิน Unyly LLM ของคุณเรียกเครื่องมือ ทุกผลลัพธ์มาพร้อมการ์ดที่แอปแสดงผลแบบเนทีฟ ผู้ใช้ยืนยันในแอป และอีเวนต์ส่งมาทาง webhook ที่ลงนาม ปัจจุบัน API ทำงานในโหมดเดโมด้วยข้อมูลสมมติ' })}</p>
  <div class="actions"><a class="btn ari" href="/partner/v1/openapi.json">${icon('code')} OpenAPI 3.1</a><a class="btn secondary" href="/developers/ari-integration-ru.md">${tr(l, { en: 'Integration spec for the Ari team (in Russian)', ru: 'ТЗ для команды Ari', th: 'ข้อกำหนดสำหรับทีม Ari (ภาษารัสเซีย)' })}</a></div>
</section>
<section class="sec-block"><h2>${tr(l, { en: 'Signing', ru: 'Подпись запросов', th: 'การลงนามคำขอ' })}</h2>
  <p>${tr(l, { en: 'Each request carries X-Unyly-Partner, X-Unyly-Timestamp (±300 s) and a single-use X-Unyly-Nonce. Webhooks to Ari use the same scheme with the webhook secret.', ru: 'Каждый запрос содержит X-Unyly-Partner, X-Unyly-Timestamp (±300 с) и одноразовый X-Unyly-Nonce. Вебхуки в Ari подписываются так же секретом вебхука.', th: 'ทุกคำขอมี X-Unyly-Partner, X-Unyly-Timestamp (±300 วินาที) และ X-Unyly-Nonce ใช้ครั้งเดียว webhook ถึง Ari ใช้รูปแบบเดียวกันด้วย webhook secret' })}</p>
  ${code('code-sign', sign)}
</section>
<section class="sec-block"><h2>${tr(l, { en: 'Endpoints', ru: 'Эндпоинты', th: 'เอนด์พอยต์' })}</h2>
  <p>${fmt(tr(l, { en: 'The main {shown} of {total} signed endpoints. The full list is in the OpenAPI document.', ru: 'Основные {shown} из {total} подписанных эндпоинтов. Полный список в документе OpenAPI.', th: 'เอนด์พอยต์หลัก {shown} จาก {total} รายการที่ลงนาม รายการทั้งหมดอยู่ในเอกสาร OpenAPI' }), { shown: endpoints.length, total: SIGNED_ENDPOINTS })}</p>
  <div class="table-wrap"><table class="ep-table"><thead class="sr-only"><tr><th scope="col">${tr(l, { en: 'Method', ru: 'Метод', th: 'เมธอด' })}</th><th scope="col">${tr(l, { en: 'Path', ru: 'Путь', th: 'พาธ' })}</th><th scope="col">${tr(l, { en: 'Purpose', ru: 'Назначение', th: 'หน้าที่' })}</th></tr></thead><tbody>${endpoints.map(([m, p, d]) => html`<tr><td class="ep-m"><span class="pill verb verb-${m.toLowerCase()}">${m}</span></td><td class="ep-p mono small">${p}</td><td class="ep-d">${tr(l, d)}</td></tr>`)}</tbody></table></div>
</section>
<section class="sec-block grid2">
  <div><h2>${tr(l, { en: 'A card', ru: 'Карточка', th: 'การ์ด' })}</h2>${code('code-card', sample)}</div>
  <div><h2>${tr(l, { en: 'An event', ru: 'Событие', th: 'อีเวนต์' })}</h2>${code('code-event', event)}</div>
</section>
<section class="sec-block"><div class="notice small">${tr(l, { en: 'Partner credentials are issued per partner by Unyly. Demo mode returns fictional Bangkok data: stores, couriers and fares are invented, and nothing is ordered or charged. Live mode switches each Grab product on only after Grab grants access. No Grab credentials exist today.', ru: 'Ключи партнёра выдаёт Unyly. Демо-режим возвращает вымышленные данные Бангкока: магазины, курьеры и цены придуманы, ничего не заказывается и не списывается. Рабочий режим включает каждый продукт Grab только после выдачи доступа. Ключей Grab сегодня нет.', th: 'Unyly ออกคีย์ให้พาร์ทเนอร์แต่ละราย โหมดเดโมส่งคืนข้อมูลสมมติของกรุงเทพฯ ร้านค้า ไรเดอร์ และราคาเป็นข้อมูลที่สร้างขึ้น ไม่มีการสั่งซื้อหรือเรียกเก็บเงินจริง โหมดใช้งานจริงจะเปิดผลิตภัณฑ์ Grab แต่ละรายการเมื่อ Grab ให้สิทธิ์แล้วเท่านั้น ปัจจุบันยังไม่มีคีย์ของ Grab' })}</div></section></div>`, { noBanner: true, description: tr(l, { en: 'Unyly Partner API: signed server-to-server API between the Ari backend and the Unyly engine, with native cards and user confirmation. Demo mode, fictional data.', ru: 'Unyly Partner API: подписанный серверный API между бэкендом Ari и движком Unyly с нативными карточками и подтверждением пользователя. Демо-режим, вымышленные данные.', th: 'Unyly Partner API: API ระหว่างเซิร์ฟเวอร์ที่ลงนาม เชื่อมแบ็กเอนด์ Ari กับเอนจิน Unyly พร้อมการ์ดแบบเนทีฟและการยืนยันจากผู้ใช้ โหมดเดโม ข้อมูลสมมติ' }) });
  });
}

