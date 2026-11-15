// Live Ari demo: the browser plays the Ari iPhone app, the server plays Ari's backend calling the
// Unyly Partner API. All text from the server is inserted with textContent (store names are data).
(() => {
  const app = document.getElementById('ari-app');
  if (!app) return;
  const S = JSON.parse(app.dataset.strings || '{}');
  const EX = JSON.parse(app.dataset.examples || '[]');
  const $ = (id) => document.getElementById(id);
  const chat = $('ari-chat');
  const chips = $('ari-chips');
  const input = $('ari-input');
  const trace = $('ari-trace');
  const island = $('ari-island');
  const push = $('ari-push');
  const sheet = $('ari-faceid');
  const call = $('ari-call');
  const lang = S.lang || document.documentElement.lang || 'en';
  let lastEvent = 0;
  let busy = false;
  let activeOrder = null;
  let pollTimer = null;
  let traceEmpty = true;
  const called = new Set();
  const orderCards = new Map();
  let orderShownAt = 0;
  let lastPushAt = 0;
  let ringTimer = null;
  let liveCard = null;

  // While the Face ID sheet or the call covers the screen, keep keyboard and screen readers inside it.
  const overlay = (node, on) => {
    for (const k of node.parentElement.children) if (k !== node) k.inert = on;
  };
  // Move keyboard focus to a new card (its first button) unless the user is typing.
  const focusCard = (c) => {
    if (!c || document.activeElement === input) return;
    const b = c.querySelector('button:not([disabled]), a[href]');
    if (b) b.focus({ preventScroll: true });
    else {
      c.tabIndex = -1;
      c.focus({ preventScroll: true });
    }
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const svg = (name) => {
    // Small inline icons (same stroke style as the site).
    const P = {
      arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', faceid: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1M15 9v1M12 9v4h-1M9 15.5a4 4 0 0 0 6 0"/>',
      car: '<path d="M5 16V11l2-5h10l2 5v5M5 16h14M7 19v-3M17 19v-3M7.5 13h.01M16.5 13h.01"/>', bike: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-7h5l3 7M10 10l-1-3H7"/>',
      x: '<path d="M6 6l12 12M18 6 6 18"/>', check: '<path d="M5 12l5 5 9-10"/>',
    };
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = P[name] || P.check;
    return s;
  };
  const scroll = () => requestAnimationFrame(() => (chat.scrollTop = chat.scrollHeight));
  const api = async (method, url, body) => {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'x-ari-demo': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({ ok: false, error: { message: S.error } }));
    if (!j.ok) throw Object.assign(new Error(j.error?.message || S.error), { code: j.error?.code });
    return j;
  };
  const withLang = (u) => `${u}${u.includes('?') ? '&' : '?'}lang=${encodeURIComponent(lang)}`;

  // ---------------- clock
  const tick = () => {
    const d = new Date();
    $('ari-clock').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 15000);

  // ---------------- messages
  const say = (who, text) => {
    if (!text) return null;
    const m = el('div', `ari-msg ${who}`, text);
    chat.appendChild(m);
    scroll();
    return m;
  };
  const typing = () => {
    const t = el('div', 'ari-typing');
    t.setAttribute('aria-label', S.typing);
    t.append(el('i'), el('i'), el('i'));
    chat.appendChild(t);
    scroll();
    return t;
  };
  const setChips = (list) => {
    chips.textContent = '';
    (list || []).forEach((x) => {
      const b = el('button', '', x);
      b.type = 'button';
      b.addEventListener('click', () => ask(x));
      chips.appendChild(b);
    });
  };
  const addTrace = (entries) => {
    (entries || []).forEach((t) => {
      if (traceEmpty) {
        trace.textContent = '';
        traceEmpty = false;
      }
      const li = el('li', `call ${t.ok ? '' : 'bad'}`);
      const [m, ...p] = String(t.call).split(' ');
      const path = p.join(' ').replace(/\/users\/[^/]+/, '/users/{uid}').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{id}');
      li.append(el('span', 'm', m), el('span', 'p', path), el('span', 'ms', `${t.ms} ms`));
      if (t.grab) {
        const g = el('span', 'g');
        g.append(el('b', '', `${S.liveCall}: `), document.createTextNode(t.grab));
        li.appendChild(g);
      }
      trace.appendChild(li);
      trace.scrollTop = trace.scrollHeight;
    });
  };

  // ---------------- cards
  const badges = (card) => {
    const list = card.badges || [];
    if (!list.length) return null;
    const w = el('div', 'badges');
    list.forEach((b) => w.appendChild(el('span', `badge ${/demo|демо|เดโม/i.test(b) ? 'demo' : /face/i.test(b) ? 'fid' : ''}`, b)));
    return w;
  };
  const routeRow = (card) => {
    if (!card.route || !card.route.from) return null;
    const r = el('div', 'ac-route');
    r.append(el('span', '', card.route.from), svg('arrow'), el('span', '', card.route.to));
    if (card.route.distance_km) r.appendChild(el('small', '', `${card.route.distance_km} km`));
    return r;
  };
  function renderCard(card, opts = {}) {
    const c = el('div', 'ari-card');
    c.dataset.type = card.type;
    if (card.type === 'options') {
      c.append(el('h4', '', card.title));
      if (card.subtitle) c.append(el('div', 'sub', card.subtitle));
      const rr = routeRow(card);
      if (rr) c.append(rr);
      const list = el('div', 'ac-opts');
      (card.options || []).forEach((o) => {
        const b = el('button', 'ac-opt');
        b.type = 'button';
        b.append(el('b', '', o.title), el('span', 'price', o.price || ''));
        b.append(el('small', '', o.disabled_reason || o.subtitle || ''), el('span', 'eta', o.eta || ''));
        if (o.badges && o.badges.length) {
          const row = el('span', 'chiprow');
          o.badges.forEach((x) => row.appendChild(el('span', 'badge', x)));
          b.append(row);
        }
        if (!o.action) b.disabled = true;
        else b.addEventListener('click', () => choose(o, list));
        list.appendChild(b);
      });
      c.append(list);
      if (card.footnote) c.append(el('div', 'ac-foot', card.footnote));
    } else if (card.type === 'checkout') {
      c.append(el('h4', '', card.title));
      if (card.subtitle) c.append(el('div', 'sub', card.subtitle));
      const bd = badges(card);
      if (bd) c.append(bd);
      const rr = routeRow(card);
      if (rr) c.append(rr);
      (card.lines || []).forEach((x) => {
        const row = el('div', 'ac-row');
        row.append(el('span', '', `${x.quantity && x.quantity > 1 ? `${x.quantity}× ` : ''}${x.title}`), el('b', '', x.value));
        c.append(row);
      });
      (card.breakdown || []).slice(1).forEach((x) => {
        const row = el('div', 'ac-row');
        row.append(el('span', '', x.label), el('span', '', x.value));
        c.append(row);
      });
      if (card.total) {
        const row = el('div', 'ac-row total');
        row.append(el('span', '', card.total.label), el('span', '', card.total.value));
        c.append(row);
      }
      const confirm = (card.actions || []).find((a) => a.kind === 'confirm');
      const decline = (card.actions || []).find((a) => a.kind === 'decline');
      if (confirm) {
        const b = el('button', 'ac-btn');
        b.type = 'button';
        b.append(svg('faceid'), document.createTextNode(confirm.label));
        b.addEventListener('click', () => doConfirm(card, confirm, c));
        c.append(b);
      }
      if (decline) {
        const b = el('button', 'ac-act secondary', decline.label);
        b.type = 'button';
        b.addEventListener('click', () => doDecline(card, c));
        c.append(b);
      }
      if (card.footnote) c.append(el('div', 'ac-foot', card.footnote));
    } else if (card.type === 'order') {
      fillOrder(c, card);
    } else if (card.type === 'cancellation') {
      c.append(el('h4', '', card.title));
      if (card.subtitle) c.append(el('div', 'sub', card.subtitle));
      const confirm = (card.actions || []).find((a) => a.kind === 'confirm');
      const keep = (card.actions || []).find((a) => a.kind === 'decline');
      if (confirm) {
        const b = el('button', 'ac-act destructive', confirm.label);
        b.type = 'button';
        b.addEventListener('click', () => doCancelConfirm(card, confirm, c));
        c.append(b);
      }
      if (keep) {
        const b = el('button', 'ac-act secondary', keep.label);
        b.type = 'button';
        b.addEventListener('click', () => c.querySelectorAll('button').forEach((x) => (x.disabled = true)));
        c.append(b);
      }
      if (card.footnote) c.append(el('div', 'ac-foot', card.footnote));
    } else {
      c.append(el('h4', '', card.title));
      if (card.subtitle) c.append(el('div', 'sub', card.subtitle));
      (card.actions || []).filter((a) => a.kind === 'open_url' && a.url).forEach((a) => {
        const link = el('a', 'ac-btn', a.label);
        link.href = a.url;
        link.rel = 'noopener';
        c.append(link);
      });
    }
    if (!opts.detached) {
      chat.appendChild(c);
      // A card taller than the chat is shown from its title, not from its bottom.
      requestAnimationFrame(() => {
        if (c.offsetHeight > chat.clientHeight - 24) chat.scrollTop += c.getBoundingClientRect().top - chat.getBoundingClientRect().top - 8;
        else chat.scrollTop = chat.scrollHeight;
      });
    }
    return c;
  }

  function fillOrder(c, card) {
    // The card is rebuilt on every poll: keep keyboard focus inside it if it was there.
    const hadFocus = c.contains(document.activeElement);
    c.textContent = '';
    c.className = `ari-card${card.status && card.status.is_final ? ' final' : ''}${card.status && /cancel|fail/.test(card.status.code) ? ' cancelled' : ''}`;
    c.append(el('h4', '', card.title));
    if (card.subtitle) c.append(el('div', 'sub', card.subtitle));
    const st = card.status;
    if (st) {
      const head = el('div', 'ac-status');
      head.append(el('b', '', st.label));
      const eta = st.eta_at && !st.is_final ? Math.max(1, Math.round((new Date(st.eta_at) - Date.now()) / 60000)) : null;
      if (eta) head.append(el('small', '', `${S.eta} ~${eta} ${S.min || 'min'}`));
      c.append(head);
      const bar = el('div', 'ac-steps');
      const idx = st.steps.findIndex((x) => x.code === st.code);
      st.steps.forEach((x, i) => {
        const s = el('span', x.done ? 'done' : i === idx + 1 && !st.is_final ? 'now' : '');
        s.title = x.label;
        bar.appendChild(s);
      });
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', card.title || st.label);
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(st.steps.length));
      bar.setAttribute('aria-valuenow', String(st.steps.filter((x) => x.done).length));
      bar.setAttribute('aria-valuetext', st.label);
      c.append(bar);
    }
    if (card.courier) {
      const cr = el('div', 'ac-courier');
      const cv = el('span', 'cv');
      cv.appendChild(svg(card.service === 'ride' ? 'car' : 'bike'));
      const info = el('div');
      info.append(el('b', '', `${card.courier.name} · ★ ${card.courier.rating}`), el('br'), document.createTextNode(card.courier.vehicle));
      cr.append(cv, info, el('span', 'plate', card.courier.plate));
      c.append(cr);
    }
    if (card.total) {
      const row = el('div', 'ac-row total');
      row.append(el('span', '', card.total.label), el('span', '', card.total.value));
      c.append(row);
    }
    const cancel = (card.actions || []).find((a) => a.kind === 'prepare_cancel');
    if (cancel) {
      const b = el('button', 'ac-act destructive', cancel.label);
      b.type = 'button';
      b.addEventListener('click', () => doCancel(card.id, b));
      c.append(b);
    }
    if (card.footnote) c.append(el('div', 'ac-foot', card.footnote));
    if (hadFocus) focusCard(c);
    updateIsland(card);
  }

  // ---------------- flows
  async function ask(text) {
    const q = String(text || '').trim();
    if (!q || busy) return;
    busy = true;
    input.value = '';
    say('me', q);
    setChips([]);
    const t = typing();
    try {
      const r = await api('POST', withLang('/ari/api/message'), { text: q });
      await new Promise((ok) => setTimeout(ok, 350));
      t.remove();
      say('ari', r.reply);
      if (r.card) focusCard(renderCard(r.card));
      setChips(r.chips && r.chips.length ? r.chips : []);
      addTrace(r.trace);
    } catch (e) {
      t.remove();
      say('ari', e.message || S.error);
      setChips(EX.slice(0, 3));
    } finally {
      busy = false;
    }
  }

  async function choose(opt, list) {
    if (busy) return;
    busy = true;
    list.querySelectorAll('button').forEach((b) => (b.disabled = true));
    say('me', opt.title);
    const t = typing();
    try {
      const a = opt.action.tool;
      const r = await api('POST', withLang('/ari/api/action'), { tool: a.name, arguments: a.arguments });
      t.remove();
      if (r.reply) say('ari', r.reply);
      if (r.card) focusCard(renderCard(r.card));
      if (r.chips && r.chips.length) setChips(r.chips);
      addTrace(r.trace);
    } catch (e) {
      t.remove();
      say('ari', e.message || S.error);
      list.querySelectorAll('button').forEach((b) => (b.disabled = false));
    } finally {
      busy = false;
    }
  }

  function markDone(node, text, ok) {
    node.querySelectorAll('.ac-btn, .ac-act').forEach((b) => b.remove());
    const d = el('div', 'ac-done');
    if (ok) d.appendChild(svg('check'));
    d.appendChild(document.createTextNode(text));
    const foot = node.querySelector('.ac-foot');
    node.insertBefore(d, foot);
  }

  const faceId = () => new Promise((ok) => {
    sheet.hidden = false;
    sheet.className = 'ari-sheet scan';
    overlay(sheet, true);
    sheet.focus({ preventScroll: true });
    setTimeout(() => {
      sheet.className = 'ari-sheet ok';
      setTimeout(() => {
        sheet.hidden = true;
        overlay(sheet, false);
        ok();
      }, 450);
    }, 1000);
  });

  async function doConfirm(card, action, node) {
    if (busy) return;
    busy = true;
    node.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      // The app may always ask for Face ID; it must when the card says biometric.
      await faceId();
      const r = await api('POST', withLang('/ari/api/confirm'), { checkout_id: card.id, confirm_hash: action.endpoint.body.confirm_hash, user_verification: 'biometric' });
      addTrace(r.trace);
      markDone(node, S.confirmed, true);
      say('ari', r.reply);
      if (r.card) {
        const c = renderCard(r.card);
        orderCards.set(r.card.id, c);
        activeOrder = r.card.id;
        liveCard = r.card;
        orderShownAt = Date.now();
        updateIsland(r.card);
        focusCard(c);
        startPolling();
      }
    } catch (e) {
      say('ari', e.message || S.error);
      node.querySelectorAll('button').forEach((b) => (b.disabled = false));
    } finally {
      busy = false;
    }
  }

  async function doDecline(card, node) {
    node.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const r = await api('POST', withLang('/ari/api/decline'), { checkout_id: card.id });
      markDone(node, S.declined, false);
      say('ari', r.reply);
      setChips(EX.slice(0, 4));
    } catch (e) {
      say('ari', e.message || S.error);
    }
  }

  async function doCancel(orderId, btn) {
    btn.disabled = true;
    try {
      const r = await api('POST', withLang('/ari/api/cancel'), { order_id: orderId });
      say('ari', r.reply);
      if (r.card) renderCard(r.card);
    } catch (e) {
      say('ari', e.message || S.error);
      btn.disabled = false;
    }
  }

  async function doCancelConfirm(card, action, node) {
    node.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const r = await api('POST', withLang('/ari/api/cancel/confirm'), { cancellation_id: card.id, confirm_hash: action.endpoint.body.confirm_hash });
      say('ari', r.reply);
      if (r.card) {
        const c = orderCards.get(r.card.id);
        if (c) fillOrder(c, r.card);
        else renderCard(r.card);
      }
    } catch (e) {
      say('ari', e.message || S.error);
    }
  }

  // ---------------- live updates: Live Activity, pushes and a call from Ari
  function updateIsland(card) {
    if (!card || card.type !== 'order' || !card.status) return;
    if (card.id !== activeOrder) return;
    const st = card.status;
    $('la-title').textContent = st.label;
    const eta = st.eta_at && !st.is_final ? Math.max(1, Math.round((new Date(st.eta_at) - Date.now()) / 60000)) : null;
    const ended = /cancel|fail/.test(st.code);
    $('la-eta').textContent = eta ? `${eta} ${S.min || 'min'}` : st.is_final && !ended ? '✓' : '';
    island.classList.toggle('ended', ended);
    island.classList.add('live');
    if (st.is_final) setTimeout(() => island.classList.remove('live'), 5000);
  }

  let pushTimer = null;
  function showPush(n) {
    $('push-title').textContent = n.title;
    $('push-body').textContent = n.body;
    push.classList.add('show');
    lastPushAt = Date.now();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push.classList.remove('show'), 3800);
  }

  function ringCall(card, notify) {
    if (!call.hidden) return;
    const courier = card && card.courier;
    const line = (S.callLine || '')
      .replace('{status}', notify.title)
      .replace('{courier}', courier ? courier.name : '')
      .replace('{vehicle}', courier ? courier.vehicle : '')
      .replace('{plate}', courier ? courier.plate : '');
    $('call-line').textContent = '';
    $('call-state').textContent = S.calling;
    call.className = 'ari-call';
    call.hidden = false;
    const before = document.activeElement;
    overlay(call, true);
    $('call-yes').focus({ preventScroll: true });
    const hang = () => {
      if (call.hidden) return;
      call.hidden = true;
      overlay(call, false);
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      if (before && before !== document.body && before.isConnected && !before.disabled) before.focus({ preventScroll: true });
      else if (liveCard && orderCards.get(liveCard.id)) focusCard(orderCards.get(liveCard.id));
    };
    call.onkeydown = (e) => { if (e.key === 'Escape') hang(); };
    $('call-no').onclick = hang;
    $('call-yes').onclick = () => {
      call.className = 'ari-call active';
      $('call-state').textContent = '0:01';
      $('call-line').textContent = line;
      $('call-no').focus({ preventScroll: true });
      try {
        if (window.speechSynthesis) {
          const u = new SpeechSynthesisUtterance(line);
          u.lang = lang === 'th' ? 'th-TH' : lang === 'ru' ? 'ru-RU' : 'en-US';
          u.rate = 1.02;
          u.onend = () => setTimeout(hang, 800);
          window.speechSynthesis.speak(u);
        } else setTimeout(hang, 6000);
      } catch (e) {
        setTimeout(hang, 6000);
      }
    };
    setTimeout(() => { if (!call.hidden && call.className === 'ari-call') hang(); }, 15000);
  }

  async function pollOnce() {
    try {
      const ev = await api('GET', withLang(`/ari/api/events?after=${lastEvent}`));
      let latestNotify = null;
      for (const e of ev.events) {
        lastEvent = Math.max(lastEvent, e.seq);
        if ((e.type === 'order.status_changed' || e.type === 'order.created') && e.notify) latestNotify = { e, n: e.notify };
      }
      if (activeOrder) {
        const r = await api('GET', withLang(`/ari/api/orders/${activeOrder}`));
        const c = orderCards.get(activeOrder);
        if (c) fillOrder(c, r.card);
        liveCard = r.card;
        if (latestNotify) {
          if (latestNotify.n.level !== 'info') showPush(latestNotify.n);
          const key = `${latestNotify.e.data.order_id}:${latestNotify.e.data.status}`;
          if (latestNotify.n.suggest_call && !called.has(key)) {
            called.add(key);
            // Let the user see the order card and the push first: ring no sooner than 9 s after the
            // card appeared and 3 s after the push, and only while that order is still running.
            const oid = r.card.id;
            const note = latestNotify.n;
            const now = Date.now();
            const wait = Math.max(900, orderShownAt + 9000 - now, lastPushAt + 3000 - now);
            clearTimeout(ringTimer);
            const ring = () => {
              if (activeOrder !== oid || !liveCard || liveCard.id !== oid) return;
              if (!sheet.hidden || busy) { ringTimer = setTimeout(ring, 1000); return; }
              const st = liveCard.status;
              if (st && st.is_final) return;
              ringCall(liveCard, { title: st && st.label ? st.label : note.title });
            };
            ringTimer = setTimeout(ring, wait);
          }
        }
        if (r.card.status && r.card.status.is_final) {
          activeOrder = null;
          stopPolling();
          setChips(EX.slice(0, 4));
        }
      }
    } catch (e) {
      /* transient; try again on the next tick */
    }
  }
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollOnce, 3000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---------------- composer, mic, Grab link, reset
  $('ari-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ask(input.value);
  });
  let exIdx = 0;
  $('ari-mic').addEventListener('click', () => {
    const mic = $('ari-mic');
    if (busy || mic.classList.contains('rec')) return;
    mic.classList.add('rec');
    const text = EX[exIdx++ % EX.length];
    let i = 0;
    const iv = setInterval(() => {
      input.value = text.slice(0, (i += 3));
      if (i >= text.length) {
        clearInterval(iv);
        mic.classList.remove('rec');
        setTimeout(() => ask(text), 250);
      }
    }, 40);
  });
  $('ari-grab').addEventListener('click', async () => {
    const b = $('ari-grab');
    if (b.classList.contains('on')) return;
    try {
      await api('POST', withLang('/ari/api/grab-link'));
      b.classList.add('on');
      b.setAttribute('aria-pressed', 'true');
      b.querySelector('span').textContent = S.linked;
      showPush({ title: 'Grab', body: S.linkedNote || S.linked });
    } catch (e) {
      say('ari', e.message || S.error);
    }
  });
  $('ari-reset').addEventListener('click', () => {
    stopPolling();
    clearTimeout(ringTimer);
    activeOrder = null;
    liveCard = null;
    island.classList.remove('live', 'ended');
    chat.textContent = '';
    start(true);
  });

  async function start(again) {
    const t = typing();
    try {
      const r = await api('POST', withLang('/ari/api/session'));
      lastEvent = r.last_event || 0;
      t.remove();
      say('ari', r.greeting);
      setChips(r.examples || EX);
      if (r.grab && r.grab.linked) {
        $('ari-grab').classList.add('on');
        $('ari-grab').setAttribute('aria-pressed', 'true');
        $('ari-grab').querySelector('span').textContent = S.linked;
      }
      if (!again) say('note', S.voiceNote);
    } catch (e) {
      t.remove();
      say('ari', e.message || S.error);
    }
  }
  start(false);
})();
