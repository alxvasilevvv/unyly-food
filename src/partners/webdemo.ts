// The website's live Ari demo (/ari). The browser plays the Ari app; this file plays Ari's backend:
// a tiny rule-based "brain" turns the user's sentence into the same Partner API calls Ari makes
// (tools with cards, native confirmation, order events). Demo mode only: synthetic stores and fares.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.js';
import { txLeading } from '../db/db.js';
import { hmac, safeEqual, UUID_RE } from '../domain/crypto.js';
import { DomainError, isDomainError } from '../domain/errors.js';
import type { Locale } from '../domain/locales.js';
import { addFirstAddress, listAddresses, toDeliveryAddress } from '../services/users.js';
import { money } from '../domain/money.js';
import { DEMO_RESTAURANTS } from '../providers/demo/catalog.js';
import { resolvePlace } from '../providers/demo/places.js';
import { callProvider } from '../services/common.js';
import { declineCheckout } from '../services/checkout.js';
import { DemoService, detectService, fixTypos, hasFoodCue, parseIntent, serviceCues } from '../web/intent.js';
import { SHOP_STORE, shopPicks, shopPlan } from '../web/try-services.js';
import { tr } from '../web/messages.js';
import { pack } from '../i18n/index.js';
import { CATALOGS } from '../i18n/generated.js';
import { Card, CardOption, chatLocale, dataText, localText, trf } from './cards.js';
import { WEB_DEMO_PARTNER } from './config.js';
import {
  cancellationCard, checkoutCard, confirmCancelWithRows, confirmCheckout, grabLinkView, orderCard, prepareCancelPartner, runTool, startGrabLink,
} from './core.js';
import { loadPartnerUserWith, partnerActor, PartnerUser, UserExtras, UserExtrasResult, upsertPartnerUser } from './users.js';
import { listPartnerEvents, listPartnerEventsFor, storedEvent } from './webhooks.js';

const P = WEB_DEMO_PARTNER;
const COOKIE = 'ari_demo';
const ALLOWED_TOOLS = new Set(['create_cart', 'update_cart', 'search_stores', 'get_store', 'estimate_trip', 'get_order_status']);

export interface TraceEntry { call: string; grab: string | null; ms: number; ok: boolean }
export interface AriTurn { reply: string; card?: Card | null; chips?: string[]; order_id?: string; trace: TraceEntry[] }

type Tri = { en: string; ru: string; th: string };
const t = (l: Locale, x: Tri) => tr(l, x);
const tf = trf;
/** Sentences of one reply, in order. Chinese sets no space between sentences. */
const glue = (l: Locale, ...parts: (string | undefined | null | false)[]) => parts.filter(Boolean).join(l === 'zh' ? '' : ' ');

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
/** The same seven requests in the language packs, which list them in another order (dinner, taxi, groceries, flowers, pharmacy, cake, parcel). */
const PACK_ORDER = [1, 0, 6, 3, 4, 2, 5];
export const ariExamples = (l: Locale): string[] => {
  const own = (EXAMPLES as Record<string, string[]>)[l];
  if (own) return own;
  const p = pack(l)?.examples;
  return p?.length === 7 ? PACK_ORDER.map((i) => p[i]) : EXAMPLES.en;
};

const GREET = /^(hi|hello|hey|good (?:morning|afternoon|evening)|привет|здравств|добр|สวัสดี|อรุณสวัสดิ์|หวัดดี|ดีครับ|ดีค่ะ|👋|xin chào|chào(?: bạn| ari)?|halo|hallo|helo|selamat (?:pagi|siang|sore|malam|petang|tengah hari)|apa khabar|kumusta|kamusta|magandang (?:umaga|hapon|gabi|araw)|សួស្តី|ជំរាបសួរ|မင်္ဂလာပါ|你好|您好|哈喽|嗨)(?![a-z])/iu;
const THANKS = /^(?:ok(?:ay)?[,! ]*)?(?:thanks?|thank you|thx|cheers|great|perfect|awesome|спасибо|благодар|отлично|супер|ขอบคุณ|ขอบใจ|🙏|❤️|cảm ơn|cám ơn|terima kasih|makasih|maraming salamat|salamat|អរគុណ|ကျေးဇူး|谢谢|多谢)(?![a-zа-яё])/iu;
const HELP = /what can you (?:do|order)|what do you do|^help\b|how does (?:this|it) work|what services|что (?:ты )?(?:умеешь|можешь)|что вы (?:умеете|можете)|^помо(?:щь|ги)|как это работает|ทำอะไรได้|ช่วยอะไร|ใช้งานยังไง/iu;
const CANCEL = /\bcancel\b|отмен|ยกเลิก|(?<!\p{L})(?:hủy|huỷ|batal\S*|kanselahin|ikansela)(?!\p{L})|បោះបង់|ပယ်ဖျက်|取消/iu;
const TRACK = /where(?: i|')s (?:my|the)|\b(?:order|delivery|ride) status\b|\bstatus of my\b|\btrack(?:ing)?\b|how long (?:until|till)|отслед|ติดตาม|где (?:мой|моя|мое|моё|мои|сейчас|курьер|водитель|заказ)|что с (?:моим )?заказ|статус заказа|когда (?:приедет|привезут|доставят)|(?:ออเดอร์|คำสั่งซื้อ|รถ|ไรเดอร์|พัสดุ)(?:ของฉัน)?(?:อยู่|ถึง)(?:ที่)?ไหน|สถานะ(?:ออเดอร์|คำสั่งซื้อ)|ถึงไหนแล้ว|đơn(?: hàng)?(?: của tôi)? (?:đang )?(?:ở đâu|đâu rồi|đến đâu)|(?:di ?mana|mana) pesanan|pesanan saya (?:di ?mana|sampai mana|sudah sampai)|nasaan (?:na )?ang (?:order|rider|driver)|订单(?:现在)?(?:在哪|到哪|状态)|到哪了|到哪儿了|ការកម្មង់របស់ខ្ញុំនៅឯណា|အော်ဒါ ?ဘယ်ရောက်/iu;

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
const OOS = /\b(?:transfer|send|wire|lend|pay)\b.{0,24}\b(?:money|cash|baht|bills?)\b|\bhotels?\b|\btrain tickets?\b|\bmovie tickets?\b|\bweather\b|\bforecast\b|\bnews\b|\bjoke\b|\btranslate\b|\bremind me\b|\balarm\b|\bplay (?:music|a song)\b|\bbitcoin\b|exchange rate|what time|what day|today'?s date|который час|сколько (?:сейчас )?времени|какое сегодня|กี่โมง|วันนี้วันอะไร|отел[ьяе]|гостиниц|погод|перев\S* (?:деньги|денег)|(?<!\p{L})деньги(?!\p{L})|новост|анекдот|напомни|будильник|курс (?:валют|доллар|бат)|จองโรงแรม|ที่พัก|อากาศ|โอนเงิน|จ่ายบิล|ข่าว|เรื่องตลก|ตั้งปลุก|อัตราแลกเปลี่ยน/iu;
const WHO = /who are you|what are you\b|what(?:'s| is) your name|are you (?:a |an )?(?:human|bot|robot|ai|real|person|machine)|кто ты|кто вы|ты кто|как (?:тебя|вас) зовут|(?:ты|вы) (?:человек|бот|робот|живая|настоящая)|คุณ(?:เป็น|คือ)ใคร|เธอ(?:เป็น|คือ)ใคร|ชื่ออะไร|เป็นคน(?:จริง)?(?:หรือ|ไหม|มั้ย|รึ)|เป็น(?:บอท|หุ่นยนต์|เอไอ|ai)/iu;
const HOW_ARE_YOU = /^how are you|how(?:'s| is) it going|how do you do|^what'?s up|как дела|^как ты\??$|как поживае|สบายดีไหม|สบายดีมั้ย|เป็น(?:ยัง)?ไงบ้าง/iu;
const BYE = /^(?:good ?bye|bye(?:[- ]bye)?|see you|see ya|good night|пока|до свидания|до встречи|спокойной ночи|บาย|บ๊ายบาย|ลาก่อน|ไปก่อนนะ|ฝันดี)(?![a-zа-яё])/iu;
/** "Yes, confirm" typed into the chat. It is never a confirmation: only the button on the card is. */
const YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|k|fine|confirm(?:ed)?|go ahead|do it|order it|place (?:the|my) order|book it|buy it|proceed|let'?s go|sounds good|да|ага|угу|давай(?:те)?|подтвержда\S*|подтверди\S*|оформ\S*|заказывай\S*|хорошо|ок(?:ей)?|ладно|согласен|согласна|беру|ใช่|ตกลง|ยืนยัน|สั่งเลย|โอเค|ได้เลย|ได้|เอาเลย|เอา|จัดไป|ครับ|ค่ะ|👍|👌|✅)(?:[\s,.!]+(?:yes|please|and|confirm\S*|go ahead|order it|do it|it|that|the order|подтвержда\S*|подтверди\S*|заказывай|оформляй|пожалуйста|ยืนยัน|เลย|ครับ|ค่ะ|นะ))*[\s.!]*$/iu;
const NO = /^(?:no|nope|nah|not now|never ?mind|нет|не надо|не нужно|не сейчас|передумал\S*|ไม่|ไม่เอา|ไม่ต้อง|ไม่เป็นไร|ไว้ก่อน)(?:[\s,.!]+(?:thanks|thank you|спасибо|ครับ|ค่ะ|ขอบคุณ))*[\s.!]*$/iu;
const FEES = /how much (?:is|does|for) (?:the )?(?:delivery|shipping|service)|delivery (?:fee|cost|price)|service fee|сколько стоит доставк|стоимость доставки|цена доставки|сервисный сбор|ค่าส่ง|ค่าบริการ|ค่าธรรมเนียม/iu;
const SUPPORT = /refund|complain|money back|lost (?:my|an?|the) |left my|talk to (?:a |an |the )?(?:human|person|agent|operator|manager|support)|human agent|customer (?:service|support|care)|\bsupport\b|возврат|верни\S* деньги|жалоб|потерял|забыл\S* в |оператор|поддержк|позови\S* (?:человека|менеджера)|живо\S* человек|คืนเงิน|เงินคืน|ร้องเรียน|ลืมของ|ของหาย|คุยกับคน|คุยกับเจ้าหน้าที่|เจ้าหน้าที่|ติดต่อ/iu;
const INSULT = /stupid|idiot|dumb|useless|\bsuck|fuck|shit|туп(?:ая|ой|ица)|дур[аы]|идиот|бесполезн|โง่|ห่วย|แย่มาก|ไร้ประโยชน์/iu;
const CHEAPER = /cheap|expensive|pricey|lower price|дешев|дёшев|дорог|ถูกกว่า|ถูกๆ|ถูกที่สุด|ราคาถูก|แพง/iu;
const ADDRESS = /(?:change|update|edit|new|another|different|other|wrong|my) (?:delivery |home )?address|поменя\S* адрес|смени\S* адрес|измени\S* адрес|друг\S* адрес|нов\S* адрес|не тот адрес|мой адрес|เปลี่ยนที่อยู่|แก้(?:ไข)?ที่อยู่|ที่อยู่ใหม่|ที่อยู่อื่น/iu;
/** A clock time or another day: the demo orders for right now only. */
const TIME = /\bat \d{1,2}(?::\d{2})?\s*(?:am|pm|o'?clock)?(?![\p{L}\d])|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\btomorrow\b|\bin \d+ (?:min\w*|hours?)\b|\bin an hour\b|(?<!\p{L})в \d{1,2}[:.]\d{2}|(?<!\p{L})в \d{1,2} (?:час\S*|утра|вечера|дня)|послезавтра|завтра(?!к)|через \d+ (?:мин\S*|час\S*)|через час|\d{1,2}\s*โมง(?:เช้า|เย็น)?|\d{1,2}[:.]\d{2}\s*น\.?|พรุ่งนี้|อีก \d+ (?:นาที|ชั่วโมง)|\d{1,2}\s*ทุ่ม|บ่าย\s*\d/giu;
const FRAGILE = /fragile|breakable|\bglass\b|хрупк|стекл|แตกง่าย|ระวังแตก|แก้ว/iu;
const GIFT = /\b(?:to|for) (?:my |our )?(?:mom|mum|mother|wife|husband|girlfriend|boyfriend|friend|dad|father|sister|brother|boss|colleague|grandma|grandmother|daughter|son)\b|(?<!\p{L})(?:маме|жене|мужу|девушке|подруге|другу|папе|сестре|брату|бабушке|коллеге|дочке|дочери|сыну|начальнику)(?!\p{L})|(?<!\p{L})для (?:мамы|жены|мужа|девушки|подруги|друга|папы|сестры|брата|бабушки|коллеги|дочки|дочери|сына|начальника)(?!\p{L})|ให้(?:คุณ)?(?:แม่|พ่อ|แฟน|ภรรยา|สามี|เพื่อน|พี่|น้อง|ยาย|ย่า|ลูก|เจ้านาย)/iu;
/** Well-known places the Bangkok demo map does not reach. */
const OUTSIDE = /singapore|phuket|pattaya|chiang ?mai|chiang ?rai|hua ?hin|krabi|samui|ayutthaya|kuala lumpur|malaysia|jakarta|\bbali\b|manila|hanoi|ho chi minh|saigon|vietnam|tokyo|japan|moscow|russia|london|paris|new york|dubai|hong kong|сингапур|пхукет|паттай|чианг ?ма|хуа ?хин|краби|самуи|москв|росси|токио|лондон|париж|дубай|малайзи|вьетнам|สิงคโปร์|ภูเก็ต|พัทยา|เชียงใหม่|เชียงราย|หัวหิน|กระบี่|สมุย|อยุธยา|มอสโก|โตเกียว|ลอนดอน|มาเลเซีย|ญี่ปุ่น/iu;

/** Names the demo map does not list as spoken: Russian case endings and everyday Thai names. */
const PLACE_ALIAS: [RegExp, string][] = [
  [/гранд[- ]?палас\S*|королевск\S* двор\S*|больш\S* двор\S*|วัดพระแก้ว|พระบรมมหาราชวัง/iu, 'Grand Palace'],
  [/эккама\S*/iu, 'Ekkamai'],
  [/силом\S*/iu, 'Silom'],
  [/чайнатаун\S*|китайск\S* квартал\S*/iu, 'Chinatown'],
  [/терминал\S* 21/iu, 'Terminal 21'],
];
const placeAlias = (s: string | undefined) => (s ? PLACE_ALIAS.find(([re]) => re.test(s))?.[1] ?? s : s);

/** Emoji stand in for the word they picture, so "🍕" or "🚕" alone is a request. */
const EMOJI: [RegExp, string][] = [
  [/🍕/u, 'pizza'], [/🍔|🍟/u, 'burger'], [/🍜|🍝|🍲|🥡/u, 'noodles'], [/🍣|🍱/u, 'sushi'], [/🍛/u, 'curry'], [/🥗/u, 'salad'],
  [/🚕|🚖|🚗|🚙|🛵|🏍/u, 'taxi'], [/💐|🌹|🌷|🌸|🌺|🌻/u, 'flowers'], [/🎂|🍰|🧁/u, 'cake'], [/📦/u, 'parcel'], [/💊|🤒|🤕|🩹/u, 'pharmacy'], [/🛒|🥚|🥛|🍌/u, 'groceries'],
];

const HELP_TEXT: Tri = {
  en: 'In this demo I show how I would order from Grab for you: food, groceries, flowers, pharmacy items, cakes, rides and parcels. Say it in your own words, pick an option, then confirm on the card. Nothing is ordered until you confirm.',
  ru: 'В этом демо я показываю, как заказываю для вас в Grab: еду, продукты, цветы, товары из аптеки, торты, поездки и посылки. Скажите своими словами, выберите вариант и подтвердите на карточке. Без подтверждения ничего не заказывается.',
  th: 'ในเดโมนี้ Ari แสดงให้เห็นว่าจะสั่งบริการจาก Grab ให้คุณอย่างไรค่ะ ทั้งอาหาร ของชำ ดอกไม้ ยาสามัญ เค้ก เรียกรถ และส่งพัสดุ บอก Ari ด้วยคำพูดของคุณเอง เลือกตัวเลือก แล้วแตะยืนยันบนการ์ด Ari จะยังไม่สั่งอะไรจนกว่าคุณจะยืนยันค่ะ',
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

type DemoStore = (typeof DEMO_RESTAURANTS)[number];
type DemoItem = DemoStore['items'][number];
interface DishHit { dish: Dish; all: { store: DemoStore; item: DemoItem }[]; open: { store: DemoStore; item: DemoItem }[]; fits: { store: DemoStore; item: DemoItem }[]; quantity?: number }

const DISH_COUNT: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, a: 1, 'один': 1, 'одну': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'หนึ่ง': 1, 'สอง': 2, 'สาม': 3, 'สี่': 4,
};
const DISH_COUNT_ALT = Object.keys(DISH_COUNT).filter((k) => k !== 'a').join('|');

/** Every named dish on the demo menus, with the reason it cannot be offered when it does not fit the request. */
function findDishes(q: string, intent: { exclude_allergens: string[]; dietary: string[] }): DishHit[] {
  const named = DISHES.filter((d) => d.re.test(q));
  // "Green curry" is not also a second, general curry.
  const dishes = named.filter((d) => !(d.name.en === 'curry' && named.some((x) => x !== d && /curry/.test(x.name.en))));
  return dishes.map((dish) => {
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
    // "2 pad thai", "один том ям", "ผัดไทยหนึ่ง": a count right next to the dish is for that dish alone.
    const m = dish.re.exec(q);
    const before = m ? new RegExp(`(?<![\\p{L}\\d])(\\d{1,2}|${DISH_COUNT_ALT})\\s*(?:x\\s*|×\\s*)?(?:\\p{L}+\\s+){0,2}$`, 'iu').exec(q.slice(0, m.index)) : null;
    const after = m ? new RegExp(`^\\s*(\\d{1,2}|หนึ่ง|สอง|สาม|สี่)(?!\\s*(?:คน|บาท|\\d))`, 'u').exec(q.slice(m.index + m[0].length)) : null;
    const k = (before?.[1] ?? (/[฀-๿]/.test(m?.[0] ?? '') ? after?.[1] : undefined))?.toLowerCase();
    const n = k ? (/^\d+$/.test(k) ? Number(k) : DISH_COUNT[k]) : undefined;
    return { dish, all, open, fits, quantity: n && n >= 1 && n <= 20 ? n : undefined };
  });
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
    return { reply: tf(l, { en: 'Your latest order: {status}.', ru: 'Ваш последний заказ: {status}.', th: 'คำสั่งซื้อล่าสุด: {status}ค่ะ' }, { status: card.status?.label ?? '' }), card, order_id: o.id, trace };
  }
  if (!card.actions.some((a) => a.kind === 'prepare_cancel')) {
    const st = card.status?.label ?? '';
    return { reply: tf(l, { en: 'This order can no longer be cancelled ({status}).', ru: 'Этот заказ уже нельзя отменить ({status}).', th: 'คำสั่งซื้อนี้ยกเลิกไม่ได้แล้วค่ะ ({status})' }, { status: st }), card, order_id: o.id, trace };
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
    reply: tf(l, { en: 'Same as your last order ({title}), at today\'s price. Nothing is ordered until you confirm on the card.', ru: 'То же, что в прошлом заказе ({title}), по сегодняшней цене. Без подтверждения на карточке ничего не заказывается.', th: 'เหมือนคำสั่งซื้อล่าสุด ({title}) ในราคาวันนี้ค่ะ Ari จะยังไม่สั่งจนกว่าคุณจะกดยืนยันบนการ์ดนะคะ' }, { title: r.card.title }),
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
    const v = { kg: kg ?? '', from: from ?? '', to };
    if (from) {
      return kg
        ? tf(l, { en: 'Send a {kg} kg parcel from {from} to {to}', ru: 'Отправить посылку {kg} кг от {from} до {to}', th: 'ส่งพัสดุ {kg} กก. จาก {from} ไป {to}' }, v)
        : tf(l, { en: 'Send a parcel from {from} to {to}', ru: 'Отправить посылку от {from} до {to}', th: 'ส่งพัสดุ จาก {from} ไป {to}' }, v);
    }
    return kg
      ? tf(l, { en: 'Send a {kg} kg parcel to {to}', ru: 'Отправить посылку {kg} кг в {to}', th: 'ส่งพัสดุ {kg} กก. ไป {to}' }, v)
      : tf(l, { en: 'Send a parcel to {to}', ru: 'Отправить посылку в {to}', th: 'ส่งพัสดุ ไป {to}' }, v);
  }
  const trip = from
    ? tf(l, { en: 'Taxi from {from} to {to}', ru: 'Такси от {from} до {to}', th: 'แท็กซี่จาก {from} ไป {to}' }, { from, to })
    : tf(l, { en: 'Taxi to {to}', ru: 'Такси до {to}', th: 'แท็กซี่ไป {to}' }, { to });
  // The party size goes last, where the place parser stops reading.
  const n = ask?.passengers;
  return n && n > 1 ? tf(l, { en: '{trip} for {n} people', ru: '{trip} на {n} человек', th: '{trip} สำหรับ {n} คน' }, { trip, n }) : trip;
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

const REVERSE = new Map<string, Map<string, string>>();
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
/**
 * A sentence that is word for word one of our own lines in a catalog language (an example chip, a button
 * label) is read as its English original, so every chip Ari offers works when tapped, whatever the parser knows.
 */
function ownLine(l: Locale, typed: string): string {
  const cat = CATALOGS[l];
  if (!cat) return typed;
  // The seven examples of a language pack mean exactly what the English examples say.
  const ex = pack(l)?.examples.findIndex((e) => norm(e) === norm(typed)) ?? -1;
  if (ex >= 0 && PACK_ORDER.includes(ex)) return EXAMPLES.en[PACK_ORDER.indexOf(ex)];
  let rev = REVERSE.get(l);
  if (!rev) {
    rev = new Map();
    for (const [en, own] of Object.entries(cat)) if (own.length <= 120 && !rev.has(norm(own))) rev.set(norm(own), en);
    REVERSE.set(l, rev);
  }
  return rev.get(norm(typed)) ?? typed;
}

/** One user message: decide what Ari would do and run it through the Partner API path. */
export async function ariRespond(ctx: Ctx, u: PartnerUser, text: string): Promise<AriTurn> {
  const l = chatLocale(u.locale);
  const trace: TraceEntry[] = [];
  const base = `/partner/v1/users/${u.external_user_id}`;
  const typed = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  // What the rules read: the sentence with emoji spelled out and common typos fixed.
  const q = fixTypos(`${ownLine(l, typed)} ${EMOJI.filter(([re]) => re.test(typed)).map(([, w]) => w).join(' ')}`.trim());
  const ex = ariExamples(l);
  if (!q || (GREET.test(q) && q.split(' ').length <= 3)) {
    return {
      reply: t(l, { en: 'Hi! In this demo I can order from Grab for you: a ride, food, groceries, flowers, pharmacy items, a cake or a parcel. What do you need?', ru: 'Здравствуйте! В этом демо я могу заказать для вас в Grab поездку, еду, продукты, цветы, товары из аптеки, торт или посылку. Что нужно?', th: 'สวัสดีค่ะ ในเดโมนี้ Ari สั่งบริการจาก Grab ให้ได้ ทั้งเรียกรถ สั่งอาหาร ของชำ ดอกไม้ ยาสามัญ เค้ก หรือส่งพัสดุ ให้ Ari ช่วยอะไรดีคะ' }),
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
    ? t(l, { en: 'I can only order for right now: scheduling a time is not part of this demo.', ru: 'Заказать могу только на сейчас: выбор времени в это демо не входит.', th: 'Ari สั่งได้เฉพาะแบบทันทีค่ะ การนัดเวลาล่วงหน้ายังไม่มีในเดโมนี้' })
    : '';
  const noConfirmNote = NO_CONFIRM.test(q)
    ? t(l, { en: 'I can\'t skip the confirmation: nothing is ordered until you tap Confirm on the card.', ru: 'Без подтверждения не получится: ничего не заказывается, пока вы не нажмёте «Подтвердить» на карточке.', th: 'Ari ข้ามขั้นตอนยืนยันไม่ได้ค่ะ จะยังไม่มีการสั่งซื้อจนกว่าคุณจะแตะยืนยันบนการ์ด' })
    : '';
  const lead = glue(l, noConfirmNote, timeNote);
  const si = detectService(timed);
  // A named dish is a food order even when it shares a word with the supermarket ("fried rice", "mango sticky rice").
  const dishNamed = DISHES.some((d) => d.re.test(q));
  if (dishNamed && si.service === 'groceries' && !/grocer|supermarket|продукт|супермаркет|ของชำ|ซูเปอร์/iu.test(q)) si.service = 'food';
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
    if (!cues.length && !hasFoodCue(q) && !dishNamed) {
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
      if (SUPPORT.test(q)) {
        return say(l, {
          en: 'Refunds, lost items and complaints are handled by Grab support, not by me: open the Help Centre in the Grab app. Here I can show your latest order or place a new one.',
          ru: 'Возвраты, забытые вещи и жалобы решает поддержка Grab, а не я: откройте Help Centre в приложении Grab. Здесь я могу показать ваш последний заказ или оформить новый.',
          th: 'เรื่องขอเงินคืน ของหาย และการร้องเรียน ทีมซัพพอร์ตของ Grab เป็นผู้ดูแลค่ะ ไม่ใช่ Ari เปิดศูนย์ช่วยเหลือในแอป Grab ได้เลย ส่วนที่นี่ Ari ดูคำสั่งซื้อล่าสุดหรือสั่งรายการใหม่ให้ได้ค่ะ',
        }, [t(l, { en: 'Where is my order', ru: 'Где мой заказ', th: 'ออเดอร์อยู่ไหน' }), ex[0]], trace);
      }
      if (FEES.test(q)) {
        return say(l, {
          en: 'It depends on the store and the distance. Before you confirm, the card lists the delivery fee, the service fee and the total, so there are no surprises. Try a request:',
          ru: 'Зависит от магазина и расстояния. До подтверждения на карточке видны плата за доставку, сервисный сбор и итог, так что сюрпризов не будет. Попробуйте:',
          th: 'ขึ้นอยู่กับร้านและระยะทางค่ะ ก่อนยืนยัน การ์ดจะแสดงค่าส่ง ค่าบริการ และยอดรวมให้เห็นครบ ไม่มีค่าใช้จ่ายแอบแฝง ลองสั่งดูได้เลยค่ะ',
        }, ex.slice(1, 4), trace);
      }
      if (INSULT.test(q)) {
        return say(l, {
          en: 'Sorry I let you down. Tell me what you need from Grab and I will do my best:',
          ru: 'Простите, что подвела. Скажите, что нужно от Grab, и я постараюсь:',
          th: 'ขออภัยที่ทำให้ผิดหวังค่ะ บอกได้เลยว่าต้องการอะไรจาก Grab Ari จะทำให้ดีที่สุดค่ะ',
        }, ex.slice(0, 3), trace);
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
      const places = u.addresses ?? (await listAddresses(ctx.db, u.user_id));
      const addr = places.find((a) => a.is_default);
      // "Home" in any language is the saved default place, whatever language its label was saved in.
      si.pickup = placeAlias(si.pickup);
      si.dropoff = placeAlias(si.dropoff);
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
      const homeWord = l === 'en' || l === 'ru' || l === 'th' ? t(l, { en: 'home', ru: 'дома', th: 'บ้าน' }) : addr?.label ?? t(l, { en: 'Home', ru: 'Дом', th: 'บ้าน' });
      const ask: TripAsk = { service: si.service, pickup: si.pickup_home ? homeWord : si.pickup, dropoff: si.dropoff_home ? homeWord : si.dropoff, weight_kg: si.weight_kg, passengers: si.passengers };
      if (si.service === 'ride' && si.passengers && si.passengers > MAX_SEATS) {
        // More people than the largest vehicle seats: say so instead of quietly offering a van that is too small.
        const half = Math.ceil(si.passengers / 2);
        return {
          reply: tf(l, { en: 'The largest vehicle here seats {seats}, so your group needs two cars. I can book one car at a time:', ru: 'В самой большой машине {seats} мест, поэтому вашей компании нужны две машины. Я заказываю по одной:', th: 'รถคันใหญ่ที่สุดนั่งได้ {seats} คนค่ะ กลุ่มของคุณจึงต้องใช้สองคัน Ari จองได้ทีละคันค่ะ' }, { seats: MAX_SEATS }),
          chips: [placeChip(l, { ...ask, passengers: half }, 'dropoff', ask.dropoff ?? '')], trace,
        };
      }
      const fragile = si.service === 'express' && FRAGILE.test(q);
      if (si.service === 'express') args.parcel_weight_kg = si.weight_kg ?? 2;
      if (fragile) args.parcel_description = t(l, { en: 'Fragile', ru: 'Хрупкое', th: 'ของแตกง่าย' });
      if (si.passengers) args.passengers = si.passengers;
      const r = await traced(trace, `POST ${base}/tools/estimate_trip`, grabFor('estimate_trip', args), () => runTool(ctx, P, u, 'estimate_trip', args, { addresses: places }));
      if (!r.ok) {
        const e = errorTurn(l, r.error, trace, ask);
        return { ...e, reply: glue(l, lead, e.reply) };
      }
      const res = r.result;
      const from = res.trip?.pickup?.name;
      const to = res.trip?.dropoff?.name;
      // The reply has to say what the card shows: when no vehicle can take the trip, say why.
      if (r.card?.options?.length && r.card.options.every((o) => !o.action)) {
        const maxKg = Math.max(0, ...(res.options ?? []).map((o: any) => Number(o.max_weight_kg) || 0));
        const maxSeats = Math.max(0, ...(res.options ?? []).map((o: any) => Number(o.seats) || 0));
        const why = si.service === 'express'
          ? tf(l, { en: 'A {kg} kg parcel is too heavy: the largest vehicle here carries up to {max} kg. Try a lighter parcel or split it.', ru: 'Посылка {kg} кг слишком тяжёлая: самая большая машина берёт до {max} кг. Уменьшите вес или разделите посылку.', th: 'พัสดุ {kg} กก. หนักเกินไปค่ะ รถคันใหญ่ที่สุดรับได้ไม่เกิน {max} กก. ลองลดน้ำหนักหรือแบ่งส่งนะคะ' }, { kg: String(args.parcel_weight_kg), max: maxKg })
          : tf(l, { en: 'No vehicle here takes {n} passengers: the largest seats {max}. Try a smaller group or two cars.', ru: 'Машины на {n} пассажиров нет: в самой большой мест {max}. Попробуйте меньшую компанию или две машины.', th: 'ไม่มีรถที่รับผู้โดยสาร {n} คนได้ค่ะ คันใหญ่ที่สุดนั่งได้ {max} คน ลองแบ่งเป็นสองคันนะคะ' }, { n: si.passengers ?? '', max: maxSeats });
        return { reply: why, card: r.card, trace };
      }
      const weightGuess = si.service === 'express' && !si.weight_kg
        ? t(l, { en: 'I assumed 2 kg; tell me the weight if it is heavier.', ru: 'Вес я приняла за 2 кг; если посылка тяжелее, назовите вес.', th: 'Ari ประมาณน้ำหนักไว้ที่ 2 กก. ถ้าหนักกว่านี้บอกน้ำหนักได้เลยค่ะ' })
        : '';
      const fragileNote = fragile ? t(l, { en: 'I marked it as fragile for the courier.', ru: 'Пометила для курьера, что посылка хрупкая.', th: 'Ari แจ้งไรเดอร์ไว้แล้วว่าเป็นของแตกง่ายค่ะ' }) : '';
      const group = si.service === 'ride' && si.passengers && si.passengers > 1
        ? tf(l, { en: 'Cars that seat {n} are on top.', ru: 'Машины на {n} пассажиров идут первыми.', th: 'รถที่นั่งได้ {n} คนอยู่ด้านบนค่ะ' }, { n: si.passengers })
        : '';
      const reply = si.service === 'ride'
        ? glue(l,
          tf(l, { en: 'From {from} to {to}, about {min} min.', ru: 'Маршрут: {from} → {to}, примерно {min} мин в пути.', th: 'จาก {from} ไป {to} ประมาณ {min} นาที' }, { from, to, min: res.trip?.drive_minutes_estimate ?? '' }),
          group,
          t(l, { en: 'Pick a ride:', ru: 'Выберите машину:', th: 'เลือกประเภทรถได้เลยค่ะ' }))
        : glue(l,
          tf(l, { en: 'Parcel {kg} kg from {from} to {to}.', ru: 'Посылка {kg} кг: {from} → {to}.', th: 'พัสดุ {kg} กก. จาก {from} ไป {to}' }, { kg: String(args.parcel_weight_kg), from, to }),
          weightGuess, fragileNote,
          t(l, { en: 'Pick a courier:', ru: 'Выберите курьера:', th: 'เลือกประเภทการส่งได้เลยค่ะ' }));
      return { reply: glue(l, lead, reply), card: r.card, trace };
    }
    if (si.service === 'food') {
      // Nothing in the sentence names a service or a meal: say what Ari can do instead of guessing restaurants.
      if (!hasFoodCue(q) && !dishNamed) return { reply: t(l, UNKNOWN_TEXT), chips: ex.slice(0, 4), trace };
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
    const names = plan.lines.map((x) => `${x.quantity > 1 ? `${x.quantity}× ` : ''}${dataText(x.name, l)}`).join(l === 'zh' ? '、' : ', ');
    const notes: string[] = [];
    if (!picks.matched && service === 'flowers') notes.push(t(l, { en: 'I picked the seasonal bouquet; say roses, lilies or orchids if you prefer.', ru: 'Я выбрала сезонный букет; если хотите розы, лилии или орхидею, скажите.', th: 'Ari เลือกช่อดอกไม้ตามฤดูกาลให้ค่ะ ถ้าอยากได้กุหลาบ ลิลลี่ หรือกล้วยไม้ บอกได้เลยนะคะ' }));
    if (!picks.matched && service === 'cakes') notes.push(t(l, { en: 'I picked the chocolate cake; there is also a birthday cake, a pandan chiffon and a mango cheesecake.', ru: 'Я выбрала шоколадный торт; ещё есть торт на день рождения, пандановый шифон и манговый чизкейк.', th: 'Ari เลือกเค้กช็อกโกแลตให้ค่ะ นอกจากนี้ยังมีเค้กวันเกิด ชิฟฟ่อนใบเตย และชีสเค้กมะม่วง' }));
    for (const x of plan.lines) {
      if (x.limited_from) notes.push(tf(l, { en: 'The store sells at most {max} of {name} per order, so I set {max} instead of {asked}.', ru: 'Магазин продаёт не больше {max} шт. «{name}» в одном заказе, поэтому вместо {asked} я поставила {max}.', th: 'ร้านขาย {name} ได้ไม่เกิน {max} ชิ้นต่อคำสั่งซื้อ Ari จึงใส่ {max} แทน {asked} ค่ะ' }, { max: x.quantity, name: dataText(x.name, l), asked: x.limited_from }));
    }
    if (service === 'flowers' && /\d/.test(typed) && !/(?<!\d)12(?!\d)/.test(typed)) notes.push(t(l, { en: 'The florist sells set bouquets, so I could not change the number of stems: check it on the card.', ru: 'Флорист продаёт готовые букеты, поэтому число цветов я изменить не могу: проверьте его на карточке.', th: 'ร้านขายเป็นช่อสำเร็จ Ari จึงเปลี่ยนจำนวนดอกไม่ได้ ตรวจจำนวนบนการ์ดได้เลยค่ะ' }));
    if (service === 'groceries' && /\d/.test(typed)) notes.push(t(l, { en: 'Items come in store packs, one of each: check the sizes on the card.', ru: 'Товары идут упаковками магазина, по одной каждого: проверьте объёмы на карточке.', th: 'สินค้าเป็นแพ็กตามที่ร้านขาย อย่างละ 1 รายการ ตรวจขนาดบนการ์ดได้เลยค่ะ' }));
    if (GIFT.test(q)) {
      const home = r.card?.subtitle ?? '';
      notes.push(tf(l, { en: 'It will be delivered to your saved address ({home}): sending to someone else\'s address is not part of this chat demo.', ru: 'Доставка будет на ваш сохранённый адрес ({home}): отправка на чужой адрес в это демо не входит.', th: 'รายการนี้จะจัดส่งไปยังที่อยู่ที่คุณบันทึกไว้ ({home}) ค่ะ การส่งไปยังที่อยู่ของผู้อื่นยังไม่มีในเดโมแชตนี้' }, { home }));
    }
    return {
      reply: glue(l, lead,
        tf(l, { en: '{store}: {names}.', ru: '{store}: {names}.', th: '{store}: {names}' }, { store: plan.store_name, names }),
        ...notes,
        t(l, { en: 'Here is the total with every fee. Confirm when ready.', ru: 'Вот итог со всеми сборами. Подтвердите, когда будете готовы.', th: 'นี่คือยอดรวมที่รวมค่าธรรมเนียมทุกรายการแล้ว แตะยืนยันเมื่อพร้อมนะคะ' })),
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

/** "3 options for 2 under ฿600." */
function optionCount(l: Locale, n: number, people: number, budget: string): string {
  const v = { n, people, budget };
  if (budget) {
    return n === 1
      ? tf(l, { en: '{n} option for {people} under ฿{budget}.', ru: 'Вариантов: {n} (на {people} чел. до {budget} бат).', th: '{n} ตัวเลือกสำหรับ {people} คน ไม่เกิน {budget} บาท' }, v)
      : tf(l, { en: '{n} options for {people} under ฿{budget}.', ru: 'Вариантов: {n} (на {people} чел. до {budget} бат).', th: '{n} ตัวเลือกสำหรับ {people} คน ไม่เกิน {budget} บาท' }, v);
  }
  return n === 1
    ? tf(l, { en: '{n} option for {people}.', ru: 'Вариантов: {n} (на {people} чел.).', th: '{n} ตัวเลือกสำหรับ {people} คน' }, v)
    : tf(l, { en: '{n} options for {people}.', ru: 'Вариантов: {n} (на {people} чел.).', th: '{n} ตัวเลือกสำหรับ {people} คน' }, v);
}

/** A food request: restaurants for the party and budget, or the named dishes when the demo menus have them. */
async function foodTurn(ctx: Ctx, u: PartnerUser, l: Locale, q: string, typed: string, lead: string, trace: TraceEntry[]): Promise<AriTurn> {
  const base = `/partner/v1/users/${u.external_user_id}`;
  const intent = parseIntent(q);
  const found = findDishes(q, intent);
  // The dishes that can be offered, and the restaurants that have all of them (one order comes from one restaurant).
  let offered = found.filter((f) => f.fits.length);
  let stores = offered.length ? offered[0].fits.map((h) => h.store).filter((st) => offered.every((f) => f.fits.some((h) => h.store.id === st.id))) : [];
  const elsewhere = offered.length > 1 && !stores.length ? offered.slice(1) : [];
  if (elsewhere.length) {
    offered = offered.slice(0, 1);
    stores = offered[0].fits.map((h) => h.store);
  }
  const dishFits = stores.length > 0;
  const counted = offered.some((f) => f.quantity);
  // A named dish is one portion unless the sentence says for how many; a general request assumes two and says so.
  const people = intent.party_size ?? (dishFits ? 1 : 2);
  // Why a named dish is not offered, when it is not.
  const notes: string[] = [];
  for (const f of found) {
    const dishName = t(l, f.dish.name);
    if (!f.all.length) {
      notes.push(tf(l, { en: 'There is no {dish} in the demo catalog.', ru: 'В демо-каталоге нет позиции «{dish}».', th: 'ในแคตตาล็อกเดโมยังไม่มี{dish}ค่ะ' }, { dish: dishName }));
    } else if (!f.open.length) {
      const st = f.all[0].store;
      notes.push(tf(l, { en: '{dish} is on the menu at {store}, but it is closed right now.', ru: '{dish} есть в {store}, но сейчас там закрыто.', th: '{store} มี{dish} แต่ตอนนี้ร้านปิดอยู่ค่ะ' }, { dish: l === 'th' ? dishName : cap(dishName), store: st.name }));
    } else if (!f.fits.length) {
      const h = f.open[0];
      notes.push(tf(l, { en: '{item} at {store} does not fit your restrictions, so I left it out.', ru: '{item} из {store} не подходит под ваши ограничения, поэтому я это блюдо не предлагаю.', th: '{item} ของร้าน {store} ไม่ตรงกับเงื่อนไขของคุณ Ari จึงไม่ได้เสนอเมนูนี้ค่ะ' }, { item: dataText(h.item.name, l), store: h.store.name }));
    } else if (elsewhere.includes(f)) {
      const h = f.fits[0];
      notes.push(tf(l, { en: '{item} is at another restaurant ({store}): ask for it as a separate order.', ru: '{item} готовят в другом ресторане ({store}): закажите это блюдо отдельно.', th: '{item} อยู่อีกร้านหนึ่ง ({store}) สั่งแยกเป็นอีกรายการได้เลยค่ะ' }, { item: dataText(h.item.name, l), store: h.store.name }));
    }
  }
  const closedOnly = found.length > 0 && found.every((f) => f.all.length > 0 && !f.open.length);
  const args: Record<string, unknown> = {
    service: 'food', limit: dishFits ? 10 : 3, party_size: people,
    ...(intent.budget_total_major ? { budget_total_major: intent.budget_total_major } : {}),
    ...(intent.exclude_allergens.length ? { exclude_allergens: intent.exclude_allergens } : {}),
    ...(intent.dietary.length ? { dietary: intent.dietary } : {}),
    // A cuisine filter would hide everything when the only place for the named dish is closed.
    ...(intent.cuisine && !closedOnly ? { cuisine: intent.cuisine } : {}),
  };
  const r = await traced(trace, `POST ${base}/tools/search_stores`, grabFor('search_stores', args), () => runTool(ctx, P, u, 'search_stores', args));
  if (!r.ok) return errorTurn(l, r.error, trace);
  const allergy = intent.exclude_allergens.length
    ? t(l, { en: 'Restaurants did not declare the allergens you excluded, but I never mark a dish as safe.', ru: 'Рестораны не заявили исключённые аллергены, но я никогда не называю блюдо безопасным.', th: 'ร้านไม่ได้ระบุว่ามีสารก่อภูมิแพ้ที่คุณยกเว้น แต่ Ari ไม่รับรองว่าเมนูใดปลอดภัยนะคะ' })
    : '';
  const partyGuess = intent.party_size || counted ? undefined : partyChips(l, typed, people);
  if (dishFits && r.card?.options) {
    // The named dishes, priced with delivery and fees, at every open restaurant that has them.
    const addr = (u.addresses ?? (await listAddresses(ctx.db, u.user_id))).find((a) => a.is_default);
    const provider = ctx.provider('demo');
    const mild = /not (?:too )?spicy|no spic|mild|не остр|неостр|ไม่เผ็ด/iu.test(q);
    const hot = !mild && /spicy|extra hot|остр|เผ็ด/iu.test(q);
    const options: CardOption[] = [];
    let undeliverable: DemoStore | null = null;
    for (const store of stores) {
      const opt = r.card.options.find((o) => o.id === store.id);
      if (!opt?.action || !addr) {
        undeliverable = store;
        continue;
      }
      const lines = offered.map((f) => {
        const item = f.fits.find((h) => h.store.id === store.id)!.item;
        // A required choice nobody named (spice level): the middle option, or what the sentence says.
        const modifiers = item.modifier_groups.filter((g) => g.min_select > 0).map((g) => {
          const free = g.options.filter((o) => o.available);
          const pick = (g.id === 'spice' ? free.find((o) => o.id === (hot ? 'hot' : mild ? 'mild' : 'medium')) : undefined) ?? free[0];
          return { group_id: g.id, option_ids: pick ? [pick.id] : [] };
        });
        return { item, quantity: f.quantity ?? people, modifiers };
      });
      const quote = await callProvider(() => provider.quote({
        restaurant_id: store.id, address: toDeliveryAddress(addr),
        lines: lines.map((x) => ({ line_id: x.item.id, item_id: x.item.id, name: x.item.name, quantity: x.quantity, modifiers: x.modifiers })),
      }));
      if (quote.issues.length) continue;
      const within = args.budget_total_major ? quote.total_minor <= Math.round(Number(args.budget_total_major) * 100) : null;
      const declared = lines.every((x) => x.item.allergen_info?.status === 'declared_by_restaurant');
      options.push({
        ...opt,
        subtitle: lines.map((x) => `${x.quantity}× ${dataText(x.item.name, l)}`).join(', '),
        price: money(quote.total_minor, quote.currency, l).formatted,
        badges: [...(within ? [t(l, BADGE_BUDGET)] : []), ...(intent.exclude_allergens.length && declared ? [t(l, BADGE_ALLERGEN)] : [])],
        action: { ...opt.action, tool: { name: 'create_cart', arguments: { store_id: store.id, items: lines.map((x) => ({ item_id: x.item.id, quantity: x.quantity, ...(x.modifiers.length ? { modifiers: x.modifiers } : {}) })) } } },
      });
    }
    if (options.length) {
      const first = options[0];
      const over = args.budget_total_major && !options.some((o) => o.badges?.includes(t(l, BADGE_BUDGET)))
        ? tf(l, { en: 'That is above your ฿{budget} budget.', ru: 'Это выше вашего бюджета {budget} бат.', th: 'ราคานี้เกินงบ {budget} บาทของคุณค่ะ' }, { budget: String(args.budget_total_major) })
        : '';
      const reply = glue(l,
        tf(l, { en: 'Found it: {items} at {store}, {price} with delivery.', ru: 'Нашла: {items} в {store}, {price} с доставкой.', th: 'เจอแล้วค่ะ {items} จากร้าน {store} ราคา {price} รวมค่าส่ง' }, { items: first.subtitle ?? '', store: first.title, price: first.price ?? '' }),
        over, allergy, ...notes,
        t(l, { en: 'Tap Choose to see every fee:', ru: 'Нажмите «Выбрать», чтобы увидеть все сборы:', th: 'แตะเลือกเพื่อดูค่าธรรมเนียมทั้งหมดได้เลยค่ะ' }));
      return { reply: glue(l, lead, reply), card: { ...r.card, options }, chips: partyGuess, trace };
    }
    if (undeliverable) {
      const dishName = t(l, offered[0].dish.name);
      notes.push(tf(l, { en: '{dish} is on the menu at {store}, but it does not deliver to your address right now.', ru: '{dish} есть в {store}, но сейчас оттуда нет доставки на ваш адрес.', th: '{store} มี{dish} แต่ตอนนี้ยังไม่จัดส่งมายังที่อยู่ของคุณค่ะ' }, { dish: l === 'th' ? dishName : cap(dishName), store: undeliverable.name }));
    }
  }
  // The general list: at most three restaurants, like any other food request.
  const card = r.card?.options ? { ...r.card, options: r.card.options.slice(0, 3) } : r.card;
  const n = (card?.options ?? []).filter((o) => o.action).length;
  const fits = (r.result?.stores ?? []).slice(0, 3).some((s: any) => s.suggestion?.within_budget === true);
  // A diet nobody in the catalog declares (halal, pork-free): say that, not "try a bigger budget".
  const unmet = intent.dietary.filter((d) => d === 'halal' || d === 'no_pork').map((d) => t(l, DIET_NAME[d])).join(', ');
  const tail = n && args.budget_total_major && !fits
    ? tf(l, { en: 'Nothing fits ฿{budget} for {people}. These are the closest options:', ru: 'В {budget} бат на {people} чел. уложиться не получится. Вот самые близкие варианты:', th: 'ยังไม่มีร้านที่อยู่ในงบ {budget} บาทสำหรับ {people} คนค่ะ นี่คือตัวเลือกที่ใกล้เคียงที่สุดค่ะ' }, { budget: String(args.budget_total_major), people })
    : n
    ? glue(l, optionCount(l, n, people, args.budget_total_major ? String(args.budget_total_major) : ''), allergy, t(l, { en: 'Tap one:', ru: 'Выберите:', th: 'เลือกได้เลยค่ะ' }))
    : unmet
    ? tf(l, { en: 'Nothing matches: no restaurant in the demo catalog declares its dishes as {diet}, and I never guess about that. Try the request without it.', ru: 'Ничего не подходит: ни один ресторан в демо-каталоге не заявляет блюда как «{diet}», а гадать я не буду. Попробуйте без этого условия.', th: 'ยังไม่มีร้านที่ตรงเงื่อนไขค่ะ ในแคตตาล็อกเดโมไม่มีร้านไหนระบุว่าเมนูเป็น{diet} และ Ari จะไม่เดาเรื่องนี้ ลองสั่งโดยไม่ใส่เงื่อนไขนี้ดูนะคะ' }, { diet: unmet })
    : t(l, { en: 'Nothing matches right now. Try a bigger budget or fewer restrictions.', ru: 'Сейчас ничего не подходит. Попробуйте увеличить бюджет или убрать ограничения.', th: 'ตอนนี้ยังไม่มีร้านที่ตรงกับเงื่อนไขค่ะ ลองเพิ่มงบหรือลดเงื่อนไขดูนะคะ' });
  // No selectable restaurant: a card of greyed-out rows would only confuse.
  const chips = !n ? ariExamples(l).slice(1, 2) : partyGuess;
  return { reply: glue(l, lead, ...(n ? notes : []), tail), card: n ? card : null, chips, trace };
}

/** The party size was a guess: one tap repeats the request for one or for four. */
function partyChips(l: Locale, typed: string, now: number): string[] | undefined {
  const s = typed.replace(/[.!?。]+$/u, '').trim();
  if (!s || s.length > 60) return undefined;
  const one = (n: number) => (n === 1
    ? tf(l, { en: '{s}, for {n}', ru: '{s}, на {n} человека', th: '{s} สำหรับ {n} คน' }, { s, n })
    : tf(l, { en: '{s}, for {n}', ru: '{s}, на {n} человек', th: '{s} สำหรับ {n} คน' }, { s, n }));
  return [now === 1 ? 2 : 1, 4].map(one);
}

function errorTurn(l: Locale, err: any, trace: TraceEntry[], ask?: TripAsk): AriTurn {
  const code = err?.code;
  if (code === 'PLACE_NOT_FOUND' || code === 'PLACE_AMBIGUOUS') {
    const field: string | undefined = err.details?.field;
    // The place is shown in quotes: quotes the user typed around it are dropped first.
    const said = ((field === 'pickup' ? ask?.pickup : ask?.dropoff) ?? '').replace(/^[\s"'«»“”„‘’「」『』]+|[\s"'«»“”„‘’「」『』]+$/gu, '');
    // A suggestion that is the other end of the trip would be a trip from a place to itself.
    const otherSaid = field === 'pickup' ? ask?.dropoff : ask?.pickup;
    const other = otherSaid ? resolvePlace(otherSaid) : null;
    const sug: string[] = (err.details?.suggestions ?? []).filter((s: string) => !(other?.ok && other.place.name === s)).slice(0, 4);
    const airports = sug.length > 0 && sug.every((s) => /airport/i.test(s));
    // An outside place is named by itself, without the words around it ("ภูเก็ตได้ไหม" is "ภูเก็ต").
    const out = OUTSIDE.exec(said);
    const outName = out ? (/[\u0E00-\u0E7F]/.test(out[0]) ? out[0] : said.slice(0, out.index + out[0].length).split(/\s+/).pop()! + (/^[\p{L}]*/u.exec(said.slice(out.index + out[0].length))?.[0] ?? '')) : '';
    const shown = outName || (said.length > 40 ? `${said.slice(0, 40)}…` : said);
    const reply = code === 'PLACE_AMBIGUOUS'
      ? airports
        ? t(l, { en: 'Bangkok has two airports. Which one?', ru: 'В Бангкоке два аэропорта. Какой нужен?', th: 'กรุงเทพฯ มีสนามบินสองแห่งค่ะ หมายถึงที่ไหนคะ' })
        : t(l, { en: 'Which one do you mean?', ru: 'Какое место вы имеете в виду?', th: 'หมายถึงที่ไหนคะ' })
      : OUTSIDE.test(said)
      ? tf(l, { en: '"{place}" is outside the demo area: rides and parcels here run within Bangkok only. Try one of these:', ru: '«{place}» за пределами демо-зоны: поездки и посылки здесь только по Бангкоку. Например:', th: '"{place}" อยู่นอกพื้นที่เดโมค่ะ ที่นี่เรียกรถและส่งพัสดุได้เฉพาะในกรุงเทพฯ ลองเลือกจากรายการนี้นะคะ' }, { place: shown })
      : shown
      ? tf(l, { en: 'I could not find "{place}" on the Bangkok demo map. Try one of these:', ru: 'Не нашла «{place}» на демо-карте Бангкока. Например:', th: 'Ari หา "{place}" บนแผนที่เดโมของกรุงเทพฯ ไม่พบค่ะ ลองเลือกจากรายการนี้นะคะ' }, { place: shown })
      : t(l, { en: 'I could not find that place on the Bangkok demo map. Try one of these:', ru: 'Не нашла это место на демо-карте Бангкока. Например:', th: 'Ari หาสถานที่นี้บนแผนที่เดโมของกรุงเทพฯ ไม่พบค่ะ ลองเลือกจากรายการนี้นะคะ' });
    return { reply, chips: sug.map((s) => placeChip(l, ask, field, s)), trace };
  }
  // Protocol-level text (argument validation) is for developers, not for the chat.
  const msg = String(err?.message ?? '');
  // So are refusals of a hand-made call ("store_id is required", "Order not found"): the chat gets the general sentence.
  const known = /^MCP error/.test(msg) || code === 'VALIDATION_FAILED' || code === 'NOT_FOUND' ? undefined : localText(msg, l);
  // English provider text has no place in a Russian or Thai chat: fall back to the general sentence.
  const fits = known && (l === 'en' || known !== msg);
  return { reply: (fits ? known : undefined) ?? t(l, { en: 'Something went wrong. Please try again.', ru: 'Что-то пошло не так. Попробуйте ещё раз.', th: 'เกิดข้อผิดพลาด กรุณาลองอีกครั้งค่ะ' }), chips: ariExamples(l).slice(0, 3), trace };
}

/** What the chat says when an endpoint refuses: the reason in plain words, in the chat language. */
function humanError(l: Locale, err: DomainError): string {
  const reason = (err.details as any)?.reason;
  const M: Record<string, Tri> = {
    DECLINED: { en: 'You declined this order earlier, so nothing was ordered. Ask me again and I will prepare a fresh card.', ru: 'Вы отказались от этого заказа, поэтому ничего не заказано. Попросите ещё раз, и я подготовлю новую карточку.', th: 'คุณกดไม่ยืนยันรายการนี้ไปแล้ว จึงยังไม่มีการสั่งซื้อค่ะ บอก Ari อีกครั้งได้เลย แล้ว Ari จะเตรียมการ์ดใหม่ให้' },
    CHANGED: { en: 'This card is out of date: the order changed after it was shown, so nothing was ordered. Please use the newest card.', ru: 'Эта карточка устарела: заказ изменился после её показа, поэтому ничего не заказано. Подтвердите на самой новой карточке.', th: 'การ์ดนี้ไม่เป็นปัจจุบันแล้วค่ะ รายการมีการเปลี่ยนแปลงหลังจากแสดงการ์ด จึงยังไม่มีการสั่งซื้อ กรุณายืนยันบนการ์ดล่าสุด' },
    CONFIRMATION_EXPIRED: { en: 'This card has expired and nothing was ordered. Ask me again for a fresh price.', ru: 'Срок этой карточки истёк, ничего не заказано. Попросите ещё раз, и я покажу актуальную цену.', th: 'การ์ดนี้หมดอายุแล้วและยังไม่มีการสั่งซื้อค่ะ บอก Ari อีกครั้งเพื่อดูราคาล่าสุดได้เลย' },
    CANCELLATION_NOT_ALLOWED: { en: 'This order can no longer be cancelled.', ru: 'Этот заказ уже нельзя отменить.', th: 'คำสั่งซื้อนี้ยกเลิกไม่ได้แล้วค่ะ' },
    NOT_FOUND: { en: 'I can\'t find that order or card any more. Please ask me again.', ru: 'Не нахожу этот заказ или карточку. Попросите, пожалуйста, ещё раз.', th: 'Ari หาคำสั่งซื้อหรือการ์ดนี้ไม่พบแล้วค่ะ กรุณาบอกอีกครั้งนะคะ' },
    AUTH_REQUIRED: { en: 'The demo session ended. Start again.', ru: 'Демо-сессия завершилась. Начните заново.', th: 'เซสชันเดโมสิ้นสุดแล้วค่ะ กรุณาเริ่มใหม่อีกครั้ง' },
    RATE_LIMITED: { en: 'The demo is busy right now. Please try again in a few minutes.', ru: 'Демо сейчас занято. Попробуйте через несколько минут.', th: 'ตอนนี้มีผู้ใช้เดโมจำนวนมากค่ะ กรุณาลองใหม่ในอีกสักครู่' },
    STEP_UP_REQUIRED: { en: 'This total needs Face ID or the device passcode before I can place the order.', ru: 'Для этой суммы нужно подтверждение по Face ID или коду устройства.', th: 'ยอดนี้ต้องยืนยันด้วย Face ID หรือรหัสผ่านของเครื่องก่อนค่ะ' },
    OTHER: { en: 'That did not go through and nothing was ordered. Please try again.', ru: 'Не получилось, ничего не заказано. Попробуйте ещё раз.', th: 'ดำเนินการไม่สำเร็จและยังไม่มีการสั่งซื้อค่ะ กรุณาลองอีกครั้ง' },
  };
  const key = err.code === 'CONFIRMATION_INVALIDATED' ? (reason === 'DECLINED' ? 'DECLINED' : 'CHANGED')
    : err.code === 'CONFIRM_HASH_MISMATCH' ? 'CHANGED'
    : err.code;
  if (err.code === 'CANCELLATION_NOT_ALLOWED') {
    // The provider's own reason when it is already in the chat language ("the trip has started").
    const own = localText(err.message, l);
    if (own && (l === 'en' ? /^Cannot cancel/.test(own) : own !== err.message)) return own;
  }
  return t(l, M[key] ?? M.OTHER);
}

// ---------------------------------------------------------------- HTTP

/** A text field of a request body. Missing is empty; any other type is refused (never coerced: String() of a crafted object throws). */
function field(body: unknown, key: string): string {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new DomainError('VALIDATION_FAILED', `${key} must be a string`);
  return v;
}

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
  // The lock statement has no parameters, so it can travel with BEGIN (see txLeading).
  const u = await txLeading(ctx.db, "SELECT pg_advisory_xact_lock(hashtext('unyly.guest_create'))", async (q) => {
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

/**
 * The demo user of a sealed cookie value, or null when it no longer exists. Database errors are not "no user": they propagate.
 * `want`: rows of that user the request needs anyway, read in the same statement.
 */
async function demoUser(ctx: Ctx, ext: string, want: UserExtras = {}): Promise<{ user: PartnerUser; extra: UserExtrasResult } | null> {
  try {
    return await loadPartnerUserWith(ctx, P, ext, want);
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
    if (origin && origin !== ctx.cfg.webOrigin && !(ctx.cfg.webOriginAliases ?? []).includes(origin)) throw new DomainError('AUTH_REQUIRED', 'Cross-site request blocked');
  };
  const send = (reply: FastifyReply, data: unknown, status = 200) => reply.code(status).header('cache-control', 'no-store').send(data);
  const fail = (reply: FastifyReply, e: unknown, req?: FastifyRequest) => {
    const err = isDomainError(e) ? e : new DomainError('INTERNAL', 'Something went wrong. Please try again.');
    if (!isDomainError(e)) console.error('[ari-demo]', e);
    // The page shows this text to the person in the chat: plain words in their language, never tool instructions.
    let l: Locale = 'en';
    try {
      if (req) l = chatLocale(detectLocale(req));
    } catch { /* keep English */ }
    return send(reply, { ok: false, error: { code: err.code, message: humanError(l, err), details: err.details } }, err.httpStatus);
  };
  /** The sealed cookie is checked before a request body is looked at (as when the user was loaded first). */
  const needSession = (req: FastifyRequest) => {
    if (!openExt(ctx, (req.cookies as any)?.[COOKIE])) throw new DomainError('AUTH_REQUIRED', 'Start the demo first.');
  };
  const currentWith = async (req: FastifyRequest, want: UserExtras): Promise<{ user: PartnerUser; extra: UserExtrasResult }> => {
    const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
    if (!ext) throw new DomainError('AUTH_REQUIRED', 'Start the demo first.');
    const got = await demoUser(ctx, ext, want);
    if (!got) throw new DomainError('AUTH_REQUIRED', 'The demo session ended. Start again.');
    const u = got.user;
    const l = detectLocale(req);
    if (l !== u.locale) {
      await ctx.db.query('UPDATE users SET locale = $2 WHERE id = $1', [u.user_id, l]);
      u.locale = l;
      if (u.row) u.row.locale = l;
    }
    return got;
  };
  const current = async (req: FastifyRequest): Promise<PartnerUser> => (await currentWith(req, {})).user;
  const rl = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.post('/ari/api/session', rl(60), async (req, reply) => {
    try {
      guard(req);
      const l = detectLocale(req);
      let u: PartnerUser | null = null;
      const ext = openExt(ctx, (req.cookies as any)?.[COOKIE]);
      // A returning visitor: the user, the Grab link and the newest event number in one statement.
      const back = ext ? await demoUser(ctx, ext, { session: true }) : null;
      if (back) u = back.user;
      if (!u) {
        u = await createDemoUser(ctx, req.ip, l);
        reply.setCookie(COOKIE, sealExt(ctx, u.external_user_id), { httpOnly: true, secure: ctx.cfg.cookieSecure, sameSite: 'lax', path: '/ari', maxAge: 24 * 3600 });
      }
      // A user created by this request has no Grab link and no events yet; for a returning one both came with the user.
      const [grab, lastEvent] = back ? [grabLinkView(back.extra.grab), back.extra.lastEvent ?? 0] : [{ linked: false, linked_at: null, simulated: false }, 0];
      return send(reply, {
        ok: true, user: { id: u.external_user_id }, grab, examples: ariExamples(l), last_event: lastEvent,
        greeting: tr(l, { en: 'Hi, I\'m Ari. Tell me what you need from Grab and I\'ll take care of it. Nothing is ordered until you confirm.', ru: 'Здравствуйте, я Ari. Скажите, что нужно от Grab, и я всё сделаю. Ничего не заказывается без вашего подтверждения.', th: 'สวัสดีค่ะ Ari เองค่ะ บอกได้เลยว่าต้องการอะไรจาก Grab เดี๋ยว Ari จัดการให้ และจะยังไม่สั่งอะไรจนกว่าคุณจะยืนยันค่ะ' }),
      });
    } catch (e) {
      return fail(reply, e, req);
    }
  });

  app.post('/ari/api/message', rl(90), async (req, reply) => {
    try {
      guard(req);
      // The saved addresses come with the user: a trip or a food search needs them, and so does every cart.
      const u = (await currentWith(req, { addresses: true })).user;
      // A message that is not text is an empty message (Ari greets); it is never coerced: String() of a crafted object throws.
      const t0 = (req.body as any)?.text;
      const text = typeof t0 === 'string' ? t0 : '';
      return send(reply, { ok: true, ...(await ariRespond(ctx, u, text)) });
    } catch (e) {
      return fail(reply, e, req);
    }
  });

  app.post('/ari/api/action', rl(90), async (req, reply) => {
    try {
      guard(req);
      const u = (await currentWith(req, { addresses: true })).user;
      const b = (req.body && typeof req.body === 'object' ? req.body : {}) as any;
      const name = field(b, 'tool');
      if (!ALLOWED_TOOLS.has(name)) throw new DomainError('VALIDATION_FAILED', 'Unknown action');
      const args = b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments) ? b.arguments : {};
      const trace: TraceEntry[] = [];
      const r = await traced(trace, `POST /partner/v1/users/${u.external_user_id}/tools/${name}`, grabFor(name, args), () => runTool(ctx, P, u, name, args));
      if (!r.ok) return send(reply, { ok: true, ...errorTurn(chatLocale(u.locale), r.error, trace) });
      const l = chatLocale(u.locale);
      const reply2 = r.card?.type === 'checkout'
        ? tr(l, { en: 'Here is everything with the final price. Tap Confirm when you are ready.', ru: 'Вот всё с итоговой ценой. Нажмите «Подтвердить», когда будете готовы.', th: 'นี่คือรายละเอียดทั้งหมดพร้อมราคาสุทธิ แตะยืนยันเมื่อพร้อมนะคะ' })
        : '';
      return send(reply, { ok: true, reply: reply2, card: r.card, trace });
    } catch (e) {
      return fail(reply, e, req);
    }
  });

  app.post('/ari/api/confirm', rl(60), async (req, reply) => {
    try {
      guard(req);
      needSession(req);
      const b = (req.body && typeof req.body === 'object' ? req.body : {}) as any;
      const id = field(b, 'checkout_id');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Checkout not found');
      // The user and the checkout (for the unlocked checks before the confirmation) in one statement.
      const { user: u, extra } = await currentWith(req, { checkoutId: id });
      const trace: TraceEntry[] = [];
      const r = await traced(trace, `POST /partner/v1/users/${u.external_user_id}/checkouts/${id}/confirm`, null, () => confirmCheckout(ctx, P, u, id, {
        confirm_hash: b.confirm_hash, user_verification: 'biometric', confirmed_at: ctx.clock.now().toISOString(), device_id: 'web-demo',
      }, { pre: extra.checkout }));
      // The service for the trace line comes from the order card of the result; only when there is no order yet is it looked up.
      const service = r.order?.card.service
        ?? (await ctx.db.query('SELECT k.service FROM checkouts c JOIN carts k ON k.id = c.cart_id WHERE c.id = $1 AND c.user_id = $2', [id, u.user_id])).rows[0]?.service;
      trace[0].grab = service === 'express' ? 'GrabPay · charge/init + GrabExpress · POST /v1/deliveries' : service === 'ride' ? 'Ride booking scope (requested) · today: Grab deep link' : 'GrabFood / GrabMart order scope (requested)';
      const l = chatLocale(u.locale);
      return send(reply, {
        ok: true,
        reply: tr(l, { en: 'Done! I\'ll keep you posted and call you when it matters.', ru: 'Готово! Буду сообщать о статусе и позвоню, когда будет важно.', th: 'เรียบร้อยค่ะ Ari จะคอยแจ้งสถานะ และโทรหาเมื่อถึงจังหวะสำคัญนะคะ' }),
        card: r.order?.card ?? null, order_id: r.order?.id ?? null, trace,
      });
    } catch (e) {
      return fail(reply, e, req);
    }
  });

  app.post('/ari/api/decline', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const id = field(req.body, 'checkout_id');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Checkout not found');
      // The card below is read after the decline and shows its result; no separate status read is needed here.
      await declineCheckout(ctx, u.user_id, id, `partner:${P.id}`);
      return send(reply, { ok: true, reply: tr(chatLocale(u.locale),{ en: 'No problem, nothing was ordered.', ru: 'Хорошо, ничего не заказано.', th: 'ได้ค่ะ ยังไม่ได้สั่งอะไรนะคะ' }), card: await checkoutCard(ctx, P, u, id) });
    } catch (e) {
      return fail(reply, e, req);
    }
  });

  app.get('/ari/api/orders/:id', rl(240), async (req, reply) => {
    try {
      guard(req);
      needSession(req);
      const id = String((req.params as any).id ?? '');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Order not found');
      // The poll: the user, the order and its simulator row in one statement; nothing else when there is no news.
      // Optional ?after=<seq>: the same answer also carries the user's events after that number (what
      // GET /ari/api/events returns), so a page can poll one endpoint instead of two.
      const afterRaw = (req.query as any)?.after;
      const after = afterRaw === undefined ? undefined : Math.max(Number(afterRaw) || 0, 0);
      const { user: u, extra } = await currentWith(req, { orderId: id, eventsAfter: after });
      if (!extra.order) throw new DomainError('NOT_FOUND', 'Order not found');
      const card = await orderCard(ctx, P, u, id, { refresh: true, known: extra.order });
      if (after === undefined) return send(reply, { ok: true, card });
      // A status this very poll picked up wrote its event after the read above: read the events again in that case only.
      const moved = card.status?.code !== extra.order.order.fulfillment_status;
      const events = moved ? await listPartnerEvents(ctx, u.user_id, after) : (extra.events ?? []).map(storedEvent);
      return send(reply, { ok: true, card, events });
    } catch (e) {
      return fail(reply, e, req);
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
      return fail(reply, e, req);
    }
  });

  app.post('/ari/api/cancel', rl(20), async (req, reply) => {
    try {
      guard(req);
      needSession(req);
      const id = field(req.body, 'order_id');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Order not found');
      // The user, the order and its simulator row in one statement.
      const { user: u, extra } = await currentWith(req, { orderId: id });
      const r = await prepareCancelPartner(ctx, P, u, id, extra.order ?? undefined);
      return send(reply, { ok: true, reply: tr(chatLocale(u.locale),{ en: 'Here are the cancellation terms:', ru: 'Условия отмены:', th: 'นี่คือเงื่อนไขการยกเลิกค่ะ' }), card: r.card });
    } catch (e) {
      return fail(reply, e, req);
    }
  });

  app.post('/ari/api/cancel/confirm', rl(20), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const b = (req.body && typeof req.body === 'object' ? req.body : {}) as any;
      const id = field(b, 'cancellation_id');
      if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', 'Cancellation not found');
      const full = await confirmCancelWithRows(ctx, P, u, id, { confirm_hash: b.confirm_hash, user_verification: 'tap', confirmed_at: ctx.clock.now().toISOString() });
      const r = full.out;
      const done = r.cancellation.status === 'executed';
      return send(reply, {
        ok: true,
        reply: done
          ? tr(chatLocale(u.locale),{ en: 'Cancelled.', ru: 'Заказ отменён.', th: 'ยกเลิกแล้วค่ะ' })
          : tr(chatLocale(u.locale),{ en: 'The cancellation did not go through; the order continues.', ru: 'Отменить не получилось, заказ продолжается.', th: 'ยกเลิกไม่สำเร็จค่ะ คำสั่งซื้อยังดำเนินต่อ' }),
        card: r.order.card,
        cancel_card: await cancellationCard(ctx, P, u, id, full.request, full.order),
      });
    } catch (e) {
      return fail(reply, e, req);
    }
  });

  app.post('/ari/api/grab-link', rl(10), async (req, reply) => {
    try {
      guard(req);
      const u = await current(req);
      const r = await startGrabLink(ctx, P, u);
      return send(reply, { ok: true, grab: r });
    } catch (e) {
      return fail(reply, e, req);
    }
  });
}
