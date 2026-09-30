import { lookup } from '../i18n/index.js';
import { tr, type Locale, type Tri } from './messages.js';

/** Display translations for demo dishes. Provider data stays in English; this is presentation only. */
const DISHES: Record<string, { ru: string; th: string }> = {
  'r1-padthai': { ru: 'Пад тай с креветками', th: 'ผัดไทยกุ้ง' },
  'r1-krapao': { ru: 'Пад кра пао с курицей и рисом', th: 'ผัดกะเพราไก่ราดข้าว' },
  'r1-greencurry': { ru: 'Зелёный карри с курицей', th: 'แกงเขียวหวานไก่' },
  'r1-tomyum': { ru: 'Том ям с креветками', th: 'ต้มยำกุ้ง' },
  'r1-veg-stirfry': { ru: 'Овощи вок с чесноком', th: 'ผัดผักรวม' },
  'r1-rice': { ru: 'Жасминовый рис', th: 'ข้าวหอมมะลิ' },
  'r1-mango': { ru: 'Манго с клейким рисом', th: 'ข้าวเหนียวมะม่วง' },
  'r1-teh': { ru: 'Тайский чай со льдом', th: 'ชาไทยเย็น' },
  'r2-tofubowl': { ru: 'Боул с тофу терияки', th: 'ข้าวหน้าเต้าหู้เทอริยากิ' },
  'r2-quinoa': { ru: 'Салат с киноа и кешью', th: 'สลัดคีนัวเม็ดมะม่วงหิมพานต์' },
  'r2-larb': { ru: 'Ларб из грибов', th: 'ลาบเห็ด' },
  'r2-springroll': { ru: 'Свежие спринг-роллы', th: 'ปอเปี๊ยะสด' },
  'r2-coconut': { ru: 'Кокосовая вода', th: 'น้ำมะพร้าวอ่อน' },
  'r3-boat': { ru: 'Лодочная лапша с говядиной', th: 'ก๋วยเตี๋ยวเรือเนื้อ' },
  'r3-khaosoi': { ru: 'Кхао сой с курицей', th: 'ข้าวซอยไก่' },
  'r3-wonton': { ru: 'Суп с вонтонами', th: 'เกี๊ยวน้ำ' },
  'r3-crispypork': { ru: 'Хрустящая свинина с рисом', th: 'ข้าวหมูกรอบ' },
  'r3-special': { ru: 'Фирменная лапша шефа', th: 'บะหมี่สูตรพิเศษของเชฟ' },
  'r4-burger': { ru: 'Классический чизбургер', th: 'ชีสเบอร์เกอร์' },
  'r5-chicken': { ru: 'Курица гриль с клейким рисом', th: 'ไก่ย่างข้าวเหนียว' },
  'r5-saiua': { ru: 'Колбаски сай уа', th: 'ไส้อั่ว' },
  'r5-somtam': { ru: 'Сом там', th: 'ส้มตำ' },
  'r6-friedrice': { ru: 'Жареный рис с морепродуктами', th: 'ข้าวผัดทะเล' },
  'r6-fish': { ru: 'Сибас на пару с лаймом', th: 'ปลากะพงนึ่งมะนาว' },
  'r6-prawns': { ru: 'Креветки с чесноком', th: 'กุ้งกระเทียม' },
  'r6-morningglory': { ru: 'Водяной шпинат вок', th: 'ผัดผักบุ้ง' },
};
export const dishName = (itemId: string, fallback: string, l: Locale) =>
  l === 'en' ? fallback : (DISHES[itemId] as Record<string, string> | undefined)?.[l] ?? lookup(l, fallback) ?? fallback;

export const ALLERGEN_NAMES: Record<string, Tri> = {
  peanut: { ru: 'арахис', en: 'peanut', th: 'ถั่วลิสง' },
  tree_nut: { ru: 'орехи', en: 'tree nuts', th: 'ถั่วเปลือกแข็ง' },
  milk: { ru: 'молоко', en: 'milk', th: 'นม' },
  egg: { ru: 'яйца', en: 'egg', th: 'ไข่' },
  wheat: { ru: 'пшеница/глютен', en: 'wheat/gluten', th: 'ข้าวสาลี/กลูเตน' },
  soy: { ru: 'соя', en: 'soy', th: 'ถั่วเหลือง' },
  fish: { ru: 'рыба', en: 'fish', th: 'ปลา' },
  shellfish: { ru: 'морепродукты', en: 'shellfish', th: 'สัตว์น้ำมีเปลือก' },
  sesame: { ru: 'кунжут', en: 'sesame', th: 'งา' },
};
export const DIET_NAMES: Record<string, Tri> = {
  vegetarian: { ru: 'вегетарианское', en: 'vegetarian', th: 'มังสวิรัติ' },
  vegan: { ru: 'веганское', en: 'vegan', th: 'วีแกน' },
  halal: { ru: 'халяль', en: 'halal', th: 'ฮาลาล' },
  no_pork: { ru: 'без свинины', en: 'no pork', th: 'ไม่มีหมู' },
  no_beef: { ru: 'без говядины', en: 'no beef', th: 'ไม่มีเนื้อวัว' },
};
export const CUISINE_NAMES: Record<string, Tri> = {
  thai: { ru: 'тайская', en: 'Thai', th: 'อาหารไทย' },
  healthy: { ru: 'полезная', en: 'healthy', th: 'เพื่อสุขภาพ' },
  vegetarian: { ru: 'вегетарианская', en: 'vegetarian', th: 'มังสวิรัติ' },
  noodles: { ru: 'лапша', en: 'noodles', th: 'ก๋วยเตี๋ยว' },
  burgers: { ru: 'бургеры', en: 'burgers', th: 'เบอร์เกอร์' },
  grill: { ru: 'гриль', en: 'grill', th: 'ปิ้งย่าง' },
  seafood: { ru: 'морепродукты', en: 'seafood', th: 'อาหารทะเล' },
};
export const t3 = (map: Record<string, Tri>, key: string, l: Locale) => (map[key] ? tr(l, map[key]) : key);
