// Round 5: the /ari chat is consistent in every interface language. Replies, cards, statuses and the
// push and call texts come in the language of the page (never English mixed into another language),
// and every example chip and suggestion chip produces the card it promises.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCALE_CODES, type Locale } from '../src/domain/locales.js';
import { PACKS } from '../src/i18n/generated.js';
import { ariExamples } from '../src/partners/webdemo.js';
import { Harness, startHarness } from './helpers.js';

let h: Harness;
let cookie = '';
let n = 0;
// The demo API limits requests per address; the test plays many visitors.
const ip = () => `10.${(++n >> 13) & 255}.${(n >> 5) & 255}.7`;
const H = () => ({ 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' });
const post = async (url: string, body: unknown = {}) => {
  const r = await h.app.inject({ method: 'POST', url, headers: H(), payload: JSON.stringify(body), remoteAddress: ip() });
  const sc = r.headers['set-cookie'];
  if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
  return r.json() as any;
};
const get = async (url: string) => (await h.app.inject({ method: 'GET', url, headers: H(), remoteAddress: ip() })).json() as any;
const say = (l: string, text: string) => post(`/ari/api/message?lang=${l}`, { text });
const start = async (l: string) => {
  cookie = '';
  return post(`/ari/api/session?lang=${l}`);
};

beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 1000, guestHourlyLimit: 100000 } as any });
});
afterAll(async () => {
  await h.close();
});

const OTHERS = LOCALE_CODES.filter((l) => l !== 'en');
const CATALOG_LANGS = ['vi', 'id', 'ms', 'fil', 'km', 'my', 'zh'] as const;
/** Scripts that share no letters with English: any run of Latin words there is leftover English. */
const NON_LATIN = ['th', 'km', 'my', 'zh', 'ru'];
const TRANSLATED_NAMES = ['km', 'my', 'zh'];
/** Names that are data and stay as they are: brands, vehicles, stores, places, units. */
const DATA = /\(Demo\)|Sukhumvit Noodle House|Baan Suan Kitchen|Green Bowl Bangkok|Bloom Bangkok Florist|Care Pharmacy Asok|Fresh Market Sukhumvit|Sweet Layers Cakes|Siam Paragon|Suvarnabhumi Airport \(BKK\)|Don Mueang Airport \(DMK\)|Chatuchak Weekend Market|ICONSIAM|Grab\w*|JustGrab|Face ID|Ari|Unyly|THB|Honda Wave 125|Wave 125|Toyota Corolla Altis|SUV|Pickup|Premium|SPF50|Taxi|[Dd]emo|Bike|Car|Watthana|Bangkok|fudge|vegan|\b(?:kg|mg|ml|lb|L|x)\b/g;
const leftover = (s: string) => /[A-Za-z]{3,}/.test(s.replace(DATA, ''));

/** Every text a card puts on the screen, except the store's own names (title, item lines, the courier's name). */
function cardTexts(card: any): string[] {
  if (!card) return [];
  const out: (string | undefined)[] = [card.footnote, card.total?.label, card.status?.label, ...(card.badges ?? [])];
  if (card.type === 'options' || card.type === 'cancellation') out.push(card.title);
  for (const o of card.options ?? []) out.push(o.eta, o.disabled_reason, o.action?.label, ...(o.badges ?? []), ...(card.service === 'ride' || card.service === 'express' ? [o.subtitle] : []));
  for (const b of card.breakdown ?? []) out.push(b.label);
  for (const s of card.status?.steps ?? []) out.push(s.label);
  for (const a of card.actions ?? []) out.push(a.label);
  if (card.courier) out.push(card.courier.vehicle);
  return out.filter((x): x is string => !!x);
}

interface Flow { texts: string[]; labels: Record<string, string>; notify: { title: string; body: string }[] }

/** One request from the example chip to the finished order, with everything the phone shows on the way. */
async function runFlow(l: string, example: number): Promise<Flow> {
  const s = await start(l);
  const texts: string[] = [s.greeting];
  let m = await say(l, s.examples[example]);
  expect(m.card, `${l} #${example}: ${m.reply}`).toBeTruthy();
  texts.push(m.reply, ...cardTexts(m.card));
  const labels: Record<string, string> = {};
  if (m.card.type === 'options') {
    labels.optionsTitle = m.card.title;
    const opt = m.card.options.find((o: any) => o.action);
    labels.choose = opt.action.label;
    m = await post(`/ari/api/action?lang=${l}`, { tool: opt.action.tool.name, arguments: opt.action.tool.arguments });
    texts.push(m.reply, ...cardTexts(m.card));
  }
  expect(m.card.type, `${l} #${example}`).toBe('checkout');
  labels.total = m.card.total.label;
  labels.items = m.card.breakdown[0].label;
  labels.demo = m.card.badges[0];
  labels.footnote = m.card.footnote;
  const confirm = m.card.actions.find((a: any) => a.kind === 'confirm');
  labels.confirm = confirm.label.split(' · ')[0];
  labels.notNow = m.card.actions.find((a: any) => a.kind === 'decline').label;
  const c = await post(`/ari/api/confirm?lang=${l}`, { checkout_id: m.card.id, confirm_hash: confirm.endpoint.body.confirm_hash, user_verification: 'biometric' });
  expect(c.card?.type, `${l} #${example} confirm`).toBe('order');
  texts.push(c.reply, ...cardTexts(c.card));
  labels.done = c.reply;
  labels.status = c.card.status.label;
  labels.cancel = c.card.actions.find((a: any) => a.kind === 'prepare_cancel').label;
  labels.vehicle = c.card.courier.vehicle;
  labels.fictional = c.card.footnote;
  const terms = await post(`/ari/api/cancel?lang=${l}`, { order_id: c.order_id });
  texts.push(terms.reply, ...cardTexts(terms.card));
  labels.cancelTitle = terms.card.title;
  // The order runs to its end: every status on the way raises an event with the push (and call) text.
  let last: any = c.card;
  for (let i = 0; i < 40 && !last.status.is_final; i++) {
    h.clock.advance(10_000);
    last = (await get(`/ari/api/orders/${c.order_id}?lang=${l}`)).card;
    texts.push(...cardTexts(last));
  }
  expect(last.status.is_final, `${l} #${example} reaches the end`).toBe(true);
  labels.finalStatus = last.status.label;
  const ev = await get('/ari/api/events?after=0');
  const notify = ev.events.filter((e: any) => e.notify && e.data?.order_id === c.order_id).map((e: any) => ({ title: e.notify.title, body: e.notify.body }));
  expect(notify.length, `${l} #${example} events`).toBeGreaterThanOrEqual(3);
  for (const x of notify) texts.push(x.title, x.body);
  const track = await say(l, 'where is my order');
  texts.push(track.reply);
  return { texts: texts.filter(Boolean), labels, notify };
}

describe('The /ari chat speaks every interface language', () => {
  // Ride, dinner, parcel and flowers: the four presenter scenarios.
  const SCENARIOS = [0, 1, 2, 3];
  const en: Flow[] = [];

  it('English is the reference', async () => {
    for (const i of SCENARIOS) en.push(await runFlow('en', i));
    expect(en[0].labels.optionsTitle).toBe('Choose a ride');
    expect(en[0].labels.total).toBe('Total');
    expect(en[0].notify.some((x) => x.body === 'Your driver is on the way to the pickup point.')).toBe(true);
    expect(en[1].notify.some((x) => /the courier is on the way to you\.$/.test(x.body))).toBe(true);
  });

  for (const l of OTHERS) {
    it(`${l}: replies, card labels, statuses and push texts are in ${l}, with no em dash`, async () => {
      for (const i of SCENARIOS) {
        const f = await runFlow(l, i);
        const ref = en[SCENARIOS.indexOf(i)];
        const where = `${l} scenario ${i}`;
        // Nothing the phone shows is the English sentence.
        for (const [k, v] of Object.entries(f.labels)) {
          expect(v, `${where} ${k}`).toBeTruthy();
          // A single word may be the same in a Latin-script language ("Total" in Indonesian and Filipino).
          if (NON_LATIN.includes(l) || /\s/.test(v)) expect(v, `${where} ${k}`).not.toBe(ref.labels[k]);
        }
        expect(f.notify.length, where).toBe(ref.notify.length);
        f.notify.forEach((x, j) => {
          expect(x.title, `${where} notify ${j}`).not.toBe(ref.notify[j].title);
          // The first event names only the store or the vehicle.
          if (/[a-z]{3,} [a-z]{3,} [a-z]{3,}/.test(ref.notify[j].body)) expect(x.body, `${where} notify body ${j}`).not.toBe(ref.notify[j].body);
        });
        const enTexts = new Set(ref.texts.filter((t) => /[a-z]{3,} [a-z]{3,} [a-z]{3,}/.test(t)));
        for (const t of f.texts) {
          expect(t.includes('—'), `${where} em dash: ${t}`).toBe(false);
          expect(enTexts.has(t), `${where} English sentence: ${t}`).toBe(false);
          // Russian and Thai show item names as the store wrote them; the catalog languages translate those too.
          if (TRANSLATED_NAMES.includes(l) && !/×/.test(t)) expect(leftover(t), `${where} leftover English: ${t}`).toBe(false);
        }
      }
    });
  }
});

describe('Example chips and suggestions work in every language', () => {
  const sig = (r: any) => (r.card
    ? [r.card.type, r.card.service, (r.card.options ?? []).map((o: any) => `${o.id}:${o.action ? JSON.stringify(o.action.tool.arguments.items) : '-'}`).join(','), r.card.total?.amount_minor ?? '', (r.card.lines ?? []).length].join('|')
    : 'no card');
  const en: string[] = [];
  const want = ['options|ride', 'options|food', 'options|express', 'checkout|mart', 'checkout|mart', 'checkout|mart', 'checkout|mart'];

  it('the catalog languages take their examples from the language packs, in the order of the English chips', () => {
    for (const l of CATALOG_LANGS) {
      const ex = ariExamples(l as Locale);
      expect(ex, l).toHaveLength(7);
      expect([...ex].sort(), l).toEqual([...PACKS[l].examples].sort());
      expect(ex[0], l).toBe(PACKS[l].examples[1]);
      expect(ex[2], l).toBe(PACKS[l].examples[6]);
      expect(ex, l).not.toEqual(ariExamples('en'));
    }
  });

  it('every example chip builds the same card as its English original', async () => {
    const s = await start('en');
    for (const ex of s.examples) en.push(sig(await say('en', ex)));
    en.forEach((x, i) => expect(x.startsWith(want[i]), `en #${i}: ${x}`).toBe(true));
    for (const l of OTHERS) {
      const sl = await start(l);
      expect(sl.examples, l).toHaveLength(7);
      for (let i = 0; i < 7; i++) expect(sig(await say(l, sl.examples[i])), `${l} #${i}: ${sl.examples[i]}`).toBe(en[i]);
    }
  });

  // What a user may type that makes Ari answer with chips: each chip must lead to the card the English chip leads to.
  const TRIGGERS: Record<string, string> = {
    unknown: 'qwerty zzz', place: 'Taxi to Atlantis', outside: 'Taxi to Phuket', airport: 'Taxi to the airport', taxi: 'taxi', parcel: 'send a parcel',
    group: 'Taxi to ICONSIAM for 14 people', table: 'book a table for two', flight: 'book a flight', cheaper: 'something cheaper', pharmacy: 'pharmacy',
    groceries: 'groceries', parcelPlace: 'Send a 3 kg parcel from Siam Paragon to Atlantis', home: 'taxi from home to home', lunch: 'lunch', rx: 'antibiotics',
  };

  it('every suggestion chip leads to a card, like its English original', async () => {
    const run = async (l: string) => {
      await start(l);
      const out: Record<string, { reply: string; chips: [string, string][] }> = {};
      for (const [k, text] of Object.entries(TRIGGERS)) {
        const r = await say(l, text);
        const chips: [string, string][] = [];
        for (const c of r.chips ?? []) {
          const cr = await say(l, c);
          chips.push([c, cr.card ? `${cr.card.type}|${cr.card.service}` : 'no card']);
        }
        out[k] = { reply: r.reply, chips };
      }
      return out;
    };
    const ref = await run('en');
    for (const [k, v] of Object.entries(ref)) {
      expect(v.chips.length, `en ${k}`).toBeGreaterThan(0);
      for (const [c, card] of v.chips) expect(card, `en ${k}: ${c}`).not.toBe('no card');
    }
    for (const l of OTHERS) {
      const got = await run(l);
      for (const [k, v] of Object.entries(got)) {
        expect(v.reply, `${l} ${k}`).not.toBe(ref[k].reply);
        expect(v.reply.includes('—'), `${l} ${k}`).toBe(false);
        expect(v.chips.map((c) => c[1]), `${l} ${k}: ${v.chips.map((c) => c[0]).join(' / ')}`).toEqual(ref[k].chips.map((c) => c[1]));
        if (NON_LATIN.includes(l)) expect(leftover(v.reply.replace(/Atlantis|Phuket|lunch/g, '')), `${l} ${k}: ${v.reply}`).toBe(false);
      }
    }
  });

  it('a request typed in the page language is understood, and greetings, thanks and "cancel" too', async () => {
    const typed: Record<string, { ride: string; hello: string; thanks: string; cancel: string }> = {
      vi: { ride: 'Taxi đến ICONSIAM', hello: 'Xin chào', thanks: 'Cảm ơn', cancel: 'Hủy đơn' },
      id: { ride: 'Taksi ke ICONSIAM', hello: 'Halo', thanks: 'Terima kasih', cancel: 'Batalkan pesanan' },
      ms: { ride: 'Teksi ke ICONSIAM', hello: 'Helo', thanks: 'Terima kasih', cancel: 'Batalkan pesanan' },
      fil: { ride: 'Taxi papunta sa ICONSIAM', hello: 'Kumusta', thanks: 'Salamat', cancel: 'Kanselahin ang order' },
      km: { ride: 'តាក់ស៊ីទៅកាន់ ICONSIAM', hello: 'សួស្តី', thanks: 'អរគុណ', cancel: 'បោះបង់ការបញ្ជាទិញ' },
      my: { ride: 'ICONSIAM သို့ Taxi ခေါ်ပေးပါ', hello: 'မင်္ဂလာပါ', thanks: 'ကျေးဇူးတင်ပါတယ်', cancel: 'အော်ဒါ ပယ်ဖျက်ပါ' },
      zh: { ride: '打车到 ICONSIAM', hello: '你好', thanks: '谢谢', cancel: '取消订单' },
    };
    await start('en');
    const ref = { hello: (await say('en', 'hello')).reply, thanks: (await say('en', 'thanks')).reply, cancel: (await say('en', 'cancel my order')).reply, unknown: (await say('en', 'qwerty zzz')).reply };
    for (const l of CATALOG_LANGS) {
      const t = typed[l];
      await start(l);
      const own = { hello: (await say(l, 'hello')).reply, thanks: (await say(l, 'thanks')).reply, cancel: (await say(l, 'cancel my order')).reply, unknown: (await say(l, 'qwerty zzz')).reply };
      expect((await say(l, t.hello)).reply, `${l} hello`).toBe(own.hello);
      expect((await say(l, t.thanks)).reply, `${l} thanks`).toBe(own.thanks);
      expect((await say(l, t.cancel)).reply, `${l} cancel`).toBe(own.cancel);
      for (const k of ['hello', 'thanks', 'cancel', 'unknown'] as const) expect(own[k], `${l} ${k}`).not.toBe(ref[k]);
      const ride = await say(l, t.ride);
      expect(ride.card?.type, `${l}: ${t.ride}: ${ride.reply}`).toBe('options');
      expect(ride.card.service, l).toBe('ride');
      expect(ride.card.route.to, l).toBe('ICONSIAM');
    }
  });
});

describe('The /ari API refuses malformed input in plain words', () => {
  const raw = (url: string, payload: string) => h.app.inject({ method: 'POST', url, headers: H(), payload, remoteAddress: ip() });

  it('an id or tool name of the wrong type is a 400 in the usual envelope, never a 500', async () => {
    await start('en');
    const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    const cases: [string, string][] = [
      ['/ari/api/action', '{"tool":{"toString":1},"arguments":{}}'],
      ['/ari/api/action', `{"tool":${deep}}`],
      ['/ari/api/confirm', '{"checkout_id":{"toString":1},"confirm_hash":"x"}'],
      ['/ari/api/decline', '{"checkout_id":["a"]}'],
      ['/ari/api/cancel', '{"order_id":{"toString":1}}'],
      ['/ari/api/cancel/confirm', `{"cancellation_id":${deep}}`],
    ];
    for (const [url, payload] of cases) {
      const r = await raw(url, payload);
      expect(r.statusCode, `${url} ${payload.slice(0, 40)}`).toBe(400);
      const j = r.json() as any;
      expect(j.ok, url).toBe(false);
      expect(j.error.code, url).toBe('VALIDATION_FAILED');
      expect(j.error.message, url).not.toMatch(/must be a string|toString|TypeError/);
    }
    // A body that is not an object, and an action whose arguments are a list.
    expect((await raw('/ari/api/message', '"hello"')).statusCode).toBeLessThan(500);
    expect((await raw('/ari/api/action', '{"tool":"search_stores","arguments":[1,2]}')).statusCode).toBeLessThan(500);
    // A message that is missing or not text is an empty message: Ari greets (200), nothing is coerced.
    for (const payload of ['{}', '{"text":{"toString":1}}', `{"text":${deep}}`, '{"text":42}', '{"text":["order","pad thai"]}']) {
      const r = await raw('/ari/api/message?lang=en', payload);
      expect(r.statusCode, payload.slice(0, 40)).toBe(200);
      expect((r.json() as any).reply, payload.slice(0, 40)).toMatch(/^Hi!/);
    }
  });

  it('a hand-made action shows a human line in the chat language, not developer text', async () => {
    for (const l of ['en', 'ru', 'vi', 'zh']) {
      await start(l);
      const general = (await post(`/ari/api/action?lang=${l}`, { tool: 'create_cart', arguments: { store_id: 'no-such-store', items: [{ item_id: 'x', quantity: 1 }] } })).reply;
      for (const args of [{}, { order_id: '00000000-0000-4000-8000-000000000000' }]) {
        for (const tool of ['create_cart', 'get_order_status', 'get_store']) {
          const r = await post(`/ari/api/action?lang=${l}`, { tool, arguments: args });
          expect(r.ok, `${l} ${tool}`).toBe(true);
          expect(r.reply, `${l} ${tool}`).not.toMatch(/is required|not found|search_stores|store_id|order_id|MCP error/i);
          if (l !== 'en') expect(r.reply, `${l} ${tool}`).not.toBe('Something went wrong. Please try again.');
        }
      }
      expect(general, l).toBeTruthy();
    }
  });

  it('a place typed in quotes is quoted once', async () => {
    await start('en');
    const en = await say('en', 'Taxi to "Atlantis"');
    expect(en.reply).toContain('"Atlantis"');
    expect(en.reply).not.toContain('""');
    await start('ru');
    const ru = await say('ru', 'Такси до «Атлантиды»');
    expect(ru.reply).toContain('«Атлантиды»');
    expect(ru.reply).not.toMatch(/««|»»/);
    await start('zh');
    const zh = await say('zh', '打车到“亚特兰蒂斯”');
    expect(zh.reply).toContain('“亚特兰蒂斯”');
    expect(zh.reply).not.toMatch(/““|””/);
  });
});
