// Natural, unscripted sentences a presenter might type into the /ari demo, in English, Russian and Thai.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectService, isHomePlace } from '../src/web/intent.js';
import { Harness, startHarness } from './helpers.js';

let h: Harness;
let cookie = '';
const post = async (url: string, body: unknown = {}) => {
  const r = await h.app.inject({ method: 'POST', url, headers: { 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  const sc = r.headers['set-cookie'];
  if (sc) cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c) => c.split(';')[0]).join('; ');
  return { status: r.statusCode, json: r.json() as any };
};
const say = (lang: string, text: string) => post(`/ari/api/message?lang=${lang}`, { text });

beforeAll(async () => {
  h = await startHarness({ cfg: { guestPerIpHourly: 100 } });
  await post('/ari/api/session?lang=en');
});
afterAll(async () => {
  await h.close();
});

describe('Ari demo brain: service detection for paraphrases', () => {
  const cases: [string, string][] = [
    ['get me a cab to the airport', 'ride'], ['take me home', 'ride'], ['go to Chatuchak market', 'ride'], ['drive me to the office', 'ride'], ['I need to get to Lumphini park', 'ride'],
    ['мне нужно в аэропорт', 'ride'], ['отвези меня домой', 'ride'], ['поехали на рынок Чатучак', 'ride'], ['вызови машину в аэропорт', 'ride'], ['из дома в аэропорт', 'ride'], ['еду домой', 'ride'],
    ['ไปสยามพารากอน', 'ride'], ['กลับบ้าน', 'ride'], ['ไปสนามบิน', 'ride'], ['วินไปทองหล่อ', 'ride'], ['ไปถนนข้าวสาร', 'ride'],
    ['send documents to Asok', 'express'], ['deliver a package to my home', 'express'], ['отправь документы на Асок', 'express'], ['доставь пакет в ICONSIAM', 'express'], ['ส่งเอกสารไปอโศก', 'express'],
    ['I want tom yum', 'food'], ['хочу том ям', 'food'], ['пад тай', 'food'], ['хочу есть', 'food'], ['อยากกินผัดไทย', 'food'], ['deliver pizza to my home', 'food'], ['закажи еду домой', 'food'],
    ['суши на троих без морепродуктов', 'food'], ['ไปกินข้าว', 'food'],
    ['need paracetamol', 'pharmacy'], ['I have a headache', 'pharmacy'], ['something for a sore throat', 'pharmacy'], ['sunscreen and mosquito repellent', 'pharmacy'],
    ['болит голова', 'pharmacy'], ['что-нибудь от горла', 'pharmacy'], ['крем от солнца и средство от комаров', 'pharmacy'], ['ปวดหัว', 'pharmacy'], ['เจ็บคอ', 'pharmacy'], ['ครีมกันแดดกับยากันยุง', 'pharmacy'],
    ['coffee and milk', 'groceries'], ['кофе и молоко', 'groceries'], ['กาแฟกับนม', 'groceries'], ['закажи цветы маме', 'flowers'], ['สั่งดอกไม้ให้แม่', 'flowers'], ['торт со свечами', 'cakes'],
  ];
  for (const [text, service] of cases) it(`${text} -> ${service}`, () => expect(detectService(text).service).toBe(service));

  it('home is a flag, not a place name, and keeps the other end of the trip', () => {
    expect(detectService('taxi home')).toMatchObject({ service: 'ride', dropoff_home: true });
    expect(detectService('ride home from Asok')).toMatchObject({ pickup: 'Asok', dropoff_home: true });
    expect(detectService('Taxi from Siam Paragon to home')).toMatchObject({ pickup: 'Siam Paragon', dropoff_home: true });
    expect(detectService('2 kg parcel from home to Siam Paragon')).toMatchObject({ service: 'express', pickup_home: true, dropoff: 'Siam Paragon', weight_kg: 2 });
    expect(detectService('такси домой от Сиам Парагона')).toMatchObject({ pickup: 'Сиам Парагона', dropoff_home: true });
    expect(detectService('посылка 2 кг из дома в Сиам Парагон')).toMatchObject({ service: 'express', pickup_home: true, dropoff: 'Сиам Парагон' });
    expect(detectService('แท็กซี่จากสยามพารากอนไปบ้าน')).toMatchObject({ pickup: 'สยามพารากอน', dropoff_home: true });
    expect(detectService('ส่งพัสดุ 2 กก จากบ้านไปสยามพารากอน')).toMatchObject({ service: 'express', pickup_home: true });
    expect(isHomePlace('home office')).toBe(false);
    expect(detectService('taxi to Siam Paragon')).not.toHaveProperty('dropoff_home');
  });
});

describe('Ari demo brain: replies', () => {
  it('"home" resolves to the saved default place in every language, whatever language the label was saved in', async () => {
    // The session was started in English, so the saved label is "Home".
    for (const [lang, text] of [['en', 'ride home from Asok'], ['ru', 'такси домой от Асока'], ['th', 'แท็กซี่จากอโศกไปบ้าน']]) {
      const r = await say(lang, text);
      expect([text, r.json.card?.route]).toEqual([text, expect.objectContaining({ from: 'Asok / Terminal 21', to: 'Home' })]);
    }
    for (const [lang, text] of [['en', '2 kg parcel from home to Siam Paragon'], ['ru', 'посылка 2 кг из дома в Сиам Парагон'], ['th', 'ส่งพัสดุ 2 กก จากบ้านไปสยามพารากอน']]) {
      const r = await say(lang, text);
      expect([text, r.json.card?.service, r.json.card?.route?.from, r.json.card?.route?.to]).toEqual([text, 'express', 'Home', 'Siam Paragon']);
    }
  });

  it('"taxi home" without a pickup asks where from, and its chips work', async () => {
    for (const [lang, text] of [['en', 'taxi home'], ['ru', 'отвези меня домой'], ['th', 'กลับบ้าน'], ['en', 'deliver a package to my home']]) {
      const r = await say(lang, text);
      expect(r.json.card ?? null).toBeNull();
      expect(r.json.chips.length).toBeGreaterThan(0);
      const next = await say(lang, r.json.chips[0]);
      expect([text, next.json.card?.route?.to]).toEqual([text, 'Home']);
      expect(next.json.card.route.from).toBe('Siam Paragon');
    }
  });

  it('an ambiguous or unknown place keeps the request: chips repeat it with the suggested place', async () => {
    const a = await say('en', 'taxi home from the airport');
    expect(a.json.chips).toEqual(['Taxi from Suvarnabhumi Airport (BKK) to home', 'Taxi from Don Mueang Airport (DMK) to home']);
    expect((await say('en', a.json.chips[1])).json.card.route).toMatchObject({ from: 'Don Mueang Airport (DMK)', to: 'Home' });
    const p = await say('ru', 'отправь посылку 5 кг в офис');
    expect(p.json.chips[0]).toMatch(/^Отправить посылку 5 кг в /);
    expect((await say('ru', p.json.chips[0])).json.card.service).toBe('express');
  });

  it('thanks, help, greetings with a request, and unknown sentences get a fitting reply', async () => {
    expect((await say('en', 'thanks')).json.reply).toContain('welcome');
    expect((await say('ru', 'спасибо')).json.reply).toContain('Пожалуйста');
    expect((await say('th', 'ขอบคุณ')).json.reply).toContain('ยินดี');
    for (const [lang, text] of [['en', 'what can you do?'], ['ru', 'что ты умеешь?'], ['th', 'ทำอะไรได้บ้าง']]) {
      const r = await say(lang, text);
      expect([text, r.json.chips.length, r.json.trace.length]).toEqual([text, 4, 0]);
      expect(r.json.reply).not.toMatch(/did not catch|Не поняла|ยังไม่แน่ใจ/);
    }
    expect((await say('en', 'Hi, taxi to Asok')).json.card.type).toBe('options');
    expect((await say('en', 'hello')).json.card ?? null).toBeNull();
    expect((await say('en', 'qwerty zxcv')).json.reply).toContain('did not catch');
  });

  it('a food search counts only restaurants that can be chosen and hides a card with nothing to tap', async () => {
    const vegan = await say('en', 'vegan dinner for two');
    const selectable = vegan.json.card.options.filter((o: any) => o.action).length;
    expect(vegan.json.reply.startsWith(`${selectable} option`)).toBe(true);
    const halal = await say('en', 'halal lunch for 4 under 800 baht');
    expect(halal.json.card ?? null).toBeNull();
    expect(halal.json.reply).toContain('Nothing matches');
  });

  it('where is my order, cancel my order and reorder work from the chat', async () => {
    expect((await say('en', 'where is my order')).json.reply).toContain('no orders yet');
    expect((await say('ru', 'отмени заказ')).json.reply).toContain('Отменять нечего');
    const order = async (lang: string, text: string) => {
      const m = await say(lang, text);
      let card = m.json.card;
      if (card.type === 'options') {
        const opt = card.options.find((o: any) => o.action);
        card = (await post(`/ari/api/action?lang=${lang}`, { tool: opt.action.tool.name, arguments: opt.action.tool.arguments })).json.card;
      }
      const cf = card.actions.find((x: any) => x.kind === 'confirm');
      const c = await post(`/ari/api/confirm?lang=${lang}`, { checkout_id: card.id, confirm_hash: cf.endpoint.body.confirm_hash });
      return { card, order_id: c.json.order_id as string };
    };
    // Above 2000 baht the checkout card asks for Face ID.
    const big = await order('en', 'roses, lilies and orchids with a gift box');
    expect(big.card.total.amount_minor).toBeGreaterThan(200_000);
    expect(big.card.actions[0].requires_user_verification).toBe('biometric');
    expect(big.card.badges).toContain('Face ID required for this amount');
    const small = await order('en', 'need paracetamol');
    expect(small.card.actions[0].requires_user_verification).toBe('tap');
    // Two orders in a row, then a ride in another language.
    const ride = await order('th', 'ไปสยามพารากอน');
    expect(new Set([big.order_id, small.order_id, ride.order_id]).size).toBe(3);
    const where = await say('ru', 'где мой заказ');
    expect(where.json.card.type).toBe('order');
    expect(where.json.order_id).toBe(ride.order_id);
    expect(where.json.reply).toMatch(/^Ваш последний заказ: \S/);
    const cancel = await say('en', 'cancel my order');
    expect(cancel.json.card.type).toBe('cancellation');
    const cc = cancel.json.card.actions.find((x: any) => x.kind === 'confirm');
    const done = await post('/ari/api/cancel/confirm?lang=th', { cancellation_id: cancel.json.card.id, confirm_hash: cc.endpoint.body.confirm_hash });
    expect(done.json.reply).toBe('ยกเลิกแล้วค่ะ');
    expect(done.json.card.status.code).toBe('cancelled');
    // Cancel then reorder.
    const again = await order('ru', 'такси в Сиам Парагон');
    expect(again.order_id).not.toBe(ride.order_id);
    expect((await say('en', 'where is my ride')).json.order_id).toBe(again.order_id);
  });

  it('switching the language mid-session switches replies and cards', async () => {
    const en = await say('en', 'taxi to Asok');
    const ru = await say('ru', 'такси до Асока');
    const th = await say('th', 'แท็กซี่ไปอโศก');
    expect(en.json.reply).toMatch(/^From Home to Asok/);
    expect(ru.json.reply).toMatch(/^Маршрут: Home → Asok/);
    expect(th.json.reply).toMatch(/^จาก Home ไป Asok/);
    expect([en.json.card.title, ru.json.card.title, th.json.card.title]).toEqual(['Choose a ride', 'Выберите поездку', 'เลือกประเภทรถ']);
  });
});
