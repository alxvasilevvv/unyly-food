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
const NEG_EN = String.raw`(?:no|without|free of|avoid|allergic to|allergy to|not)\s+(?:\S+\s+){0,2}?`;
const NEG_RU = String.raw`(?:без|аллерги[яю] на|не)\s+(?:\S+\s+){0,2}?`;
const NEG_TH = String.raw`(?:ไม่ใส่|ไม่เอา|ไม่กิน|แพ้|ไม่มี|งด)\S{0,6}?`;

const ALLERGEN_WORDS: [string[], string, string, string, string?][] = [
  // [allergens], en, ru, th, suffix-form (en "nut-free", "nut allergy")
  [['peanut', 'tree_nut'], 'nuts?|peanuts?|cashews?', 'орех\\S*|арахис\\S*', 'ถั่ว(?!เหลือง)'],
  [['shellfish'], 'shellfish|shrimps?|prawns?', 'кревет\\S*|морепродукт\\S*|моллюск\\S*', 'กุ้ง|อาหารทะเล|หอย'],
  [['milk'], 'dairy|milk|lactose', 'молок\\S*|молочн\\S*|лактоз\\S*', 'นม'],
  [['egg'], 'eggs?', 'яйц\\S*|яиц\\S*', 'ไข่'],
  [['wheat'], 'gluten|wheat', 'глютен\\S*|пшениц\\S*', 'กลูเตน|แป้งสาลี'],
  [['soy'], 'soy|soya', 'со[яиеюй]\\S*', 'ถั่วเหลือง'],
  [['fish'], 'fish', 'рыб\\S*', 'ปลา'],
  [['sesame'], 'sesame', 'кунжут\\S*', 'งา'],
];

export function parseIntent(input: string): Intent {
  const q = ` ${input.toLowerCase().replace(/[,.;!?()]/g, ' ').replace(/\s+/g, ' ')} `;
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
      new RegExp(`${NEG_EN}(?:${en})\\b`).test(q) ||
      new RegExp(`(?:${en})[- ](?:free|allergy)`).test(q) ||
      new RegExp(`${NEG_RU}(?:${ru})`).test(q) ||
      new RegExp(`${NEG_TH}(?:${th})`).test(q);
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
