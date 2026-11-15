import { packs } from '../i18n/index.js';
// Tiny rule-based parser for the /try guided demo. It only mimics what an AI assistant would
// extract from a request (party size, budget, allergies, diet, cuisine). Real assistants do this
// themselves and call the MCP tools with structured arguments.

export interface Intent {
  party_size?: number;
  budget_total_major?: number;
  exclude_allergens: string[];
  dietary: string[];
  cuisine?: string;
}

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, couple: 2,
  'одного': 1, 'двоих': 2, 'троих': 3, 'четверых': 4, 'пятерых': 5, 'шестерых': 6, 'двое': 2, 'трое': 3, 'четверо': 4,
  'หนึ่ง': 1, 'สอง': 2, 'สาม': 3, 'สี่': 4, 'ห้า': 5, 'หก': 6,
};

// Negation/exclusion cue followed closely by the allergen word (EN/RU are spaced; Thai is not).
// Words between the cue and the allergen may not cross a comma ("no pork , extra fish").
const NEG_EN = String.raw`(?<![a-z])(?:no|without|free of|avoid|not)\s+(?:[^\s,]+\s+){0,2}?`;
const NEG_RU = String.raw`(?<!\p{L})(?:без|не)\s+(?:[^\s,]+\s+){0,2}?`;
/** After an allergy cue, every allergen word until the end of the sentence counts. */
const ALLERGY_CUE = /(?<![a-z])allerg\S*|(?<!\p{L})аллерги\S*|แพ้/u;
const NEG_TH = String.raw`(?:ไม่ใส่|ไม่เอา|ไม่กิน|แพ้|ไม่มี|งด)\S{0,6}?`;

const ALLERGEN_WORDS: [string[], string, string, string, string?][] = [
  // [allergens], en, ru, th, suffix-form (en "nut-free", "nut allergy")
  [['peanut', 'tree_nut'], 'nuts?|peanuts?|cashews?', 'орех\\S*|арахис\\S*', 'ถั่ว(?!เหลือง)'],
  [['shellfish'], 'shellfish|shrimps?|prawns?|crabs?|lobsters?|clams?|mussels?|oysters?', 'кревет\\S*|морепродукт\\S*|моллюск\\S*|краб\\S*|миди\\S*|устриц\\S*', 'กุ้ง|อาหารทะเล|หอย|ปู'],
  [['milk'], 'dairy|milk|lactose', 'молок\\S*|молочн\\S*|лактоз\\S*', 'นม'],
  [['egg'], 'eggs?', 'яйц\\S*|яиц\\S*', 'ไข่'],
  [['wheat'], 'gluten|wheat', 'глютен\\S*|пшениц\\S*', 'กลูเตน|แป้งสาลี'],
  [['soy'], 'soy|soya', 'со[яиеюй]\\S*', 'ถั่วเหลือง'],
  [['fish'], 'fish', 'рыб\\S*', 'ปลา'],
  [['sesame'], 'sesame', 'кунжут\\S*', 'งา'],
];

// ---------------- Language packs (vi, id, ms, fil, km, my, zh) ----------------
const UNSPACED = /[^\u0000-\u024F\u0400-\u04FF\s]/;
const reEsc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Index of a word in lowercased text: word start for spaced scripts, plain substring for scripts without spaces. */
function findWord(q: string, w: string, from = 0): number {
  if (!w) return -1;
  if (UNSPACED.test(w)) return q.indexOf(w, from);
  const m = new RegExp(`(^|[^\\p{L}\\p{M}])${reEsc(w)}`, 'u').exec(q.slice(from));
  return m ? from + m.index + m[1].length : -1;
}
const hasWord = (q: string, words: string[] | undefined) => (words ?? []).some((w) => findWord(q, w.toLowerCase()) >= 0);
const PACKS = packs();
const all = <T>(f: (p: (typeof PACKS)[number][1]) => T[] | undefined): T[] => PACKS.flatMap(([, p]) => f(p) ?? []);
const lc = (a: string[]) => a.map((x) => x.toLowerCase()).filter(Boolean);
export const PK = {
  service: {
    ride: lc(all((p) => p.service_words?.ride)), express: lc(all((p) => p.service_words?.express)), flowers: lc(all((p) => p.service_words?.flowers)),
    pharmacy: lc(all((p) => p.service_words?.pharmacy)), cakes: lc(all((p) => p.service_words?.cakes)), groceries: lc(all((p) => p.service_words?.groceries)),
  },
  meal: lc(all((p) => p.meal_words)),
  weight: lc(all((p) => p.weight_units)),
  negation: lc(all((p) => p.negation)),
  allergyCue: lc(all((p) => p.allergy_cue)),
  people: lc(all((p) => p.party?.people)),
  partyCue: lc(all((p) => p.party?.cue)),
  budget: lc(all((p) => p.budget_cues)),
  currency: lc(all((p) => p.currency_words)),
  numbers: Object.fromEntries(all((p) => Object.entries(p.number_words ?? {})).map(([k, v]) => [k.toLowerCase(), Number(v)])) as Record<string, number>,
  allergens: Object.fromEntries(['peanut', 'shellfish', 'milk', 'egg', 'wheat', 'soy', 'fish', 'sesame'].map((a) => [a, lc(all((p) => (p.allergens as any)?.[a]))])) as Record<string, string[]>,
  diet: Object.fromEntries(['vegan', 'vegetarian', 'halal', 'no_pork'].map((d) => [d, lc(all((p) => (p.diet as any)?.[d]))])) as Record<string, string[]>,
  routes: PACKS.map(([lang, p]) => ({ lang, from: lc(p.route?.from ?? []), to: lc(p.route?.to ?? []) })),
};
/** Languages that put "from"/"to" after the place (Burmese: X မှ Y သို့). */
const POSTPOSITIONAL = new Set(['my']);
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;

/** Fills what the built-in EN/RU/TH rules missed, using the language packs. */
function packIntent(q: string, out: Intent) {
  if (out.party_size === undefined) {
    for (const w of PK.people) {
      const m = new RegExp(`(\\d{1,2})\\s*${reEsc(w)}`, 'u').exec(q) ?? (UNSPACED.test(w) ? null : new RegExp(`${reEsc(w)}\\s*(\\d{1,2})`, 'u').exec(q));
      if (m) { out.party_size = Number(m[1]); break; }
    }
    if (out.party_size === undefined) {
      // "两人", "สองคน": a number word directly followed by a people word.
      outer: for (const [k, n] of Object.entries(PK.numbers)) for (const w of PK.people) if (q.includes(k + w) || q.includes(`${k} ${w}`)) { out.party_size = n; break outer; }
    }
    if (out.party_size === undefined) {
      const hit = Object.keys(PK.numbers).filter((k) => k.length > 1 && findWord(q, k) >= 0).sort((a, b) => b.length - a.length)[0];
      if (hit) out.party_size = PK.numbers[hit];
    }
    if (out.party_size !== undefined) out.party_size = Math.min(Math.max(out.party_size, 1), 12);
  }
  if (out.budget_total_major === undefined) {
    for (const w of PK.budget) {
      const i = findWord(q, w);
      if (i < 0) continue;
      const m = /(\d{2,6})/.exec(q.slice(i + w.length, i + w.length + 16));
      if (m) { out.budget_total_major = Math.min(Number(m[1]), 100000); break; }
    }
    if (out.budget_total_major === undefined) {
      for (const w of PK.currency) {
        const m = new RegExp(`(\\d{2,6})\\s*${reEsc(w)}`, 'u').exec(q);
        if (m) { out.budget_total_major = Math.min(Number(m[1]), 100000); break; }
      }
    }
  }
  // Allergens: a negation cue shortly before the word, or an allergy cue anywhere before it.
  const cueBefore = (i: number, len: number) =>
    PK.negation.some((n) => { const j = q.lastIndexOf(n, i); return j >= 0 && i - (j + n.length) <= 14; }) ||
    // Languages that put the negation after the noun (Burmese "X မပါ", Filipino "walang X" is before): short window after.
    PK.negation.some((n) => { const j = q.indexOf(n, i + len); return j >= 0 && j - (i + len) <= 6; }) ||
    PK.allergyCue.some((c) => { const j = q.lastIndexOf(c, i); return j >= 0 && j < i; });
  for (const [code, words] of Object.entries(PK.allergens)) {
    for (const w of words) {
      const i = findWord(q, w);
      if (i >= 0 && cueBefore(i, w.length)) {
        for (const c of code === 'peanut' ? ['peanut', 'tree_nut'] : [code]) if (!out.exclude_allergens.includes(c)) out.exclude_allergens.push(c);
        break;
      }
    }
  }
  if (!out.dietary.length) {
    if (hasWord(q, PK.diet.vegan)) out.dietary.push('vegan');
    else if (hasWord(q, PK.diet.vegetarian)) out.dietary.push('vegetarian');
  }
  if (!out.dietary.includes('halal') && hasWord(q, PK.diet.halal)) out.dietary.push('halal');
  if (!out.dietary.includes('no_pork') && hasWord(q, PK.diet.no_pork)) out.dietary.push('no_pork');
}

export function parseIntent(input: string): Intent {
  const lower = input.toLowerCase();
  const q = ` ${lower.replace(/,/g, ' , ').replace(/[.;!?():]/g, ' ').replace(/\s+/g, ' ')} `;
  // Sentences that follow an allergy cue ("allergic to shrimp, crab and peanuts", "Allergy: peanuts").
  const allergyTail = lower
    .split(/[.;!?\n]/)
    .map((sentence) => {
      const m = ALLERGY_CUE.exec(sentence);
      return m ? sentence.slice(m.index) : '';
    })
    .join(' ');
  const out: Intent = { exclude_allergens: [], dietary: [] };

  // Budget: a number next to a currency word or after a budget cue.
  const budget =
    /(?:under|below|up to|max(?:imum)?|within|budget(?: of)?|less than|до|не дороже|бюджет|ไม่เกิน|งบ)\s*(?:฿|thb)?\s*(\d{2,6})/.exec(q) ??
    /(\d{2,6})\s*(?:฿|baht|thb|бат\S*|บาท)/.exec(q) ??
    /฿\s*(\d{2,6})/.exec(q);
  if (budget) out.budget_total_major = Math.min(Number(budget[1]), 100000);

  // Party size.
  const party =
    /(?:for|на|สำหรับ)\s*(\d{1,2})\s*(?:people|persons|pax|guests|of us|человек\S*|чел|персон\S*|คน)?/.exec(q) ??
    /(\d{1,2})\s*(?:people|persons|pax|guests|of us|человек\S*|чел|персон\S*|คน)/.exec(q);
  if (party && Number(party[1]) !== out.budget_total_major) out.party_size = Number(party[1]);
  else {
    // A whole word only: "someone", "phone" and "острое" hold no number.
    const w = /(?<!\p{L})(?:for |на |สำหรับ\s*)?(one|two|three|four|five|six|couple|одного|двоих|троих|четверых|пятерых|шестерых|двое|трое|четверо)(?=\s)|(หนึ่ง|สอง|สาม|สี่|ห้า|หก)\s*คน/u.exec(q);
    if (w) out.party_size = WORD_NUM[w[1] ?? w[2]];
    // "me and my two colleagues", "я и двое коллег": the speaker counts too.
    const plus = /(?<!\p{L})(?:me|myself|i) and (?:my )?(\d{1,2}|one|two|three|four|five|six|a|an) (?:\p{L}+ )?(?:colleagues?|friends?|coworkers?|guests?|kids?|children|people)|(?<!\p{L})(?:я|мы|мне|нам) и (?:мо[ийя]х? )?(\d{1,2}|двое|трое|четверо|два|две|три|четыре|пять) (?:коллег|друз|друг|подруг|гост|реб|дет)/u.exec(q);
    if (plus) {
      const k = plus[1] ?? plus[2];
      const n = /^\d+$/.test(k) ? Number(k) : ({ a: 1, an: 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5 } as Record<string, number>)[k] ?? WORD_NUM[k];
      if (n) out.party_size = n + 1;
    }
  }
  if (out.party_size !== undefined) out.party_size = Math.min(Math.max(out.party_size, 1), 12);

  for (const [codes, en, ru, th] of ALLERGEN_WORDS) {
    const hit =
      new RegExp(`${NEG_EN}(?:${en})\\b`, 'u').test(q) ||
      new RegExp(`(?:${en})[- ](?:free|allergy)`, 'u').test(q) ||
      new RegExp(`${NEG_RU}(?:${ru})`, 'u').test(q) ||
      new RegExp(`${NEG_TH}(?:${th})`, 'u').test(q) ||
      new RegExp(`(?<![a-z])(?:${en})\\b|(?:${ru})|(?:${th})`, 'u').test(allergyTail);
    if (hit) for (const c of codes) if (!out.exclude_allergens.includes(c)) out.exclude_allergens.push(c);
  }
  // "No soy" must not also exclude peanuts: the Thai soy word contains the nut word.
  if (/(?:ไม่ใส่|ไม่เอา|แพ้|ไม่มี|งด)\S{0,6}?ถั่วเหลือง/.test(q) && !/(?:ไม่ใส่|ไม่เอา|แพ้|ไม่มี|งด)\S{0,6}?ถั่ว(?!เหลือง)/.test(q)) {
    out.exclude_allergens = out.exclude_allergens.filter((a) => a !== 'peanut' && a !== 'tree_nut');
  }

  if (/\bvegan\b|веган|วีแกน/.test(q)) out.dietary.push('vegan');
  else if (/vegetarian|veggie|вегетариан|มังสวิรัติ|\sเจ\s|อาหารเจ/.test(q)) out.dietary.push('vegetarian');
  if (/halal|халял|ฮาลาล/.test(q)) out.dietary.push('halal');
  if (/no pork|without pork|(?:not|n't|never) eat(?:s|ing)? pork|без свинин|не (?:ест|ем|едим|едят) свинин|ไม่(?:กิน|เอา|ใส่|ทาน)หมู/.test(q)) out.dietary.push('no_pork');

  packIntent(lower, out);
  if (/seafood|морепродукт|อาหารทะเล/.test(q) && !out.exclude_allergens.includes('shellfish')) out.cuisine = 'seafood';
  else if (/noodle|лапш|ก๋วยเตี๋ยว|บะหมี่/.test(q)) out.cuisine = 'noodles';
  else if (/grill|bbq|гриль|шашлык|ย่าง/.test(q)) out.cuisine = 'grill';
  else if (/healthy|salad|bowl|полезн|салат|боул|สุขภาพ|สลัด/.test(q)) out.cuisine = 'healthy';
  else if (/burger|бургер|เบอร์เกอร์/.test(q)) out.cuisine = 'burgers';
  return out;
}

// ---------------- Service detection for the multi-service demo ----------------
// Again only a stand-in for what an assistant extracts; assistants call the MCP tools directly.

export type DemoService = 'food' | 'groceries' | 'flowers' | 'pharmacy' | 'cakes' | 'ride' | 'express';

export interface ServiceIntent {
  service: DemoService;
  pickup?: string;
  dropoff?: string;
  weight_kg?: number;
  passengers?: number;
  /** The sentence names the user's home ("taxi home", "из дома", "กลับบ้าน"): the caller puts the saved default place there. */
  pickup_home?: boolean;
  dropoff_home?: boolean;
}

const RIDE = /taxi|taksi|\btaxy\b|\btexi\b|\bcab\b|\bride\b|grabcar|justgrab|grabbike|grabtaxi|grabvan|\bbike to\b|\bcar to\b|\blift to\b|\bgrab to\b|такси|токси|мототакси|(?<!\p{L})байк\S* (?:до|в|на)(?!\p{L})|поездк|отвез|довез|подвез|машину до|แท็กซี่|แทกซี่|แท๊กซี่|เรียกรถ|นั่งรถ|รถไป|จองรถ|ขอรถ|หารถ|รถ(?:สำหรับ|ตู้|เก๋ง)|เรียกแกร็บ|วินมอเตอร์ไซค์|วิน(?=ไป)/u;
const EXPRESS = /parcel|package|courier|\bsend\b|посылк|отправ|курьер|พัสดุ|ส่งของ|ส่งเอกสาร|แมสเซนเจอร์/u;
// Weaker cues: they decide only when nothing in the sentence names a shop or a meal.
const SOFT_EXPRESS = /\bdeliver\b|\bdocuments?\b|\benvelope\b|(?<!\p{L})достав(?:ь|ьте|ить)(?!\p{L})|документ|(?<!\p{L})пакет(?!\p{L})|конверт|เอกสาร/u;
const SOFT_RIDE = /\b(?:take|drive|get|bring) me\b|\bpick me up\b|\b(?:go|going|get|heading) (?:to|home|back)\b|\b(?:a|the) (?:car|driver)\b|\bmotorbike\b|\bairport\b|\bhome\b|поехали|поеду|(?<!\p{L})едем(?!\p{L})|(?<!\p{L})(?:нужно|надо|хочу|мне) (?:в|на|до|домой)(?!\p{L})|(?<!\p{L})машин[ауы]?(?!\p{L})|(?<!\p{L})домой(?!\p{L})|из дома|аэропорт|กลับบ้าน|ไปบ้าน|ไปส่ง|สนามบิน/u;
/** A sentence that opens with "going to X" is a ride even when the place name looks like food (Khao San). */
const START_GO = /^\s*(?:ไป(?!กิน|ซื้อ|หา|ทาน)|(?:я\s+)?еду\s+(?:в|на|до|домой)(?!\p{L}))/u;
const HOME_PLACE = /^(?:to\s+)?(?:my\s+|the\s+)?(?:home|house|place)$|^(?:мой\s+|моего\s+)?(?:дом|дома|дому|домой)$|^(?:ที่)?บ้าน(?:ฉัน|ผม)?$/iu;
const HOME_WORD = /\bhome\b|(?<!\p{L})домой(?!\p{L})|กลับบ้าน|ไปบ้าน|ถึงบ้าน/iu;
/** True when a place phrase means the user's home. */
export const isHomePlace = (s: string | undefined) => !!s && HOME_PLACE.test(s.trim());
const FLOWERS = /flower|bouquet|roses?\b|lil(?:y|ies)|orchid|garland|цвет|букет|(?<!\p{L})роз[ыау]?(?!\p{L})|лили|орхиде|ดอกไม้|กุหลาบ|ช่อ|พวงมาลัย|กล้วยไม้/u;
const PHARMACY = /pharmac|painkiller|pain ?relief|ibuprofen|aspirin|vitamins?\b|\bcough|(?:a|the|my) cold\b|cold medicine|\bflu\b|diarrh|stomach ?ache|antihistamine|eye drops|bandage|first aid|face masks?|\bpills?\b|\btablets?\b|головн\S* бол|от головы|обезбол|ибупрофен|аспирин|витамин|кашл|кашел|простуд|насморк|понос|диаре|таблетк|(?<!\p{L})бинт|ยาพารา|ขอยา|ซื้อยา|ยาลดไข้|แอสไพริน|ไอบูโพรเฟน|วิตามิน|แก้ไอ|เป็นหวัด|ท้องเสีย|ปวดท้อง|หน้ากากอนามัย|paracetamol|plaster|band-?aid|thermometer|medicine|drugstore|headache|\bfever\b|sore throat|lozenge|sunscreen|repellent|antiseptic|аптек|парацетамол|пластыр|лекарств|градусник|термометр|болит голов|голова болит|от горл|болит горл|температур|от комаров|репеллент|от солнца|солнцезащит|антисепт|ร้านยา|ยาสามัญ|พาราเซตามอล|พลาสเตอร์|ปรอทวัดไข้|ยาแก้|ปวดหัว|เจ็บคอ|เป็นไข้|กันยุง|กันแดด|ยาอม/u;
const CAKES = /\bcakes?\b|cheesecake|торт|чизкейк|пирожн|เค้ก/u;
const GROCERY = /grocer|supermarket|(?<!море)продукт|супермаркет|ของชำ|ซูเปอร์มาร์เก็ต|ของใช้ในบ้าน/u;
const STAPLE = /\beggs?\b|\bmilk\b|\bwater\b|bananas?|\brice\b|\bcoffee\b|mango(?:es)?\b|яйц|молок|(?<!\p{L})кофе(?!\p{L})|манго|(?<!\p{L})вод[уаы](?!\p{L})|банан|(?<!\p{L})рис(?!\p{L})|ไข่ไก่|นมสด|น้ำดื่ม|กล้วย|ข้าวสาร|กาแฟ|มะม่วง|(?<!ข|ไม่ใส่|ไม่เอา|ไม่กิน|แพ้)นม/u;
const MEAL = /dinner|lunch|breakfast|meal|ужин|обед|завтрак|ข้าวเย็น|มื้อ|อาหารเย็น|อาหารกลางวัน/u;
const FOOD_CUE = /food|\beat|hungry|restaurant|pizza|burger|noodle|sushi|pad thai|curry|soup|salad|sandwich|chicken|tom yum|tom kha|som tam|fried rice|ramen|pasta|steak|kebab|dumpling|snack|fries|\bpho\b|taco|dim sum|bubble tea|dessert|ice cream|spicy|vegan|vegetarian|halal|еда|еды|еду|поесть|покушать|перекус|голод|ресторан|пицц|бургер|лапш|суши|суп|салат|том ям|том кха|пад тай|рамен|стейк|шаурм|плов|картошк\S* фри|пельмен|десерт|морожен|остр(?:ое|ого|енько)|(?<!\p{L})есть(?!\p{L})|веган|вегетариан|халял|อาหาร|กิน|หิว|ข้าว|ก๋วยเตี๋ยว|พิซซ่า|เบอร์เกอร์|ซูชิ|ส้มตำ|ผัดไทย|ต้มยำ|ไก่ทอด|แกง|ราเมง|สเต๊ก|ชานม|ของหวาน|ไอศกรีม|เผ็ด/u;
/** True when the sentence asks for a meal: a meal or dish word, or anything the food parser understood. */
export function hasFoodCue(input: string): boolean {
  const q = input.toLowerCase();
  if (MEAL.test(q) || FOOD_CUE.test(q) || hasWord(q, PK.meal)) return true;
  const i = parseIntent(input);
  return !!(i.cuisine || i.dietary.length || i.exclude_allergens.length || i.budget_total_major);
}

/** Every service the sentence names outright (not the default). Used to spot two requests in one sentence and small talk with no request at all. */
export function serviceCues(input: string): DemoService[] {
  const q = input.toLowerCase();
  const S = PK.service;
  const out: DemoService[] = [];
  if (RIDE.test(q) || hasWord(q, S.ride) || START_GO.test(q) || SOFT_RIDE.test(q)) out.push('ride');
  if (FLOWERS.test(q) || hasWord(q, S.flowers)) out.push('flowers');
  if (PHARMACY.test(q) || hasWord(q, S.pharmacy)) out.push('pharmacy');
  if (CAKES.test(q) || hasWord(q, S.cakes)) out.push('cakes');
  if (EXPRESS.test(q) || hasWord(q, S.express) || SOFT_EXPRESS.test(q)) out.push('express');
  if (GROCERY.test(q) || STAPLE.test(q) || hasWord(q, S.groceries)) out.push('groceries');
  if (MEAL.test(q) || FOOD_CUE.test(q) || hasWord(q, PK.meal)) out.push('food');
  return out;
}

/** Common misspellings of the words the demo map and the service rules look for. */
export function fixTypos(input: string): string {
  return input
    .replace(/\b(?:arport|airprot|airpot|aiport|aeroport|air port)\b/giu, 'airport')
    .replace(/(?<!\p{L})(?:аэрапорт|аеропорт|аиропорт)/giu, 'аэропорт')
    .replace(/สนามบิล/gu, 'สนามบิน');
}

const WEIGHT_UNITS =['kg', 'кг', 'กก', 'กิโล', ...PK.weight].sort((a, b) => b.length - a.length).map(reEsc).join('|');
const CUT = new RegExp(`,|;|，|、|。|\\bfor\\b|\\bwith\\b|\\bна\\s+\\d|\\bдля\\b|\\bс\\s+\\d|${NUM}\\s*(?:${WEIGHT_UNITS})|สำหรับ`, 'iu');
function cutPlace(s: string, last = false): string {
  const parts = s.split(CUT).filter((x) => x && x.trim());
  const piece = (last ? parts[parts.length - 1] : parts[0]) ?? '';
  return piece.replace(/[.!?！？]+$/, '').trim().slice(0, 120);
}

/** "from X to Y" in a pack language. Returns original-case slices. */
function packRoute(src: string): { pickup?: string; dropoff?: string; post?: boolean } | null {
  const q = src.toLowerCase();
  for (const r of PK.routes) {
    const post = POSTPOSITIONAL.has(r.lang);
    for (const f of r.from) {
      const fi = findWord(q, f);
      if (fi < 0) continue;
      for (const t of r.to) {
        const ti = findWord(q, t, fi + f.length);
        if (ti < 0) continue;
        return post
          ? { pickup: src.slice(0, fi), dropoff: src.slice(fi + f.length, ti), post: true }
          : { pickup: src.slice(fi + f.length, ti), dropoff: src.slice(ti + t.length) };
      }
    }
  }
  for (const r of PK.routes) {
    const post = POSTPOSITIONAL.has(r.lang);
    for (const t of r.to) {
      const ti = findWord(q, t);
      if (ti < 0) continue;
      return { dropoff: post ? src.slice(0, ti) : src.slice(ti + t.length), post };
    }
  }
  return null;
}

export function detectService(input: string): ServiceIntent {
  const q = input.toLowerCase();
  let service: DemoService = 'food';
  const S = PK.service;
  const meal = MEAL.test(q) || hasWord(q, PK.meal);
  if (RIDE.test(q) || hasWord(q, S.ride) || START_GO.test(q)) service = 'ride';
  else if (FLOWERS.test(q) || hasWord(q, S.flowers)) service = 'flowers';
  else if (PHARMACY.test(q) || hasWord(q, S.pharmacy)) service = 'pharmacy';
  else if (CAKES.test(q) || hasWord(q, S.cakes)) service = 'cakes';
  else if (EXPRESS.test(q) || hasWord(q, S.express)) service = 'express';
  else if (GROCERY.test(q) || (!meal && hasWord(q, S.groceries)) || (STAPLE.test(q) && !meal && !/\b(?:no|without)\s|без\s|ไม่ใส่|ไม่เอา/u.test(q))) service = 'groceries';
  else if (!meal && !FOOD_CUE.test(q) && SOFT_EXPRESS.test(q)) service = 'express';
  else if (!meal && !FOOD_CUE.test(q) && SOFT_RIDE.test(q)) service = 'ride';
  const out: ServiceIntent = { service };
  if (service === 'ride' || service === 'express') {
    // Match on the original text (case-insensitive) so place names keep their capitalisation.
    const src = input.trim();
    const m =
      /\bfrom\s+(.+?)\s+to\s+(.+)$/iu.exec(src) ??
      /(?:^|\s)(?:от|из|с)\s+(.+?)\s+(?:до|в|во|на)\s+(.+)$/iu.exec(src) ??
      /จาก\s*(.+?)\s*(?:ไปที่|ไป|ถึง)\s*(.+)$/iu.exec(src);
    const pr = m ? null : packRoute(src);
    if (m) {
      out.pickup = cutPlace(m[1]);
      out.dropoff = cutPlace(m[2]);
    } else if (pr) {
      // Postpositional: the place is the text right before the particle, so keep the last piece.
      if (pr.pickup) out.pickup = cutPlace(pr.pickup, pr.post) || undefined;
      if (pr.dropoff) out.dropoff = cutPlace(pr.dropoff, pr.post) || undefined;
    } else {
      const d = /(?:\bto|(?:^|\s)до|(?:^|\s)в|(?:^|\s)во|(?:^|\s)на|ไปที่|ไป)\s+(.+)$/iu.exec(src) ?? /(?:ไปที่|ไป)(.+)$/iu.exec(src);
      if (d) out.dropoff = cutPlace(d[1]);
    }
    // Home: "taxi home", "from Siam Paragon home", "из дома в аэропорт", "กลับบ้าน".
    if (isHomePlace(out.pickup)) { out.pickup = undefined; out.pickup_home = true; }
    if (isHomePlace(out.dropoff)) { out.dropoff = undefined; out.dropoff_home = true; }
    if (!out.dropoff && !out.dropoff_home && !out.pickup_home && HOME_WORD.test(src)) {
      out.dropoff_home = true;
      const f = /\bfrom\s+(.+?)(?:\s+(?:back\s+)?home\b.*)?$/iu.exec(src) ?? /(?:^|\s)(?:от|из|с)\s+(.+?)(?:\s+домой(?!\p{L}).*)?$/iu.exec(src) ?? /จาก\s*(.+?)\s*กลับบ้าน/iu.exec(src);
      if (f && !isHomePlace(cutPlace(f[1]))) out.pickup = cutPlace(f[1]) || undefined;
    }
    const w = new RegExp(`${NUM}\\s*(?:${WEIGHT_UNITS})`, 'iu').exec(q);
    if (w) out.weight_kg = Math.min(Number(w[1].replace(',', '.')), 1000);
    const p = parseIntent(input).party_size;
    if (p && service === 'ride') out.passengers = p;
  }
  return out;
}
