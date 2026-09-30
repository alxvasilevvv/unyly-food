// Public showcase pages: landing, the guided /try demo and the /for-grab partnership page.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { audit } from '../context.js';
import { hmac } from '../domain/crypto.js';
import { checkCsrf, createSession, setSessionCookie } from '../auth/session.js';
import { isDomainError, DomainError } from '../domain/errors.js';
import { formatMinor } from '../domain/money.js';
import { createCart, quoteCart } from '../services/carts.js';
import { searchRestaurants } from '../services/catalog.js';
import { prepareCheckout } from '../services/checkout.js';
import { addAddress, getDefaultAddress } from '../services/users.js';
import { car, flowDiagram, greenCurry, icon, mangoSticky, noodleSoup, padThai, parcel, restaurantArt, tofuBowl, tomYum } from './art.js';
import { ALLERGEN_NAMES, CUISINE_NAMES, DIET_NAMES, dishName, t3 } from './copy.js';
import { html, SafeHtml } from './html.js';
import { detectService, parseIntent } from './intent.js';
import { SHOP_STORE, shopPlan, ShopPlan, tripPlan, TripPlan } from './try-services.js';
import { REPO_URL } from './layout.js';
import { fmt, Locale, tr } from './messages.js';
import { pack } from '../i18n/index.js';
import type { Kit, R } from './routes.js';

const BASE_EXAMPLES: Record<'en' | 'th' | 'ru', string[]> = {
  en: ['Dinner for two under 600 baht, no nuts', 'Taxi from Siam Paragon to Suvarnabhumi airport', 'Groceries: rice, eggs and water', 'Red roses with a gift box', 'Paracetamol and plasters', 'Chocolate cake for a birthday', 'Send a 3 kg parcel to ICONSIAM'],
  th: ['ข้าวเย็นสำหรับ 2 คน ไม่เกิน 600 บาท ไม่ใส่ถั่ว', 'เรียกแท็กซี่จากสยามพารากอนไปสนามบินสุวรรณภูมิ', 'ของชำ ข้าวสาร ไข่ไก่ น้ำดื่ม', 'ช่อดอกกุหลาบให้แฟน', 'พาราเซตามอลกับพลาสเตอร์', 'เค้กช็อกโกแลตวันเกิด', 'ส่งพัสดุ 3 กก ไปไอคอนสยาม'],
  ru: ['Ужин на двоих до 600 бат, без орехов', 'Такси от Сиам Парагона до аэропорта Суварнабхуми', 'Продукты: рис, яйца и вода', 'Букет роз для жены', 'Парацетамол и пластыри', 'Шоколадный торт на день рождения', 'Отправить посылку 3 кг в Айконсиам'],
};
/** Example requests per language: ru/en/th here, the others from the language packs. */
const exFor = (l: Locale): string[] => {
  const base = (BASE_EXAMPLES as Record<string, string[]>)[l];
  if (base) return base;
  const p = pack(l)?.examples;
  return p && p.length === 7 ? p : BASE_EXAMPLES.en;
};
const EXAMPLES = new Proxy({} as Record<Locale, string[]>, { get: (_t, k) => exFor(k as Locale) });
/** Service chip for each example, same order as EXAMPLES. */
const EXAMPLE_KIND: { ic: string; name: { ru: string; en: string; th: string } }[] = [
  { ic: 'bowl', name: { ru: 'Еда', en: 'Food', th: 'อาหาร' } },
  { ic: 'car', name: { ru: 'Такси', en: 'Ride', th: 'เรียกรถ' } },
  { ic: 'basket', name: { ru: 'Продукты', en: 'Groceries', th: 'ของชำ' } },
  { ic: 'flower', name: { ru: 'Цветы', en: 'Flowers', th: 'ดอกไม้' } },
  { ic: 'pill', name: { ru: 'Аптека', en: 'Pharmacy', th: 'ร้านยา' } },
  { ic: 'cake', name: { ru: 'Торты', en: 'Cakes', th: 'เค้ก' } },
  { ic: 'box', name: { ru: 'Посылка', en: 'Parcel', th: 'ส่งพัสดุ' } },
];

export function registerShowcase(app: FastifyInstance, kit: Kit) {
  const { ctx, base, send, csrfField, errorBox } = kit;
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@unyly.org';
  const baht = (minor: number, l: Locale) => formatMinor(minor, 'THB', l).replace(/\.00(?=\D*$)/, '').replace(/,00(?=\D*$)/, '');

  // ---------------- Landing ----------------
  app.get('/', async (req, reply) => {
    const r = await base(req, reply);
    const { l, m } = r;
    const phone = html`<div class="phone" aria-hidden="true"><div class="phone-screen">
  <div class="phone-top"><span class="avatar">${icon('sparkle')}</span><span><b>${tr(l, { ru: 'ИИ-ассистент', en: 'AI assistant', th: 'ผู้ช่วย AI' })}</b><small>${tr(l, { ru: 'через Unyly MCP', en: 'via Unyly MCP', th: 'ผ่าน Unyly MCP' })}</small></span></div>
  <div class="chat">
    <div class="bubble me">${EXAMPLES[l][0]}</div>
    <div class="bubble ai"><span>${tr(l, { ru: '3 варианта, где рестораны не заявили орехи:', en: '3 options with no nuts declared:', th: '3 ตัวเลือกที่ร้านไม่ได้ระบุว่ามีถั่ว:' })}</span>
      <span class="opt">${greenCurry()}<span>Baan Suan Kitchen</span><b>฿320</b></span>
      <span class="opt">${noodleSoup()}<span>Sukhumvit Noodle House</span><b>฿250</b></span>
      <span class="opt">${tofuBowl()}<span>Green Bowl Bangkok</span><b>฿358</b></span>
    </div>
    <div class="bubble me">${tr(l, { ru: 'Давай первый', en: 'The first one', th: 'เอาร้านแรก' })}</div>
  </div>
  <div class="confirm-sheet">
    <div class="row"><span>${tr(l, { ru: 'Еда', en: 'Food', th: 'ค่าอาหาร' })}</span><span>฿285</span></div>
    <div class="row"><span>${tr(l, { ru: 'Доставка и сбор', en: 'Delivery and fees', th: 'ค่าส่งและค่าบริการ' })}</span><span>฿35</span></div>
    <div class="row t"><span>${tr(l, { ru: 'Итого', en: 'Total', th: 'รวม' })}</span><span>฿320</span></div>
    <div class="go">${tr(l, { ru: 'Подтвердить на Unyly', en: 'Confirm on Unyly', th: 'ยืนยันบน Unyly' })}</div>
  </div>
</div></div>`;
    const feature = (ic: string, t: string, d: string) => html`<div class="feature"><span class="ico">${icon(ic)}</span><h3>${t}</h3><p>${d}</p></div>`;
    const status = (ok: boolean, t: string, d: string, badge: string) =>
      html`<div class="status-tile ${ok ? 'ok' : 'wait'}"><span class="pill ${ok ? 'ok' : 'warn'}">${badge}</span><h3>${t}</h3><p>${d}</p></div>`;
    const services = [
      { ic: 'bowl', t: { ru: 'Еда', en: 'Food', th: 'อาหาร' }, d: { ru: 'Под бюджет, компанию и аллергии', en: 'For your budget, group and allergies', th: 'ตามงบ จำนวนคน และอาการแพ้' }, q: 0 },
      { ic: 'basket', t: { ru: 'Продукты', en: 'Groceries', th: 'ของชำ' }, d: { ru: 'Супермаркет и магазин у дома', en: 'Supermarket and corner shop', th: 'ซูเปอร์มาร์เก็ตและร้านสะดวกซื้อ' }, q: 2 },
      { ic: 'flower', t: { ru: 'Цветы', en: 'Flowers', th: 'ดอกไม้' }, d: { ru: 'Букет с открыткой', en: 'A bouquet with a card', th: 'ช่อดอกไม้พร้อมการ์ด' }, q: 3 },
      { ic: 'pill', t: { ru: 'Аптека', en: 'Pharmacy', th: 'ร้านยา' }, d: { ru: 'Только безрецептурные средства', en: 'Household remedies only', th: 'เฉพาะยาสามัญประจำบ้าน' }, q: 4 },
      { ic: 'cake', t: { ru: 'Торты', en: 'Cakes', th: 'เค้ก' }, d: { ru: 'С надписью к празднику', en: 'With an inscription', th: 'พร้อมข้อความบนเค้ก' }, q: 5 },
      { ic: 'car', t: { ru: 'Такси', en: 'Rides', th: 'เรียกรถ' }, d: { ru: 'Байк, машина, такси, минивэн', en: 'Bike, car, taxi, van', th: 'มอเตอร์ไซค์ รถยนต์ แท็กซี่ รถตู้' }, q: 1 },
      { ic: 'box', t: { ru: 'Посылки', en: 'Parcels', th: 'ส่งพัสดุ' }, d: { ru: 'От документов до 300 кг', en: 'From documents to 300 kg', th: 'ตั้งแต่เอกสารถึง 300 กก.' }, q: 6 },
    ];
    return send(reply, r, tr(l, { ru: 'Grab через ИИ-ассистента', en: 'Grab through your AI assistant', th: 'Grab ผ่านผู้ช่วย AI' }), html`
<section class="hero">
  <div>
    <span class="eyebrow">${icon('sparkle')} ${tr(l, { ru: 'Концепт для Grab · все сервисы · старт в Бангкоке', en: 'Concept for Grab · every service · starting in Bangkok', th: 'แนวคิดสำหรับ Grab · ทุกบริการ · เริ่มที่กรุงเทพฯ' })}</span>
    <h1>${tr(l, { ru: 'Скажите ИИ, что нужно.', en: 'Tell your AI what you need.', th: 'บอก AI ว่าต้องการอะไร' })} <span class="hl">${tr(l, { ru: 'Подтвердите одним нажатием.', en: 'Confirm with one tap.', th: 'แล้วกดยืนยันครั้งเดียว' })}</span></h1>
    <p class="lead">${tr(l, {
      ru: 'Еда, продукты, цветы, аптека, такси или посылка. Unyly позволяет ChatGPT, Claude, Gemini и другим ИИ-ассистентам подобрать варианты, собрать заказ или маршрут и посчитать цену со всеми сборами. Ничего не заказывается, пока вы не подтвердите на защищённой странице.',
      en: 'Food, groceries, flowers, pharmacy, a ride or a parcel. Unyly lets ChatGPT, Claude, Gemini and other AI assistants find options, build the order or the trip and price it with every fee. Nothing is ordered until you confirm on a secure page.',
      th: 'อาหาร ของชำ ดอกไม้ ร้านยา เรียกรถ หรือส่งพัสดุ Unyly ให้ ChatGPT, Claude, Gemini และผู้ช่วย AI อื่นๆ หาตัวเลือก จัดออเดอร์หรือเส้นทาง และคำนวณราคาพร้อมค่าธรรมเนียมทั้งหมด ไม่มีการสั่งจนกว่าคุณจะยืนยันในหน้าที่ปลอดภัย',
    })}</p>
    <div class="actions">
      <a class="btn lg" href="/try">${tr(l, { ru: 'Попробовать демо', en: 'Try the live demo', th: 'ลองเดโมเลย' })} ${icon('arrow')}</a>
      <a class="btn lg secondary" href="/for-grab">${tr(l, { ru: 'Предложение для Grab', en: 'Proposal for Grab', th: 'ข้อเสนอสำหรับ Grab' })}</a>
    </div>
    <div class="trust">
      <span>${icon('keyoff')} ${tr(l, { ru: 'Без пароля Grab и OTP', en: 'No Grab password or OTP', th: 'ไม่ขอรหัสผ่าน Grab หรือ OTP' })}</span>
      <span>${icon('tap')} ${tr(l, { ru: 'Подтверждает человек', en: 'A human confirms', th: 'คนเป็นผู้ยืนยัน' })}</span>
      <span>${icon('repeat')} ${tr(l, { ru: 'Без дублей заказов', en: 'No duplicate orders', th: 'ไม่มีออเดอร์ซ้ำ' })}</span>
    </div>
  </div>
  <div class="hero-art">
    <div class="blob"></div>
    <div class="plate p1">${padThai()}</div>
    <div class="plate p2">${tomYum()}</div>
    <div class="plate p3">${mangoSticky()}</div>
    ${phone}
    <div class="float-chip c1" aria-hidden="true"><span class="fc-ico lime">${icon('check')}</span><span><b>${tr(l, { ru: 'Подтверждено вами', en: 'Confirmed by you', th: 'คุณยืนยันแล้ว' })}</b><small>฿320 · ${tr(l, { ru: 'одно нажатие', en: 'one tap', th: 'กดครั้งเดียว' })}</small></span></div>
    <div class="float-chip c2" aria-hidden="true"><span class="fc-ico">${icon('bike')}</span><span><b>${tr(l, { ru: 'Курьер в пути', en: 'Rider on the way', th: 'ไรเดอร์กำลังไป' })}</b><small>${tr(l, { ru: 'около 12 мин', en: 'about 12 min', th: 'ประมาณ 12 นาที' })}</small></span></div>
  </div>
</section>

<div class="kpis">
  <div><b>7</b><span>${tr(l, { ru: 'видов заказов в одном диалоге', en: 'kinds of orders, one conversation', th: 'ประเภทคำสั่งในบทสนทนาเดียว' })}</span></div>
  <div><b>10</b><span>${tr(l, { ru: 'ИИ-ассистентов с инструкцией', en: 'AI assistants with a setup guide', th: 'ผู้ช่วย AI พร้อมวิธีเชื่อมต่อ' })}</span></div>
  <div><b>8</b><span>${tr(l, { ru: 'стран Grab', en: 'Grab markets', th: 'ประเทศที่มี Grab' })}</span></div>
  <div><b>1</b><span>${tr(l, { ru: 'нажатие человека на заказ', en: 'human tap per order', th: 'การกดของคนต่อออเดอร์' })}</span></div>
</div>

<section class="section" aria-labelledby="sv">
  <div class="section-head"><span class="eyebrow">${icon('sparkle')} ${tr(l, { ru: 'Один помощник для всего Grab', en: 'One helper for all of Grab', th: 'ผู้ช่วยเดียวสำหรับทุกบริการ Grab' })}</span><h2 id="sv">${tr(l, { ru: 'Что можно попросить', en: 'What you can ask for', th: 'ขออะไรได้บ้าง' })}</h2></div>
  <div class="svc-grid">${services.map((x) => html`<a class="svc" href="/try?q=${encodeURIComponent(EXAMPLES[l][x.q])}"><span class="ico">${icon(x.ic)}</span><b>${tr(l, x.t)}</b><small>${tr(l, x.d)}</small><em>“${EXAMPLES[l][x.q]}”</em></a>`)}</div>
</section>

<section class="section" aria-labelledby="st">
  <div class="section-head"><span class="eyebrow">${icon('check')} ${m.statusTitle}</span><h2 id="st">${tr(l, { ru: 'Честно о том, что работает', en: 'Honest about what works today', th: 'บอกตรงๆ ว่าตอนนี้อะไรใช้ได้บ้าง' })}</h2></div>
  <div class="grid three">
    ${status(true, tr(l, { ru: 'Демо', en: 'Demo', th: 'เดโม' }), m.statusDemo, m.available)}
    ${status(true, 'Handoff', m.statusHandoff, m.available)}
    ${status(false, tr(l, { ru: 'Живые заказы Grab', en: 'Live Grab orders', th: 'สั่ง Grab จริง' }), m.statusLive, tr(l, { ru: 'Нужен Grab', en: 'Needs Grab', th: 'ต้องมี Grab' }))}
  </div>
</section>

<section class="section" id="how" aria-labelledby="how-h">
  <div class="section-head"><span class="eyebrow">${icon('bolt')} ${m.howTitle}</span><h2 id="how-h">${tr(l, { ru: 'От сообщения до результата за четыре шага', en: 'From a message to done in four steps', th: 'จากข้อความจนเสร็จใน 4 ขั้นตอน' })}</h2></div>
  <div class="flow">
    ${[[m.how1t, m.how1d], [m.how2t, m.how2d], [m.how3t, m.how3d], [m.how4t, m.how4d]].map(([t, d]) => html`<div class="step"><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
</section>

<section class="section" aria-labelledby="ft">
  <div class="section-head"><span class="eyebrow">${icon('store')} ${tr(l, { ru: 'Для реальной жизни', en: 'Built for real life', th: 'ออกแบบมาเพื่อชีวิตจริง' })}</span><h2 id="ft">${tr(l, { ru: 'Сделано для реальных заказов', en: 'Made for real orders', th: 'ออกแบบมาสำหรับการสั่งจริง' })}</h2></div>
  <div class="grid three">
    ${feature('tag', tr(l, { ru: 'Бюджет со всеми сборами', en: 'Budget with every fee', th: 'งบรวมค่าธรรมเนียมทุกอย่าง' }), tr(l, { ru: 'Доставка, сервисный сбор и доплата за малый заказ видны до подтверждения.', en: 'Delivery, service and small-order fees are shown before you confirm.', th: 'เห็นค่าส่ง ค่าบริการ และค่าออเดอร์เล็กก่อนกดยืนยัน' }))}
    ${feature('alert', tr(l, { ru: 'Честно об аллергенах', en: 'Honest about allergens', th: 'ซื่อตรงเรื่องสารก่อภูมิแพ้' }), tr(l, { ru: 'Показываем только то, что заявил ресторан, и никогда не пишем «безопасно».', en: 'Shows only what restaurants declare and never says "safe".', th: 'แสดงเฉพาะที่ร้านระบุ และไม่เคยบอกว่า "ปลอดภัย"' }))}
    ${feature('users', tr(l, { ru: 'Для компании', en: 'For groups', th: 'สั่งเป็นกลุ่ม' }), tr(l, { ru: 'Порции на 1–12 человек из одной фразы.', en: 'Portions for 1 to 12 people from one sentence.', th: 'จัดอาหารสำหรับ 1 ถึง 12 คนจากประโยคเดียว' }))}
    ${feature('globe', tr(l, { ru: 'Тайский, английский, русский', en: 'Thai, English, Russian', th: 'ไทย อังกฤษ รัสเซีย' }), tr(l, { ru: 'Интерфейс и понимание запросов на трёх языках.', en: 'Interface and request understanding in three languages.', th: 'หน้าจอและการเข้าใจคำขอใน 3 ภาษา' }))}
    ${feature('bike', tr(l, { ru: 'Живой статус', en: 'Live status', th: 'สถานะแบบเรียลไทม์' }), tr(l, { ru: 'Статус приходит от провайдера по подписанным событиям, время доставки честно помечено как оценка.', en: 'Status arrives from the provider via signed events; the ETA is clearly marked as an estimate.', th: 'สถานะมาจากผู้ให้บริการผ่านเหตุการณ์ที่มีลายเซ็น เวลาจัดส่งระบุชัดว่าเป็นการประมาณ' }))}
    ${feature('plug', tr(l, { ru: 'Любой ассистент', en: 'Any assistant', th: 'ผู้ช่วยตัวไหนก็ได้' }), tr(l, { ru: 'Открытый стандарт MCP: вход через OAuth или персональный токен для любого клиента.', en: 'Open MCP standard: OAuth sign-in, or a personal token for any client.', th: 'มาตรฐานเปิด MCP: ลงชื่อเข้าใช้ด้วย OAuth หรือโทเคนส่วนตัวสำหรับไคลเอนต์ใดก็ได้' }))}
  </div>
</section>

<section class="section split dark-band" aria-labelledby="sf">
  <div class="section-head">
    <span class="eyebrow">${icon('shield')} ${tr(l, { ru: 'Безопасность', en: 'Safety', th: 'ความปลอดภัย' })}</span>
    <h2 id="sf">${m.safetyTitle}</h2>
    <p class="lead">${tr(l, { ru: 'ИИ может ошибаться. Поэтому деньги тратит только человек, а сервер защищён от повторов, подмены цены и инструкций, спрятанных в меню.', en: 'AI can make mistakes. So only a human can spend money, and the server is protected against retries, price swaps and instructions hidden in menus.', th: 'AI อาจผิดพลาดได้ จึงมีแต่คนเท่านั้นที่ใช้เงินได้ และเซิร์ฟเวอร์ป้องกันการส่งซ้ำ การเปลี่ยนราคา และคำสั่งที่ซ่อนอยู่ในเมนู' })}</p>
  </div>
  <ul class="check-list">${[m.safety1, m.safety2, m.safety3, m.safety4, m.safety5].map((x) => html`<li>${icon('check')}<span>${x}</span></li>`)}</ul>
</section>

<section class="section" aria-labelledby="cl">
  <div class="section-head"><span class="eyebrow">${icon('plug')} ${tr(l, { ru: 'Совместимость', en: 'Works with', th: 'ใช้งานร่วมกับ' })}</span><h2 id="cl">${tr(l, { ru: 'Один сервер для всех ассистентов', en: 'One server for every assistant', th: 'เซิร์ฟเวอร์เดียวสำหรับผู้ช่วยทุกตัว' })}</h2></div>
  <div class="clients"><span>ChatGPT</span><span>Claude</span><span>Gemini</span><span>Microsoft Copilot</span><span>Perplexity</span><span>Grok</span><span>Mistral Le Chat</span><span>DeepSeek</span><span>Qwen</span><span>Claude Code</span><span>OpenAI API</span><span>${tr(l, { ru: 'Любой MCP-клиент', en: 'Any MCP client', th: 'ไคลเอนต์ MCP ใดก็ได้' })}</span></div>
  <p style="margin-top:16px"><a href="/connect">${tr(l, { ru: 'Как подключить', en: 'How to connect', th: 'วิธีเชื่อมต่อ' })} ${icon('arrow')}</a></p>
</section>

<section class="section">
  <div class="band">
    <div class="band-in">
      <span class="eyebrow lime">${icon('handshake')} ${tr(l, { ru: 'Для команды Grab', en: 'For the Grab team', th: 'สำหรับทีม Grab' })}</span>
      <h2>${tr(l, { ru: 'Мы сделали это как предложение Grab', en: 'We built this as a proposal for Grab', th: 'เราสร้างสิ่งนี้เป็นข้อเสนอสำหรับ Grab' })}</h2>
      <p class="lead">${tr(l, { ru: 'Всё, кроме живых заказов, уже работает. Не хватает только партнёрского доступа к API заказов, поездок и доставки.', en: 'Everything except live orders already works. The only missing piece is partner access to ordering, ride and delivery APIs.', th: 'ทุกอย่างทำงานได้แล้ว ยกเว้นการสั่งจริง สิ่งที่ขาดคือสิทธิ์พันธมิตรในการเข้าถึง API สั่งซื้อ เรียกรถ และจัดส่ง' })}</p>
      <div class="actions"><a class="btn lime" href="/for-grab">${tr(l, { ru: 'Читать предложение', en: 'Read the proposal', th: 'อ่านข้อเสนอ' })} ${icon('arrow')}</a><a class="btn secondary" href="/try">${tr(l, { ru: 'Открыть демо', en: 'Open the demo', th: 'เปิดเดโม' })}</a></div>
    </div>
  </div>
</section>`, { noBanner: true, description: tr(l, { ru: 'Концепт: все сервисы Grab через ИИ-ассистентов с подтверждением человеком.', en: 'A concept for using every Grab service through AI assistants, with human confirmation.', th: 'แนวคิดการใช้ทุกบริการของ Grab ผ่านผู้ช่วย AI โดยมีคนเป็นผู้ยืนยัน' }) });
  });

  // ---------------- For Grab ----------------
  app.get('/for-grab', async (req, reply) => {
    const r = await base(req, reply);
    const l = r.l;
    const origin = ctx.cfg.webOrigin;
    const diagram = flowDiagram({
      you: tr(l, { ru: 'Покупатель', en: 'Customer', th: 'ลูกค้า' }),
      assistant: tr(l, { ru: 'ИИ-ассистент', en: 'AI assistant', th: 'ผู้ช่วย AI' }),
      assistantSub: 'ChatGPT · Claude · Gemini · MCP',
      unyly: 'Unyly',
      unylySub: tr(l, { ru: 'MCP-сервер и защита', en: 'MCP server + safety layer', th: 'เซิร์ฟเวอร์ MCP + ความปลอดภัย' }),
      grab: 'Grab',
      grabSub: tr(l, { ru: 'партнёрский API (нужен)', en: 'partner API (needed)', th: 'API พันธมิตร (ที่ต้องการ)' }),
      confirm: tr(l, { ru: 'Страница подтверждения', en: 'Confirmation page', th: 'หน้ายืนยัน' }),
      confirmSub: tr(l, { ru: 'цена, адрес или маршрут', en: 'price, address or route', th: 'ราคา ที่อยู่หรือเส้นทาง' }),
      tap: tr(l, { ru: 'одно нажатие', en: 'one tap to confirm', th: 'กดยืนยันครั้งเดียว' }),
      mcp: 'MCP',
      api: 'API',
    });
    const stat = (b: string, s: string) => html`<div class="stat"><b>${b}</b><span>${s}</span></div>`;
    const built = (href: string, t: string, d: string) => html`<a class="built" href="${href}"><span><strong>${t}</strong><span class="small muted">${d}</span></span>${icon('arrow')}</a>`;
    const guard = (ic: string, t: string, d: string) => html`<div class="feature"><span class="ico">${icon(ic)}</span><h3>${t}</h3><p>${d}</p></div>`;
    return send(reply, r, tr(l, { ru: 'Предложение для Grab', en: 'Proposal for Grab', th: 'ข้อเสนอสำหรับ Grab' }), html`
<section class="pitch-hero">
  <span class="eyebrow">${icon('handshake')} ${tr(l, { ru: 'Предложение о партнёрстве · черновик', en: 'Partnership proposal · draft', th: 'ข้อเสนอความร่วมมือ · ฉบับร่าง' })}</span>
  <h1>${tr(l, { ru: 'Весь Grab в любом ИИ-ассистенте. Безопасно.', en: 'All of Grab inside any AI assistant. Safely.', th: 'ทุกบริการของ Grab ในผู้ช่วย AI ทุกตัว อย่างปลอดภัย' })}</h1>
  <p class="lead">${tr(l, {
    ru: 'Люди всё чаще начинают задачи в ChatGPT, Claude, Gemini и других ассистентах. Открытый стандарт MCP позволяет им работать с внешними сервисами. Unyly - готовый слой между десятью популярными ассистентами и сервисами Grab: еда, Mart (продукты, цветы, аптека, торты), поездки и Express. Один сценарий: поиск, корзина или маршрут, точная цена, подтверждение человеком, отслеживание.',
    en: 'People increasingly start tasks in ChatGPT, Claude, Gemini and other assistants. The open MCP standard lets them use outside services. Unyly is a ready-made layer between the ten most used assistants and Grab services: Food, Mart (groceries, flowers, pharmacy, cakes), rides and Express. One flow: search, cart or route, exact price, human confirmation, tracking.',
    th: 'ผู้คนเริ่มต้นงานใน ChatGPT, Claude, Gemini และผู้ช่วยอื่นๆ มากขึ้นเรื่อยๆ มาตรฐานเปิด MCP ทำให้ผู้ช่วยเหล่านี้ใช้บริการภายนอกได้ Unyly คือชั้นกลางที่พร้อมใช้ระหว่างผู้ช่วย AI ยอดนิยม 10 ตัวกับบริการของ Grab ได้แก่ Food, Mart (ของชำ ดอกไม้ ร้านยา เค้ก) การเดินทาง และ Express ขั้นตอนเดียว: ค้นหา ตะกร้าหรือเส้นทาง ราคาที่แม่นยำ การยืนยันโดยคน และการติดตาม',
  })}</p>
  <div class="actions"><a class="btn lg" href="/try">${tr(l, { ru: 'Посмотреть демо', en: 'See the demo', th: 'ดูเดโม' })} ${icon('arrow')}</a><a class="btn lg secondary" href="mailto:${supportEmail}">${icon('mail')} ${tr(l, { ru: 'Связаться', en: 'Get in touch', th: 'ติดต่อเรา' })}</a></div>
</section>

<div class="stat-row" style="margin-top:36px">
  ${stat('4', tr(l, { ru: 'сервиса Grab: Food, Mart, поездки, Express', en: 'Grab services: Food, Mart, rides, Express', th: 'บริการ Grab: Food, Mart, เดินทาง, Express' }))}
  ${stat('15', tr(l, { ru: 'инструментов MCP на всё', en: 'MCP tools for all of it', th: 'เครื่องมือ MCP สำหรับทั้งหมด' }))}
  ${stat('10', tr(l, { ru: 'ИИ-ассистентов с инструкцией', en: 'AI assistants covered', th: 'ผู้ช่วย AI ที่รองรับ' }))}
  ${stat('8', tr(l, { ru: 'стран Grab (старт: Таиланд)', en: 'Grab markets (Thailand first)', th: 'ประเทศ (เริ่มที่ไทย)' }))}
</div>

<section class="section">
  <div class="section-head"><span class="eyebrow">${icon('code')} ${tr(l, { ru: 'Архитектура', en: 'How it fits', th: 'โครงสร้างการทำงาน' })}</span><h2>${tr(l, { ru: 'Ассистент готовит, человек подтверждает, Grab выполняет', en: 'The assistant prepares, a human confirms, Grab fulfils', th: 'ผู้ช่วยเตรียม คนยืนยัน Grab ดำเนินการ' })}</h2></div>
  <div class="diagram">${diagram}</div>
  <ol class="diagram-mobile" aria-hidden="true">
    <li><strong>${tr(l, { ru: 'Покупатель', en: 'Customer', th: 'ลูกค้า' })}</strong><span>${tr(l, { ru: 'пишет ассистенту обычными словами', en: 'types a request in plain words', th: 'พิมพ์คำขอเป็นภาษาปกติ' })}</span></li>
    <li><strong>${tr(l, { ru: 'ИИ-ассистент', en: 'AI assistant', th: 'ผู้ช่วย AI' })}</strong><span>ChatGPT · Claude · Gemini · MCP</span></li>
    <li class="brand"><strong>Unyly</strong><span>${tr(l, { ru: 'MCP-сервер и защита', en: 'MCP server + safety layer', th: 'เซิร์ฟเวอร์ MCP + ความปลอดภัย' })}</span></li>
    <li class="lime"><strong>${tr(l, { ru: 'Страница подтверждения', en: 'Confirmation page', th: 'หน้ายืนยัน' })}</strong><span>${tr(l, { ru: 'покупатель нажимает одну кнопку', en: 'the customer taps once to confirm', th: 'ลูกค้ากดยืนยันครั้งเดียว' })}</span></li>
    <li class="dash"><strong>Grab</strong><span>${tr(l, { ru: 'партнёрский API (нужен)', en: 'partner API (needed)', th: 'API พันธมิตร (ที่ต้องการ)' })}</span></li>
  </ol>
</section>

<section class="section">
  <div class="section-head"><span class="eyebrow">${icon('check')} ${tr(l, { ru: 'Уже сделано', en: 'Already built', th: 'สร้างเสร็จแล้ว' })}</span><h2>${tr(l, { ru: 'Работает сегодня', en: 'Working today', th: 'ใช้งานได้วันนี้' })}</h2>
  <p class="lead">${tr(l, { ru: 'Полный сценарий для всех сервисов на вымышленных данных, с той же логикой, что понадобится для живых заказов.', en: 'The full flow for every service on fictional data, with the same logic live orders will need.', th: 'ขั้นตอนครบถ้วนสำหรับทุกบริการด้วยข้อมูลสมมติ ใช้ตรรกะเดียวกับที่การสั่งจริงต้องใช้' })}</p></div>
  <div class="built-list">
    ${built('/try', tr(l, { ru: 'Интерактивное демо', en: 'Interactive demo', th: 'เดโมแบบโต้ตอบ' }), tr(l, { ru: 'Еда, продукты, цветы, аптека, торты, такси, посылки на 10 языках стран Grab', en: 'Food, groceries, flowers, pharmacy, cakes, rides and parcels in the 10 languages of Grab markets', th: 'อาหาร ของชำ ดอกไม้ ร้านยา เค้ก เรียกรถ ส่งพัสดุ ใน 10 ภาษาของประเทศที่มี Grab' }))}
    ${built('/connect', tr(l, { ru: 'Удалённый MCP-сервер для 10 ассистентов', en: 'Remote MCP server for 10 assistants', th: 'เซิร์ฟเวอร์ MCP ระยะไกลสำหรับผู้ช่วย 10 ตัว' }), `${origin}/mcp · OAuth 2.1 + PKCE · CIMD · ${tr(l, { ru: 'персональные токены', en: 'personal tokens', th: 'โทเคนส่วนตัว' })}`)}
    ${built(`${origin}/.well-known/oauth-authorization-server`, tr(l, { ru: 'Метаданные OAuth', en: 'OAuth metadata', th: 'ข้อมูลเมตา OAuth' }), 'RFC 8414 · RFC 9728 · RFC 8707')}
    ${built(REPO_URL, tr(l, { ru: 'Исходный код и документация', en: 'Source code and docs', th: 'ซอร์สโค้ดและเอกสาร' }), tr(l, { ru: 'Архитектура, модель угроз, схемы инструментов, тесты', en: 'Architecture, threat model, tool schemas, tests', th: 'สถาปัตยกรรม โมเดลภัยคุกคาม สคีมาเครื่องมือ การทดสอบ' }))}
  </div>
</section>

<section class="section">
  <div class="section-head"><span class="eyebrow">${icon('shield')} ${tr(l, { ru: 'Для команд риска и безопасности', en: 'For risk and security teams', th: 'สำหรับทีมความเสี่ยงและความปลอดภัย' })}</span><h2>${tr(l, { ru: 'Защита встроена, а не добавлена', en: 'Safety built in, not bolted on', th: 'ความปลอดภัยฝังอยู่ในระบบตั้งแต่แรก' })}</h2></div>
  <div class="grid three">
    ${guard('tap', tr(l, { ru: 'Согласие человека', en: 'Human consent', th: 'ความยินยอมของคน' }), tr(l, { ru: 'Одноразовое подтверждение привязано к пользователю, версии корзины, цене, адресу или маршруту и сроку действия.', en: 'A one-time approval bound to the user, cart version, price, address or route, and expiry.', th: 'การยืนยันครั้งเดียวผูกกับผู้ใช้ เวอร์ชันตะกร้า ราคา ที่อยู่หรือเส้นทาง และเวลาหมดอายุ' }))}
    ${guard('repeat', tr(l, { ru: 'Без дублей', en: 'No duplicates', th: 'ไม่มีออเดอร์ซ้ำ' }), tr(l, { ru: 'Ключ идемпотентности на каждую отправку; неизвестный исход сверяется, а не отправляется заново.', en: 'An idempotency key per submission; unknown outcomes are reconciled, never resent.', th: 'มีคีย์ idempotency ทุกการส่ง ผลลัพธ์ที่ไม่ชัดเจนจะถูกตรวจสอบ ไม่ส่งซ้ำ' }))}
    ${guard('eye', tr(l, { ru: 'Защита от инъекций', en: 'Prompt-injection resistant', th: 'ต้านทาน prompt injection' }), tr(l, { ru: 'Текст меню - это данные. Даже «инструкция» в описании блюда не обходит подтверждение.', en: 'Menu text is data. Even an "instruction" in a dish description cannot skip confirmation.', th: 'ข้อความในเมนูเป็นเพียงข้อมูล แม้มี "คำสั่ง" ในคำอธิบายอาหารก็ข้ามการยืนยันไม่ได้' }))}
    ${guard('keyoff', tr(l, { ru: 'Никаких учётных данных Grab', en: 'No Grab credentials', th: 'ไม่ใช้ข้อมูลบัญชี Grab' }), tr(l, { ru: 'Нет парсинга, cookies, перехвата токенов и обхода CAPTCHA. Только документированные API.', en: 'No scraping, cookies, token interception or CAPTCHA bypass. Documented APIs only.', th: 'ไม่ดึงข้อมูลเว็บ ไม่ใช้คุกกี้ ไม่ดักโทเคน ไม่ข้าม CAPTCHA ใช้เฉพาะ API ที่มีเอกสาร' }))}
    ${guard('power', tr(l, { ru: 'Аварийный выключатель', en: 'Kill switch', th: 'สวิตช์หยุดฉุกเฉิน' }), tr(l, { ru: 'Новые заказы останавливаются по режиму без перезапуска, статусы продолжают работать.', en: 'New orders stop per mode without a restart; status tracking keeps working.', th: 'หยุดรับออเดอร์ใหม่แยกตามโหมดได้โดยไม่ต้องรีสตาร์ท การติดตามสถานะยังทำงานต่อ' }))}
    ${guard('alert', tr(l, { ru: 'Честные аллергены', en: 'Honest allergens', th: 'ข้อมูลสารก่อภูมิแพ้ที่ตรงไปตรงมา' }), tr(l, { ru: 'Аллергии отделены от диеты. Нет данных - так и пишем, слово «безопасно» не используется.', en: 'Allergies are separate from diet. Missing data is shown as missing; "safe" is never used.', th: 'อาการแพ้แยกจากความชอบด้านอาหาร ถ้าไม่มีข้อมูลก็แสดงว่าไม่มี ไม่ใช้คำว่า "ปลอดภัย"' }))}
    ${guard('pill', tr(l, { ru: 'Аптека по правилам', en: 'Pharmacy within the rules', th: 'ร้านยาตามกฎหมาย' }), tr(l, { ru: 'Только безрецептурные средства (ยาสามัญประจำบ้าน), лимиты на количество, никаких рецептурных препаратов.', en: 'Household remedies only (ยาสามัญประจำบ้าน), per-order limits, no prescription medicines.', th: 'เฉพาะยาสามัญประจำบ้าน จำกัดจำนวนต่อออเดอร์ ไม่มียาที่ต้องใช้ใบสั่งแพทย์' }))}
    ${guard('car', tr(l, { ru: 'Маршрут под контролем', en: 'Routes you can check', th: 'ตรวจสอบเส้นทางได้' }), tr(l, { ru: 'Места распознаются явно; «аэропорт» без уточнения не угадывается. Смена маршрута аннулирует подтверждение.', en: 'Places are resolved explicitly; "the airport" is never guessed. Changing the route voids the approval.', th: 'ระบุสถานที่อย่างชัดเจน ไม่เดาว่า "สนามบิน" คือที่ไหน เปลี่ยนเส้นทางแล้วการยืนยันเดิมจะใช้ไม่ได้' }))}
  </div>
</section>

<section class="section split">
  <div class="section-head"><span class="eyebrow">${icon('handshake')} ${tr(l, { ru: 'Что нужно от Grab', en: 'What we need from Grab', th: 'สิ่งที่ต้องการจาก Grab' })}</span><h2>${tr(l, { ru: 'Шесть вещей до первого живого заказа', en: 'Six things before the first live order', th: '6 สิ่งก่อนออเดอร์จริงครั้งแรก' })}</h2>
  <p class="lead">${tr(l, { ru: 'Публичных API для заказа еды, товаров Mart или поездки от имени покупателя сейчас нет, поэтому живой режим выключен. Мы ничего не обходим. GrabExpress Delivery API существует для бизнеса и может стать первым живым сервисом.', en: 'There are no public APIs for ordering food, Mart items or rides on behalf of a customer today, so live mode is off. We do not work around that. The GrabExpress Delivery API exists for businesses and could be the first live service.', th: 'ปัจจุบันไม่มี API สาธารณะสำหรับสั่งอาหาร สินค้า Mart หรือเรียกรถแทนลูกค้า โหมดจริงจึงปิดไว้ และเราไม่หาทางเลี่ยง GrabExpress Delivery API มีสำหรับธุรกิจ และอาจเป็นบริการแรกที่เปิดใช้จริง' })}</p></div>
  <ol class="ask-list">
    <li><span><strong>${tr(l, { ru: 'API заказа Food и Mart для партнёров', en: 'Partner ordering API for Food and Mart', th: 'API สั่งซื้อ Food และ Mart สำหรับพันธมิตร' })}</strong><br><span class="small muted">${tr(l, { ru: 'Поиск, каталог, расчёт цены, создание заказа, статусы, отмена', en: 'Search, catalogue, pricing, order creation, status, cancellation', th: 'ค้นหา แคตตาล็อก คำนวณราคา สร้างออเดอร์ สถานะ ยกเลิก' })}</span></span></li>
    <li><span><strong>${tr(l, { ru: 'API поездок и доступ к Express', en: 'Ride booking API and Express access', th: 'API เรียกรถ และสิทธิ์ใช้ Express' })}</strong><br><span class="small muted">${tr(l, { ru: 'Расчёт тарифа, бронирование, статус водителя; ключи GrabExpress для песочницы', en: 'Fare estimate, booking, driver status; GrabExpress sandbox keys', th: 'ประเมินค่าโดยสาร จอง สถานะคนขับ และคีย์ sandbox ของ GrabExpress' })}</span></span></li>
    <li><span><strong>${tr(l, { ru: 'Вход через GrabID', en: 'GrabID sign-in', th: 'เข้าสู่ระบบด้วย GrabID' })}</strong><br><span class="small muted">${tr(l, { ru: 'OAuth-scopes для заказов от имени пользователя', en: 'OAuth scopes for ordering on the user’s behalf', th: 'OAuth scope สำหรับสั่งแทนผู้ใช้' })}</span></span></li>
    <li><span><strong>${tr(l, { ru: 'Оплата внутри Grab', en: 'Payment inside Grab', th: 'ชำระเงินภายใน Grab' })}</strong><br><span class="small muted">${tr(l, { ru: 'GrabPay с подтверждением на стороне Grab; Unyly не видит карты', en: 'GrabPay approved on Grab’s side; Unyly never sees cards', th: 'GrabPay ยืนยันฝั่ง Grab Unyly ไม่เห็นข้อมูลบัตร' })}</span></span></li>
    <li><span><strong>${tr(l, { ru: 'Подписанные webhooks', en: 'Signed webhooks', th: 'Webhook ที่มีลายเซ็น' })}</strong><br><span class="small muted">${tr(l, { ru: 'События статуса заказа с проверяемой подписью', en: 'Order status events with a verifiable signature', th: 'เหตุการณ์สถานะออเดอร์พร้อมลายเซ็นที่ตรวจสอบได้' })}</span></span></li>
    <li><span><strong>${tr(l, { ru: 'Ключ идемпотентности', en: 'Idempotency key', th: 'คีย์ idempotency' })}</strong><br><span class="small muted">${tr(l, { ru: 'Или поиск заказа по нашему ключу, чтобы безопасно сверять сбои сети', en: 'Or order lookup by our key, to reconcile network failures safely', th: 'หรือค้นหาออเดอร์ด้วยคีย์ของเรา เพื่อตรวจสอบเมื่อเครือข่ายล้มเหลวอย่างปลอดภัย' })}</span></span></li>
  </ol>
</section>

<section class="section">
  <div class="section-head"><span class="eyebrow">${icon('chart')} ${tr(l, { ru: 'Пилот', en: 'Pilot', th: 'โครงการนำร่อง' })}</span><h2>${tr(l, { ru: 'Предлагаемый пилот', en: 'Proposed pilot', th: 'โครงการนำร่องที่เสนอ' })}</h2></div>
  <div class="grid three">
    <div class="phase"><span class="pill accent">${tr(l, { ru: 'Недели 1–3', en: 'Weeks 1-3', th: 'สัปดาห์ 1-3' })}</span><h3>Sandbox</h3><p>${tr(l, { ru: 'Live-адаптер к песочнице Grab, контрактные тесты, проверка безопасности вашей командой.', en: 'Live adapter against the Grab sandbox, contract tests, security review by your team.', th: 'เชื่อมต่อกับ sandbox ของ Grab ทดสอบสัญญา และให้ทีมของคุณตรวจความปลอดภัย' })}</p></div>
    <div class="phase"><span class="pill accent">${tr(l, { ru: 'Недели 4–8', en: 'Weeks 4-8', th: 'สัปดาห์ 4-8' })}</span><h3>${tr(l, { ru: 'Закрытая бета в Бангкоке', en: 'Closed beta in Bangkok', th: 'เบต้าปิดในกรุงเทพฯ' })}</h3><p>${tr(l, { ru: 'Ограниченная группа пользователей, лимиты на сумму, ежедневный разбор инцидентов.', en: 'A limited group of users, spending caps, daily incident review.', th: 'ผู้ใช้กลุ่มจำกัด จำกัดยอดใช้จ่าย ทบทวนเหตุการณ์ทุกวัน' })}</p></div>
    <div class="phase"><span class="pill accent">${tr(l, { ru: 'Итог', en: 'Outcome', th: 'ผลลัพธ์' })}</span><h3>${tr(l, { ru: 'Решение по запуску', en: 'Go or no-go', th: 'ตัดสินใจเปิดตัว' })}</h3><p>${tr(l, { ru: 'Метрики: доля подтверждённых предложений, отмены, обращения в поддержку, время до заказа.', en: 'Metrics: suggestion-to-order rate, cancellations, support contacts, time to order.', th: 'ตัวชี้วัด: อัตราจากข้อเสนอถึงออเดอร์ การยกเลิก การติดต่อฝ่ายสนับสนุน เวลาจนสั่งสำเร็จ' })}</p></div>
  </div>
  <p class="small muted" style="margin-top:14px">${tr(l, { ru: 'Модель дохода - гипотеза для обсуждения: реферальная комиссия за заказ или лицензия на технологию. Пользователям сервис бесплатен.', en: 'Revenue model is a hypothesis to discuss: a referral fee per order or a technology licence. Free for users.', th: 'รูปแบบรายได้เป็นสมมติฐานเพื่อหารือ: ค่าแนะนำต่อออเดอร์ หรือค่าลิขสิทธิ์เทคโนโลยี ผู้ใช้ใช้ฟรี' })}</p>
</section>

<section class="section" id="disclaimer">
  <div class="card tint stack">
    <h3>${icon('alert')} ${tr(l, { ru: 'Важно', en: 'Important', th: 'ข้อสำคัญ' })}</h3>
    <p>${tr(l, {
      ru: 'Unyly - независимый концепт. Он не связан с Grab, не одобрен и не спонсируется Grab. Названия Grab и его сервисов принадлежат их владельцам и используются только для описания предлагаемой интеграции. Логотипы Grab не используются. Демо-магазины, водители и тарифы вымышлены, реальные заказы и поездки не создаются.',
      en: 'Unyly is an independent concept. It is not affiliated with, endorsed by or sponsored by Grab. The names of Grab and its services belong to their owners and are used only to describe the proposed integration. No Grab logos are used. Demo stores, drivers and fares are fictional; no real orders or rides are created.',
      th: 'Unyly เป็นแนวคิดอิสระ ไม่ได้เกี่ยวข้อง ไม่ได้รับการรับรอง และไม่ได้รับการสนับสนุนจาก Grab ชื่อ Grab และชื่อบริการต่างๆ เป็นของเจ้าของสิทธิ์ และใช้เพื่ออธิบายการเชื่อมต่อที่เสนอเท่านั้น ไม่มีการใช้โลโก้ของ Grab ร้านค้า คนขับ และค่าโดยสารในเดโมเป็นข้อมูลสมมติ ไม่มีการสั่งซื้อหรือเดินทางจริง',
    })}</p>
    <p class="small muted">${tr(l, { ru: 'Контакт:', en: 'Contact:', th: 'ติดต่อ:' })} <a href="mailto:${supportEmail}">${supportEmail}</a></p>
  </div>
</section>`, { noBanner: true, description: tr(l, { ru: 'Предложение о партнёрстве: все сервисы Grab через ИИ-ассистентов.', en: 'Partnership proposal: every Grab service through AI assistants.', th: 'ข้อเสนอความร่วมมือ: ทุกบริการของ Grab ผ่านผู้ช่วย AI' }) });
  });

  // ---------------- Guided demo ----------------
  const cleanQ = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

  async function createGuest(l: Locale, reply: FastifyReply, ip: string) {
    // Keyed hash: a plain sha256 of an IPv4 address can be reversed by brute force.
    const ipHash = hmac(ctx.cfg.demoWebhookSecret, `guest-ip:${ip}`).slice(0, 32);
    const userId = await ctx.db.tx(async (q) => {
      // Serialize guest creation so both caps hold under concurrency.
      await q.query("SELECT pg_advisory_xact_lock(hashtext('unyly.guest_create'))");
      const c = (await q.query(
        `SELECT count(*)::int total, count(*) FILTER (WHERE guest_ip_hash = $1)::int mine FROM users WHERE is_guest AND created_at > now() - interval '1 hour'`,
        [ipHash],
      )).rows[0];
      if (c.mine >= ctx.cfg.guestPerIpHourly || c.total >= ctx.cfg.guestHourlyLimit) return null;
      const u = await q.query(`INSERT INTO users (email, locale, is_guest, onboarded_at, guest_ip_hash) VALUES ($1, $2, true, now(), $3) RETURNING id`, [`guest-${randomUUID()}@guest.unyly.invalid`, l, ipHash]);
      const id = u.rows[0].id as string;
      await q.query('INSERT INTO preferences (user_id, default_party_size) VALUES ($1, 2)', [id]);
      await q.query(`INSERT INTO provider_connections (user_id, provider, mode, status) VALUES ($1,'demo','demo','connected') ON CONFLICT DO NOTHING`, [id]);
      await audit(q, { userId: id, actor: 'web', action: 'user.guest_created' });
      return id;
    });
    if (!userId) throw new DomainError('RATE_LIMITED', 'The demo is busy right now. Please try again in a few minutes.');
    await addAddress(ctx, userId, {
      label: tr(l, { ru: 'Демо-квартира', en: 'Demo condo', th: 'คอนโดเดโม' }),
      line1: '88 Sukhumvit Soi 24 (demo)', district: 'Watthana', city: 'Bangkok', country: 'TH',
    }, true);
    const token = await createSession(ctx.db, userId);
    setSessionCookie(ctx, reply, token);
  }

  app.post('/try/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = await base(req, reply);
    const q = cleanQ((req.body as any)?.q) || EXAMPLES[r.l][0];
    try {
      if (r.s) checkCsrf(ctx, req, r.s);
      else {
        // No session yet, so no CSRF token: require a same-origin browser request instead.
        if (!kit.sameOrigin(req)) throw new DomainError('AUTH_REQUIRED', 'Cross-site request blocked');
        await createGuest(r.l, reply, req.ip);
      }
    } catch (e) {
      if (!isDomainError(e)) req.log.error(e);
      return renderTry(reply, r, q, null, errorBox(e), 400);
    }
    return reply.code(303).redirect(`/try?q=${encodeURIComponent(q)}`);
  });

  app.get('/try', async (req, reply) => {
    const r = await base(req, reply);
    const q = cleanQ((req.query as any)?.q);
    if (!q || !r.s) return renderTry(reply, r, q, null);
    const pre = await preflight(r);
    if (pre) return renderTry(reply, r, q, null, pre);
    const actor = { userId: r.s.user.id, via: 'web' as const };
    try {
      const si = detectService(q);
      if (si.service === 'ride' || si.service === 'express') return renderTry(reply, r, q, { kind: 'trip', plan: await tripPlan(ctx, actor, si) });
      if (si.service !== 'food') return renderTry(reply, r, q, { kind: 'shop', plan: await shopPlan(ctx, actor, si.service, q) });
      const intent = parseIntent(q);
      const res = await searchRestaurants(ctx, actor, { ...intent, limit: 10 });
      return renderTry(reply, r, q, { kind: 'food', intent, res });
    } catch (e) {
      if (!isDomainError(e)) req.log.error(e);
      return renderTry(reply, r, q, null, placeError(r.l, q, e));
    }
  });

  /** Unknown or ambiguous place: offer the suggestions as ready-made requests. */
  function placeError(l: Locale, q: string, e: unknown): SafeHtml {
    if (isDomainError(e) && (e.code === 'PLACE_AMBIGUOUS' || e.code === 'PLACE_NOT_FOUND')) {
      const sug = ((e.details?.suggestions as string[]) ?? []).slice(0, 4);
      const field = e.details?.field === 'pickup' ? 'pickup' : 'dropoff';
      const si = detectService(q);
      const other = field === 'pickup' ? si.dropoff : si.pickup;
      const verb = si.service === 'express' ? tr(l, { ru: 'Посылка', en: 'Parcel', th: 'ส่งพัสดุ' }) : tr(l, { ru: 'Такси', en: 'Taxi', th: 'แท็กซี่' });
      const FROM = tr(l, { ru: 'от', en: 'from', th: 'จาก' });
      const TO = tr(l, { ru: 'до', en: 'to', th: 'ไป' });
      // Burmese puts the particles after the place: "X မှ Y သို့ Taxi".
      const post = l === 'my';
      const route = (a: string | undefined, b: string) =>
        post ? `${a ? `${a}${FROM} ` : ''}${b}${TO} ${verb}` : `${verb}${a ? ` ${FROM} ${a}` : ''} ${TO} ${b}`;
      const make = (p: string) => (field === 'pickup' ? route(p, other ?? '') : route(other, p)).replace(/\s+/g, ' ').trim();
      const head = e.code === 'PLACE_AMBIGUOUS'
        ? tr(l, { ru: 'Уточните место:', en: 'Which one do you mean?', th: 'หมายถึงที่ไหน?' })
        : tr(l, { ru: 'Не нашёл это место на демо-карте Бангкока. Например:', en: 'That place is not on the Bangkok demo map. Try one of these:', th: 'ไม่พบสถานที่นี้บนแผนที่เดโมกรุงเทพฯ ลองเลือก:' });
      return html`<div class="notice warn stack" role="status"><span>${head}</span><div class="chips">${sug.map((x) => html`<a href="/try?q=${encodeURIComponent(make(x))}">${x}</a>`)}</div></div>`;
    }
    return errorBox(e);
  }

  app.post('/try/choose', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = await base(req, reply);
    const b = (req.body ?? {}) as Record<string, string>;
    const q = cleanQ(b.q);
    if (!r.s) return reply.code(303).redirect(`/try?q=${encodeURIComponent(q)}`);
    try {
      checkCsrf(ctx, req, r.s);
      const pre = await preflight(r);
      if (pre) return renderTry(reply, r, q, null, pre, 409);
      const actor = { userId: r.s.user.id, via: 'web' as const };
      // Never trust the client for items: recompute the plan server-side from the request text.
      const si = detectService(q);
      if (b.kind === 'trip' && (si.service === 'ride' || si.service === 'express')) {
        const plan = await tripPlan(ctx, actor, si);
        const opt = plan.result.options.find((o) => o.item_id === String(b.item_id ?? '') && o.fits);
        if (!opt) throw new DomainError('VALIDATION_FAILED', 'This option is no longer available. Please search again.');
        const cart = await createCart(ctx, actor, { service: plan.service, pickup: plan.pickup, dropoff: plan.dropoff, parcel_weight_kg: plan.weight_kg, items: [{ item_id: opt.item_id, quantity: 1 }] });
        const { quote } = await quoteCart(ctx, actor, cart.id);
        const co = await prepareCheckout(ctx, actor, { cart_id: cart.id, quote_id: quote.id });
        return reply.code(303).redirect(`/confirm/${co.id}`);
      }
      if (b.kind === 'shop' && si.service !== 'food' && si.service !== 'ride' && si.service !== 'express') {
        const plan = await shopPlan(ctx, actor, si.service, q);
        if (plan.store_id !== String(b.store_id ?? '') || plan.blocking.length) throw new DomainError('VALIDATION_FAILED', 'This option is no longer available. Please search again.');
        const cart = await createCart(ctx, actor, { restaurant_id: plan.store_id, items: plan.lines.map((x) => ({ item_id: x.item_id, quantity: x.quantity, modifiers: x.modifiers })) });
        const { quote } = await quoteCart(ctx, actor, cart.id);
        const co = await prepareCheckout(ctx, actor, { cart_id: cart.id, quote_id: quote.id });
        return reply.code(303).redirect(`/confirm/${co.id}`);
      }
      if (si.service !== 'food') throw new DomainError('VALIDATION_FAILED', 'This option is no longer available. Please search again.');
      const res = await searchRestaurants(ctx, actor, { ...parseIntent(q), limit: 10 });
      const hit = res.restaurants.find((x: any) => x.restaurant.store_id === String(b.restaurant_id ?? ''));
      if (!hit?.suggestion || hit.availability_notes.length || hit.suggestion.blocking_issues.length) throw new DomainError('VALIDATION_FAILED', 'This option is no longer available. Please search again.');
      const cart = await createCart(ctx, actor, { restaurant_id: hit.restaurant.store_id, items: hit.suggestion.items.map((i: any) => ({ item_id: i.item_id, quantity: i.quantity })) });
      const { quote } = await quoteCart(ctx, actor, cart.id);
      const co = await prepareCheckout(ctx, actor, { cart_id: cart.id, quote_id: quote.id });
      return reply.code(303).redirect(`/confirm/${co.id}`);
    } catch (e) {
      if (!isDomainError(e)) req.log.error(e);
      if (isDomainError(e) && e.code === 'AUTH_REQUIRED') return renderTry(reply, r, q, null, errorBox(e), 403);
      return renderTry(reply, r, q, null, errorBox(e), 409);
    }
  });

  /** A signed-in (non-guest) user must be in Demo mode with an address for the guided demo. */
  async function preflight(r: R): Promise<SafeHtml | null> {
    const l = r.l;
    if (r.s!.user.mode !== 'demo') {
      return html`<p class="notice warn">${tr(l, { ru: 'Демо работает в режиме «Демо». Сейчас у вас другой режим.', en: 'The guided demo runs in Demo mode. Your account uses another mode.', th: 'เดโมนี้ทำงานในโหมดเดโม บัญชีของคุณใช้โหมดอื่นอยู่' })} <a href="/app/mode">${tr(l, { ru: 'Сменить режим', en: 'Change mode', th: 'เปลี่ยนโหมด' })}</a></p>`;
    }
    if (!(await getDefaultAddress(ctx.db, r.s!.user.id))) {
      return html`<p class="notice warn">${tr(l, { ru: 'Добавьте адрес доставки в Бангкоке, чтобы увидеть цены.', en: 'Add a Bangkok delivery address to see prices.', th: 'เพิ่มที่อยู่จัดส่งในกรุงเทพฯ เพื่อดูราคา' })} <a href="/app/addresses">${tr(l, { ru: 'Добавить адрес', en: 'Add address', th: 'เพิ่มที่อยู่' })}</a></p>`;
    }
    return null;
  }

  type Found =
    | { kind: 'food'; intent: ReturnType<typeof parseIntent>; res: any }
    | { kind: 'shop'; plan: ShopPlan }
    | { kind: 'trip'; plan: TripPlan };

  function renderTry(reply: FastifyReply, r: R, q: string, found: Found | null, flash?: SafeHtml, status = 200) {
    const l = r.l;
    const ex = EXAMPLES[l];
    const form = html`<form class="ask card" method="post" action="/try/start" id="ask">
  ${r.s ? csrfField(r.s) : ''}
  <label for="q" class="sr-only">${tr(l, { ru: 'Ваш запрос', en: 'Your request', th: 'คำขอของคุณ' })}</label>
  <textarea id="q" name="q" rows="2" maxlength="300" required placeholder="${ex[0]}">${q}</textarea>
  <div class="ask-row">
    <div class="chips svc-chips" role="group" aria-label="${tr(l, { ru: 'Примеры', en: 'Examples', th: 'ตัวอย่าง' })}">${ex.map((e, i) => html`<a href="/try?q=${encodeURIComponent(e)}" data-fill="${e}" title="${e}">${icon(EXAMPLE_KIND[i].ic)}${tr(l, EXAMPLE_KIND[i].name)}</a>`)}</div>
    <button class="btn" type="submit">${tr(l, { ru: 'Спросить', en: 'Ask', th: 'ถาม' })} ${icon('send')}</button>
  </div>
</form>`;
    let convo: SafeHtml | string = '';
    let log: SafeHtml;
    const me = html`<div class="msg me"><span class="who">${icon('users')}<span class="sr-only">${tr(l, { ru: 'Вы:', en: 'You:', th: 'คุณ:' })}</span></span><div class="body"><div class="txt">${q}</div></div></div>`;
    const min = tr(l, { ru: 'мин', en: 'min', th: 'นาที' });
    const afterChoose = html`<li class="next"><span class="fn">create_cart</span> → <span class="fn">quote_cart</span> → <span class="fn">prepare_checkout</span> <span class="ret">${tr(l, { ru: 'после выбора', en: 'after you choose', th: 'หลังคุณเลือก' })}</span></li>
  <li class="next"><span class="fn">submit_order</span> <span class="ret">${tr(l, { ru: 'только после вашего подтверждения', en: 'only after you confirm', th: 'หลังคุณยืนยันเท่านั้น' })}</span></li>`;
    if (found?.kind === 'shop') {
      const p = found.plan;
      convo = html`${me}
<div class="msg ai"><span class="who">${icon('sparkle')}<span class="sr-only">${tr(l, { ru: 'Ассистент:', en: 'Assistant:', th: 'ผู้ช่วย:' })}</span></span><div class="body stack">
  <p class="said">${tr(l, { ru: 'Собрал корзину. Цена уже с доставкой и сборами:', en: 'Here is a basket. The price already includes delivery and fees:', th: 'จัดตะกร้าให้แล้ว ราคารวมค่าส่งและค่าบริการ:' })}</p>
  ${p.notice ? html`<p class="notice warn small">${icon('alert')} ${p.notice}</p>` : ''}
  <div class="options one"><article class="opt-card">
    <div class="art">${restaurantArt(p.store_id, p.store_name)}<span class="eta">${icon('clock')} ${p.eta[0]}–${p.eta[1]} ${min}</span></div>
    <div class="in">
      <h3>${p.store_name}</h3>
      <ul class="dish-list">${p.lines.map((x) => html`<li><span><strong>${x.quantity}×</strong> ${x.name}${x.option_note ? html`<br><span class="small muted">${x.option_note}</span>` : ''}</span><span class="small">${baht(x.unit_minor * x.quantity, l)}</span></li>`)}</ul>
      <div class="total-row"><span class="small muted">${tr(l, { ru: 'Итого со сборами', en: 'Total with fees', th: 'รวมค่าธรรมเนียม' })}</span><span class="total">${baht(p.total_minor, l)}</span></div>
      ${p.blocking.length ? html`<p class="notice bad small">${p.blocking.join('; ')}</p>` : html`<form method="post" action="/try/choose">${csrfField(r.s!)}<input type="hidden" name="q" value="${q}"><input type="hidden" name="kind" value="shop"><input type="hidden" name="store_id" value="${p.store_id}">
        <button class="btn block" type="submit">${tr(l, { ru: 'Оформить', en: 'Check out', th: 'สั่งซื้อ' })}</button></form>`}
    </div>
  </article></div>
  <p class="small muted">${tr(l, { ru: 'Ассистент может поменять количество, добавить позиции или записку (например, текст открытки) до подтверждения.', en: 'Before you confirm, the assistant can change quantities, add items or a note (a card message, for example).', th: 'ก่อนยืนยัน ผู้ช่วยสามารถเปลี่ยนจำนวน เพิ่มสินค้า หรือใส่ข้อความ (เช่น ข้อความบนการ์ด) ได้' })}</p>
</div></div>`;
      log = html`<ol class="tool-log">
  <li><span class="fn">get_capabilities</span>() <span class="ret">→ mode: "demo"</span></li>
  <li><span class="fn">search_stores</span>({"service":"mart","category":"${p.category}"}) <span class="ret">→ ${p.store_name}</span></li>
  <li><span class="fn">get_store</span>({"store_id":"${p.store_id}"}) <span class="ret">→ ${p.lines.length} ${tr(l, { ru: 'позиций выбрано', en: 'items picked', th: 'รายการที่เลือก' })}</span></li>
  ${afterChoose}
</ol>`;
    } else if (found?.kind === 'trip') {
      const p = found.plan;
      const t = p.result.trip!;
      const opts = p.result.options.filter((o) => o.fits).slice(0, 3);
      const art = p.service === 'ride' ? car : parcel;
      convo = html`${me}
<div class="msg ai"><span class="who">${icon('sparkle')}<span class="sr-only">${tr(l, { ru: 'Ассистент:', en: 'Assistant:', th: 'ผู้ช่วย:' })}</span></span><div class="body stack">
  <div class="route-card"><span class="rt-dot a"></span><span><strong>${t.pickup.name}</strong>${t.pickup.area ? html` <span class="small muted">${t.pickup.area}</span>` : ''}</span>
    <span class="rt-line"></span><span class="rt-dot b"></span><span><strong>${t.dropoff.name}</strong>${t.dropoff.area ? html` <span class="small muted">${t.dropoff.area}</span>` : ''}</span>
    <span class="small muted rt-meta">≈ ${t.distance_km_estimate} km · ≈ ${t.drive_minutes_estimate} ${min}${t.parcel ? ` · ${t.parcel.weight_kg} kg` : ''}</span></div>
  <p class="said">${p.service === 'ride'
    ? tr(l, { ru: 'Варианты поездки. Цена по демо-тарифу:', en: 'Ride options. Demo fares:', th: 'ตัวเลือกการเดินทาง ค่าโดยสารเดโม:' })
    : tr(l, { ru: 'Варианты доставки посылки. Цена по демо-тарифу:', en: 'Parcel options. Demo fares:', th: 'ตัวเลือกส่งพัสดุ ค่าบริการเดโม:' })}</p>
  <div class="options">${opts.map((o, i) => html`<article class="opt-card" style="animation-delay:${i * 90}ms">
    <div class="art">${art(o.name)}<span class="eta">${icon('clock')} ${o.eta_estimate_minutes.min}–${o.eta_estimate_minutes.max} ${min}</span></div>
    <div class="in">
      <h3>${o.name}</h3>
      <p class="small muted">${o.description ?? ''}${o.seats ? html` · ${icon('users')} ${o.seats}` : ''}${o.max_weight_kg ? ` · ≤ ${o.max_weight_kg} kg` : ''}</p>
      ${o.note ? html`<p class="small muted">${o.note}</p>` : ''}
      <div class="total-row"><span class="small muted">${tr(l, { ru: 'Оценка', en: 'Estimate', th: 'ประมาณ' })}</span><span class="total">${baht(o.estimated_total.amount_minor, l)}</span></div>
      <form method="post" action="/try/choose">${csrfField(r.s!)}<input type="hidden" name="q" value="${q}"><input type="hidden" name="kind" value="trip"><input type="hidden" name="item_id" value="${o.item_id}">
        <button class="btn block" type="submit">${tr(l, { ru: 'Выбрать', en: 'Choose', th: 'เลือก' })}</button></form>
    </div></article>`)}</div>
  ${p.result.store.notice ? html`<p class="small muted">${p.result.store.notice}</p>` : ''}
</div></div>`;
      log = html`<ol class="tool-log">
  <li><span class="fn">get_capabilities</span>() <span class="ret">→ mode: "demo"</span></li>
  <li><span class="fn">estimate_trip</span>(${JSON.stringify({ service: p.service, pickup: p.pickup, dropoff: p.dropoff, ...(p.weight_kg ? { parcel_weight_kg: p.weight_kg } : {}) })}) <span class="ret">→ ${p.result.options.length} ${tr(l, { ru: 'вариантов', en: 'options', th: 'ตัวเลือก' })}</span></li>
  ${afterChoose}
</ol>`;
    } else if (found?.kind === 'food') {
      const { intent, res } = found;
      const f = res.applied_filters;
      const viable = res.restaurants.filter((x: any) => x.suggestion && !x.availability_notes.length && !x.suggestion.blocking_issues.length);
      const hidden = res.restaurants.filter((x: any) => x.availability_notes.length);
      const want = intent.cuisine;
      const picks = [...viable]
        .sort((a: any, b: any) => {
          const cm = (x: any) => (want && x.restaurant.cuisines.includes(want) ? 0 : 1);
          const bud = (x: any) => (x.suggestion.within_budget === false ? 1 : 0);
          return cm(a) - cm(b) || bud(a) - bud(b) || a.suggestion.estimated_total.amount_minor - b.suggestion.estimated_total.amount_minor;
        })
        .slice(0, 3);
      const chip = (ic: string, t: string) => html`<span class="fchip">${icon(ic)}${t}</span>`;
      const people = f.party_size === 1 ? tr(l, { ru: 'чел.', en: 'person', th: 'คน' }) : tr(l, { ru: 'чел.', en: 'people', th: 'คน' });
      const understood = html`<div class="fchips">
        ${chip('users', `${f.party_size} ${people}${intent.party_size ? '' : tr(l, { ru: ' (по умолчанию)', en: ' (default)', th: ' (ค่าเริ่มต้น)' })}`)}
        ${f.budget_total_major ? chip('tag', `${tr(l, { ru: 'до', en: 'up to', th: 'ไม่เกิน' })} ฿${f.budget_total_major}`) : ''}
        ${f.exclude_allergens.length ? chip('alert', `${tr(l, { ru: 'без:', en: 'avoid:', th: 'ไม่เอา:' })} ${f.exclude_allergens.map((a: string) => t3(ALLERGEN_NAMES, a, l)).join(', ')}`) : ''}
        ${f.dietary.length ? chip('leaf', f.dietary.map((d: string) => t3(DIET_NAMES, d, l)).join(', ')) : ''}
        ${want ? chip('store', t3(CUISINE_NAMES, want, l)) : ''}
      </div>`;
      const badge = (st: string, note?: string) =>
        st === 'unknown'
          ? html`<span class="pill warn" title="${note ?? ''}">${tr(l, { ru: 'нет данных об аллергенах', en: 'no allergen data', th: 'ไม่มีข้อมูลสารก่อภูมิแพ้' })}</span>`
          : st === 'none_declared'
            ? html`<span class="pill" title="${note ?? ''}">${tr(l, { ru: 'ваши аллергены не заявлены', en: 'your allergens not declared', th: 'ร้านไม่ได้ระบุสารที่คุณแพ้' })}</span>`
            : '';
      const card = (x: any, i: number) => {
        const s = x.suggestion;
        const rest = x.restaurant;
        return html`<article class="opt-card" style="animation-delay:${i * 90}ms">
  <div class="art">${restaurantArt(rest.store_id, rest.name)}<span class="eta">${icon('clock')} ${rest.eta_estimate_minutes.min}–${rest.eta_estimate_minutes.max} ${tr(l, { ru: 'мин', en: 'min', th: 'นาที' })}</span></div>
  <div class="in">
    <h3>${rest.name}</h3>
    <p class="small muted">${rest.cuisines.map((c: string) => t3(CUISINE_NAMES, c, l)).join(' · ')}</p>
    <ul class="dish-list">${s.items.map((it: any) => html`<li><span><strong>${it.quantity}×</strong> ${dishName(it.item_id, it.name, l)}</span>${badge(it.allergen_check.status, it.allergen_check.note)}</li>`)}</ul>
    <div class="tags">
      ${s.within_budget === true ? html`<span class="pill ok">${icon('check')} ${tr(l, { ru: 'в бюджете', en: 'within budget', th: 'อยู่ในงบ' })}</span>` : ''}
      ${s.within_budget === false ? html`<span class="pill warn">${tr(l, { ru: 'выше бюджета', en: 'over budget', th: 'เกินงบ' })}</span>` : ''}
      ${rest.promo ? html`<span class="pill accent">${icon('tag')} promo</span>` : ''}
    </div>
    <div class="total-row"><span class="small muted">${tr(l, { ru: 'Итого со сборами', en: 'Total with fees', th: 'รวมค่าธรรมเนียม' })}</span><span class="total">${baht(s.estimated_total.amount_minor, l)}</span></div>
    <form method="post" action="/try/choose">${csrfField(r.s!)}<input type="hidden" name="q" value="${q}"><input type="hidden" name="restaurant_id" value="${rest.store_id}">
      <button class="btn block" type="submit">${tr(l, { ru: 'Выбрать', en: 'Choose', th: 'เลือก' })}</button></form>
  </div>
</article>`;
      };
      const reason = (x: any) =>
        !x.restaurant.is_open ? tr(l, { ru: 'закрыт', en: 'closed', th: 'ปิดอยู่' }) : x.restaurant.delivers_to_address === false ? tr(l, { ru: 'не доставляет по вашему адресу', en: 'does not deliver to you', th: 'ไม่ส่งถึงที่อยู่ของคุณ' }) : tr(l, { ru: 'недоступен', en: 'unavailable', th: 'ไม่พร้อมให้บริการ' });
      convo = html`
<div class="msg me"><span class="who">${icon('users')}<span class="sr-only">${tr(l, { ru: 'Вы:', en: 'You:', th: 'คุณ:' })}</span></span><div class="body"><div class="txt">${q}</div></div></div>
<div class="msg ai"><span class="who">${icon('sparkle')}<span class="sr-only">${tr(l, { ru: 'Ассистент:', en: 'Assistant:', th: 'ผู้ช่วย:' })}</span></span><div class="body stack">
  <p class="said">${tr(l, { ru: 'Понял так:', en: 'Here is what I understood:', th: 'ฉันเข้าใจว่า:' })}</p>
  ${understood}
  ${res.allergen_disclaimer ? html`<p class="notice warn small">${icon('alert')} ${tr(l, { ru: 'Данные об аллергенах приходят от ресторанов и могут быть неполными. Unyly никогда не называет блюдо безопасным. Уточняйте у ресторана.', en: 'Allergen data comes from restaurants and may be incomplete. Unyly never calls a dish safe. Check with the restaurant.', th: 'ข้อมูลสารก่อภูมิแพ้มาจากร้านอาหารและอาจไม่ครบถ้วน Unyly ไม่เคยเรียกเมนูใดว่าปลอดภัย โปรดสอบถามร้าน' })}</p>` : ''}
  ${picks.length
    ? html`<p class="said">${fmt(tr(l, { ru: 'Вот {n} варианта. Цены уже со всеми сборами:', en: 'Here are {n} options. Prices already include all fees:', th: 'นี่คือ {n} ตัวเลือก ราคารวมค่าธรรมเนียมแล้ว:' }), { n: picks.length })}</p>
      <div class="options">${picks.map(card)}</div>`
    : html`<p class="notice">${tr(l, { ru: 'Под эти условия ничего не нашлось. Попробуйте увеличить бюджет или убрать ограничения.', en: 'Nothing fits these filters. Try a higher budget or fewer restrictions.', th: 'ไม่พบตัวเลือกที่ตรงเงื่อนไข ลองเพิ่มงบหรือลดข้อจำกัด' })}</p>`}
  ${hidden.length ? html`<p class="small muted">${tr(l, { ru: 'Не показаны:', en: 'Not shown:', th: 'ไม่แสดง:' })} ${hidden.map((x: any) => `${x.restaurant.name} (${reason(x)})`).join(', ')}</p>` : ''}
</div></div>`;
      const args = JSON.stringify({
        party_size: f.party_size,
        ...(f.budget_total_major ? { budget_total_major: f.budget_total_major } : {}),
        ...(f.exclude_allergens.length ? { exclude_allergens: f.exclude_allergens } : {}),
        ...(f.dietary.length ? { dietary: f.dietary } : {}),
      });
      log = html`<ol class="tool-log">
  <li><span class="fn">get_capabilities</span>() <span class="ret">→ mode: "demo"</span></li>
  <li><span class="fn">search_stores</span>(${args}) <span class="ret">→ ${res.restaurants.length} ${tr(l, { ru: 'ресторанов', en: 'restaurants', th: 'ร้าน' })}, ${viable.length} ${tr(l, { ru: 'с предложением', en: 'with a suggestion', th: 'มีข้อเสนอ' })}</span></li>
  <li class="next"><span class="fn">create_cart</span> → <span class="fn">quote_cart</span> → <span class="fn">prepare_checkout</span> <span class="ret">${tr(l, { ru: 'после выбора', en: 'after you choose', th: 'หลังคุณเลือก' })}</span></li>
  <li class="next"><span class="fn">submit_order</span> <span class="ret">${tr(l, { ru: 'только после вашего подтверждения', en: 'only after you confirm', th: 'หลังคุณยืนยันเท่านั้น' })}</span></li>
</ol>`;
    } else {
      log = html`<ol class="tool-log"><li class="next">${tr(l, { ru: 'Отправьте запрос, и здесь появятся вызовы инструментов.', en: 'Send a request and the tool calls appear here.', th: 'ส่งคำขอแล้วการเรียกเครื่องมือจะแสดงที่นี่' })}</li></ol>`;
    }
    const steps = [
      tr(l, { ru: 'Опишите, что нужно', en: 'Describe what you need', th: 'บอกสิ่งที่ต้องการ' }),
      tr(l, { ru: 'Выберите вариант', en: 'Pick an option', th: 'เลือกตัวเลือก' }),
      tr(l, { ru: 'Подтвердите на защищённой странице', en: 'Confirm on the secure page', th: 'ยืนยันในหน้าที่ปลอดภัย' }),
      tr(l, { ru: 'Следите за статусом', en: 'Track the status', th: 'ติดตามสถานะ' }),
    ];
    const body = html`
<div class="page-head">
  <span class="eyebrow">${icon('sparkle')} ${tr(l, { ru: 'Живое демо · вымышленные данные · без оплаты', en: 'Live demo · fictional data · no payment', th: 'เดโมสด · ข้อมูลสมมติ · ไม่มีการชำระเงิน' })}</span>
  <h1>${tr(l, { ru: 'Попросите так, как написали бы другу', en: 'Ask the way you would text a friend', th: 'ขอเหมือนพิมพ์คุยกับเพื่อน' })}</h1>
  <p class="lead">${tr(l, {
    ru: 'Демо-ассистент Unyly превращает ваш запрос в те же вызовы MCP, что сделали бы ChatGPT или Claude. Заказ уходит только после вашего подтверждения.',
    en: 'The Unyly demo assistant turns your request into the same MCP calls ChatGPT or Claude would make. The order goes out only after you confirm.',
    th: 'ผู้ช่วยเดโมของ Unyly แปลงคำขอของคุณเป็นการเรียก MCP แบบเดียวกับที่ ChatGPT หรือ Claude ทำ ออเดอร์จะถูกส่งหลังคุณยืนยันเท่านั้น',
  })}</p>
</div>
${flash ?? ''}
<div class="try-shell">
  <div class="convo">${form}${convo}</div>
  <aside class="side stack">
    <div class="card tool-card"><h3>${icon('code')} ${tr(l, { ru: 'Вызовы MCP', en: 'MCP calls', th: 'การเรียก MCP' })}</h3>${log}
      <p class="small muted">${tr(l, { ru: 'Ассистент видит только название адреса и район.', en: 'The assistant only sees the address name and area.', th: 'ผู้ช่วยเห็นเพียงชื่อที่อยู่และเขตเท่านั้น' })}</p></div>
    <div class="card"><h3>${tr(l, { ru: 'Как проходит демо', en: 'How the demo goes', th: 'ขั้นตอนของเดโม' })}</h3><ol class="steps">${steps.map((s) => html`<li><span class="num" aria-hidden="true"></span><span class="grow">${s}</span></li>`)}</ol></div>
  </aside>
</div>`;
    return send(reply, r, tr(l, { ru: 'Демо', en: 'Live demo', th: 'เดโม' }), body, { status, noBanner: !r.s, description: tr(l, { ru: 'Попробуйте заказ через ИИ-ассистента в браузере.', en: 'Try ordering through an AI assistant in your browser.', th: 'ลองสั่งอาหารผ่านผู้ช่วย AI ในเบราว์เซอร์' }) });
  }
}

