// Original illustrations and icons for Unyly. All artwork here is drawn from scratch for this
// project (flat top-down food, stroke icons). No third-party or Grab brand assets are used.
import { raw, SafeHtml } from './html.js';

let seq = 0;
const uid = (p: string) => `${p}${(++seq).toString(36)}`;

// ---------- Building blocks ----------
const shrimp = (x: number, y: number, r = 0, s = 1) => `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})">
<path d="M-9 4c-2-8 4-14 11-13 7 1 10 8 7 13-2 3-6 4-8 2" fill="none" stroke="#f07b56" stroke-width="7" stroke-linecap="round"/>
<path d="M-9 4c-2-8 4-14 11-13 7 1 10 8 7 13" fill="none" stroke="#ffb199" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="3 3.2"/>
<path d="M1 6l-4 5M3 6l1 6" stroke="#e25d3a" stroke-width="2" stroke-linecap="round"/></g>`;
const leaf = (x: number, y: number, r: number, c = '#2f9e44', s = 1) =>
  `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})"><path d="M0 0c4-6 12-7 16-2-4 6-12 7-16 2z" fill="${c}"/><path d="M1 0h13" stroke="#fff" stroke-opacity=".35" stroke-width="1"/></g>`;
const chili = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="3.2" fill="#e5533d"/><circle cx="${x}" cy="${y}" r="1.3" fill="#ffd1c7"/>`;
const lime = (x: number, y: number, r: number) =>
  `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M-10 0a10 10 0 0 1 20 0z" fill="#7cc242"/><path d="M-7.5 0a7.5 7.5 0 0 1 15 0z" fill="#d4f08a"/><path d="M0 0v-7M0 0l-5-5M0 0l5-5" stroke="#9fd65a" stroke-width="1"/></g>`;
const plateBase = (id: string) => `<circle cx="60" cy="62" r="55" fill="#0f1f18" opacity=".08"/>
<circle cx="60" cy="60" r="55" fill="#fff"/><circle cx="60" cy="60" r="55" fill="none" stroke="#ece6d9" stroke-width="2"/>
<circle cx="60" cy="60" r="42" fill="#f7f3ea"/><clipPath id="${id}"><circle cx="60" cy="60" r="40"/></clipPath>`;
const bowlBase = (id: string, broth: string, rim = '#fffaf0') => `<circle cx="60" cy="63" r="54" fill="#0f1f18" opacity=".1"/>
<circle cx="60" cy="60" r="54" fill="${rim}"/><circle cx="60" cy="60" r="54" fill="none" stroke="#e6dcc8" stroke-width="2"/>
<circle cx="60" cy="60" r="44" fill="${broth}"/><clipPath id="${id}"><circle cx="60" cy="60" r="44"/></clipPath>`;

const svg = (inner: string, label: string, vb = '0 0 120 120') =>
  raw(`<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">${inner}</svg>`);

// ---------- Dishes ----------
export function padThai(label = 'Pad thai') {
  const c = uid('pt');
  const noodles = Array.from({ length: 9 }, (_, i) => {
    const y = 30 + i * 7.5;
    const o = (i % 3) * 4;
    return `<path d="M${14 + o} ${y}q7-6 14 0t14 0 14 0 14 0 14 0 14 0" fill="none" stroke="${i % 2 ? '#e8b36b' : '#f2c985'}" stroke-width="4.2" stroke-linecap="round"/>`;
  }).join('');
  const nuts = [[46, 44], [52, 41], [70, 70], [74, 66], [44, 72], [66, 48], [58, 76]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.2" fill="#b97a3d"/>`).join('');
  const onion = [[40, 56], [80, 52], [62, 36], [54, 64], [76, 78]].map(([x, y], i) => `<rect x="${x}" y="${y}" width="6" height="2.6" rx="1.3" fill="#58b848" transform="rotate(${i * 37} ${x} ${y})"/>`).join('');
  return svg(`${plateBase(c)}<g clip-path="url(#${c})">${noodles}</g>${shrimp(48, 56, -20)}${shrimp(70, 60, 30)}${shrimp(58, 44, 80, .9)}${nuts}${onion}${lime(84, 84, -35)}`, label);
}

export function greenCurry(label = 'Green curry') {
  const c = uid('gc');
  const chicken = [[42, 50], [70, 44], [56, 70], [76, 66]].map(([x, y], i) => `<rect x="${x - 7}" y="${y - 5}" width="14" height="10" rx="4" fill="#f4e3bf" transform="rotate(${i * 25 - 20} ${x} ${y})"/>`).join('');
  const eggplant = [[52, 40], [80, 56], [40, 68], [64, 56]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.5" fill="#e3ecb4"/><circle cx="${x}" cy="${y}" r="5.5" fill="none" stroke="#86a83e" stroke-width="1.6"/>`).join('');
  return svg(`${bowlBase(c, '#b7cc5a')}<g clip-path="url(#${c})"><path d="M20 58c14-10 26 6 40-2s26-10 40 2" fill="none" stroke="#fffbe8" stroke-opacity=".7" stroke-width="4" stroke-linecap="round"/><path d="M26 76c12-6 20 4 32-2" fill="none" stroke="#fffbe8" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/>${chicken}${eggplant}</g>${leaf(60, 40, -30)}${leaf(46, 60, 20, '#3cae52')}${leaf(72, 76, -60)}${chili(66, 48)}${chili(50, 78)}${chili(82, 70)}`, label);
}

export function tomYum(label = 'Tom yum') {
  const c = uid('ty');
  const drops = [[40, 44, 3], [78, 50, 2.4], [52, 78, 2.6], [70, 34, 2], [34, 64, 2.2], [84, 72, 1.8]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffc46b" opacity=".85"/>`).join('');
  const mush = [[46, 50], [74, 72]].map(([x, y]) => `<path d="M${x - 7} ${y}a7 7 0 0 1 14 0z" fill="#efe4d0"/><rect x="${x - 2}" y="${y}" width="4" height="5" rx="1.5" fill="#e2d4bb"/>`).join('');
  const grass = [[62, 82], [36, 72], [84, 44]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="#f0f4c9"/><circle cx="${x}" cy="${y}" r="4" fill="none" stroke="#b6c86a" stroke-width="1.4"/>`).join('');
  return svg(`${bowlBase(c, '#ef8a3a')}<g clip-path="url(#${c})"><circle cx="60" cy="60" r="44" fill="#f3a14c" opacity=".35"/>${drops}${mush}${grass}</g>${shrimp(58, 58, 10, 1.05)}${shrimp(76, 56, 60, .85)}${leaf(42, 40, 10, '#3cae52', .9)}${leaf(66, 38, -40, '#2f9e44', .8)}${chili(50, 66)}${chili(82, 62)}`, label);
}

export function mangoSticky(label = 'Mango sticky rice') {
  const c = uid('ms');
  const rice = Array.from({ length: 26 }, (_, i) => {
    const a = i * 2.39;
    const rr = 4 + (i % 7) * 2.2;
    return `<ellipse cx="${(44 + Math.cos(a) * rr).toFixed(1)}" cy="${(62 + Math.sin(a) * rr * 0.8).toFixed(1)}" rx="1.8" ry="1.1" fill="#e9e1cf" transform="rotate(${i * 31} ${(44 + Math.cos(a) * rr).toFixed(1)} ${(62 + Math.sin(a) * rr * 0.8).toFixed(1)})"/>`;
  }).join('');
  const slices = [0, 1, 2, 3, 4].map((i) => `<g transform="translate(56 ${42 + i * 8.5}) rotate(${-16 + i * 8})"><path d="M0 0c6-7 24-8 30-1-6 7-24 8-30 1z" fill="${i % 2 ? '#ffc53d' : '#ffb21a'}"/><path d="M5 0h20" stroke="#f59e0b" stroke-width="1" opacity=".7"/></g>`).join('');
  return svg(`${plateBase(c)}<ellipse cx="44" cy="62" rx="22" ry="18" fill="#fffdf6"/>${rice}<path d="M26 58c6 6 18 8 30 2" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".95"/>${[[36, 56], [44, 60], [52, 57], [40, 64]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4" fill="#e3b04b"/>`).join('')}${slices}${leaf(82, 34, 30, '#3cae52', .7)}`, label);
}

export function noodleSoup(label = 'Noodle soup') {
  const c = uid('ns');
  const noodles = Array.from({ length: 7 }, (_, i) => `<path d="M${18 + (i % 2) * 6} ${36 + i * 8}q6-5 12 0t12 0 12 0 12 0 12 0 12 0 12 0" fill="none" stroke="#f3d27a" stroke-width="3.6" stroke-linecap="round"/>`).join('');
  const beef = [[44, 46], [68, 42], [76, 62], [50, 70]].map(([x, y], i) => `<path d="M${x - 9} ${y}c3-6 15-6 18 0-3 5-15 5-18 0z" fill="#8b4a36" transform="rotate(${i * 40} ${x} ${y})"/><path d="M${x - 6} ${y}h12" stroke="#b86d55" stroke-width="1.2" transform="rotate(${i * 40} ${x} ${y})"/>`).join('');
  const sprouts = [[36, 58], [84, 50], [62, 80], [58, 34]].map(([x, y], i) => `<path d="M${x} ${y}q4 -3 9 0" stroke="#fffbea" stroke-width="2.4" fill="none" stroke-linecap="round" transform="rotate(${i * 50} ${x} ${y})"/>`).join('');
  return svg(`${bowlBase(c, '#9c4f2c', '#1f5b4a')}<circle cx="60" cy="60" r="54" fill="none" stroke="#2c7a63" stroke-width="3"/><g clip-path="url(#${c})"><circle cx="60" cy="60" r="44" fill="#b8632f" opacity=".4"/>${noodles}${beef}${sprouts}</g>${leaf(60, 56, -20, '#48b24e')}${leaf(40, 44, 40, '#2f9e44', .8)}${leaf(78, 74, 160, '#3cae52', .8)}${chili(70, 52)}`, label);
}

export function grillSet(label = 'Grill set') {
  const c = uid('gs');
  const skewer = (y: number, r: number) => `<g transform="rotate(${r} 60 ${y})"><path d="M14 ${y}h86" stroke="#caa074" stroke-width="2.4" stroke-linecap="round"/>${[28, 44, 60, 76].map((x) => `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="4.5" fill="#b8612b"/><path d="M${x - 4} ${y - 5}l6 10M${x + 1} ${y - 6}l5 9" stroke="#6d3417" stroke-width="1.6" stroke-linecap="round"/>`).join('')}</g>`;
  const basketWeave = Array.from({ length: 6 }, (_, i) => `<path d="M${74 + i * 3} 70l-6 18" stroke="#b8904f" stroke-width="1"/>`).join('');
  return svg(`${plateBase(c)}${skewer(44, -10)}${skewer(60, -4)}<circle cx="80" cy="80" r="15" fill="#dcb772"/>${basketWeave}<circle cx="80" cy="80" r="15" fill="none" stroke="#b8904f" stroke-width="2"/><ellipse cx="80" cy="78" rx="10" ry="8" fill="#fffdf4"/>${[[36, 80], [44, 86]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" fill="#9fd36a"/><circle cx="${x}" cy="${y}" r="5" fill="#e6f7c8"/>`).join('')}`, label);
}

export function seafoodRice(label = 'Seafood fried rice') {
  const c = uid('sr');
  const grains = Array.from({ length: 70 }, (_, i) => {
    const a = i * 2.4;
    const rr = 3 + (i % 11) * 3;
    const x = 58 + Math.cos(a) * rr;
    const y = 60 + Math.sin(a) * rr * 0.85;
    return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="2.2" ry="1.2" fill="${i % 3 ? '#f6d998' : '#ebc378'}" transform="rotate(${i * 47} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }).join('');
  const bits = [[40, 50, '#7cc242'], [70, 44, '#f28c28'], [48, 72, '#7cc242'], [74, 70, '#f28c28'], [60, 58, '#7cc242'], [36, 62, '#f28c28'], [80, 56, '#7cc242']]
    .map(([x, y, col]) => `<rect x="${x}" y="${y}" width="4" height="4" rx="1.2" fill="${col}"/>`).join('');
  return svg(`${plateBase(c)}<ellipse cx="58" cy="60" rx="36" ry="31" fill="#f3d38e"/>${grains}${bits}${shrimp(50, 50, -30, .95)}${shrimp(70, 62, 40, .95)}${shrimp(48, 70, 150, .85)}${lime(86, 82, -40)}`, label);
}

export function tofuBowl(label = 'Tofu bowl') {
  const c = uid('tb');
  const greens = Array.from({ length: 7 }, (_, i) => leaf(30 + (i % 3) * 8, 40 + i * 6, i * 50, i % 2 ? '#58b848' : '#3a9d3f', 1.1)).join('');
  const tofu = [[64, 40], [78, 48], [70, 56], [84, 62]].map(([x, y]) => `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" rx="3" fill="#f7e2b3"/><path d="M${x - 6} ${y + 3}h12" stroke="#a9582a" stroke-width="3" stroke-linecap="round"/>`).join('');
  const edamame = [[56, 76], [62, 80], [50, 82], [44, 74]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="4" ry="3" fill="#8fd14f"/>`).join('');
  const carrot = [[74, 76], [80, 80], [70, 84]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.4" fill="#f28c28"/>`).join('');
  return svg(`${bowlBase(c, '#f5efe1', '#e7f3ea')}<g clip-path="url(#${c})">${greens}${tofu}${edamame}${carrot}<path d="M22 60h76" stroke="#efe6d2" stroke-width="1" opacity=".6"/></g>${[[66, 50], [74, 44], [80, 58], [60, 58]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="1.2" ry=".7" fill="#fff"/>`).join('')}`, label);
}

export function burger(label = 'Burger') {
  const c = uid('bg');
  return svg(`${plateBase(c)}<path d="M30 56a30 22 0 0 1 60 0z" fill="#eaa64a"/>${[[44, 44], [56, 40], [68, 44], [60, 48], [50, 50], [74, 50]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="2" ry="1" fill="#fff4d8"/>`).join('')}
<path d="M28 58q6 6 12 0t12 0 12 0 12 0 12 0 4 0" fill="#6cc04a"/><rect x="28" y="62" width="64" height="7" rx="3" fill="#ffc933"/><rect x="28" y="67" width="64" height="11" rx="5" fill="#6e3a22"/><path d="M30 80h60a4 4 0 0 1-4 6H34a4 4 0 0 1-4-6z" fill="#e39a3f"/>`, label);
}

const DISH_BY_RESTAURANT: Record<string, (l?: string) => SafeHtml> = {
  'demo-r1': padThai,
  'demo-r2': tofuBowl,
  'demo-r3': noodleSoup,
  'demo-r4': burger,
  'demo-r5': grillSet,
  'demo-r6': seafoodRice,
};
export const restaurantArt = (id: string | null | undefined, label: string) => (DISH_BY_RESTAURANT[id ?? ''] ?? greenCurry)(label);

// ---------- Brand ----------
export const logoMark = () =>
  raw(`<svg class="logo-mark" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="40" height="40" rx="12" fill="#0a8a53"/><path d="M8.5 19.5h23a11.5 11.5 0 0 1-23 0z" fill="#fff"/><path d="M12 25.5c3 2.6 13 2.6 16 0" stroke="#0a8a53" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".35"/><path d="M23.5 6.5h8a3 3 0 0 1 3 3v3.5a3 3 0 0 1-3 3h-3.2l-3.3 2.6v-2.7a3 3 0 0 1-1.5-2.6V9.5a3 3 0 0 1 3-3z" fill="#c9f26b"/><circle cx="26" cy="11.2" r="1" fill="#0a8a53"/><circle cx="29" cy="11.2" r="1" fill="#0a8a53"/><circle cx="32" cy="11.2" r="1" fill="#0a8a53"/></svg>`);
export const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='12' fill='%230a8a53'/%3E%3Cpath d='M8.5 19.5h23a11.5 11.5 0 0 1-23 0z' fill='white'/%3E%3Cpath d='M23.5 6.5h8a3 3 0 0 1 3 3v3.5a3 3 0 0 1-3 3h-3.2l-3.3 2.6v-2.7a3 3 0 0 1-1.5-2.6V9.5a3 3 0 0 1 3-3z' fill='%23c9f26b'/%3E%3C/svg%3E";

// ---------- Scenes ----------
export function scooter(label = 'Rider on the way') {
  return raw(`<svg viewBox="0 0 160 110" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">
<ellipse cx="82" cy="100" rx="62" ry="5" fill="#0f1f18" opacity=".1"/>
<g stroke="#b9c9c0" stroke-width="3" stroke-linecap="round" opacity=".8"><path d="M8 52h22M2 64h24M12 76h16"/></g>
<circle cx="44" cy="84" r="14" fill="#0f1f18"/><circle cx="44" cy="84" r="6" fill="#e9efe9"/>
<circle cx="122" cy="84" r="14" fill="#0f1f18"/><circle cx="122" cy="84" r="6" fill="#e9efe9"/>
<path d="M30 80c2-14 14-20 30-20h34l14-24h8l-10 30c10 0 22 6 24 18H104c-2-8-8-12-16-12H64c-8 0-14 4-16 8z" fill="#0a8a53"/>
<path d="M108 36h12" stroke="#0f1f18" stroke-width="4" stroke-linecap="round"/>
<rect x="34" y="28" width="34" height="30" rx="6" fill="#c9f26b"/><path d="M40 38h22M40 46h14" stroke="#0a8a53" stroke-width="3" stroke-linecap="round"/>
<path d="M74 60l10-24c2-5 7-7 12-5l8 4-6 12-8-3-6 16z" fill="#0f1f18"/>
<path d="M86 36l18 4" stroke="#f4c9a8" stroke-width="5" stroke-linecap="round"/>
<circle cx="92" cy="18" r="11" fill="#0a8a53"/><path d="M81 19a11 11 0 0 1 22 0z" fill="#06a765"/><rect x="90" y="17" width="12" height="5" rx="2.5" fill="#0f1f18" opacity=".85"/>
<path d="M78 62l-6 18h10" stroke="#0f1f18" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`);
}

export function checkBurst(label = 'Done') {
  return raw(`<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">
<circle cx="60" cy="60" r="46" fill="#e3f4ea"/><circle cx="60" cy="60" r="32" fill="#0a8a53"/><path d="M45 61l10 10 20-22" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<rect x="58" y="4" width="4" height="10" rx="2" fill="${a % 90 ? '#c9f26b' : '#0a8a53'}" transform="rotate(${a} 60 60)"/>`).join('')}</svg>`);
}

// ---------- Icons (24px, stroke) ----------
const ICONS: Record<string, string> = {
  shield: '<path d="M12 3l7 3v5c0 4.6-3 8.3-7 10-4-1.7-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  repeat: '<path d="M4 12a8 8 0 0 1 13.7-5.6"/><path d="M20 12a8 8 0 0 1-13.7 5.6"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  keyoff: '<circle cx="8" cy="15" r="4"/><path d="M11 12l7-7M15 8l2 2M3 3l18 18"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h8M8 13h5"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  bike: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17h5l4-8h3M15 9l3 8M9 9h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3 3 3 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>',
  plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  leaf: '<path d="M5 19C5 10 11 5 20 5c0 9-5 15-14 15z"/><path d="M5 19l7-7"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  store: '<path d="M4 10h16l-1.5-5h-13zM5 10v10h14V10M10 20v-5h4v5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>',
  tap: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  map: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  cart: '<path d="M3 4h2.5l2.2 11h10.6l2.2-8H6.6"/><circle cx="9" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/>',
  handshake: '<path d="M3 12l4-4 4 2 3-3 7 5-4 4"/><path d="M7 8l-4 4 5 5 2-2M11 16l2 2M13 14l3 3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 7.2a8 8 0 1 0 11.4 0"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/><path d="M11 13l9-9"/>',
};
export const icon = (name: keyof typeof ICONS | string, cls = '') =>
  raw(`<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.check}</svg>`);

// ---------- Architecture diagram ----------
export function flowDiagram(t: { you: string; assistant: string; assistantSub: string; unyly: string; unylySub: string; grab: string; grabSub: string; confirm: string; confirmSub: string; tap: string; mcp: string; api: string }) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const box = (x: number, y: number, w: number, title: string, sub: string, fill: string, ink: string, subInk: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="74" rx="18" fill="${fill}"/><text x="${x + w / 2}" y="${y + 32}" text-anchor="middle" font-size="17" font-weight="800" fill="${ink}">${esc(title)}</text><text x="${x + w / 2}" y="${y + 54}" text-anchor="middle" font-size="12.5" fill="${subInk}">${esc(sub)}</text>`;
  return raw(`<svg viewBox="0 0 900 290" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(t.you)} → ${esc(t.assistant)} → ${esc(t.unyly)} → ${esc(t.grab)}" font-family="Manrope, Inter, 'Noto Sans Thai', sans-serif">
<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0l10 5-10 5z" fill="#0a8a53"/></marker></defs>
${box(10, 30, 150, t.you, '', '#0f1f18', '#ffffff', '#b6c8be')}
${box(220, 30, 190, t.assistant, t.assistantSub, '#ffffff', '#0f1f18', '#5c6b64')}
${box(470, 30, 190, t.unyly, t.unylySub, '#0a8a53', '#ffffff', '#d9f3e5')}
${box(720, 30, 170, t.grab, t.grabSub, '#ffffff', '#0f1f18', '#5c6b64')}
<rect x="220.5" y="30.5" width="189" height="73" rx="18" fill="none" stroke="#e2ded2"/><rect x="720.5" y="30.5" width="169" height="73" rx="18" fill="none" stroke="#0a8a53" stroke-dasharray="6 5"/>
${[162, 412, 662].map((x) => `<path d="M${x} 67h50" stroke="#0a8a53" stroke-width="2.5" marker-end="url(#ah)"/>`).join('')}
<text x="437" y="58" text-anchor="middle" font-size="11.5" font-weight="700" fill="#0a8a53">${esc(t.mcp)}</text>
<text x="688" y="58" text-anchor="middle" font-size="11.5" font-weight="700" fill="#0a8a53">${esc(t.api)}</text>
${box(470, 190, 190, t.confirm, t.confirmSub, '#c9f26b', '#0f1f18', '#2c4a3b')}
<path d="M565 106v78" stroke="#0a8a53" stroke-width="2.5" marker-end="url(#ah)"/>
<path d="M466 227H85V110" stroke="#0f1f18" stroke-width="2.5" stroke-dasharray="7 6" fill="none" marker-end="url(#ah)"/>
<rect x="190" y="212" width="170" height="30" rx="15" fill="#0f1f18"/><text x="275" y="232" text-anchor="middle" font-size="13" font-weight="800" fill="#c9f26b">${esc(t.tap)}</text>
</svg>`);
}
