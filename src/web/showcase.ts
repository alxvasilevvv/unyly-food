// Public showcase pages: landing, the guided /try demo and the /for-grab partnership page.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { audit } from '../context.js';
import { sha256 } from '../domain/crypto.js';
import { checkCsrf, createSession, setSessionCookie } from '../auth/session.js';
import { isDomainError, DomainError } from '../domain/errors.js';
import { formatMinor } from '../domain/money.js';
import { createCart, quoteCart } from '../services/carts.js';
import { searchRestaurants } from '../services/catalog.js';
import { prepareCheckout } from '../services/checkout.js';
import { addAddress, getDefaultAddress } from '../services/users.js';
import { flowDiagram, greenCurry, icon, mangoSticky, noodleSoup, padThai, restaurantArt, tofuBowl, tomYum } from './art.js';
import { ALLERGEN_NAMES, CUISINE_NAMES, DIET_NAMES, dishName, t3 } from './copy.js';
import { html, SafeHtml } from './html.js';
import { parseIntent } from './intent.js';
import { REPO_URL } from './layout.js';
import { Locale, tr } from './messages.js';
import type { Kit, R } from './routes.js';

const EXAMPLES: Record<Locale, string[]> = {
  en: ['Dinner for two under 600 baht, no nuts', 'Vegetarian lunch for 3', 'Seafood for 4, budget 2000', 'Lunch for 1 under 250, allergic to shellfish'],
  th: ['ข้าวเย็นสำหรับ 2 คน ไม่เกิน 600 บาท ไม่ใส่ถั่ว', 'อาหารมังสวิรัติ 3 คน', 'อาหารทะเล 4 คน งบ 2000 บาท', 'มื้อกลางวัน 1 คน ไม่เกิน 250 บาท แพ้กุ้ง'],
  ru: ['Ужин на двоих до 600 бат, без орехов', 'Вегетарианский обед на 3 человек', 'Морепродукты на 4, бюджет 2000 бат', 'Обед на 1 до 250 бат, аллергия на креветки'],
};

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
    return send(reply, r, tr(l, { ru: 'Заказ еды через ИИ-ассистента', en: 'Order food through your AI assistant', th: 'สั่งอาหารผ่านผู้ช่วย AI' }), html`
<section class="hero">
  <div>
    <span class="eyebrow">${icon('sparkle')} ${tr(l, { ru: 'Концепт AI-заказа для GrabFood · Бангкок', en: 'AI ordering concept for GrabFood · Bangkok', th: 'แนวคิดสั่งอาหารด้วย AI สำหรับ GrabFood · กรุงเทพฯ' })}</span>
    <h1>${tr(l, { ru: 'Скажите ИИ, чего хочется.', en: 'Tell your AI what you are craving.', th: 'บอก AI ว่าอยากกินอะไร' })} <span class="hl">${tr(l, { ru: 'Подтвердите одним нажатием.', en: 'Confirm with one tap.', th: 'แล้วกดยืนยันครั้งเดียว' })}</span></h1>
    <p class="lead">${tr(l, {
      ru: 'Unyly позволяет ChatGPT, Claude и другим ИИ-ассистентам подобрать блюда под бюджет, компанию и аллергии, собрать корзину и посчитать цену со всеми сборами. Ничего не заказывается, пока вы не подтвердите на защищённой странице.',
      en: 'Unyly lets ChatGPT, Claude and other AI assistants find dishes that fit your budget, group and allergies, build the cart and price it with every fee. Nothing is ordered until you confirm on a secure page.',
      th: 'Unyly ให้ ChatGPT, Claude และผู้ช่วย AI อื่นๆ หาเมนูที่ตรงกับงบ จำนวนคน และอาการแพ้ของคุณ จัดตะกร้าและคำนวณราคาพร้อมค่าธรรมเนียมทั้งหมด ไม่มีการสั่งซื้อจนกว่าคุณจะยืนยันในหน้าที่ปลอดภัย',
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
  </div>
</section>

<section class="section" aria-labelledby="st">
  <div class="section-head"><span class="eyebrow">${icon('check')} ${m.statusTitle}</span><h2 id="st">${tr(l, { ru: 'Честно о том, что работает', en: 'Honest about what works today', th: 'บอกตรงๆ ว่าตอนนี้อะไรใช้ได้บ้าง' })}</h2></div>
  <div class="grid three">
    ${status(true, tr(l, { ru: 'Демо', en: 'Demo', th: 'เดโม' }), m.statusDemo, m.available)}
    ${status(true, 'Handoff', m.statusHandoff, m.available)}
    ${status(false, tr(l, { ru: 'Живые заказы GrabFood', en: 'Live GrabFood orders', th: 'สั่ง GrabFood จริง' }), m.statusLive, tr(l, { ru: 'Нужен Grab', en: 'Needs Grab', th: 'ต้องมี Grab' }))}
  </div>
</section>

<section class="section" id="how" aria-labelledby="how-h">
  <div class="section-head"><span class="eyebrow">${icon('bolt')} ${m.howTitle}</span><h2 id="how-h">${tr(l, { ru: 'От сообщения до двери за четыре шага', en: 'From a message to your door in four steps', th: 'จากข้อความถึงหน้าประตูใน 4 ขั้นตอน' })}</h2></div>
  <div class="flow">
    ${[[m.how1t, m.how1d], [m.how2t, m.how2d], [m.how3t, m.how3d], [m.how4t, m.how4d]].map(([t, d]) => html`<div class="step"><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
</section>

<section class="section" aria-labelledby="ft">
  <div class="section-head"><span class="eyebrow">${icon('store')} ${tr(l, { ru: 'Для реальной жизни', en: 'Built for real life', th: 'ออกแบบมาเพื่อชีวิตจริง' })}</span><h2 id="ft">${tr(l, { ru: 'Как заказывают в Бангкоке', en: 'Made for how Bangkok orders', th: 'เหมาะกับวิธีสั่งอาหารของคนกรุงเทพฯ' })}</h2></div>
  <div class="grid three">
    ${feature('tag', tr(l, { ru: 'Бюджет со всеми сборами', en: 'Budget with every fee', th: 'งบรวมค่าธรรมเนียมทุกอย่าง' }), tr(l, { ru: 'Доставка, сервисный сбор и доплата за малый заказ видны до подтверждения.', en: 'Delivery, service and small-order fees are shown before you confirm.', th: 'เห็นค่าส่ง ค่าบริการ และค่าออเดอร์เล็กก่อนกดยืนยัน' }))}
    ${feature('alert', tr(l, { ru: 'Честно об аллергенах', en: 'Honest about allergens', th: 'ซื่อตรงเรื่องสารก่อภูมิแพ้' }), tr(l, { ru: 'Показываем только то, что заявил ресторан, и никогда не пишем «безопасно».', en: 'Shows only what restaurants declare and never says "safe".', th: 'แสดงเฉพาะที่ร้านระบุ และไม่เคยบอกว่า "ปลอดภัย"' }))}
    ${feature('users', tr(l, { ru: 'Для компании', en: 'For groups', th: 'สั่งเป็นกลุ่ม' }), tr(l, { ru: 'Порции на 1–12 человек из одной фразы.', en: 'Portions for 1 to 12 people from one sentence.', th: 'จัดอาหารสำหรับ 1 ถึง 12 คนจากประโยคเดียว' }))}
    ${feature('globe', tr(l, { ru: 'Тайский, английский, русский', en: 'Thai, English, Russian', th: 'ไทย อังกฤษ รัสเซีย' }), tr(l, { ru: 'Интерфейс и понимание запросов на трёх языках.', en: 'Interface and request understanding in three languages.', th: 'หน้าจอและการเข้าใจคำขอใน 3 ภาษา' }))}
    ${feature('bike', tr(l, { ru: 'Живой статус', en: 'Live status', th: 'สถานะแบบเรียลไทม์' }), tr(l, { ru: 'Статус приходит от провайдера по подписанным событиям, время доставки честно помечено как оценка.', en: 'Status arrives from the provider via signed events; the ETA is clearly marked as an estimate.', th: 'สถานะมาจากผู้ให้บริการผ่านเหตุการณ์ที่มีลายเซ็น เวลาจัดส่งระบุชัดว่าเป็นการประมาณ' }))}
    ${feature('plug', tr(l, { ru: 'Любой ассистент', en: 'Any assistant', th: 'ผู้ช่วยตัวไหนก็ได้' }), tr(l, { ru: 'Открытый стандарт MCP: ChatGPT, Claude, Claude Code и другие клиенты.', en: 'Open MCP standard: ChatGPT, Claude, Claude Code and other clients.', th: 'มาตรฐานเปิด MCP: ChatGPT, Claude, Claude Code และไคลเอนต์อื่นๆ' }))}
  </div>
</section>

<section class="section split" aria-labelledby="sf">
  <div class="section-head">
    <span class="eyebrow">${icon('shield')} ${tr(l, { ru: 'Безопасность', en: 'Safety', th: 'ความปลอดภัย' })}</span>
    <h2 id="sf">${m.safetyTitle}</h2>
    <p class="lead">${tr(l, { ru: 'ИИ может ошибаться. Поэтому деньги тратит только человек, а сервер защищён от повторов, подмены цены и инструкций, спрятанных в меню.', en: 'AI can make mistakes. So only a human can spend money, and the server is protected against retries, price swaps and instructions hidden in menus.', th: 'AI อาจผิดพลาดได้ จึงมีแต่คนเท่านั้นที่ใช้เงินได้ และเซิร์ฟเวอร์ป้องกันการส่งซ้ำ การเปลี่ยนราคา และคำสั่งที่ซ่อนอยู่ในเมนู' })}</p>
  </div>
  <ul class="check-list">${[m.safety1, m.safety2, m.safety3, m.safety4, m.safety5].map((x) => html`<li>${icon('check')}<span>${x}</span></li>`)}</ul>
</section>

<section class="section" aria-labelledby="cl">
  <div class="section-head"><span class="eyebrow">${icon('plug')} ${tr(l, { ru: 'Совместимость', en: 'Works with', th: 'ใช้งานร่วมกับ' })}</span><h2 id="cl">${tr(l, { ru: 'Один сервер для всех ассистентов', en: 'One server for every assistant', th: 'เซิร์ฟเวอร์เดียวสำหรับผู้ช่วยทุกตัว' })}</h2></div>
  <div class="clients"><span>ChatGPT</span><span>Claude</span><span>Claude Code</span><span>OpenAI Responses API</span><span>Anthropic API</span><span>${tr(l, { ru: 'Любой MCP-клиент', en: 'Any MCP client', th: 'ไคลเอนต์ MCP ใดก็ได้' })}</span></div>
  <p style="margin-top:16px"><a href="/connect">${tr(l, { ru: 'Как подключить', en: 'How to connect', th: 'วิธีเชื่อมต่อ' })} ${icon('arrow')}</a></p>
</section>

<section class="section">
  <div class="band">
    <div class="band-in">
      <span class="eyebrow lime">${icon('handshake')} ${tr(l, { ru: 'Для команды Grab', en: 'For the Grab team', th: 'สำหรับทีม Grab' })}</span>
      <h2>${tr(l, { ru: 'Мы сделали это как предложение GrabFood', en: 'We built this as a proposal for GrabFood', th: 'เราสร้างสิ่งนี้เป็นข้อเสนอสำหรับ GrabFood' })}</h2>
      <p class="lead">${tr(l, { ru: 'Всё, кроме живого заказа, уже работает. Не хватает только партнёрского доступа к API заказов.', en: 'Everything except the live order already works. The only missing piece is partner access to an ordering API.', th: 'ทุกอย่างทำงานได้แล้ว ยกเว้นการสั่งจริง สิ่งที่ขาดคือสิทธิ์พันธมิตรในการเข้าถึง API สั่งอาหาร' })}</p>
      <div class="actions"><a class="btn lime" href="/for-grab">${tr(l, { ru: 'Читать предложение', en: 'Read the proposal', th: 'อ่านข้อเสนอ' })} ${icon('arrow')}</a><a class="btn secondary" href="/try">${tr(l, { ru: 'Открыть демо', en: 'Open the demo', th: 'เปิดเดโม' })}</a></div>
    </div>
  </div>
</section>`, { noBanner: true, description: tr(l, { ru: 'Концепт заказа GrabFood через ИИ-ассистентов с подтверждением человеком.', en: 'A concept for ordering GrabFood through AI assistants, with human confirmation.', th: 'แนวคิดการสั่ง GrabFood ผ่านผู้ช่วย AI โดยมีคนเป็นผู้ยืนยัน' }) });
  });

  // ---------------- For Grab ----------------
  app.get('/for-grab', async (req, reply) => {
    const r = await base(req, reply);
    const l = r.l;
    const origin = ctx.cfg.webOrigin;
    const diagram = flowDiagram({
      you: tr(l, { ru: 'Покупатель', en: 'Customer', th: 'ลูกค้า' }),
      assistant: tr(l, { ru: 'ИИ-ассистент', en: 'AI assistant', th: 'ผู้ช่วย AI' }),
      assistantSub: 'ChatGPT · Claude · MCP',
      unyly: 'Unyly',
      unylySub: tr(l, { ru: 'MCP-сервер и защита', en: 'MCP server + safety layer', th: 'เซิร์ฟเวอร์ MCP + ความปลอดภัย' }),
      grab: 'GrabFood',
      grabSub: tr(l, { ru: 'партнёрский API (нужен)', en: 'partner API (needed)', th: 'API พันธมิตร (ที่ต้องการ)' }),
      confirm: tr(l, { ru: 'Страница подтверждения', en: 'Confirmation page', th: 'หน้ายืนยัน' }),
      confirmSub: tr(l, { ru: 'цена, адрес, итог', en: 'price, address, total', th: 'ราคา ที่อยู่ ยอดรวม' }),
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
  <h1>${tr(l, { ru: 'Пусть люди заказывают GrabFood у своего ИИ-ассистента. Безопасно.', en: 'Let people order GrabFood from their AI assistant. Safely.', th: 'ให้ผู้คนสั่ง GrabFood ผ่านผู้ช่วย AI ของตัวเอง อย่างปลอดภัย' })}</h1>
  <p class="lead">${tr(l, {
    ru: 'Люди всё чаще начинают задачи в ChatGPT и Claude. Открытый стандарт MCP позволяет этим ассистентам работать с внешними сервисами. Unyly - готовый слой между ассистентами и GrabFood: поиск, корзина, точная цена, подтверждение человеком и отслеживание.',
    en: 'People increasingly start tasks in ChatGPT and Claude. The open MCP standard lets these assistants use outside services. Unyly is a ready-made layer between assistants and GrabFood: search, cart, exact pricing, human confirmation and tracking.',
    th: 'ผู้คนเริ่มต้นงานต่างๆ ใน ChatGPT และ Claude มากขึ้นเรื่อยๆ มาตรฐานเปิด MCP ทำให้ผู้ช่วยเหล่านี้ใช้บริการภายนอกได้ Unyly คือชั้นกลางที่พร้อมใช้ระหว่างผู้ช่วย AI กับ GrabFood ทั้งการค้นหา ตะกร้า ราคาที่แม่นยำ การยืนยันโดยคน และการติดตามสถานะ',
  })}</p>
  <div class="actions"><a class="btn lg" href="/try">${tr(l, { ru: 'Посмотреть демо', en: 'See the demo', th: 'ดูเดโม' })} ${icon('arrow')}</a><a class="btn lg secondary" href="mailto:${supportEmail}">${icon('mail')} ${tr(l, { ru: 'Связаться', en: 'Get in touch', th: 'ติดต่อเรา' })}</a></div>
</section>

<div class="stat-row" style="margin-top:36px">
  ${stat('14', tr(l, { ru: 'инструментов MCP', en: 'MCP tools', th: 'เครื่องมือ MCP' }))}
  ${stat('1', tr(l, { ru: 'нажатие человека на заказ', en: 'human tap per order', th: 'การกดของคนต่อออเดอร์' }))}
  ${stat('0', tr(l, { ru: 'паролей Grab у нас', en: 'Grab passwords stored', th: 'รหัสผ่าน Grab ที่เราเก็บ' }))}
  ${stat('3', tr(l, { ru: 'языка: TH, EN, RU', en: 'languages: TH, EN, RU', th: 'ภาษา: ไทย อังกฤษ รัสเซีย' }))}
</div>

<section class="section">
  <div class="section-head"><span class="eyebrow">${icon('code')} ${tr(l, { ru: 'Архитектура', en: 'How it fits', th: 'โครงสร้างการทำงาน' })}</span><h2>${tr(l, { ru: 'Ассистент готовит, человек подтверждает, Grab доставляет', en: 'The assistant prepares, a human confirms, Grab delivers', th: 'ผู้ช่วยเตรียม คนยืนยัน Grab จัดส่ง' })}</h2></div>
  <div class="diagram">${diagram}</div>
  <ol class="diagram-mobile" aria-hidden="true">
    <li><strong>${tr(l, { ru: 'Покупатель', en: 'Customer', th: 'ลูกค้า' })}</strong><span>${tr(l, { ru: 'пишет ассистенту обычными словами', en: 'types a request in plain words', th: 'พิมพ์คำขอเป็นภาษาปกติ' })}</span></li>
    <li><strong>${tr(l, { ru: 'ИИ-ассистент', en: 'AI assistant', th: 'ผู้ช่วย AI' })}</strong><span>ChatGPT · Claude · MCP</span></li>
    <li class="brand"><strong>Unyly</strong><span>${tr(l, { ru: 'MCP-сервер и защита', en: 'MCP server + safety layer', th: 'เซิร์ฟเวอร์ MCP + ความปลอดภัย' })}</span></li>
    <li class="lime"><strong>${tr(l, { ru: 'Страница подтверждения', en: 'Confirmation page', th: 'หน้ายืนยัน' })}</strong><span>${tr(l, { ru: 'покупатель нажимает одну кнопку', en: 'the customer taps once to confirm', th: 'ลูกค้ากดยืนยันครั้งเดียว' })}</span></li>
    <li class="dash"><strong>GrabFood</strong><span>${tr(l, { ru: 'партнёрский API (нужен)', en: 'partner API (needed)', th: 'API พันธมิตร (ที่ต้องการ)' })}</span></li>
  </ol>
</section>

<section class="section">
  <div class="section-head"><span class="eyebrow">${icon('check')} ${tr(l, { ru: 'Уже сделано', en: 'Already built', th: 'สร้างเสร็จแล้ว' })}</span><h2>${tr(l, { ru: 'Работает сегодня', en: 'Working today', th: 'ใช้งานได้วันนี้' })}</h2>
  <p class="lead">${tr(l, { ru: 'Полный сценарий на вымышленных ресторанах с той же логикой, что понадобится для живых заказов.', en: 'The full flow on fictional restaurants, with the same logic live orders will need.', th: 'ขั้นตอนครบถ้วนกับร้านสมมติ ใช้ตรรกะเดียวกับที่การสั่งจริงต้องใช้' })}</p></div>
  <div class="built-list">
    ${built('/try', tr(l, { ru: 'Интерактивное демо', en: 'Interactive demo', th: 'เดโมแบบโต้ตอบ' }), tr(l, { ru: 'Запрос на тайском, английском или русском → варианты → подтверждение → живой статус', en: 'Request in Thai, English or Russian → options → confirmation → live status', th: 'ขอเป็นภาษาไทย อังกฤษ หรือรัสเซีย → ตัวเลือก → ยืนยัน → สถานะสด' }))}
    ${built('/connect', tr(l, { ru: 'Удалённый MCP-сервер', en: 'Remote MCP server', th: 'เซิร์ฟเวอร์ MCP ระยะไกล' }), `${origin}/mcp · OAuth 2.1 + PKCE`)}
    ${built(`${origin}/.well-known/oauth-authorization-server`, tr(l, { ru: 'Метаданные OAuth', en: 'OAuth metadata', th: 'ข้อมูลเมตา OAuth' }), 'RFC 8414 · RFC 9728 · RFC 8707')}
    ${built(REPO_URL, tr(l, { ru: 'Исходный код и документация', en: 'Source code and docs', th: 'ซอร์สโค้ดและเอกสาร' }), tr(l, { ru: 'Архитектура, модель угроз, схемы инструментов, тесты', en: 'Architecture, threat model, tool schemas, tests', th: 'สถาปัตยกรรม โมเดลภัยคุกคาม สคีมาเครื่องมือ การทดสอบ' }))}
  </div>
</section>

<section class="section">
  <div class="section-head"><span class="eyebrow">${icon('shield')} ${tr(l, { ru: 'Для команд риска и безопасности', en: 'For risk and security teams', th: 'สำหรับทีมความเสี่ยงและความปลอดภัย' })}</span><h2>${tr(l, { ru: 'Защита встроена, а не добавлена', en: 'Safety built in, not bolted on', th: 'ความปลอดภัยฝังอยู่ในระบบตั้งแต่แรก' })}</h2></div>
  <div class="grid three">
    ${guard('tap', tr(l, { ru: 'Согласие человека', en: 'Human consent', th: 'ความยินยอมของคน' }), tr(l, { ru: 'Одноразовое подтверждение привязано к пользователю, версии корзины, цене, адресу и сроку действия.', en: 'A one-time approval bound to the user, cart version, price, address and expiry.', th: 'การยืนยันครั้งเดียวผูกกับผู้ใช้ เวอร์ชันตะกร้า ราคา ที่อยู่ และเวลาหมดอายุ' }))}
    ${guard('repeat', tr(l, { ru: 'Без дублей', en: 'No duplicates', th: 'ไม่มีออเดอร์ซ้ำ' }), tr(l, { ru: 'Ключ идемпотентности на каждую отправку; неизвестный исход сверяется, а не отправляется заново.', en: 'An idempotency key per submission; unknown outcomes are reconciled, never resent.', th: 'มีคีย์ idempotency ทุกการส่ง ผลลัพธ์ที่ไม่ชัดเจนจะถูกตรวจสอบ ไม่ส่งซ้ำ' }))}
    ${guard('eye', tr(l, { ru: 'Защита от инъекций', en: 'Prompt-injection resistant', th: 'ต้านทาน prompt injection' }), tr(l, { ru: 'Текст меню - это данные. Даже «инструкция» в описании блюда не обходит подтверждение.', en: 'Menu text is data. Even an "instruction" in a dish description cannot skip confirmation.', th: 'ข้อความในเมนูเป็นเพียงข้อมูล แม้มี "คำสั่ง" ในคำอธิบายอาหารก็ข้ามการยืนยันไม่ได้' }))}
    ${guard('keyoff', tr(l, { ru: 'Никаких учётных данных Grab', en: 'No Grab credentials', th: 'ไม่ใช้ข้อมูลบัญชี Grab' }), tr(l, { ru: 'Нет парсинга, cookies, перехвата токенов и обхода CAPTCHA. Только документированные API.', en: 'No scraping, cookies, token interception or CAPTCHA bypass. Documented APIs only.', th: 'ไม่ดึงข้อมูลเว็บ ไม่ใช้คุกกี้ ไม่ดักโทเคน ไม่ข้าม CAPTCHA ใช้เฉพาะ API ที่มีเอกสาร' }))}
    ${guard('power', tr(l, { ru: 'Аварийный выключатель', en: 'Kill switch', th: 'สวิตช์หยุดฉุกเฉิน' }), tr(l, { ru: 'Новые заказы останавливаются по режиму без перезапуска, статусы продолжают работать.', en: 'New orders stop per mode without a restart; status tracking keeps working.', th: 'หยุดรับออเดอร์ใหม่แยกตามโหมดได้โดยไม่ต้องรีสตาร์ท การติดตามสถานะยังทำงานต่อ' }))}
    ${guard('alert', tr(l, { ru: 'Честные аллергены', en: 'Honest allergens', th: 'ข้อมูลสารก่อภูมิแพ้ที่ตรงไปตรงมา' }), tr(l, { ru: 'Аллергии отделены от диеты. Нет данных - так и пишем, слово «безопасно» не используется.', en: 'Allergies are separate from diet. Missing data is shown as missing; "safe" is never used.', th: 'อาการแพ้แยกจากความชอบด้านอาหาร ถ้าไม่มีข้อมูลก็แสดงว่าไม่มี ไม่ใช้คำว่า "ปลอดภัย"' }))}
  </div>
</section>

<section class="section split">
  <div class="section-head"><span class="eyebrow">${icon('handshake')} ${tr(l, { ru: 'Что нужно от Grab', en: 'What we need from Grab', th: 'สิ่งที่ต้องการจาก Grab' })}</span><h2>${tr(l, { ru: 'Пять вещей до первого живого заказа', en: 'Five things before the first live order', th: '5 สิ่งก่อนออเดอร์จริงครั้งแรก' })}</h2>
  <p class="lead">${tr(l, { ru: 'Публичного API для заказа от имени покупателя сейчас нет, поэтому живой режим выключен. Мы ничего не обходим.', en: 'There is no public API for ordering on behalf of a customer today, so live mode is off. We do not work around that.', th: 'ปัจจุบันไม่มี API สาธารณะสำหรับสั่งแทนลูกค้า โหมดจริงจึงปิดไว้ และเราไม่หาทางเลี่ยง' })}</p></div>
  <ol class="ask-list">
    <li><span><strong>${tr(l, { ru: 'API заказа для партнёров', en: 'Partner ordering API', th: 'API สั่งอาหารสำหรับพันธมิตร' })}</strong><br><span class="small muted">${tr(l, { ru: 'Поиск, меню, расчёт цены, создание заказа, статусы, отмена', en: 'Search, menu, pricing, order creation, status, cancellation', th: 'ค้นหา เมนู คำนวณราคา สร้างออเดอร์ สถานะ ยกเลิก' })}</span></span></li>
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
      ru: 'Unyly - независимый концепт. Он не связан с Grab, не одобрен и не спонсируется Grab. Названия Grab и GrabFood принадлежат их владельцам и используются только для описания предлагаемой интеграции. Логотипы Grab не используются. Демо-рестораны вымышлены, реальные заказы не создаются.',
      en: 'Unyly is an independent concept. It is not affiliated with, endorsed by or sponsored by Grab. The names Grab and GrabFood belong to their owners and are used only to describe the proposed integration. No Grab logos are used. Demo restaurants are fictional and no real orders are created.',
      th: 'Unyly เป็นแนวคิดอิสระ ไม่ได้เกี่ยวข้อง ไม่ได้รับการรับรอง และไม่ได้รับการสนับสนุนจาก Grab ชื่อ Grab และ GrabFood เป็นของเจ้าของสิทธิ์ และใช้เพื่ออธิบายการเชื่อมต่อที่เสนอเท่านั้น ไม่มีการใช้โลโก้ของ Grab ร้านในเดโมเป็นร้านสมมติและไม่มีการสั่งซื้อจริง',
    })}</p>
    <p class="small muted">${tr(l, { ru: 'Контакт:', en: 'Contact:', th: 'ติดต่อ:' })} <a href="mailto:${supportEmail}">${supportEmail}</a></p>
  </div>
</section>`, { noBanner: true, description: tr(l, { ru: 'Предложение о партнёрстве: заказ GrabFood через ИИ-ассистентов.', en: 'Partnership proposal: ordering GrabFood through AI assistants.', th: 'ข้อเสนอความร่วมมือ: สั่ง GrabFood ผ่านผู้ช่วย AI' }) });
  });

  // ---------------- Guided demo ----------------
  const cleanQ = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

  async function createGuest(l: Locale, reply: FastifyReply, ip: string) {
    const ipHash = sha256(`guest-ip:${ip}`).slice(0, 32);
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
    try {
      const intent = parseIntent(q);
      const res = await searchRestaurants(ctx, { userId: r.s.user.id, via: 'web' }, { ...intent, limit: 10 });
      return renderTry(reply, r, q, { intent, res });
    } catch (e) {
      if (!isDomainError(e)) req.log.error(e);
      return renderTry(reply, r, q, null, errorBox(e));
    }
  });

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
      // Never trust the client for items: recompute the suggestion server-side.
      const res = await searchRestaurants(ctx, actor, { ...parseIntent(q), limit: 10 });
      const hit = res.restaurants.find((x: any) => x.restaurant.restaurant_id === String(b.restaurant_id ?? ''));
      if (!hit?.suggestion || hit.availability_notes.length || hit.suggestion.blocking_issues.length) throw new DomainError('VALIDATION_FAILED', 'This option is no longer available. Please search again.');
      const cart = await createCart(ctx, actor, { restaurant_id: hit.restaurant.restaurant_id, items: hit.suggestion.items.map((i: any) => ({ item_id: i.item_id, quantity: i.quantity })) });
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

  function renderTry(reply: FastifyReply, r: R, q: string, found: { intent: ReturnType<typeof parseIntent>; res: any } | null, flash?: SafeHtml, status = 200) {
    const l = r.l;
    const ex = EXAMPLES[l];
    const form = html`<form class="ask card" method="post" action="/try/start" id="ask">
  ${r.s ? csrfField(r.s) : ''}
  <label for="q" class="sr-only">${tr(l, { ru: 'Ваш запрос', en: 'Your request', th: 'คำขอของคุณ' })}</label>
  <textarea id="q" name="q" rows="2" maxlength="300" placeholder="${ex[0]}">${q}</textarea>
  <div class="ask-row">
    <div class="chips" aria-label="${tr(l, { ru: 'Примеры', en: 'Examples', th: 'ตัวอย่าง' })}">${ex.map((e) => html`<a href="/try?q=${encodeURIComponent(e)}" data-fill="${e}">${e}</a>`)}</div>
    <button class="btn" type="submit">${tr(l, { ru: 'Спросить', en: 'Ask', th: 'ถาม' })} ${icon('send')}</button>
  </div>
</form>`;
    let convo: SafeHtml | string = '';
    let log: SafeHtml;
    if (found) {
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
      const people = tr(l, { ru: 'чел.', en: f.party_size === 1 ? 'person' : 'people', th: 'คน' });
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
  <div class="art">${restaurantArt(rest.restaurant_id, rest.name)}<span class="eta">${icon('clock')} ${rest.eta_estimate_minutes.min}–${rest.eta_estimate_minutes.max} ${tr(l, { ru: 'мин', en: 'min', th: 'นาที' })}</span></div>
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
    <form method="post" action="/try/choose">${csrfField(r.s!)}<input type="hidden" name="q" value="${q}"><input type="hidden" name="restaurant_id" value="${rest.restaurant_id}">
      <button class="btn block" type="submit">${tr(l, { ru: 'Выбрать', en: 'Choose', th: 'เลือก' })}</button></form>
  </div>
</article>`;
      };
      const reason = (x: any) =>
        !x.restaurant.is_open ? tr(l, { ru: 'закрыт', en: 'closed', th: 'ปิดอยู่' }) : x.restaurant.delivers_to_address === false ? tr(l, { ru: 'не доставляет по вашему адресу', en: 'does not deliver to you', th: 'ไม่ส่งถึงที่อยู่ของคุณ' }) : tr(l, { ru: 'недоступен', en: 'unavailable', th: 'ไม่พร้อมให้บริการ' });
      convo = html`
<div class="msg me"><span class="who">${icon('users')}</span><div class="body"><div class="txt">${q}</div></div></div>
<div class="msg ai"><span class="who">${icon('sparkle')}</span><div class="body stack">
  <p class="said">${tr(l, { ru: 'Понял так:', en: 'Here is what I understood:', th: 'ฉันเข้าใจว่า:' })}</p>
  ${understood}
  ${res.allergen_disclaimer ? html`<p class="notice warn small">${icon('alert')} ${tr(l, { ru: 'Данные об аллергенах приходят от ресторанов и могут быть неполными. Unyly никогда не называет блюдо безопасным. Уточняйте у ресторана.', en: 'Allergen data comes from restaurants and may be incomplete. Unyly never calls a dish safe. Check with the restaurant.', th: 'ข้อมูลสารก่อภูมิแพ้มาจากร้านอาหารและอาจไม่ครบถ้วน Unyly ไม่เคยเรียกเมนูใดว่าปลอดภัย โปรดสอบถามร้าน' })}</p>` : ''}
  ${picks.length
    ? html`<p class="said">${tr(l, { ru: `Вот ${picks.length} варианта. Цены уже со всеми сборами:`, en: `Here are ${picks.length} options. Prices already include all fees:`, th: `นี่คือ ${picks.length} ตัวเลือก ราคารวมค่าธรรมเนียมแล้ว:` })}</p>
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
  <li><span class="fn">search_restaurants</span>(${args}) <span class="ret">→ ${res.restaurants.length} ${tr(l, { ru: 'ресторанов', en: 'restaurants', th: 'ร้าน' })}, ${viable.length} ${tr(l, { ru: 'с предложением', en: 'with a suggestion', th: 'มีข้อเสนอ' })}</span></li>
  <li class="next"><span class="fn">create_cart</span> → <span class="fn">quote_cart</span> → <span class="fn">prepare_checkout</span> <span class="ret">${tr(l, { ru: 'после выбора', en: 'after you choose', th: 'หลังคุณเลือก' })}</span></li>
  <li class="next"><span class="fn">submit_order</span> <span class="ret">${tr(l, { ru: 'только после вашего подтверждения', en: 'only after you confirm', th: 'หลังคุณยืนยันเท่านั้น' })}</span></li>
</ol>`;
    } else {
      log = html`<ol class="tool-log"><li class="next">${tr(l, { ru: 'Отправьте запрос, и здесь появятся вызовы инструментов.', en: 'Send a request and the tool calls appear here.', th: 'ส่งคำขอแล้วการเรียกเครื่องมือจะแสดงที่นี่' })}</li></ol>`;
    }
    const steps = [
      tr(l, { ru: 'Опишите, что хотите', en: 'Describe what you want', th: 'บอกสิ่งที่อยากกิน' }),
      tr(l, { ru: 'Выберите вариант', en: 'Pick an option', th: 'เลือกตัวเลือก' }),
      tr(l, { ru: 'Подтвердите на защищённой странице', en: 'Confirm on the secure page', th: 'ยืนยันในหน้าที่ปลอดภัย' }),
      tr(l, { ru: 'Следите за курьером', en: 'Watch the rider', th: 'ติดตามไรเดอร์' }),
    ];
    const body = html`
<div class="page-head">
  <span class="eyebrow">${icon('sparkle')} ${tr(l, { ru: 'Живое демо · вымышленные рестораны · без оплаты', en: 'Live demo · fictional restaurants · no payment', th: 'เดโมสด · ร้านสมมติ · ไม่มีการชำระเงิน' })}</span>
  <h1>${tr(l, { ru: 'Закажите так, как написали бы другу', en: 'Order the way you would text a friend', th: 'สั่งอาหารเหมือนพิมพ์คุยกับเพื่อน' })}</h1>
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

