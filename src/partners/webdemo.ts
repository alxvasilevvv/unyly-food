// The website's live Ari demo (/ari). The browser plays the Ari app; this file plays Ari's backend:
// a tiny rule-based "brain" turns the user's sentence into the same Partner API calls Ari makes
// (tools with cards, native confirmation, order events). Demo mode only: synthetic stores and fares.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.js';
import { hmac, safeEqual, UUID_RE } from '../domain/crypto.js';
import { DomainError, isDomainError } from '../domain/errors.js';
import type { Locale } from '../domain/locales.js';
import { addFirstAddress, listAddresses, toDeliveryAddress } from '../services/users.js';
import { money } from '../domain/money.js';
import { DEMO_RESTAURANTS } from '../providers/demo/catalog.js';
import { resolvePlace } from '../providers/demo/places.js';
import { callProvider } from '../services/common.js';
import { DemoService, detectService, fixTypos, hasFoodCue, parseIntent, serviceCues } from '../web/intent.js';
import { SHOP_STORE, shopPicks, shopPlan } from '../web/try-services.js';
import { tr } from '../web/messages.js';
import { Card, CardOption, cardLocale, localText } from './cards.js';
import { WEB_DEMO_PARTNER } from './config.js';
import {
  cancellationCard, checkoutCard, confirmCancelPartner, confirmCheckout, declineCheckoutPartner, grabLinkStatus, orderCard, prepareCancelPartner, runTool, startGrabLink,
} from './core.js';
import { loadPartnerUser, partnerActor, PartnerUser, upsertPartnerUser } from './users.js';
import { lastPartnerEventSeq, listPartnerEventsFor } from './webhooks.js';

const P = WEB_DEMO_PARTNER;
const COOKIE = 'ari_demo';
const ALLOWED_TOOLS = new Set(['create_cart', 'update_cart', 'search_stores', 'get_store', 'estimate_trip', 'get_order_status']);

export interface TraceEntry { call: string; grab: string | null; ms: number; ok: boolean }
export interface AriTurn { reply: string; card?: Card | null; chips?: string[]; order_id?: string; trace: TraceEntry[] }

type Tri = { en: string; ru: string; th: string };
const t = (l: Locale, x: Tri) => tr(l, x);

/** The Grab API a live deployment would call for the same step. */
function grabFor(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'estimate_trip') return args.service === 'express' ? 'GrabExpress · POST /v1/deliveries/quotes' : 'Grab Farefeed · POST /farefeed/v1/estimate';
  if (tool === 'create_cart' && args.service === 'express') return 'GrabExpress · POST /v1/deliveries/quotes';
  if (tool === 'create_cart' && args.service === 'ride') return 'Grab Farefeed · fare + deep link';
  if (tool === 'search_stores') return 'GrabFood / GrabMart · consumer scope requested from Grab';
  if (tool === 'get_order_status') return 'GrabExpress · GET /v1/deliveries/{id}';
  return null;
}

async function traced<T>(trace: TraceEntry[], call: string, grab: string | null, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    trace.push({ call, grab, ms: Date.now() - t0, ok: (r as any)?.ok !== false });
    return r;
  } catch (e) {
    trace.push({ call, grab, ms: Date.now() - t0, ok: false });
    throw e;
  }
}

const EXAMPLES: Record<'en' | 'ru' | 'th', string[]> = {
  en: ['Taxi from Siam Paragon to Suvarnabhumi airport', 'Dinner for two under 600 baht, no nuts', 'Send a 3 kg parcel to ICONSIAM', 'Red roses with a gift box', 'Paracetamol and plasters', 'Groceries: rice, eggs and water', 'Chocolate cake for a birthday'],
  ru: ['Такси от Сиам Парагона до аэропорта Суварнабхуми', 'Ужин на двоих до 600 бат, без орехов', 'Отправить посылку 3 кг в Айконсиам', 'Букет роз в подарочной коробке', 'Парацетамол и пластыри', 'Продукты: рис, яйца и вода', 'Шоколадный торт на день рождения'],
  th: ['เรียกแท็กซี่จากสยามพารากอนไปสนามบินสุวรรณภูมิ', 'มื้อเย็นสำหรับ 2 คน ไม่เกิน 600 บาท ไม่ใส่ถั่ว', 'ส่งพัสดุ 3 กก. ไปไอคอนสยาม', 'ช่อดอกกุหลาบพร้อมกล่องของขวัญ', 'พาราเซตามอลกับพลาสเตอร์', 'ของชำ ข้าวสาร ไข่ไก่ น้ำดื่ม', 'เค้กช็อกโกแลตวันเกิด'],
};
export const ariExamples = (l: Locale) => (EXAMPLES as Record<string, string[]>)[l] ?? EXAMPLES.en;

const GREET = /^(hi|hello|hey|good (?:morning|afternoon|evening)|привет|здравств|добр|สวัสดี|หวัดดี|👋)(?![a-z])/iu;
const THANKS = /^(?:ok(?:ay)?[,! ]*)?(?:thanks?|thank you|thx|cheers|great|perfect|awesome|спасибо|благодар|отлично|супер|ขอบคุณ|ขอบใจ|🙏|❤️)(?![a-zа-яё])/iu;
const HELP = /what can you (?:do|order)|what do you do|^help\b|how does (?:this|it) work|what services|что (?:ты )?(?:умеешь|можешь)|что вы (?:умеете|можете)|^помо(?:щь|ги)|как это работает|ทำอะไรได้|ช่วยอะไร|ใช้งานยังไง/iu;
const CANCEL = /\bcancel\b|отмен|ยกเลิก/iu;
const TRACK = /where(?: i|')s (?:my|the)|\b(?:order|delivery|ride) status\b|\bstatus of my\b|\btrack\b|how long (?:until|till)|где (?:мой|моя|мое|моё|мои|сейчас|курьер|водитель|заказ)|что с (?:моим )?заказ|статус заказа|когда (?:приедет|привезут|доставят)|(?:ออเดอร์|คำสั่งซื้อ|รถ|ไรเดอร์|พัสดุ)(?:ของฉัน)?(?:อยู่|ถึง)(?:ที่)?ไหน|สถานะ(?:ออเดอร์|คำสั่งซื้อ)|ถึงไหนแล้ว/iu;

// ---- Requests Ari answers in words, without a tool call ----
/** Prescription-only and controlled medicines: never ordered, whatever the wording. */
const RX = /antibiotic|amoxicillin|azithromycin|penicillin|ciprofloxacin|doxycycline|viagra|sildenafil|cialis|tramadol|codeine|morphine|oxycodone|opioid|xanax|valium|diazepam|alprazolam|sleeping pills?|sedative|antidepressant|insulin|steroid|prescription|ozempic|adderall|ritalin|антибиотик|амоксициллин|азитромицин|пенициллин|виагр|сиалис|трамадол|кодеин|морфин|снотворн|успокоительн|антидепрессант|инсулин|рецептурн|по рецепту|транквилиз|феназепам|ยาปฏิชีวนะ|ยาแก้อักเสบ|(?<!น้ำ)ยาฆ่าเชื้อ|อะม็อกซี|อะม๊อกซี|อะมอกซี|ไวอากร้า|ยานอนหลับ|ทรามาดอล|ยาตามใบสั่ง|ใบสั่งยา|อินซูลิน|มอร์ฟีน/iu;
const RESTRICTED = /\b(?:beers?|wine|whisk(?:e)?y|vodka|rum|gin|tequila|champagne|soju|alcohol|liquor|booze|cigarettes?|cigars?|tobacco|vapes?|e-cig\S*|weed|cannabis|marijuana|cocaine|drugs|kratom|guns?|weapons?)\b|(?<!\p{L})пив[оа](?!\p{L})|(?<!\p{L})вин[оа](?!\p{L})|виски|водк|шампанск|алкогол|спиртн|сигарет|табак|вейп|травк|марихуан|наркот|оружи|เบียร์|ไวน์|เหล้า|วิสกี้|วอดก้า|สุรา|แอลกอฮอล์(?!ล้าง)|บุหรี่|กัญชา|ยาเสพติด|อาวุธ|ปืน/iu;
const EMERGENCY = /call (?:me )?(?:a |an |the )?(?:doctor|ambulance)|\bambulance\b|\bemergency\b|вызов\S* (?:врача|скорую)|скор(?:ую|ая) помощь|เรียกหมอ|รถพยาบาล|ฉุกเฉิน/iu;
/** Attempts to talk Ari out of its rules. */
const INJECT = /ignore (?:all |your |the |my |any |previous |prior )*(?:rules|instructions|prompts?|guidelines)|system prompt|developer mode|jailbreak|you are now|pretend (?:to be|you)|confirm (?:it |the order |this |that |everything )?(?:yourself|for me|on my behalf|automatically)|игнорируй|забудь (?:все |свои |про )*(?:правила|инструкции)|подтверд\S* (?:заказ |всё |все )?(?:сама|сам|за меня|автоматически)|ไม่ต้องสนกฎ|ไม่ต้องสนใจกฎ|ลืมกฎ|ยืนยัน(?:ออเดอร์|คำสั่งซื้อ)?(?:เอง|แทน)/iu;
const NO_CONFIRM = /without (?:any |my |a )?confirm|no confirmation|skip (?:the )?confirm|don'?t ask(?: me)?|без подтвержд|не спрашива|ไม่ต้องยืนยัน|ไม่ต้องถาม/iu;
const REORDER = /\b(?:repeat|reorder|re-order)\b|\b(?:same|order) (?:it |that |thing )?again\b|same as (?:last|before)|\bthe usual\b|повтор|ещё раз|еще раз|как (?:в прошлый раз|обычно)|то же самое|เหมือนเดิม|สั่งซ้ำ|สั่งอีก|อีกครั้ง|อีกรอบ/iu;
const OOS_TABLE = /\b(?:book|reserve|get)\b.{0,24}\btable\b|\btable for\b|\breservation\b|столик|бронь стол|จองโต๊ะ/iu;
const OOS_FLIGHT = /\bflights?\b|\b(?:plane|air|airline) tickets?\b|(?<!\p{L})рейс|авиабилет|билет\S* на самол|ตั๋วเครื่องบิน|เที่ยวบิน/iu;
const OOS = /\b(?:transfer|send|wire|lend|pay)\b.{0,24}\b(?:money|cash|baht|bills?)\b|\bhotels?\b|\btrain tickets?\b|\bmovie tickets?\b|\bweather\b|\bforecast\b|\bnews\b|\bjoke\b|\btranslate\b|\bremind me\b|\balarm\b|\bplay (?:music|a song)\b|\bbitcoin\b|exchange rate|отел[ьяе]|гостиниц|погод|перев\S* (?:деньги|денег)|(?<!\p{L})деньги(?!\p{L})|новост|анекдот|напомни|будильник|курс (?:валют|доллар|бат)|จองโรงแรม|ที่พัก|อากาศ|โอนเงิน|จ่ายบิล|ข่าว|เรื่องตลก|ตั้งปลุก|อัตราแลกเปลี่ยน/iu;
const WHO = /who are you|what are you\b|what(?:'s| is) your name|are you (?:a |an )?(?:human|bot|robot|ai|real|person|machine)|кто ты|кто вы|ты кто|как (?:тебя|вас) зовут|(?:ты|вы) (?:человек|бот|робот|живая|настоящая)|คุณ(?:เป็น|คือ)ใคร|เธอ(?:เป็น|คือ)ใคร|ชื่ออะไร|เป็นคน(?:จริง)?(?:หรือ|ไหม|มั้ย|รึ)|เป็น(?:บอท|หุ่นยนต์|เอไอ|ai)/iu;
const HOW_ARE_YOU = /^how are you|how(?:'s| is) it going|how do you do|^what'?s up|как дела|^как ты\??$|как поживае|สบายดีไหม|สบายดีมั้ย|เป็น(?:ยัง)?ไงบ้าง/iu;
const BYE = /^(?:good ?bye|bye(?:[- ]bye)?|see you|see ya|good night|пока|до свидания|до встречи|спокойной ночи|บาย|บ๊ายบาย|ลาก่อน|ไปก่อนนะ|ฝันดี)(?![a-zа-яё])/iu;
/** "Yes, confirm" typed into the chat. It is never a confirmation: only the button on the card is. */
const YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|k|fine|confirm(?:ed)?|go ahead|do it|order it|place (?:the|my) order|book it|buy it|proceed|let'?s go|sounds good|да|ага|угу|давай(?:те)?|подтвержда\S*|подтверди\S*|оформ\S*|заказывай\S*|хорошо|ок(?:ей)?|ладно|согласен|согласна|беру|ใช่|ตกลง|ยืนยัน|สั่งเลย|โอเค|ได้เลย|ได้|เอาเลย|เอา|จัดไป|ครับ|ค่ะ|👍|👌|✅)(?:[\s,.!]+(?:yes|please|and|confirm\S*|go ahead|order it|do it|it|that|the order|подтвержда\S*|подтверди\S*|заказывай|оформляй|пожалуйста|ยืนยัน|เลย|ครับ|ค่ะ|นะ))*[\s.!]*$/iu;
const NO = /^(?:no|nope|nah|not now|never ?mind|нет|не надо|не нужно|не сейчас|передумал\S*|ไม่|ไม่เอา|ไม่ต้อง|ไม่เป็นไร|ไว้ก่อน)(?:[\s,.!]+(?:thanks|thank you|спасибо|ครับ|ค่ะ|ขอบคุณ))*[\s.!]*$/iu;
const CHEAPER = /cheap|expensive|pricey|lower price|дешев|дёшев|дорог|ถูกกว่า|ถูกๆ|ถูกที่สุด|ราคาถูก|แพง/iu;
const ADDRESS = /(?:change|update|edit|new|another|different|other|wrong|my) (?:delivery |home )?address|поменя\S* адрес|смени\S* адрес|измени\S* адрес|друг\S* адрес|нов\S* адрес|не тот адрес|мой адрес|เปลี่ยนที่อยู่|แก้(?:ไข)?ที่อยู่|ที่อยู่ใหม่|ที่อยู่อื่น/iu;
/** A clock time or another day: the demo orders for right now only. */
const TIME = /\bat \d{1,2}(?::\d{2})?\s*(?:am|pm|o'?clock)?(?![\p{L}\d])|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\btomorrow\b|\bin \d+ (?:min\w*|hours?)\b|\bin an hour\b|(?<!\p{L})в \d{1,2}[:.]\d{2}|(?<!\p{L})в \d{1,2} (?:час\S*|утра|вечера|дня)|послезавтра|завтра|через \d+ (?:мин\S*|час\S*)|через час|\d{1,2}\s*โมง(?:เช้า|เย็น)?|\d{1,2}[:.]\d{2}\s*น\.?|พรุ่งนี้|อีก \d+ (?:นาที|ชั่วโมง)|\d{1,2}\s*ทุ่ม|บ่าย\s*\d/giu;
const FRAGILE = /fragile|breakable|\bglass\b|хрупк|стекл|แตกง่าย|ระวังแตก|แก้ว/iu;
const GIFT = /\b(?:to|for) (?:my |our )?(?:mom|mum|mother|wife|husband|girlfriend|boyfriend|friend|dad|father|sister|brother|boss|colleague|grandma|grandmother|daughter|son)\b|(?<!\p{L})(?:маме|жене|мужу|девушке|подруге|другу|папе|сестре|брату|бабушке|коллеге|дочке|дочери|сыну|начальнику)(?!\p{L})|ให้(?:คุณ)?(?:แม่|พ่อ|แฟน|ภรรยา|สามี|เพื่อน|พี่|น้อง|ยาย|ย่า|ลูก|เจ้านาย)/iu;
/** Well-known places the Bangkok demo map does not reach. */
const OUTSIDE = /singapore|phuket|pattaya|chiang ?mai|chiang ?rai|hua ?hin|krabi|samui|ayutthaya|kuala lumpur|malaysia|jakarta|\bbali\b|manila|hanoi|ho chi minh|saigon|vietnam|tokyo|japan|moscow|russia|london|paris|new york|dubai|hong kong|сингапур|пхукет|паттай|чианг ?ма|хуа ?хин|краби|самуи|москв|росси|токио|лондон|париж|дубай|малайзи|вьетнам|สิงคโปร์|ภูเก็ต|พัทยา|เชียงใหม่|เชียงราย|หัวหิน|กระบี่|สมุย|อยุธยา|มอสโก|โตเกียว|ลอนดอน|มาเลเซีย|ญี่ปุ่น/iu;

/** Emoji stand in for the word they picture, so "🍕" or "🚕" alone is a request. */
const EMOJI: [RegExp, string][] = [
  [/🍕/u, 'pizza'], [/🍔|🍟/u, 'burger'], [/🍜|🍝|🍲|🥡/u, 'noodles'], [/🍣|🍱/u, 'sushi'], [/🍛/u, 'curry'], [/🥗/u, 'salad'],
  [/🚕|🚖|🚗|🚙|🛵|🏍/u, 'taxi'], [/💐|🌹|🌷|🌸|🌺|🌻/u, 'flowers'], [/🎂|🍰|🧁/u, 'cake'], [/📦/u, 'parcel'], [/💊|🤒|🤕|🩹/u, 'pharmacy'], [/🛒|🥚|🥛|🍌/u, 'groceries'],
];

const HELP_TEXT: Tri = {
  en: 'I can order any Grab service for you: a ride, food, groceries, flowers, pharmacy items, a cake or a parcel. Say it in your own words, pick an option, then confirm on the card. Nothing is ordered until you confirm.',
  ru: 'Я закажу любой сервис Grab: поездку, еду, продукты, цветы, товары из аптеки, торт или посылку. Скажите своими словами, выберите вариант и подтвердите на карточке. Без подтверждения ничего не заказывается.',
  th: 'Ari สั่งบริการของ Grab ให้ได้ทุกอย่างค่ะ ทั้งเรียกรถ สั่งอาหาร ของชำ ดอกไม้ ยาสามัญ เค้ก หรือส่งพัสดุ บอก Ari ด้วยคำพูดของคุณเอง เลือกตัวเลือก แล้วแตะยืนยันบนการ์ด Ari จะยังไม่สั่งอะไรจนกว่าคุณจะยืนยันค่ะ',
};
const UNKNOWN_TEXT: Tri = {
  en: 'I did not catch which Grab service you need. I can book a ride, order food, groceries, flowers or pharmacy items, or send a parcel. Try one of these:',
  ru: 'Не поняла, какой сервис Grab нужен. Могу вызвать такси, заказать еду, продукты, цветы, товары из аптеки или отправить посылку. Например:',
  th: 'Ari ยังไม่แน่ใจว่าคุณต้องการบริการไหนของ Grab ค่ะ Ari เรียกรถ สั่งอาหาร ของชำ ดอกไม้ ยาสามัญ หรือส่งพัสดุให้ได้ ลองแบบนี้ดูนะคะ',
};
const PHARMACY_CHIPS: Tri[] = [
  { en: 'Paracetamol and plasters', ru: 'Парацетамол и пластыри', th: 'พาราเซตามอลกับพลาสเตอร์' },
  { en: 'Throat lozenges', ru: 'Леденцы от горла', th: 'ยาอมแก้เจ็บคอ' },
  { en: 'Sunscreen and mosquito repellent', ru: 'Крем от солнца и средство от комаров', th: 'ครีมกันแดดกับยากันยุง' },
];
const PHARMACY_LIST: Tri = {
  en: 'The pharmacy in this demo carries household remedies only: paracetamol, plasters, throat lozenges, rehydration salts, antiseptic, a thermometer, face masks, mosquito repellent and sunscreen. Which one do you need?',
  ru: 'В аптеке этого демо только безрецептурные товары: парацетамол, пластыри, леденцы от горла, регидратационные соли, антисептик, термометр, маски, средство от комаров и крем от солнца. Что из этого нужно?',
  th: 'ร้านยาในเดโมนี้มีเฉพาะยาสามัญและของใช้ทั่วไปค่ะ ได้แก่ พาราเซตามอล พลาสเตอร์ ยาอมแก้เจ็บคอ ผงเกลือแร่ น้ำยาฆ่าเชื้อ ปรอทวัดไข้ หน้ากากอนามัย สเปรย์กันยุง และครีมกันแดด ต้องการตัวไหนคะ',
};

/** A dish the user may name. `cat` finds it on the demo menus; null means the demo catalog has nothing like it. */
interface Dish { re: RegExp; cat: RegExp | null; name: Tri }
const DISHES: Dish[] = [
  { re: /pad ?thai|phad thai|пад ?тай|ผัดไทย/iu, cat: /pad thai/i, name: { en: 'pad thai', ru: 'пад тай', th: 'ผัดไทย' } },
  { re: /tom ?yum|том ?ям|ต้มยำ/iu, cat: /tom yum/i, name: { en: 'tom yum', ru: 'том ям', th: 'ต้มยำ' } },
  { re: /green curry|зел[её]н\S* карри|แกงเขียวหวาน/iu, cat: /green curry/i, name: { en: 'green curry', ru: 'зелёный карри', th: 'แกงเขียวหวาน' } },
  { re: /kra ?pao|krapow|ka ?prao|basil chicken|кра ?пао|กะเพรา|กระเพรา/iu, cat: /kra pao/i, name: { en: 'pad kra pao', ru: 'пад кра пао', th: 'กะเพรา' } },
  { re: /som ?tam|papaya salad|сом ?там|ส้มตำ/iu, cat: /som tam/i, name: { en: 'som tam', ru: 'сом там', th: 'ส้มตำ' } },
  { re: /khao ?soi|као ?сой|ข้าวซอย/iu, cat: /khao soi/i, name: { en: 'khao soi', ru: 'као сой', th: 'ข้าวซอย' } },
  { re: /boat noodles?|ก๋วยเตี๋ยวเรือ/iu, cat: /boat noodles/i, name: { en: 'boat noodles', ru: 'лапша', th: 'ก๋วยเตี๋ยวเรือ' } },
  { re: /fried rice|жарен\S* рис|ข้าวผัด/iu, cat: /fried rice/i, name: { en: 'fried rice', ru: 'жареный рис', th: 'ข้าวผัด' } },
  { re: /mango sticky rice|sticky rice|манго с (?:клейким )?рисом|ข้าวเหนียวมะม่วง/iu, cat: /mango sticky/i, name: { en: 'mango sticky rice', ru: 'манго с клейким рисом', th: 'ข้าวเหนียวมะม่วง' } },
  { re: /spring rolls?|спринг[- ]?ролл|ปอเปี๊ยะ/iu, cat: /spring rolls/i, name: { en: 'spring rolls', ru: 'спринг-роллы', th: 'ปอเปี๊ยะ' } },
  { re: /wonton|вонтон|เกี๊ยว/iu, cat: /wonton/i, name: { en: 'wonton soup', ru: 'суп с вонтонами', th: 'เกี๊ยว' } },
  { re: /grilled chicken|курица[- ]гриль|куриц\S* на гриле|ไก่ย่าง/iu, cat: /grilled chicken/i, name: { en: 'grilled chicken', ru: 'курица гриль', th: 'ไก่ย่าง' } },
  { re: /burger|бургер|เบอร์เกอร์/iu, cat: /burger/i, name: { en: 'burger', ru: 'бургер', th: 'เบอร์เกอร์' } },
  { re: /pizza|пицц|พิซซ่า/iu, cat: null, name: { en: 'pizza', ru: 'пицца', th: 'พิซซ่า' } },
  { re: /sushi|sashimi|суши|сашими|ซูชิ/iu, cat: null, name: { en: 'sushi', ru: 'суши', th: 'ซูชิ' } },
  { re: /ramen|рамен|ราเมง|ราเม็ง/iu, cat: null, name: { en: 'ramen', ru: 'рамен', th: 'ราเมง' } },
  { re: /pasta|spaghetti|(?<!\p{L})паст[ауы](?!\p{L})|спагетти|พาสต้า|สปาเก็ตตี้/iu, cat: null, name: { en: 'pasta', ru: 'паста', th: 'พาสต้า' } },
  { re: /steak|стейк|สเต๊ก/iu, cat: null, name: { en: 'steak', ru: 'стейк', th: 'สเต๊ก' } },
  { re: /kebab|shawarma|шаурм|кебаб|เคบับ/iu, cat: null, name: { en: 'kebab', ru: 'шаурма', th: 'เคบับ' } },
  { re: /sandwich|сэндвич|бутерброд|แซนด์วิช/iu, cat: null, name: { en: 'sandwiches', ru: 'сэндвичи', th: 'แซนด์วิช' } },
  { re: /dumplings?|dim sum|пельмен|дим ?сам|ติ่มซำ/iu, cat: null, name: { en: 'dumplings', ru: 'пельмени', th: 'ติ่มซำ' } },
  { re: /\bpho\b|фо бо|เฝอ/iu, cat: null, name: { en: 'pho', ru: 'фо бо', th: 'เฝอ' } },
  { re: /tacos?\b|burrito|(?<!\p{L})тако(?!\p{L})|буррито|ทาโก้/iu, cat: null, name: { en: 'tacos', ru: 'тако', th: 'ทาโก้' } },
  { re: /fried chicken|\bkfc\b|ไก่ทอด/iu, cat: null, name: { en: 'fried chicken', ru: 'жареная курица', th: 'ไก่ทอด' } },
  { re: /bubble tea|\bboba\b|ชานม/iu, cat: null, name: { en: 'bubble tea', ru: 'бабл-ти', th: 'ชานมไข่มุก' } },
  { re: /ice cream|морожен|ไอศกรีม|ไอติม/iu, cat: null, name: { en: 'ice cream', ru: 'мороженое', th: 'ไอศกรีม' } },
  { re: /curry|карри|แกง/iu, cat: /curry/i, name: { en: 'curry', ru: 'карри', th: 'แกง' } },
];

/** The named dish on the demo menus, with the reason it cannot be offered when it does not fit the request. */
function findDish(q: string, intent: { exclude_allergens: string[]; dietary: string[] }) {
  const dish = DISHES.find((d) => d.re.test(q));
  if (!dish) return null;
  const all = dish.cat
    ? DEMO_RESTAURANTS.filter((r) => r.service === 'food').flatMap((r) => r.items.filter((it) => it.available && dish.cat!.test(it.name)).map((item) => ({ store: r, item })))
    : [];
  const open = all.filter((h) => h.store.open);
  const fits = open.filter(({ item }) => {
    const declared: string[] = item.allergen_info?.declared ?? [];
    if (intent.exclude_allergens.some((a) => declared.includes(a))) return false;
    const tags: string[] = item.dietary_tags_declared ?? [];
    if (intent.dietary.includes('vegan') && !tags.includes('vegan')) return false;
    if (intent.dietary.includes('vegetarian') && !tags.includes('vegetarian') && !tags.includes('vegan')) return false;
    if (intent.dietary.includes('halal') && !tags.includes('halal')) return false;
    if (intent.dietary.includes('no_pork') && /pork/i.test(item.name)) return false;
    return true;
  });
  return { dish, all, open, fits };
}

/** "Where is my order" and "cancel my order" act on the latest order, like the buttons on its card. */
async function latestOrderTurn(ctx: Ctx, u: PartnerUser, l: Locale, cancel: boolean, trace: TraceEntry[]): Promise<AriTurn> {
  const base = `/partner/v1/users/${u.external_user_id}`;
  const o = (await ctx.db.query(
    `SELECT id FROM orders WHERE user_id = $1 ORDER BY (fulfillment_status IN ('submitted','accepted','preparing','picked_up')) DESC, created_at DESC LIMIT 1`,
    [u.user_id],
  )).rows[0];
  if (!o) {
    return {
      reply: cancel
        ? t(l, { en: 'There is nothing to cancel: you have no orders yet. A card you have not confirmed orders nothing.', ru: 'Отменять нечего: заказов пока нет. Карточка без подтверждения ничего не заказывает.', th: 'ยังไม่มีคำสั่งซื้อให้ยกเลิกค่ะ การ์ดที่ยังไม่ได้กดยืนยันจะไม่มีการสั่งซื้อใดๆ ค่ะ' })
        : t(l, { en: 'You have no orders yet. What would you like from Grab?', ru: 'Заказов пока нет. Что заказать в Grab?', th: 'ยังไม่มีคำสั่งซื้อค่ะ ต้องการอะไรจาก Grab ดีคะ' }),
      chips: ariExamples(l).slice(0, 3), trace,
    };
  }
  const card = await traced(trace, `GET ${base}/orders/${o.id}`, 'GrabExpress · GET /v1/deliveries/{id}', () => orderCard(ctx, P, u, o.id, { refresh: true }));
  if (!cancel) {
    return { reply: t(l, { en: `Your latest order: ${card.status?.label ?? ''}.`, ru: `Ваш последний заказ: ${card.status?.label ?? ''}.`, th: `คำสั่งซื้อล่าสุด: ${card.status?.label ?? ''}ค่ะ` }), card, order_id: o.id, trace };
  }
  if (!card.actions.some((a) => a.kind === 'prepare_cancel')) {
    const st = card.status?.label ?? '';
    return { reply: t(l, { en: `This order can no longer be cancelled (${st}).`, ru: `Этот заказ уже нельзя отменить (${st}).`, th: `คำสั่งซื้อนี้ยกเลิกไม่ได้แล้วค่ะ (${st})` }), card, order_id: o.id, trace };
  }
  const r = await traced(trace, `POST ${base}/orders/${o.id}/cancel`, null, () => prepareCancelPartner(ctx, P, u, o.id));
  return { reply: t(l, { en: 'Here are the cancellation terms. The order is cancelled only when you confirm on the card:', ru: 'Условия отмены. Заказ отменится только после подтверждения на карточке:', th: 'นี่คือเงื่อนไขการยกเลิกค่ะ คำสั่งซื้อจะถูกยกเลิกเมื่อคุณกดยืนยันบนการ์ดเท่านั้น' }), card: r.card, trace };
}

/** "Repeat my last order": a new cart from the latest order at today's prices, shown as a checkout card to confirm. */
async function reorderTurn(ctx: Ctx, u: PartnerUser, l: Locale, trace: TraceEntry[]): Promise<AriTurn> {
  const base = `/partner/v1/users/${u.external_user_id}`;
  const o = (await ctx.db.query('SELECT id FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [u.user_id])).rows[0];
  if (!o) {
    return {
      reply: t(l, { en: 'There is no earlier order to repeat yet. What would you like from Grab?', ru: 'Повторять пока нечего: заказов ещё не было. Что заказать в Grab?', th: 'ยังไม่มีคำสั่งซื้อก่อนหน้าให้สั่งซ้ำค่ะ ต้องการอะไรจาก Grab ดีคะ' }),
      chips: ariExamples(l).slice(0, 3), trace,
    };
  }
  const args = { from_order_id: o.id };
  const r = await traced(trace, `POST ${base}/tools/create_cart`, null, () => runTool(ctx, P, u, 'create_cart', args));
  if (!r.ok) return errorTurn(l, r.error, trace);
  if (r.card?.type !== 'checkout') {
    return { reply: t(l, { en: 'I could not repeat that order exactly as it was:', ru: 'Повторить заказ один в один не получилось:', th: 'Ari สั่งซ้ำแบบเดิมทุกอย่างไม่ได้ค่ะ' }), card: r.card, chips: ariExamples(l).slice(0, 3), trace };
  }
  return {
    reply: t(l, { en: `Same as your last order (${r.card.title}), at today's price. Nothing is ordered until you confirm on the card.`, ru: `То же, что в прошлом заказе (${r.card.title}), по сегодняшней цене. Без подтверждения на карточке ничего не заказывается.`, th: `เหมือนคำสั่งซื้อล่าสุด (${r.card.title}) ในราคาวันนี้ค่ะ Ari จะยังไม่สั่งจนกว่าคุณจะกดยืนยันบนการ์ดนะคะ` }),
    card: r.card, trace,
  };
}

interface TripAsk { service: string; pickup?: string; dropoff?: string; weight_kg?: number; passengers?: number }

/** Example chips after an unknown or ambiguous place: the same request with the suggested place in the slot that failed. */
function placeChip(l: Locale, ask: TripAsk | undefined, field: string | undefined, place: string): string {
  const from = field === 'pickup' ? place : ask?.pickup;
  const to = field === 'pickup' ? ask?.dropoff ?? '' : place;
  const kg = ask?.weight_kg;
  if (ask?.service === 'express') {
    return from
      ? t(l, { en: `Send a ${kg ? `${kg} kg ` : ''}parcel from ${from} to ${to}`, ru: `Отправить посылку${kg ? ` ${kg} кг` : ''} от ${from} до ${to}`, th: `ส่งพัสดุ${kg ? ` ${kg} กก.` : ''} จาก ${from} ไป ${to}` })
      : t(l, { en: `Send a ${kg ? `${kg} kg ` : ''}parcel to ${to}`, ru: `Отправить посылку${kg ? ` ${kg} кг` : ''} в ${to}`, th: `ส่งพัสดุ${kg ? ` ${kg} กก.` : ''} ไป ${to}` });
  }
  // The party size goes last, where the place parser stops reading.
  const n = ask?.passengers;
  const group = n && n > 1 ? t(l, { en: ` for ${n} people`, ru: ` на ${n} человек`, th: ` สำหรับ ${n} คน` }) : '';
  return (from
    ? t(l, { en: `Taxi from ${from} to ${to}`, ru: `Такси от ${from} до ${to}`, th: `แท็กซี่จาก ${from} ไป ${to}` })
    : t(l, { en: `Taxi to ${to}`, ru: `Такси до ${to}`, th: `แท็กซี่ไป ${to}` })) + group;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SPLIT = /\s*(?:,|;|\band then\b|\bthen\b|\band also\b|\balso\b|\bplus\b|\band\b|&|(?<!\p{L})(?:а также|а ещё|и ещё|потом|затем|и)(?!\p{L})|แล้วก็|แล้ว|และ|พร้อมกับ|กับ)\s*/iu;
const OWN_CARD = new Set<DemoService>(['ride', 'express', 'flowers', 'cakes', 'pharmacy']);
/** Two different services in one sentence ("send flowers to my mom and book a taxi"): the parts, one per service. */
function twoRequests(q: string): string[] | null {
  const parts = q.split(SPLIT).map((p) => p?.trim()).filter((p): p is string => !!p && p.length > 1);
  if (parts.length < 2) return null;
  const seen = new Map<DemoService, string>();
  for (const p of parts) {
    if (!serviceCues(p).length) continue;
    const s = detectService(p).service;
    if (!seen.has(s)) seen.set(s, p);
  }
  if (seen.size < 2 || ![...seen.keys()].some((s) => OWN_CARD.has(s))) return null;
  return [...seen.values()].slice(0, 3).map(cap);
}

const say = (l: Locale, x: Tri, chips: string[], trace: TraceEntry[]): AriTurn => ({ reply: t(l, x), chips, trace });

/** One user message: decide what Ari would do and run it through the Partner API path. */
export async function ariRespond(ctx: Ctx, u: PartnerUser, text: string): Promise<AriTurn> {
  const l = cardLocale(u.locale);
  const trace: TraceEntry[] = [];
  const base = `/partner/v1/users/${u.external_user_id}`;
  const typed = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  // What the rules read: the sentence with emoji spelled out and common typos fixed.
  const q = fixTypos(`${typed} ${EMOJI.filter(([re]) => re.test(typed)).map(([, w]) => w).join(' ')}`.trim());
  const ex = ariExamples(l);
  if (!q || (GREET.test(q) && q.split(' ').length <= 3)) {
    return {
      reply: t(l, { en: 'Hi! I can order any Grab service for you: a ride, food, groceries, flowers, pharmacy or a parcel. What do you need?', ru: 'Здравствуйте! Я закажу любой сервис Grab: поездку, еду, продукты, цветы, товары из аптеки или посылку. Что нужно?', th: 'สวัสดีค่ะ Ari สั่งบริการของ Grab ให้ได้ทุกอย่าง ทั้งเรียกรถ สั่งอาหาร ของชำ ดอกไม้ ยาสามัญ หรือส่งพัสดุ ให้ Ari ช่วยอะไรดีคะ' }),
      chips: ex.slice(0, 4), trace,
    };
  }
  if (THANKS.test(q) && q.length < 40) {
    return { reply: t(l, { en: 'You\'re welcome! Anything else from Grab?', ru: 'Пожалуйста! Заказать в Grab что-нибудь ещё?', th: 'ยินดีค่ะ ต้องการอะไรจาก Grab อีกไหมคะ' }), chips: ex.slice(0, 3), trace };
  }
  if (HELP.test(q)) return { reply: t(l, HELP_TEXT), chips: ex.slice(0, 4), trace };
  // Refusals come first: no wording turns these into an order.
  if (RX.test(q)) {
    return say(l, {
      en: 'I can\'t order prescription medicines such as antibiotics: they need a doctor or a pharmacist. Here I can order household remedies only, for example paracetamol, plasters or throat lozenges.',
      ru: 'Рецептурные лекарства, например антибиотики, я не заказываю: для них нужен врач или фармацевт. Здесь доступны только безрецептурные товары: парацетамол, пластыри, леденцы от горла.',
      th: 'Ari สั่งยาที่ต้องมีใบสั่งแพทย์ เช่น ยาปฏิชีวนะ ให้ไม่ได้ค่ะ ต้องปรึกษาแพทย์หรือเภสัชกรก่อน ที่นี่ Ari สั่งได้เฉพาะยาสามัญประจำบ้าน เช่น พาราเซตามอล พลาสเตอร์ หรือยาอมแก้เจ็บคอค่ะ',
    }, PHARMACY_CHIPS.map((c) => t(l, c)), trace);
  }
  if (INJECT.test(q)) {
    return say(l, {
      en: 'I can\'t do that. My rules stay as they are, and I never confirm an order myself: an order is placed only when you tap Confirm on its card. What would you like from Grab?',
      ru: 'Так я не сделаю. Правила остаются в силе, и сама я заказы не подтверждаю: заказ оформляется только после вашего нажатия «Подтвердить» на карточке. Что заказать в Grab?',
      th: 'Ari ทำแบบนั้นไม่ได้ค่ะ กฎยังเหมือนเดิม และ Ari จะไม่ยืนยันคำสั่งซื้อเอง คำสั่งซื้อจะเกิดขึ้นเมื่อคุณแตะยืนยันบนการ์ดเท่านั้น ต้องการอะไรจาก Grab ดีคะ',
    }, ex.slice(0, 3), trace);
  }
  if (RESTRICTED.test(q)) {
    return say(l, {
      en: 'Sorry, I can\'t order that: alcohol, tobacco and other restricted goods are off limits for me. I can order food, groceries, flowers, a cake or pharmacy items, book a ride or send a parcel.',
      ru: 'Извините, это я не закажу: алкоголь, табак и другие товары с ограничениями мне недоступны. Могу заказать еду, продукты, цветы, торт или товары из аптеки, вызвать такси или отправить посылку.',
      th: 'ขออภัยค่ะ Ari สั่งสินค้านี้ให้ไม่ได้ เครื่องดื่มแอลกอฮอล์ บุหรี่ และสินค้าควบคุมอื่นๆ อยู่นอกเหนือสิ่งที่ Ari ทำได้ Ari สั่งอาหาร ของชำ ดอกไม้ เค้ก หรือยาสามัญ เรียกรถ หรือส่งพัสดุให้ได้ค่ะ',
    }, ex.slice(0, 3), trace);
  }
  const cues = serviceCues(q);
  if (EMERGENCY.test(q) && !cues.includes('ride')) {
    return say(l, {
      en: 'I can\'t call a doctor or an ambulance. In an emergency in Thailand call 1669. If it helps, I can order household remedies from a pharmacy or book a ride.',
      ru: 'Вызвать врача или скорую я не могу. В экстренном случае в Таиланде звоните 1669. Если нужно, закажу безрецептурные товары из аптеки или вызову такси.',
      th: 'Ari เรียกแพทย์หรือรถพยาบาลให้ไม่ได้ค่ะ หากเป็นเหตุฉุกเฉินในประเทศไทย โทร 1669 ได้เลย ถ้าต้องการ Ari สั่งยาสามัญจากร้านยาหรือเรียกรถให้ได้ค่ะ',
    }, [t(l, PHARMACY_CHIPS[0]), ex[0]], trace);
  }
  // A clock time or another day is not a place name: it is set aside before the route is read.
  const timed = q.replace(TIME, ' ').replace(/\s+/g, ' ').trim();
  const scheduled = timed !== q;
  const timeNote = scheduled
    ? t(l, { en: 'I can only order for right now: scheduling a time is not part of this demo. ', ru: 'Заказать могу только на сейчас: выбор времени в это демо не входит. ', th: 'Ari สั่งได้เฉพาะแบบทันทีค่ะ การนัดเวลาล่วงหน้ายังไม่มีในเดโมนี้ ' })
    : '';
  const noConfirmNote = NO_CONFIRM.test(q)
    ? t(l, { en: 'I can\'t skip the confirmation: nothing is ordered until you tap Confirm on the card. ', ru: 'Без подтверждения не получится: ничего не заказывается, пока вы не нажмёте «Подтвердить» на карточке. ', th: 'Ari ข้ามขั้นตอนยืนยันไม่ได้ค่ะ จะยังไม่มีการสั่งซื้อจนกว่าคุณจะแตะยืนยันบนการ์ด ' })
    : '';
  const lead = noConfirmNote + timeNote;
  const si = detectService(timed);
  try {
    if (TRACK.test(q) || (CANCEL.test(q) && q.length < 60)) return await latestOrderTurn(ctx, u, l, !TRACK.test(q), trace);
    if (REORDER.test(q) && q.length < 60) return await reorderTurn(ctx, u, l, trace);
    if (OOS_TABLE.test(q)) {
      return say(l, {
        en: 'I can\'t book a table, but I can have food delivered to you. For example:',
        ru: 'Столик забронировать не могу, зато могу заказать доставку еды. Например:',
        th: 'Ari จองโต๊ะให้ไม่ได้ค่ะ แต่สั่งอาหารมาส่งให้ได้ เช่น',
      }, [ex[1], t(l, { en: 'Vegan lunch for 3', ru: 'Веганский обед на троих', th: 'อาหารกลางวันวีแกนสำหรับ 3 คน' })], trace);
    }
    if (!cues.includes('ride') && OOS_FLIGHT.test(q)) {
      return say(l, {
        en: 'I can\'t book flights, but I can get you a ride to the airport:',
        ru: 'Авиабилеты я не бронирую, но могу вызвать такси до аэропорта:',
        th: 'Ari จองตั๋วเครื่องบินให้ไม่ได้ค่ะ แต่เรียกรถไปสนามบินให้ได้',
      }, [t(l, { en: 'Taxi to Suvarnabhumi Airport (BKK)', ru: 'Такси до аэропорта Суварнабхуми', th: 'แท็กซี่ไปสนามบินสุวรรณภูมิ' }), t(l, { en: 'Taxi to Don Mueang Airport (DMK)', ru: 'Такси до аэропорта Дон Муанг', th: 'แท็กซี่ไปสนามบินดอนเมือง' })], trace);
    }
    if (!cues.includes('ride') && OOS.test(q)) {
      return say(l, {
        en: 'That is outside what I can do here. I work with Grab services only: rides, food, groceries, flowers, pharmacy items, cakes and parcels. For example:',
        ru: 'Это за пределами того, что я умею здесь. Я работаю только с сервисами Grab: поездки, еда, продукты, цветы, аптека, торты и посылки. Например:',
        th: 'เรื่องนี้อยู่นอกเหนือสิ่งที่ Ari ทำได้ที่นี่ค่ะ Ari ดูแลเฉพาะบริการของ Grab ได้แก่ เรียกรถ อาหาร ของชำ ดอกไม้ ยาสามัญ เค้ก และส่งพัสดุ เช่น',
      }, ex.slice(0, 3), trace);
    }
    if (ADDRESS.test(q)) {
      return say(l, {
        en: 'Deliveries in this demo go to your saved home address (88 Sukhumvit Soi 24). Addresses are changed in the app settings, not in the chat. For a ride or a parcel just name the places:',
        ru: 'В этом демо доставка идёт на сохранённый домашний адрес (88 Sukhumvit Soi 24). Адреса меняются в настройках приложения, а не в чате. Для поездки или посылки просто назовите места:',
        th: 'ในเดโมนี้จะจัดส่งไปยังที่อยู่บ้านที่บันทึกไว้ (88 Sukhumvit Soi 24) ค่ะ การเปลี่ยนที่อยู่ทำได้ในหน้าตั้งค่าของแอป ไม่ใช่ในแชต ส่วนการเรียกรถหรือส่งพัสดุ บอกชื่อสถานที่ได้เลยค่ะ',
      }, [ex[0], ex[2]], trace);
    }
    if (!cues.length && !hasFoodCue(q)) {
      // Small talk and follow-ups that name no service.
      if (WHO.test(q)) {
        return say(l, {
          en: 'I\'m Ari, an AI assistant, not a human. In this demo I order Grab services for you through Unyly: you say what you need, I show a card with the price, and nothing is ordered until you confirm it.',
          ru: 'Я Ari, ИИ-ассистент, не человек. В этом демо я заказываю сервисы Grab через Unyly: вы говорите, что нужно, я показываю карточку с ценой, и без вашего подтверждения ничего не заказывается.',
          th: 'Ari เป็นผู้ช่วย AI ค่ะ ไม่ใช่คนจริง ในเดโมนี้ Ari สั่งบริการของ Grab ให้คุณผ่าน Unyly คุณบอกสิ่งที่ต้องการ Ari แสดงการ์ดพร้อมราคา และจะยังไม่สั่งอะไรจนกว่าคุณจะยืนยันค่ะ',
        }, ex.slice(0, 3), trace);
      }
      if (HOW_ARE_YOU.test(q)) {
        return say(l, { en: 'Doing well, thank you! What can I get you from Grab?', ru: 'Всё хорошо, спасибо! Что заказать в Grab?', th: 'สบายดีค่ะ ขอบคุณนะคะ ต้องการอะไรจาก Grab ดีคะ' }, ex.slice(0, 3), trace);
      }
      if (BYE.test(q)) {
        return say(l, { en: 'Goodbye! I\'m here whenever you need something from Grab.', ru: 'До свидания! Я на связи, когда понадобится что-нибудь из Grab.', th: 'ลาก่อนค่ะ ต้องการอะไรจาก Grab เมื่อไหร่ เรียก Ari ได้เสมอนะคะ' }, [], trace);
      }
      if (YES.test(q)) {
        return say(l, {
          en: 'A chat message can\'t confirm an order. If the card looks right, tap its Confirm button: that is the only way an order is placed. Nothing has been ordered so far.',
          ru: 'Сообщением в чате заказ подтвердить нельзя. Если на карточке всё верно, нажмите на ней «Подтвердить»: заказ оформляется только так. Пока ничего не заказано.',
          th: 'ข้อความในแชตใช้ยืนยันคำสั่งซื้อไม่ได้ค่ะ ถ้าการ์ดถูกต้องแล้ว แตะปุ่มยืนยันบนการ์ดได้เลย นี่เป็นวิธีเดียวที่จะสั่งซื้อ ตอนนี้ยังไม่มีการสั่งอะไรค่ะ',
        }, [], trace);
      }
      if (NO.test(q)) {
        return say(l, { en: 'No problem, nothing was ordered. Anything else from Grab?', ru: 'Хорошо, ничего не заказано. Нужно что-нибудь ещё из Grab?', th: 'ได้ค่ะ ยังไม่ได้สั่งอะไรนะคะ ต้องการอะไรจาก Grab อีกไหมคะ' }, ex.slice(0, 3), trace);
      }
      if (CHEAPER.test(q)) {
        return say(l, {
          en: 'On a ride or parcel card the cheapest option is listed first. For food, tell me your budget and I will stay within it:',
          ru: 'На карточке поездки или посылки самый дешёвый вариант идёт первым. Для еды назовите бюджет, и я в него уложусь:',
          th: 'บนการ์ดเรียกรถหรือส่งพัสดุ ตัวเลือกที่ถูกที่สุดจะอยู่บนสุดค่ะ ส่วนอาหาร บอกงบมาได้เลย Ari จะเลือกให้อยู่ในงบ',
        }, [t(l, { en: 'Dinner for two under 300 baht', ru: 'Ужин на двоих до 300 бат', th: 'มื้อเย็นสำหรับ 2 คน ไม่เกิน 300 บาท' }), t(l, { en: 'Lunch for one under 150 baht', ru: 'Обед на одного до 150 бат', th: 'อาหารกลางวันสำหรับ 1 คน ไม่เกิน 150 บาท' })], trace);
      }
      return { reply: t(l, UNKNOWN_TEXT), chips: ex.slice(0, 4), trace };
    }
    const two = twoRequests(timed);
    if (two) {
      return say(l, {
        en: 'That sounds like more than one request. I take them one at a time, so each gets its own card and its own confirmation. Which one first?',
        ru: 'Похоже, здесь несколько просьб. Я выполняю их по одной, чтобы у каждой была своя карточка и своё подтверждение. С чего начнём?',
        th: 'ดูเหมือนจะมีมากกว่าหนึ่งคำขอค่ะ Ari ทำทีละอย่าง เพื่อให้แต่ละรายการมีการ์ดและการยืนยันของตัวเอง เริ่มจากอันไหนก่อนดีคะ',
      }, two, trace);
    }
    if (si.service === 'ride' || si.service === 'express') {
      // The saved places are read once here and handed to the tool call below, which resolves pickup and drop-off against them.
      const places = await listAddresses(ctx.db, u.user_id);
      const addr = places.find((a) => a.is_default);
      // "Home" in any language is the saved default place, whatever language its label was saved in.
      const pickup = (si.pickup_home ? addr?.label : si.pickup) || addr?.label || '';
      if (si.dropoff_home && addr) si.dropoff = addr.label;
      if (si.dropoff_home && addr && pickup === addr.label) {
        // Home to home: the pickup is missing, not the destination.
        return si.service === 'express'
          ? { reply: t(l, { en: 'Where should the courier pick the parcel up? For example "from Siam Paragon".', ru: 'Откуда забрать посылку? Например, «от Сиам Парагона».', th: 'ให้ไปรับพัสดุที่ไหนคะ เช่น "จากสยามพารากอน"' }), chips: [t(l, { en: 'Send a parcel from Siam Paragon to home', ru: 'Отправить посылку от Сиам Парагона до дома', th: 'ส่งพัสดุจากสยามพารากอนไปบ้าน' })], trace }
          : { reply: t(l, { en: 'Where should I pick you up? For example "from Siam Paragon".', ru: 'Откуда вас забрать? Например, «от Сиам Парагона».', th: 'ให้ไปรับที่ไหนคะ เช่น "จากสยามพารากอน"' }), chips: [t(l, { en: 'Taxi from Siam Paragon to home', ru: 'Такси от Сиам Парагона до дома', th: 'แท็กซี่จากสยามพารากอนไปบ้าน' }), t(l, { en: 'Taxi from Suvarnabhumi airport to home', ru: 'Такси от аэропорта Суварнабхуми до дома', th: 'แท็กซี่จากสนามบินสุวรรณภูมิไปบ้าน' })], trace };
      }
      if (!si.dropoff) {
        if (si.service === 'express') {
          return { reply: t(l, { en: 'Where should the parcel go? For example "to ICONSIAM".', ru: 'Куда доставить посылку? Например, «в Айконсиам».', th: 'ส่งพัสดุไปที่ไหนคะ เช่น "ไปไอคอนสยาม"' }), chips: [ex[2]], trace };
        }
        return { reply: t(l, { en: 'Where to? For example "to Suvarnabhumi airport".', ru: 'Куда едем? Например, «до аэропорта Суварнабхуми».', th: 'ไปที่ไหนคะ เช่น "ไปสนามบินสุวรรณภูมิ"' }), chips: [ex[0], t(l, { en: 'Taxi to Siam Paragon', ru: 'Такси до Сиам Парагона', th: 'แท็กซี่ไปสยามพารากอน' })], trace };
      }
      const args: Record<string, unknown> = { service: si.service, pickup, dropoff: si.dropoff };
      // What the user said, for "did you mean" chips: home stays the word "home" in the chat language.
      const homeWord = t(l, { en: 'home', ru: 'дома', th: 'บ้าน' });
      const ask: TripAsk = { service: si.service, pickup: si.pickup_home ? homeWord : si.pickup, dropoff: si.dropoff_home ? homeWord : si.dropoff, weight_kg: si.weight_kg, passengers: si.passengers };
      if (si.service === 'ride' && si.passengers && si.passengers > MAX_SEATS) {
        // More people than the largest vehicle seats: say so instead of quietly offering a van that is too small.
        const half = Math.ceil(si.passengers / 2);
        return {
          reply: t(l, { en: `The largest vehicle here seats ${MAX_SEATS}, so your group needs two cars. I can book one car at a time:`, ru: `В самой большой машине ${MAX_SEATS} мест, поэтому вашей компании нужны две машины. Я заказываю по одной:`, th: `รถคันใหญ่ที่สุดนั่งได้ ${MAX_SEATS} คนค่ะ กลุ่มของคุณจึงต้องใช้สองคัน Ari จองได้ทีละคันค่ะ` }),
          chips: [placeChip(l, { ...ask, passengers: half }, 'dropoff', ask.dropoff ?? '')], trace,
        };
      }
      const fragile = si.service === 'express' && FRAGILE.test(q);
      if (si.service === 'express') args.parcel_weight_kg = si.weight_kg ?? 2;
      if (fragile) args.parcel_description = t(l, { en: 'Fragile', ru: 'Хрупкое', th: 'ของแตกง่าย' });
      if (si.passengers) args.passengers = si.passengers;
      const r = await traced(trace, `POST ${base}/tools/estimate_trip`, grabFor('estimate_trip', args), () => runTool(ctx, P, u, 'estimate_trip', args, { addresses: places }));
      if (!r.ok) return errorTurn(l, r.error, trace, ask);
      const res = r.result;
      const from = res.trip?.pickup?.name;
      const to = res.trip?.dropoff?.name;
      // The reply has to say what the card shows: when no vehicle can take the trip, say why.
      if (r.card?.options?.length && r.card.options.every((o) => !o.action)) {
        const maxKg = Math.max(0, ...(res.options ?? []).map((o: any) => Number(o.max_weight_kg) || 0));
        const maxSeats = Math.max(0, ...(res.options ?? []).map((o: any) => Number(o.seats) || 0));
        const why = si.service === 'express'
          ? t(l, { en: `A ${args.parcel_weight_kg} kg parcel is too heavy: the largest vehicle here carries up to ${maxKg} kg. Try a lighter parcel or split it.`, ru: `Посылка ${args.parcel_weight_kg} кг слишком тяжёлая: самая большая машина берёт до ${maxKg} кг. Уменьшите вес или разделите посылку.`, th: `พัสดุ ${args.parcel_weight_kg} กก. หนักเกินไปค่ะ รถคันใหญ่ที่สุดรับได้ไม่เกิน ${maxKg} กก. ลองลดน้ำหนักหรือแบ่งส่งนะคะ` })
          : t(l, { en: `No vehicle here takes ${si.passengers ?? ''} passengers: the largest seats ${maxSeats}. Try a smaller group or two cars.`, ru: `Машины на ${si.passengers ?? ''} пассажиров нет: в самой большой мест ${maxSeats}. Попробуйте меньшую компанию или две машины.`, th: `ไม่มีรถที่รับผู้โดยสาร ${si.passengers ?? ''} คนได้ค่ะ คันใหญ่ที่สุดนั่งได้ ${maxSeats} คน ลองแบ่งเป็นสองคันนะคะ` });
        return { reply: why, card: r.card, trace };
      }
      const weightGuess = si.service === 'express' && !si.weight_kg
        ? t(l, { en: ' I assumed 2 kg; tell me the weight if it is heavier.', ru: ' Вес я приняла за 2 кг; если посылка тяжелее, назовите вес.', th: ' Ari ประมาณน้ำหนักไว้ที่ 2 กก. ถ้าหนักกว่านี้บอกน้ำหนักได้เลยค่ะ' })
        : '';
      const fragileNote = fragile ? t(l, { en: ' I marked it as fragile for the courier.', ru: ' Пометила для курьера, что посылка хрупкая.', th: ' Ari แจ้งไรเดอร์ไว้แล้วว่าเป็นของแตกง่ายค่ะ' }) : '';
      const group = si.service === 'ride' && si.passengers && si.passengers > 1
        ? t(l, { en: ` Cars that seat ${si.passengers} are on top.`, ru: ` Машины на ${si.passengers} пассажиров идут первыми.`, th: ` รถที่นั่งได้ ${si.passengers} คนอยู่ด้านบนค่ะ` })
        : '';
      const reply = si.service === 'ride'
        ? t(l, { en: `From ${from} to ${to}, about ${res.trip?.drive_minutes_estimate} min.${group} Pick a ride:`, ru: `Маршрут: ${from} → ${to}, примерно ${res.trip?.drive_minutes_estimate} мин в пути.${group} Выберите машину:`, th: `จาก ${from} ไป ${to} ประมาณ ${res.trip?.drive_minutes_estimate} นาที${group} เลือกประเภทรถได้เลยค่ะ` })
        : t(l, { en: `Parcel ${args.parcel_weight_kg} kg from ${from} to ${to}.${weightGuess}${fragileNote} Pick a courier:`, ru: `Посылка ${args.parcel_weight_kg} кг: ${from} → ${to}.${weightGuess}${fragileNote} Выберите курьера:`, th: `พัสดุ ${args.parcel_weight_kg} กก. จาก ${from} ไป ${to}${weightGuess}${fragileNote} เลือกประเภทการส่งได้เลยค่ะ` });
      return { reply: lead + reply, card: r.card, trace };
    }
    if (si.service === 'food') {
      // Nothing in the sentence names a service or a meal: say what Ari can do instead of guessing restaurants.
      if (!hasFoodCue(q)) return { reply: t(l, UNKNOWN_TEXT), chips: ex.slice(0, 4), trace };
      return await foodTurn(ctx, u, l, q, typed, lead, trace);
    }
    // Shops: pick the items from the sentence, then build the cart (one step, like an assistant would).
    const service = si.service as keyof typeof SHOP_STORE;
    const picks = shopPicks(service, q);
    // A pharmacy or a supermarket request that names nothing the store carries: ask, never put a default medicine in the cart.
    if (!picks.matched && service === 'pharmacy') return say(l, PHARMACY_LIST, PHARMACY_CHIPS.map((c) => t(l, c)), trace);
    if (!picks.matched && service === 'groceries') {
      return say(l, {
        en: 'What should I put in the basket? The demo supermarket has rice, eggs, milk, water, bananas, mango, chicken, instant noodles, coffee and vegetables.',
        ru: 'Что положить в корзину? В демо-супермаркете есть рис, яйца, молоко, вода, бананы, манго, курица, лапша быстрого приготовления, кофе и овощи.',
        th: 'ให้ใส่อะไรในตะกร้าดีคะ ซูเปอร์มาร์เก็ตในเดโมมีข้าวสาร ไข่ไก่ นมสด น้ำดื่ม กล้วย มะม่วง อกไก่ บะหมี่กึ่งสำเร็จรูป กาแฟ และผักค่ะ',
      }, [ex[5], t(l, { en: 'Milk and bananas', ru: 'Молоко и бананы', th: 'นมสดกับกล้วย' })], trace);
    }
    const plan = await traced(trace, `POST ${base}/tools/search_stores`, grabFor('search_stores', {}), () => shopPlan(ctx, partnerActor(P, u.user_id), service, q));
    const args = { store_id: plan.store_id, items: plan.lines.map((x) => ({ item_id: x.item_id, quantity: x.quantity, ...(x.modifiers.length ? { modifiers: x.modifiers } : {}) })) };
    const r = await traced(trace, `POST ${base}/tools/create_cart`, grabFor('create_cart', args), () => runTool(ctx, P, u, 'create_cart', args));
    if (!r.ok) return errorTurn(l, r.error, trace);
    const names = plan.lines.map((x) => `${x.quantity > 1 ? `${x.quantity}× ` : ''}${x.name}`).join(', ');
    const notes: string[] = [];
    if (!picks.matched && service === 'flowers') notes.push(t(l, { en: 'I picked the seasonal bouquet; say roses, lilies or orchids if you prefer.', ru: 'Я выбрала сезонный букет; если хотите розы, лилии или орхидею, скажите.', th: 'Ari เลือกช่อดอกไม้ตามฤดูกาลให้ค่ะ ถ้าอยากได้กุหลาบ ลิลลี่ หรือกล้วยไม้ บอกได้เลยนะคะ' }));
    if (!picks.matched && service === 'cakes') notes.push(t(l, { en: 'I picked the chocolate cake; there is also a birthday cake, a pandan chiffon and a mango cheesecake.', ru: 'Я выбрала шоколадный торт; ещё есть торт на день рождения, пандановый шифон и манговый чизкейк.', th: 'Ari เลือกเค้กช็อกโกแลตให้ค่ะ นอกจากนี้ยังมีเค้กวันเกิด ชิฟฟ่อนใบเตย และชีสเค้กมะม่วง' }));
    for (const x of plan.lines) {
      if (x.limited_from) notes.push(t(l, { en: `The store sells at most ${x.quantity} of ${x.name} per order, so I set ${x.quantity} instead of ${x.limited_from}.`, ru: `Магазин продаёт не больше ${x.quantity} шт. «${x.name}» в одном заказе, поэтому вместо ${x.limited_from} я поставила ${x.quantity}.`, th: `ร้านขาย ${x.name} ได้ไม่เกิน ${x.quantity} ชิ้นต่อคำสั่งซื้อ Ari จึงใส่ ${x.quantity} แทน ${x.limited_from} ค่ะ` }));
    }
    if (service === 'groceries' && /\d/.test(typed)) notes.push(t(l, { en: 'Items come in store packs, one of each: check the sizes on the card.', ru: 'Товары идут упаковками магазина, по одной каждого: проверьте объёмы на карточке.', th: 'สินค้าเป็นแพ็กตามที่ร้านขาย อย่างละ 1 รายการ ตรวจขนาดบนการ์ดได้เลยค่ะ' }));
    if (GIFT.test(q)) {
      const home = r.card?.subtitle ?? '';
      notes.push(t(l, { en: `It will be delivered to your saved address (${home}): sending to someone else's address is not part of this chat demo.`, ru: `Доставка будет на ваш сохранённый адрес (${home}): отправка на чужой адрес в это демо не входит.`, th: `รายการนี้จะจัดส่งไปยังที่อยู่ที่คุณบันทึกไว้ (${home}) ค่ะ การส่งไปยังที่อยู่ของผู้อื่นยังไม่มีในเดโมแชตนี้` }));
    }
    const extra = notes.length ? ` ${notes.join(' ')}` : '';
    return {
      reply: lead + t(l, { en: `${plan.store_name}: ${names}.${extra} Here is the total with every fee. Confirm when ready.`, ru: `${plan.store_name}: ${names}.${extra} Вот итог со всеми сборами. Подтвердите, когда будете готовы.`, th: `${plan.store_name}: ${names}${extra} นี่คือยอดรวมที่รวมค่าธรรมเนียมทุกรายการแล้ว แตะยืนยันเมื่อพร้อมนะคะ` }),
      card: r.card, trace,
    };
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return errorTurn(l, { code: e.code, message: e.message, details: e.details }, trace, { service: si.service });
  }
}

const DIET_NAME: Record<string, Tri> = {
  halal: { en: 'halal', ru: 'халяль', th: 'ฮาลาล' },
  no_pork: { en: 'pork-free', ru: 'без свинины', th: 'ไม่มีหมู' },
};
/** The largest demo vehicle (GrabVan). */
const MAX_SEATS = 10;
const BADGE_BUDGET: Tri = { en: 'Within budget', ru: 'В бюджете', th: 'อยู่ในงบ' };
const BADGE_ALLERGEN: Tri = { en: 'Excluded allergens not declared', ru: 'Исключённые аллергены не заявлены', th: 'ร้านไม่ได้ระบุสารก่อภูมิแพ้ที่ยกเว้น' };

/** A food request: restaurants for the party and budget, or the named dish when the demo menus have it. */
async function foodTurn(ctx: Ctx, u: PartnerUser, l: Locale, q: string, typed: string, lead: string, trace: TraceEntry[]): Promise<AriTurn> {
  const base = `/partner/v1/users/${u.external_user_id}`;
  const intent = parseIntent(q);
  const found = findDish(q, intent);
  const dishFits = !!found?.fits.length;
  // A named dish is one portion unless the sentence says for how many; a general request assumes two and says so.
  const people = intent.party_size ?? (dishFits ? 1 : 2);
  const dishName = found ? t(l, found.dish.name) : '';
  // Why the named dish is not offered, when it is not.
  let dishNote = '';
  if (found && !found.all.length) {
    dishNote = t(l, { en: `There is no ${dishName} in the demo catalog. `, ru: `В демо-каталоге нет позиции «${dishName}». `, th: `ในแคตตาล็อกเดโมยังไม่มี${dishName}ค่ะ ` });
  } else if (found && !found.open.length) {
    const s = found.all[0].store;
    dishNote = t(l, { en: `${cap(dishName)} is on the menu at ${s.name}, but it is closed right now. `, ru: `${cap(dishName)} есть в ${s.name}, но сейчас там закрыто. `, th: `${s.name} มี${dishName} แต่ตอนนี้ร้านปิดอยู่ค่ะ ` });
  } else if (found && !found.fits.length) {
    const h = found.open[0];
    dishNote = t(l, { en: `${h.item.name} at ${h.store.name} does not fit your restrictions, so I left it out. `, ru: `${h.item.name} из ${h.store.name} не подходит под ваши ограничения, поэтому я это блюдо не предлагаю. `, th: `${h.item.name} ของร้าน ${h.store.name} ไม่ตรงกับเงื่อนไขของคุณ Ari จึงไม่ได้เสนอเมนูนี้ค่ะ ` });
  }
  const args: Record<string, unknown> = {
    service: 'food', limit: dishFits ? 10 : 3, party_size: people,
    ...(intent.budget_total_major ? { budget_total_major: intent.budget_total_major } : {}),
    ...(intent.exclude_allergens.length ? { exclude_allergens: intent.exclude_allergens } : {}),
    ...(intent.dietary.length ? { dietary: intent.dietary } : {}),
    // A cuisine filter would hide everything when the only place for the named dish is closed.
    ...(intent.cuisine && !(found && !found.open.length) ? { cuisine: intent.cuisine } : {}),
  };
  const r = await traced(trace, `POST ${base}/tools/search_stores`, grabFor('search_stores', args), () => runTool(ctx, P, u, 'search_stores', args));
  if (!r.ok) return errorTurn(l, r.error, trace);
  const budget = args.budget_total_major ? ` ${t(l, { en: `under ฿${args.budget_total_major}`, ru: `до ${args.budget_total_major} бат`, th: `ไม่เกิน ${args.budget_total_major} บาท` })}` : '';
  const allergy = intent.exclude_allergens.length
    ? t(l, { en: ' Restaurants did not declare the allergens you excluded, but I never mark a dish as safe.', ru: ' Рестораны не заявили исключённые аллергены, но я никогда не называю блюдо безопасным.', th: ' ร้านไม่ได้ระบุว่ามีสารก่อภูมิแพ้ที่คุณยกเว้น แต่ Ari ไม่รับรองว่าเมนูใดปลอดภัยนะคะ' })
    : '';
  if (dishFits && r.card?.options) {
    // The named dish, priced with delivery and fees, at every open restaurant that has it.
    const addr = (await listAddresses(ctx.db, u.user_id)).find((a) => a.is_default);
    const provider = ctx.provider('demo');
    const hot = /spicy|extra hot|остр|เผ็ด/iu.test(q) && !/not (?:too )?spicy|no spic|mild|не остр|неостр|ไม่เผ็ด/iu.test(q);
    const mild = /not (?:too )?spicy|no spic|mild|не остр|неостр|ไม่เผ็ด/iu.test(q);
    const options: CardOption[] = [];
    for (const { store, item } of found!.fits) {
      const opt = r.card.options.find((o) => o.id === store.id);
      if (!opt?.action || !addr) continue;
      // A required choice nobody named (spice level): the middle option, or what the sentence says.
      const modifiers = item.modifier_groups.filter((g) => g.min_select > 0).map((g) => {
        const free = g.options.filter((o) => o.available);
        const pick = (g.id === 'spice' ? free.find((o) => o.id === (hot ? 'hot' : mild ? 'mild' : 'medium')) : undefined) ?? free[0];
        return { group_id: g.id, option_ids: pick ? [pick.id] : [] };
      });
      const items = [{ item_id: item.id, quantity: people, ...(modifiers.length ? { modifiers } : {}) }];
      const quote = await callProvider(() => provider.quote({ restaurant_id: store.id, lines: [{ line_id: item.id, item_id: item.id, name: item.name, quantity: people, modifiers }], address: toDeliveryAddress(addr) }));
      if (quote.issues.length) continue;
      const within = args.budget_total_major ? quote.total_minor <= Math.round(Number(args.budget_total_major) * 100) : null;
      const declared = item.allergen_info?.status === 'declared_by_restaurant';
      options.push({
        ...opt,
        subtitle: `${people}× ${item.name}`,
        price: money(quote.total_minor, quote.currency, l).formatted,
        badges: [...(within ? [t(l, BADGE_BUDGET)] : []), ...(intent.exclude_allergens.length && declared ? [t(l, BADGE_ALLERGEN)] : [])],
        action: { ...opt.action, tool: { name: 'create_cart', arguments: { store_id: store.id, items } } },
      });
    }
    if (options.length) {
      const first = options[0];
      const over = args.budget_total_major && !options.some((o) => o.badges?.includes(t(l, BADGE_BUDGET)))
        ? t(l, { en: ` That is above your ฿${args.budget_total_major} budget.`, ru: ` Это выше вашего бюджета ${args.budget_total_major} бат.`, th: ` ราคานี้เกินงบ ${args.budget_total_major} บาทของคุณค่ะ` })
        : '';
      const portions = t(l, { en: `${people} ${people === 1 ? 'portion' : 'portions'}`, ru: `порций: ${people}`, th: `${people} ที่` });
      const reply = t(l, {
        en: `Found it: ${first.subtitle?.replace(/^\d+× /, '')} at ${first.title}, ${portions}, ${first.price} with delivery.${over}${allergy} Tap Choose to see every fee:`,
        ru: `Нашла: ${first.subtitle?.replace(/^\d+× /, '')} в ${first.title}, ${portions}, ${first.price} с доставкой.${over}${allergy} Нажмите «Выбрать», чтобы увидеть все сборы:`,
        th: `เจอแล้วค่ะ ${first.subtitle?.replace(/^\d+× /, '')} จากร้าน ${first.title} จำนวน ${portions} ราคา ${first.price} รวมค่าส่ง${over}${allergy} แตะเลือกเพื่อดูค่าธรรมเนียมทั้งหมดได้เลยค่ะ`,
      });
      return { reply: lead + reply, card: { ...r.card, options }, chips: intent.party_size ? undefined : partyChips(l, typed, people), trace };
    }
  }
  const n = (r.card?.options ?? []).filter((o) => o.action).length;
  const fits = (r.result?.stores ?? []).some((s: any) => s.suggestion?.within_budget === true);
  // A diet nobody in the catalog declares (halal, pork-free): say that, not "try a bigger budget".
  const unmet = intent.dietary.filter((d) => d === 'halal' || d === 'no_pork').map((d) => t(l, DIET_NAME[d])).join(', ');
  const tail = n && args.budget_total_major && !fits
    ? t(l, { en: `Nothing fits ฿${args.budget_total_major} for ${people}. These are the closest options:`, ru: `В ${args.budget_total_major} бат на ${people} чел. уложиться не получится. Вот самые близкие варианты:`, th: `ยังไม่มีร้านที่อยู่ในงบ ${args.budget_total_major} บาทสำหรับ ${people} คนค่ะ นี่คือตัวเลือกที่ใกล้เคียงที่สุดค่ะ` })
    : n
    ? t(l, { en: `${n} ${n === 1 ? 'option' : 'options'} for ${people}${budget}.${allergy} Tap one:`, ru: `Вариантов: ${n} (на ${people} чел.${budget}).${allergy} Выберите:`, th: `${n} ตัวเลือกสำหรับ ${people} คน${budget}${allergy} เลือกได้เลยค่ะ` })
    : unmet
    ? t(l, { en: `Nothing matches: no restaurant in the demo catalog declares its dishes as ${unmet}, and I never guess about that. Try the request without it.`, ru: `Ничего не подходит: ни один ресторан в демо-каталоге не заявляет блюда как «${unmet}», а гадать я не буду. Попробуйте без этого условия.`, th: `ยังไม่มีร้านที่ตรงเงื่อนไขค่ะ ในแคตตาล็อกเดโมไม่มีร้านไหนระบุว่าเมนูเป็น${unmet} และ Ari จะไม่เดาเรื่องนี้ ลองสั่งโดยไม่ใส่เงื่อนไขนี้ดูนะคะ` })
    : t(l, { en: 'Nothing matches right now. Try a bigger budget or fewer restrictions.', ru: 'Сейчас ничего не подходит. Попробуйте увеличить бюджет или убрать ограничения.', th: 'ตอนนี้ยังไม่มีร้านที่ตรงกับเงื่อนไขค่ะ ลองเพิ่มงบหรือลดเงื่อนไขดูนะคะ' });
  // No selectable restaurant: a card of greyed-out rows would only confuse.
  const chips = !n ? ariExamples(l).slice(1, 2) : intent.party_size ? undefined : partyChips(l, typed, people);
  return { reply: lead + (n ? dishNote : '') + tail, card: n ? r.card : null, chips, trace };
}

/** The party size was a guess: one tap repeats the request for one or for four. */
function partyChips(l: Locale, typed: string, now: number): string[] | undefined {
  const s = typed.replace(/[.!?。]+$/u, '').trim();
  if (!s || s.length > 60) return undefined;
  const one = (n: number) => t(l, { en: `${s}, for ${n}`, ru: `${s}, на ${n} ${n === 1 ? 'человека' : 'человек'}`, th: `${s} สำหรับ ${n} คน` });
  return [now === 1 ? 2 : 1, 4].map(one);
}

function errorTurn(l: Locale, err: any, trace: TraceEntry[], ask?: TripAsk): AriTurn {
  const code = err?.code;
  if (code === 'PLACE_NOT_FOUND' || code === 'PLACE_AMBIGUOUS') {
    const field: string | undefined = err.details?.field;
    const said = (field === 'pickup' ? ask?.pickup : ask?.dropoff) ?? '';
    // A suggestion that is the other end of the trip would be a trip from a place to itself.
    const otherSaid = field === 'pickup' ? ask?.dropoff : ask?.pickup;
    const other = otherSaid ? resolvePlace(otherSaid) : null;
    const sug: string[] = (err.details?.suggestions ?? []).filter((s: string) => !(other?.ok && other.place.name === s)).slice(0, 4);
    const airports = sug.length > 0 && sug.every((s) => /airport/i.test(s));
    const shown = said.length > 40 ? `${said.slice(0, 40)}…` : said;
    const reply = code === 'PLACE_AMBIGUOUS'
      ? airports
        ? t(l, { en: 'Bangkok has two airports. Which one?', ru: 'В Бангкоке два аэропорта. Какой нужен?', th: 'กรุงเทพฯ มีสนามบินสองแห่งค่ะ หมายถึงที่ไหนคะ' })
        : t(l, { en: 'Which one do you mean?', ru: 'Какое место вы имеете в виду?', th: 'หมายถึงที่ไหนคะ' })
      : OUTSIDE.test(said)
      ? t(l, { en: `"${shown}" is outside the demo area: rides and parcels here run within Bangkok only. Try one of these:`, ru: `«${shown}» за пределами демо-зоны: поездки и посылки здесь только по Бангкоку. Например:`, th: `"${shown}" อยู่นอกพื้นที่เดโมค่ะ ที่นี่เรียกรถและส่งพัสดุได้เฉพาะในกรุงเทพฯ ลองเลือกจากรายการนี้นะคะ` })
      : shown
      ? t(l, { en: `I could not find "${shown}" on the Bangkok demo map. Try one of these:`, ru: `Не нашла «${shown}» на демо-карте Бангкока. Например:`, th: `Ari หา "${shown}" บนแผนที่เดโมของกรุงเทพฯ ไม่พบค่ะ ลองเลือกจากรายการนี้นะคะ` })
      : t(l, { en: 'I could not find that place on the Bangkok demo map. Try one of these:', ru: 'Не нашла это место на демо-карте Бангкока. Например:', th: 'Ari หาสถานที่นี้บนแผนที่เดโมของกรุงเทพฯ ไม่พบค่ะ ลองเลือกจากรายการนี้นะคะ' });
    return { reply, chips: sug.map((s) => placeChip(l, ask, field, s)), trace };
  }
  // Protocol-level text (argument validation) is for developers, not for the chat.
  const msg = String(err?.message ?? '');
  const known = /^MCP error/.test(msg) ? undefined : localText(msg, l);
  // English provider text has no place in a Russian or Thai chat: fall back to the general sentence.
  const fits = known && (l === 'en' || known !== msg);
  return { reply: (fits ? known : undefined) ?? t(l, { en: 'Something went wrong. Please try again.', ru: 'Что-то пошло не так. Попробуйте ещё раз.', th: 'เกิดข้อผิดพลาด กรุณาลองอีกครั้งค่ะ' }), chips: ariExamples(l).slice(0, 3), trace };
}

// ---------------------------------------------------------------- HTTP

const sealExt = (ctx: Ctx, ext: string) => `${ext}.${hmac(`${ctx.cfg.demoWebhookSecret}:ari-demo`, ext).slice(0, 32)}`;
function openExt(ctx: Ctx, v: string | undefined): string | null {
  if (!v) return null;
  const i = v.lastIndexOf('.');
  if (i < 0) return null;
  const ext = v.slice(0, i);
  return /^web-[0-9a-f-]{36}$/.test(ext) && safeEqual(sealExt(ctx, ext), v) ? ext : null;
}

async function createDemoUser(ctx: Ctx, ip: string, locale: Locale): Promise<PartnerUser> {
  const ipHash = hmac(ctx.cfg.demoWebhookSecret, `guest-ip:${ip}`).slice(0, 32);
  // Count and create under one lock so parallel requests cannot exceed the per-IP and global caps.
  // The user and the demo home address are written in the same transaction (one BEGIN/COMMIT).
  const u = await ctx.db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext('unyly.guest_create'))");
    const c = (await q.query(
      `SELECT count(*)::int total, count(*) FILTER (WHERE guest_ip_hash = $1)::int mine FROM users WHERE is_guest AND created_at > now() - interval '1 hour'`,
      [ipHash],
    )).rows[0];
    if (c.mine >= ctx.cfg.guestPerIpHourly || c.total >= ctx.cfg.guestHourlyLimit) return null;
    // Same lifetime as other demo guests: deleted after 24 hours by the job worker.
    // A new random id: nothing to look up or lock for it (the unique key still guards the insert).
    const created = await upsertPartnerUser(ctx, P, `web-${randomUUID()}`, { locale }, { q, guestIpHash: ipHash, fresh: true });
    await addFirstAddress(q, created.user_id, demoHome(locale));
    return created;
  });
  if (!u) throw new DomainError('RATE_LIMITED', 'The demo is busy right now. Please try again in a few minutes.');
  return u;
}

function demoHome(locale: Locale) {
  return ({
    label: tr(locale, { ru: 'Дом', en: 'Home', th: 'บ้าน' }), line1: '88 Sukhumvit Soi 24 (demo)', district: 'Watthana', city: 'Bangkok', country: 'TH',
  });
}

/** The demo user of a sealed cookie value, or null when it no longer exists. Database errors are not "no user": they propagate. */
async function demoUser(ctx: Ctx, ext: string): Promise<PartnerUser | null> {
  try {
    return await loadPartnerUser(ctx, P, ext);
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

export function registerAriDemo(app: FastifyInstance, ctx: Ctx, detectLocale: (req: FastifyRequest) => Locale) {
  const guard = (req: FastifyRequest) => {
    // JSON API for our own page only: custom header (forces a CORS preflight cross-site) plus same origin.
    if (req.headers['x-ari-demo'] !== '1') throw new DomainError('AUTH_REQUIRED', 'Cross-site request blocked');
    const origin = req.headers.origin;
    if (origin && origin !== ctx.cfg.webOrigin) throw new DomainError('AUTH_REQUIRED', 'Cross-site request blocked');
  };
  const send = (reply: FastifyReply, data: unknown, status = 200) => reply.code(status).header('cache-control', 'no-store').send(data);
  const fail = (reply: FastifyReply, e: unknown) => {
    const err = isDomainError(e) ? e : new DomainError('INTERNAL', 'Something went wrong. Please try again.');
    if (!isDomainError(e)) console.error('[ari-demo]', e);
    return send(reply, { ok: false, error: { code: err.code, message: err.message, details: err.details } }, err.httpStatus);
  };
  const current = async (req: FastifyRequest): Promise<PartnerUser> => {
    const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
    if (!ext) throw new DomainError('AUTH_REQUIRED', 'Start the demo first.');
    const u = await demoUser(ctx, ext);
    if (!u) throw new DomainError('AUTH_REQUIRED', 'The demo session ended. Start again.');
    const l = detectLocale(req);
    if (l !== u.locale) {
      await ctx.db.query('UPDATE users SET locale = $2 WHERE id = $1', [u.user_id, l]);
      u.locale = l;
      if (u.row) u.row.locale = l;
    }
    return u;
  };
  const rl = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.post('/ari/api/session', rl(60), async (req, reply) => {
    try {
      guard(req);
      const l = detectLocale(req);
      let u: PartnerUser | null = null;
      const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
      if (ext) u = await demoUser(ctx, ext);
      if (!u) {
        u = await createDemoUser(ctx, req.ip, l);
        reply.setCookie(COOKIE, sealExt(ctx, u.external_user_id), { httpOnly: true, secure: ctx.cfg.cookieSecure, sameSite: 'lax', path: '/ari', maxAge: 24 * 3600 });
      }
      // A user created by this request has no Grab link and no events yet; for a returning one both are read together.
      const [grab, lastEvent] = u.created
        ? [{ linked: false, linked_at: null, simulated: false }, 0]
        : await Promise.all([grabLinkStatus(ctx, u), lastPartnerEventSeq(ctx, u.user_id)]);
      return send(reply, {
        ok: true, user: { id: u.external_user_id }, grab, examples: ariExamples(l), last_event: lastEvent,
        greeting: tr(l, { en: 'Hi, I\'m Ari. Tell me what you need from Grab and I\'ll take care of it. Nothing is ordered until you confirm.', ru: 'Здравствуйте, я Ari. Скажите, что нужно от Grab, и я всё сделаю. Ничего не заказывается без вашего подтверждения.', th: 'สวัสดีค่ะ Ari เองค่ะ บอกได้เลยว่าต้องการอะไรจาก Grab เดี๋ยว Ari จัดการให้ และจะยังไม่สั่งอะไรจนกว่าคุณจะยืนยันค่ะ' }),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/message', rl(90), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const text = String((req.body as any)?.text ?? '');
      return send(reply, { ok: true, ...(await ariRespond(ctx, u, text)) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/action', rl(90), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body ?? {}) as any;
      const name = String(b.tool ?? '');
      if (!ALLOWED_TOOLS.has(name)) throw new DomainError('VALIDATION_FAILED', 'Unknown action');
      const args = b.arguments && typeof b.arguments === 'object' ? b.arguments : {};
      const trace: TraceEntry[] = [];
      const r = await traced(trace, `POST /partner/v1/users/${u.external_user_id}/tools/${name}`, grabFor(name, args), () => runTool(ctx, P, u, name, args));
      if (!r.ok) return send(reply, { ok: true, ...errorTurn(cardLocale(u.locale), r.error, trace) });
      const l = cardLocale(u.locale);
      const reply2 = r.card?.type === 'checkout'
        ? tr(l, { en: 'Here is everything with the final price. Tap Confirm when you are ready.', ru: 'Вот всё с итоговой ценой. Нажмите «Подтвердить», когда будете готовы.', th: 'นี่คือรายละเอียดทั้งหมดพร้อมราคาสุทธิ แตะยืนยันเมื่อพร้อมนะคะ' })
        : '';
      return send(reply, { ok: true, reply: reply2, card: r.card, trace });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/confirm', rl(60), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body ?? {}) as any;
      const id = String(b.checkout_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Checkout not found');
      const trace: TraceEntry[] = [];
      const r = await traced(trace, `POST /partner/v1/users/${u.external_user_id}/checkouts/${id}/confirm`, null, () => confirmCheckout(ctx, P, u, id, {
        confirm_hash: b.confirm_hash, user_verification: 'biometric', confirmed_at: ctx.clock.now().toISOString(), device_id: 'web-demo',
      }));
      // The service for the trace line comes from the order card of the result; only when there is no order yet is it looked up.
      const service = r.order?.card.service
        ?? (await ctx.db.query('SELECT k.service FROM checkouts c JOIN carts k ON k.id = c.cart_id WHERE c.id = $1 AND c.user_id = $2', [id, u.user_id])).rows[0]?.service;
      trace[0].grab = service === 'express' ? 'GrabPay · charge/init + GrabExpress · POST /v1/deliveries' : service === 'ride' ? 'Ride booking scope (requested) · today: Grab deep link' : 'GrabFood / GrabMart order scope (requested)';
      const l = cardLocale(u.locale);
      return send(reply, {
        ok: true,
        reply: tr(l, { en: 'Done! I\'ll keep you posted and call you when it matters.', ru: 'Готово! Буду сообщать о статусе и позвоню, когда будет важно.', th: 'เรียบร้อยค่ะ Ari จะคอยแจ้งสถานะ และโทรหาเมื่อถึงจังหวะสำคัญนะคะ' }),
        card: r.order?.card ?? null, order_id: r.order?.id ?? null, trace,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/decline', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const id = String((req.body as any)?.checkout_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Checkout not found');
      await declineCheckoutPartner(ctx, P, u, id);
      return send(reply, { ok: true, reply: tr(cardLocale(u.locale),{ en: 'No problem, nothing was ordered.', ru: 'Хорошо, ничего не заказано.', th: 'ได้ค่ะ ยังไม่ได้สั่งอะไรนะคะ' }), card: await checkoutCard(ctx, P, u, id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/ari/api/orders/:id', rl(240), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const id = String((req.params as any).id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Order not found');
      return send(reply, { ok: true, card: await orderCard(ctx, P, u, id, { refresh: true }) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/ari/api/events', rl(240), async (req, reply) => {
    try {
      guard(req);
      // The poll: the user check and the events in one statement.
      const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
      if (!ext) throw new DomainError('AUTH_REQUIRED', 'Start the demo first.');
      const after = Math.max(Number((req.query as any)?.after ?? 0) || 0, 0);
      const events = await listPartnerEventsFor(ctx, P.id, ext, after);
      if (!events) throw new DomainError('AUTH_REQUIRED', 'The demo session ended. Start again.');
      return send(reply, { ok: true, events });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/cancel', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const id = String((req.body as any)?.order_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Order not found');
      const r = await prepareCancelPartner(ctx, P, u, id);
      return send(reply, { ok: true, reply: tr(cardLocale(u.locale),{ en: 'Here are the cancellation terms:', ru: 'Условия отмены:', th: 'นี่คือเงื่อนไขการยกเลิกค่ะ' }), card: r.card });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/cancel/confirm', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body ?? {}) as any;
      const id = String(b.cancellation_id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Cancellation not found');
      const r = await confirmCancelPartner(ctx, P, u, id, { confirm_hash: b.confirm_hash, user_verification: 'tap', confirmed_at: ctx.clock.now().toISOString() });
      const done = r.cancellation.status === 'executed';
      return send(reply, {
        ok: true,
        reply: done
          ? tr(cardLocale(u.locale),{ en: 'Cancelled.', ru: 'Заказ отменён.', th: 'ยกเลิกแล้วค่ะ' })
          : tr(cardLocale(u.locale),{ en: 'The cancellation did not go through; the order continues.', ru: 'Отменить не получилось, заказ продолжается.', th: 'ยกเลิกไม่สำเร็จค่ะ คำสั่งซื้อยังดำเนินต่อ' }),
        card: r.order.card,
        cancel_card: await cancellationCard(ctx, P, u, id),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/ari/api/grab-link', rl(10), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const r = await startGrabLink(ctx, P, u);
      return send(reply, { ok: true, grab: r });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
