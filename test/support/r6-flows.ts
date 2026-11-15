// The complete /ari flows used by the round-6 behaviour check (test/r6-perf-e2e.test.ts): every service in three
// languages from the first sentence to the final status, plus cancellation with a fee, decline, an expired card,
// repeat, double and parallel confirmation. It only talks HTTP to the app and reads the database, so the same
// flows can be run against another build of the server and the two transcripts compared.

export interface FlowDeps {
  inject(opts: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; payload?: string; remoteAddress?: string }): Promise<{ statusCode: number; headers: Record<string, any>; json(): any }>;
  clock: { advance(ms: number): void };
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  /** The seven example requests of a language: taxi, dinner, parcel, flowers, pharmacy, groceries, cake. */
  examples(lang: string): string[];
}

export interface Step { step: string; status: number; body: any }

export const SERVICES = ['ride', 'food', 'express', 'flowers', 'pharmacy', 'groceries', 'cake'] as const;
export const LANGS = ['en', 'ru', 'th'] as const;

let sessions = 0;

class Session {
  cookie = '';
  /** Every session comes from its own address, so the per-address request limits of the demo API count it alone. */
  private ip = `10.9.${Math.floor(++sessions / 250)}.${(sessions % 250) + 1}`;
  constructor(private d: FlowDeps, readonly lang: string, private log: Step[], private tag: string) {}
  private headers() {
    return { 'x-ari-demo': '1', origin: 'http://localhost:3000', cookie: this.cookie, 'content-type': 'application/json' };
  }
  private url(path: string) {
    return `${path}${path.includes('?') ? '&' : '?'}lang=${this.lang}`;
  }
  async post(step: string, path: string, body: unknown = {}, record = true) {
    const r = await this.d.inject({ method: 'POST', url: this.url(path), headers: this.headers(), payload: JSON.stringify(body), remoteAddress: this.ip });
    const sc = r.headers['set-cookie'];
    if (sc) this.cookie = (Array.isArray(sc) ? sc : [String(sc)]).map((c: string) => c.split(';')[0]).join('; ');
    const out = { step: `${this.tag}:${step}`, status: r.statusCode, body: r.json() };
    if (record) this.log.push(out);
    return out;
  }
  async get(step: string, path: string, record = true) {
    const r = await this.d.inject({ method: 'GET', url: this.url(path), headers: this.headers(), remoteAddress: this.ip });
    const out = { step: `${this.tag}:${step}`, status: r.statusCode, body: r.json() };
    if (record) this.log.push(out);
    return out;
  }
  start() {
    return this.post('session', '/ari/api/session');
  }
  /** A sentence to Ari, then the first option when Ari offers a choice. Returns the checkout card. */
  async checkout(step: string, text: string) {
    const m = await this.post(`${step}.message`, '/ari/api/message', { text });
    let card = m.body.card;
    if (card?.type === 'options') {
      const opt = card.options.find((o: any) => o.action);
      card = (await this.post(`${step}.action`, '/ari/api/action', { tool: opt.action.tool.name, arguments: opt.action.tool.arguments })).body.card;
    }
    return card;
  }
  confirm(step: string, card: any, record = true) {
    const cf = card.actions.find((x: any) => x.kind === 'confirm');
    return this.post(step, '/ari/api/confirm', { checkout_id: card.id, confirm_hash: cf?.endpoint.body.confirm_hash }, record);
  }
  /** Polls like the page does (events, then the order) while the demo clock moves, until the order is final. */
  async follow(step: string, orderId: string, after: number) {
    const statuses: string[] = [];
    const events: any[] = [];
    let seq = after;
    for (let i = 0; i < 40; i++) {
      const o = await this.get(`${step}.poll`, `/ari/api/orders/${orderId}`, false);
      const ev = await this.get(`${step}.events`, `/ari/api/events?after=${seq}`, false);
      for (const e of ev.body.events ?? []) {
        seq = Math.max(seq, e.seq);
        events.push(e);
      }
      const code = o.body.card?.status?.code;
      if (statuses.at(-1) !== code) statuses.push(code);
      if (o.body.card?.status?.is_final) {
        this.log.push({ step: `${this.tag}:${step}.final`, status: o.status, body: o.body });
        break;
      }
      this.d.clock.advance(i < 10 ? 2_000 : 30_000);
    }
    this.log.push({ step: `${this.tag}:${step}.followed`, status: 200, body: { statuses, events } });
    return { statuses, events, seq };
  }
}

export async function runFlows(d: FlowDeps): Promise<Step[]> {
  const log: Step[] = [];

  // 1. Every service in every language: options, checkout card, confirm, status progression with events.
  for (const lang of LANGS) {
    const s = new Session(d, lang, log, lang);
    await s.start();
    const ex = d.examples(lang);
    for (let i = 0; i < SERVICES.length; i++) {
      const name = SERVICES[i];
      const card = await s.checkout(name, ex[i]);
      const before = (await s.get(`${name}.events0`, '/ari/api/events?after=0', false)).body.events?.at(-1)?.seq ?? 0;
      const c = await s.confirm(`${name}.confirm`, card);
      await s.follow(name, c.body.order_id, before);
    }
    await s.post('session.again', '/ari/api/session');
  }

  // 2. Cancellation: free right after the order, with a fee once the kitchen (or the driver) has started, refused later.
  {
    const s = new Session(d, 'en', log, 'cancel');
    await s.start();
    const ex = d.examples('en');
    for (const [name, text, waitMs] of [['food.free', ex[1], 0], ['food.fee', ex[1], 8_000], ['ride.fee', ex[0], 4_000], ['ride.late', ex[0], 60_000]] as const) {
      const card = await s.checkout(name, text);
      const c = await s.confirm(`${name}.confirm`, card);
      await s.get(`${name}.poll0`, `/ari/api/orders/${c.body.order_id}`);
      d.clock.advance(waitMs);
      await s.get(`${name}.poll1`, `/ari/api/orders/${c.body.order_id}`);
      const k = await s.post(`${name}.cancel`, '/ari/api/cancel', { order_id: c.body.order_id });
      if (k.body.card) {
        const kc = k.body.card.actions.find((x: any) => x.kind === 'confirm');
        await s.post(`${name}.cancel.confirm`, '/ari/api/cancel/confirm', { cancellation_id: k.body.card.id, confirm_hash: kc.endpoint.body.confirm_hash });
        await s.post(`${name}.cancel.again`, '/ari/api/cancel/confirm', { cancellation_id: k.body.card.id, confirm_hash: kc.endpoint.body.confirm_hash });
      }
      await s.get(`${name}.after`, `/ari/api/orders/${c.body.order_id}`);
      await s.get(`${name}.events`, '/ari/api/events?after=0');
      d.clock.advance(10 * 60_000);
      await s.get(`${name}.settled`, `/ari/api/orders/${c.body.order_id}`);
    }
    // From the chat: "where is my order", "cancel my order" (only prepares), then the tap.
    const card = await s.checkout('chat', ex[4]);
    await s.confirm('chat.confirm', card);
    await s.post('chat.where', '/ari/api/message', { text: 'where is my order' });
    const ask = await s.post('chat.cancel', '/ari/api/message', { text: 'cancel my order' });
    const kc = ask.body.card?.actions?.find((x: any) => x.kind === 'confirm');
    if (kc) await s.post('chat.cancel.confirm', '/ari/api/cancel/confirm', { cancellation_id: ask.body.card.id, confirm_hash: kc.endpoint.body.confirm_hash });
  }

  // 3. Decline, a wrong hash, an expired card, a card whose quote went stale, a superseded card.
  {
    const s = new Session(d, 'ru', log, 'edge');
    await s.start();
    const ex = d.examples('ru');
    const declined = await s.checkout('decline', ex[0]);
    await s.post('decline.decline', '/ari/api/decline', { checkout_id: declined.id });
    await s.confirm('decline.confirm-after', declined);
    await s.post('decline.again', '/ari/api/decline', { checkout_id: declined.id });

    const wrong = await s.checkout('hash', ex[5]);
    await s.post('hash.wrong', '/ari/api/confirm', { checkout_id: wrong.id, confirm_hash: 'x'.repeat(40) });
    await s.post('hash.missing', '/ari/api/confirm', { checkout_id: wrong.id });
    await s.post('hash.unknown', '/ari/api/confirm', { checkout_id: '00000000-0000-4000-8000-000000000000', confirm_hash: 'x'.repeat(40) });
    await s.confirm('hash.right', wrong);

    const stale = await s.checkout('stale', ex[3]);
    d.clock.advance(6 * 60_000); // the provider quote (5 minutes) is over, the card (15 minutes) is not
    await s.confirm('stale.confirm', stale);

    const expired = await s.checkout('expired', ex[0]);
    d.clock.advance(16 * 60_000);
    await s.confirm('expired.confirm', expired);
    await s.confirm('expired.again', expired);
  }

  // 4. Repeat the last order, double confirmation, five parallel confirmations.
  {
    const s = new Session(d, 'th', log, 'repeat');
    await s.start();
    const ex = d.examples('th');
    await s.post('nothing', '/ari/api/message', { text: 'repeat my last order' });
    const first = await s.checkout('first', ex[1]);
    const c1 = await s.confirm('first.confirm', first);
    const c2 = await s.confirm('first.confirm.twice', first);
    log.push({ step: 'repeat:first.same-order', status: 200, body: { same: c1.body.order_id === c2.body.order_id && !!c1.body.order_id } });
    const again = await s.post('again', '/ari/api/message', { text: 'repeat my last order' });
    if (again.body.card?.type === 'checkout') {
      const many = await Promise.all([1, 2, 3, 4, 5].map(() => s.confirm('again.parallel', again.body.card, false)));
      const ids = new Set(many.map((m) => m.body.order_id));
      log.push({ step: 'repeat:again.parallel', status: 200, body: { statuses: many.map((m) => m.status).sort(), distinct_orders: ids.size, has_order: [...ids].every(Boolean), card: many[0].body.card } });
      const r = await d.query('SELECT count(*)::int AS n FROM orders WHERE checkout_id = $1', [again.body.card.id]);
      const sim = await d.query('SELECT count(*)::int AS n FROM demo_sim_orders WHERE idempotency_key = $1', [`unyly-${again.body.card.id}`]);
      const att = await d.query('SELECT count(*)::int AS n FROM submission_attempts WHERE checkout_id = $1', [again.body.card.id]);
      log.push({ step: 'repeat:again.parallel.rows', status: 200, body: { orders: r.rows[0].n, provider_orders: sim.rows[0].n, attempts: att.rows[0].n } });
      await s.follow('again', [...ids][0] as string, 0);
    }
    await s.post('track', '/ari/api/message', { text: 'where is my order' });
  }
  return log;
}

/** What the flows left in the database, without ids and times: the part of the behaviour no response shows. */
export async function dumpState(d: Pick<FlowDeps, 'query'>) {
  const rows = async (sql: string) => (await d.query(sql)).rows;
  return {
    audit: await rows(`SELECT regexp_replace(actor, 'web-[0-9a-f-]+', 'web-ID') AS actor, action, mode, entity, (details - 'total'::text) - 'fee'::text AS details, (details ->> 'total') IS NOT NULL AS has_total FROM audit_log ORDER BY id`),
    checkouts: await rows(`SELECT status, invalid_reason, approved_via, (approved_at IS NOT NULL) AS approved, (consumed_at IS NOT NULL) AS consumed, total_minor, mode FROM checkouts ORDER BY created_at, id`),
    attempts: await rows(`SELECT status, error_code, mode, (provider_order_ref IS NOT NULL) AS has_ref, (finished_at IS NOT NULL) AS finished, (next_reconcile_at IS NULL) AS settled FROM submission_attempts ORDER BY started_at, id`),
    orders: await rows(`SELECT service, mode, provider, restaurant_name, address_label, items, total_minor, currency, fulfillment_status, payment_status, status_version, (eta_at IS NOT NULL) AS has_eta, (picked_up_at IS NOT NULL) AS picked FROM orders ORDER BY created_at, id`),
    carts: await rows(`SELECT service, status, version, restaurant_name FROM carts ORDER BY created_at, id`),
    sim: await rows(`SELECT status, sequence, speed, total_minor, payload -> 'service' AS service, (cancelled_at IS NOT NULL) AS cancelled FROM demo_sim_orders ORDER BY accepted_at, ref`),
    cancellations: await rows(`SELECT status, fee_minor, currency, terms, error_code, (approved_at IS NOT NULL) AS approved, (executed_at IS NOT NULL) AS executed FROM cancellation_requests ORDER BY created_at, id`),
    confirmations: await rows(`SELECT partner_id, entity, user_verification, device_id FROM partner_confirmations ORDER BY created_at, id`),
    events: await rows(`SELECT event_type, status, (payload -> 'data') - '{order_id,checkout_id,cancellation_id,eta_at}'::text[] AS data, (payload -> 'notify') - 'live_activity'::text AS notify,
                               (payload #> '{notify,live_activity}') - 'eta_at'::text AS live FROM partner_webhooks ORDER BY id`),
  };
}

/** A response without ids, times and trace timings: what stays the same from run to run. */
export function normalize(v: unknown): unknown {
  const ids = new Map<string, string>();
  const idOf = (kind: string, x: string) => {
    if (!ids.has(x)) ids.set(x, `<${kind}${ids.size + 1}>`);
    return ids.get(x)!;
  };
  const walk = (x: unknown, key = ''): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (typeof x === 'string') {
      return x
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => idOf('id', m))
        .replace(/DEMO-[A-Z0-9]+/g, (m) => idOf('ref', m))
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
        .replace(/\b[0-9a-f]{40}\b/g, '<hash>')
        .replace(/^(search|trip):\d+$/, '$1:<n>');
    }
    if (!x || typeof x !== 'object') return key === 'ms' || key === 'seq' ? '<n>' : x;
    // The demo courier (name, plate, rating) is drawn from the random provider reference: only its shape is stable.
    if (key === 'courier') return Object.keys(x as object).sort();
    return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, walk(y, k)]));
  };
  return walk(v);
}
