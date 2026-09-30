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
    const w = /(?:for |на |สำหรับ\s*)?(one|two|three|four|five|six|couple|одного|двоих|троих|четверых|пятерых|шестерых|двое|трое|четверо)(?=\s)|(หนึ่ง|สอง|สาม|สี่|ห้า|หก)\s*คน/.exec(q);
    if (w) out.party_size = WORD_NUM[w[1] ?? w[2]];
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
  if (/no pork|without pork|без свинин|ไม่(?:กิน|เอา|ใส่)หมู/.test(q)) out.dietary.push('no_pork');

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
}

const RIDE = /taxi|\bcab\b|\bride\b|grabcar|justgrab|grabbike|\bbike to\b|\bcar to\b|такси|поездк|отвез|довез|подвез|машину до|แท็กซี่|เรียกรถ|นั่งรถ|รถไป|วินมอเตอร์ไซค์/u;
const EXPRESS = /parcel|package|courier|\bsend\b|посылк|отправ|курьер|พัสดุ|ส่งของ|แมสเซนเจอร์/u;
const FLOWERS = /flower|bouquet|roses?\b|lil(?:y|ies)|orchid|garland|цвет|букет|роз[ыау]?\b|лили|орхиде|ดอกไม้|กุหลาบ|ช่อ|พวงมาลัย|กล้วยไม้/u;
const PHARMACY = /pharmac|paracetamol|plaster|band-?aid|thermometer|medicine|drugstore|аптек|парацетамол|пластыр|лекарств|градусник|термометр|ร้านยา|ยาสามัญ|พาราเซตามอล|พลาสเตอร์|ปรอทวัดไข้|ยาแก้/u;
const CAKES = /\bcakes?\b|cheesecake|торт|чизкейк|пирожн|เค้ก/u;
const GROCERY = /grocer|supermarket|продукт|супермаркет|ของชำ|ซูเปอร์มาร์เก็ต|ของใช้ในบ้าน/u;
const STAPLE = /\beggs?\b|\bmilk\b|\bwater\b|bananas?|\brice\b|яйц|молок|\bвод[уаы]\b|банан|\bрис\b|ไข่ไก่|นมสด|น้ำดื่ม|กล้วย|ข้าวสาร/u;
const MEAL = /dinner|lunch|breakfast|meal|ужин|обед|завтрак|ข้าวเย็น|มื้อ|อาหารเย็น|อาหารกลางวัน/u;

function cutPlace(s: string): string {
  return s
    .split(/,|;|\bfor\b|\bwith\b|\bна\s+\d|\bдля\b|\bс\s+\d|\d+(?:[.,]\d+)?\s*(?:kg|кг|กก|กิโล)|สำหรับ/iu)[0]
    .replace(/[.!?]+$/, '')
    .trim()
    .slice(0, 120);
}

export function detectService(input: string): ServiceIntent {
  const q = input.toLowerCase();
  let service: DemoService = 'food';
  if (RIDE.test(q)) service = 'ride';
  else if (FLOWERS.test(q)) service = 'flowers';
  else if (PHARMACY.test(q)) service = 'pharmacy';
  else if (CAKES.test(q)) service = 'cakes';
  else if (EXPRESS.test(q)) service = 'express';
  else if (GROCERY.test(q) || (STAPLE.test(q) && !MEAL.test(q) && !/\b(?:no|without)\s|без\s|ไม่ใส่|ไม่เอา/u.test(q))) service = 'groceries';
  const out: ServiceIntent = { service };
  if (service === 'ride' || service === 'express') {
    // Match on the original text (case-insensitive) so place names keep their capitalisation.
    const src = input.trim();
    const m =
      /\bfrom\s+(.+?)\s+to\s+(.+)$/iu.exec(src) ??
      /(?:^|\s)(?:от|из|с)\s+(.+?)\s+(?:до|в|во|на)\s+(.+)$/iu.exec(src) ??
      /จาก\s*(.+?)\s*(?:ไปที่|ไป|ถึง)\s*(.+)$/iu.exec(src);
    if (m) {
      out.pickup = cutPlace(m[1]);
      out.dropoff = cutPlace(m[2]);
    } else {
      const d = /(?:\bto|(?:^|\s)до|(?:^|\s)в|(?:^|\s)во|ไปที่|ไป)\s+(.+)$/iu.exec(src) ?? /(?:ไปที่|ไป)(.+)$/iu.exec(src);
      if (d) out.dropoff = cutPlace(d[1]);
    }
    const w = /(\d+(?:[.,]\d+)?)\s*(?:kg|кг|กก|กิโล)/u.exec(q);
    if (w) out.weight_kg = Math.min(Number(w[1].replace(',', '.')), 1000);
    const p = parseIntent(input).party_size;
    if (p && service === 'ride') out.passengers = p;
  }
  return out;
}
