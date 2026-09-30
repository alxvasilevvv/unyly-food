// Progressive enhancement only; every page works without JavaScript.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = document.getElementById(b.dataset.copy)?.textContent?.trim() ?? '';
  navigator.clipboard?.writeText(text).then(() => {
    const old = b.textContent;
    b.textContent = b.dataset.copied || 'Copied';
    setTimeout(() => (b.textContent = old), 1500);
  });
});
// Visual guard against double submission. The server is idempotent regardless.
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.dataset.submitted) {
    e.preventDefault();
    return;
  }
  f.dataset.submitted = '1';
  f.querySelectorAll('button[type=submit]').forEach((b) => b.setAttribute('aria-busy', 'true'));
});

// ---------------- Passkeys (WebAuthn) ----------------
(() => {
  const b64uToBuf = (s) => {
    const p = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
  };
  const bufToB64u = (b) => {
    let s = '';
    new Uint8Array(b).forEach((x) => (s += String.fromCharCode(x)));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const supported = () => typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message || 'Error'), { server: true });
    return j;
  };
  const creationOptions = (o) => {
    if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
    return {
      ...o,
      challenge: b64uToBuf(o.challenge),
      user: { ...o.user, id: b64uToBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
  };
  const requestOptions = (o) => {
    if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
    return { ...o, challenge: b64uToBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) };
  };
  const credToJSON = (c) => {
    try {
      if (typeof c.toJSON === 'function') return c.toJSON();
    } catch {}
    const r = c.response;
    const out = { id: c.id, rawId: bufToB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment, response: { clientDataJSON: bufToB64u(r.clientDataJSON) } };
    if (r.attestationObject) {
      out.response.attestationObject = bufToB64u(r.attestationObject);
      out.response.transports = r.getTransports ? r.getTransports() : [];
    } else {
      out.response.authenticatorData = bufToB64u(r.authenticatorData);
      out.response.signature = bufToB64u(r.signature);
      if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
    }
    return out;
  };
  const setStatus = (el, box, msg) => { if (el) el.textContent = msg || ''; };
  const fail = (el, box, e) => {
    const cancelled = e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
    setStatus(el, box, e && e.server ? e.message : cancelled ? box.dataset.msgCancelled : (e && e.message) || 'Error');
  };

  const loginBox = document.getElementById('pk-login-box');
  if (loginBox) {
    const st = document.getElementById('pk-login-status');
    document.getElementById('pk-login').addEventListener('click', async (ev) => {
      if (!supported()) return setStatus(st, loginBox, loginBox.dataset.msgUnsupported);
      ev.target.setAttribute('aria-busy', 'true');
      try {
        setStatus(st, loginBox, loginBox.dataset.msgWorking);
        const { challenge_id, options } = await post('/auth/passkey/login/options', {});
        const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
        const r = await post('/auth/passkey/login/verify', { challenge_id, response: credToJSON(cred), next: loginBox.dataset.next });
        location.href = r.redirect || '/app';
      } catch (e) {
        fail(st, loginBox, e);
      } finally {
        ev.target.removeAttribute('aria-busy');
      }
    });
  }

  const regForm = document.getElementById('pk-register');
  if (regForm) {
    const st = document.getElementById('pk-register-status');
    regForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      delete regForm.dataset.submitted;
      if (!supported()) return setStatus(st, regForm, regForm.dataset.msgUnsupported);
      try {
        setStatus(st, regForm, regForm.dataset.msgWorking);
        const { challenge_id, options } = await post('/auth/passkey/register/options', { email: regForm.email.value });
        const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
        const r = await post('/auth/passkey/register/verify', { challenge_id, response: credToJSON(cred), locale: regForm.dataset.locale });
        location.href = r.redirect || '/app';
      } catch (e) {
        fail(st, regForm, e);
      } finally {
        delete regForm.dataset.submitted;
        regForm.querySelectorAll('button').forEach((b) => b.removeAttribute('aria-busy'));
      }
    });
  }

  const addBox = document.getElementById('pk-add-box');
  if (addBox) {
    const st = document.getElementById('pk-add-status');
    document.getElementById('pk-add').addEventListener('click', async () => {
      if (!supported()) return setStatus(st, addBox, addBox.dataset.msgUnsupported);
      try {
        setStatus(st, addBox, addBox.dataset.msgWorking);
        const { challenge_id, options } = await post('/auth/passkey/register/options', { _csrf: addBox.dataset.csrf });
        const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
        const r = await post('/auth/passkey/register/verify', { challenge_id, response: credToJSON(cred) });
        location.href = r.redirect || '/app/data';
      } catch (e) {
        fail(st, addBox, e);
      }
    });
  }

  // Step-up on the confirmation page: a large order is approved with a passkey assertion bound to this
  // checkout. The assertion travels in the form (hidden step_up field) with the usual CSRF token.
  const confirmForm = document.getElementById('confirm-form');
  if (confirmForm && confirmForm.dataset.stepUp) {
    const st = document.getElementById('step-up-status');
    const field = confirmForm.querySelector('input[name=step_up]');
    const reset = () => {
      delete confirmForm.dataset.submitted;
      confirmForm.querySelectorAll('button').forEach((b) => b.removeAttribute('aria-busy'));
    };
    confirmForm.addEventListener('submit', async (ev) => {
      if (field.value) return; // assertion attached: let the form go
      ev.preventDefault();
      if (!supported()) {
        setStatus(st, confirmForm, confirmForm.dataset.msgUnsupported);
        setTimeout(reset);
        return;
      }
      try {
        setStatus(st, confirmForm, confirmForm.dataset.msgWorking);
        const { challenge_id, options } = await post(confirmForm.dataset.stepUp, { _csrf: confirmForm.dataset.csrf });
        const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
        if (!cred) throw Object.assign(new Error('no credential'), { name: 'NotAllowedError' });
        field.value = JSON.stringify({ challenge_id, response: credToJSON(cred) });
        confirmForm.submit();
      } catch (e) {
        const name = e && e.name;
        const msg = e && e.server ? confirmForm.dataset.msgFailed
          : name === 'NotAllowedError' || name === 'AbortError' ? confirmForm.dataset.msgCancelled
          : name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotSupportedError' ? confirmForm.dataset.msgNotAllowed
          : confirmForm.dataset.msgFailed;
        setStatus(st, confirmForm, msg);
        field.value = '';
        reset();
      }
    });
  }
})();

// ---------------- Guided demo: example chips fill the request box ----------------
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-fill]');
  const form = document.getElementById('ask');
  if (!a || !form) return;
  e.preventDefault();
  form.querySelector('textarea').value = a.dataset.fill;
  form.requestSubmit ? form.requestSubmit() : form.submit();
});
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME candidate selection (Thai, Vietnamese, Chinese)
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches?.('#ask textarea')) {
    e.preventDefault();
    const f = e.target.form;
    f.requestSubmit ? f.requestSubmit() : f.submit();
  }
});

// ---------------- Order status: poll and refresh when the status changes ----------------
(() => {
  const card = document.querySelector('[data-poll]');
  if (!card || card.dataset.final) return;
  let delay = 4000;
  const tick = async () => {
    try {
      const r = await fetch(card.dataset.poll, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        if (j.status !== card.dataset.status) {
          location.replace(location.pathname);
          return;
        }
        if (j.is_final) return;
        delay = 4000;
      } else delay = Math.min(delay * 2, 30000);
    } catch {
      delay = Math.min(delay * 2, 30000);
    }
    setTimeout(tick, document.hidden ? 15000 : delay);
  };
  setTimeout(tick, delay);
})();

// ---------------- Language menu: close on outside click or Escape ----------------
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.lang-menu[open]')) if (!d.contains(e.target)) d.removeAttribute('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const d of document.querySelectorAll('details.lang-menu[open]')) {
    d.removeAttribute('open');
    d.querySelector('summary')?.focus();
  }
});
document.addEventListener('focusout', (e) => {
  const d = e.target.closest?.('details.lang-menu[open]');
  if (d && !d.contains(e.relatedTarget)) d.removeAttribute('open');
});
// Keep the current query (for example ?q= or ?next=) when switching language.
for (const a of document.querySelectorAll('.lang-menu a[hreflang]')) {
  const u = new URL(location.href);
  u.searchParams.set('lang', a.getAttribute('hreflang'));
  a.href = u.pathname + u.search + u.hash;
}

// ---------------- Docs: scroll-spy table of contents, section filter, copy heading links ----------------
(() => {
  const root = document.querySelector('[data-docs]');
  if (!root) return;
  const sections = [...root.querySelectorAll('section.doc-section')];
  const tocLinks = [...document.querySelectorAll('.docs-toc a[href^="#"]')];
  const linksFor = (id) => tocLinks.filter((a) => a.getAttribute('href') === `#${id}`);
  let current = '';
  const setActive = (id) => {
    if (id === current) return;
    current = id;
    for (const a of tocLinks) {
      if (a.getAttribute('href') === `#${id}`) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
    const side = document.querySelector('.docs-side .docs-toc');
    const act = side?.querySelector('a[aria-current]');
    if (side && act && side.scrollHeight > side.clientHeight) {
      const top = act.offsetTop - side.clientHeight / 2;
      side.scrollTo({ top: Math.max(0, top) });
    }
  };
  let ticking = false;
  const spy = () => {
    ticking = false;
    const line = 130;
    let id = '';
    for (const s of sections) {
      if (s.hidden) continue;
      if (s.getBoundingClientRect().top - line <= 0) id = s.id;
      else break;
    }
    if (!id) id = sections.find((s) => !s.hidden)?.id ?? '';
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      const vis = sections.filter((s) => !s.hidden);
      if (vis.length) id = vis[vis.length - 1].id;
    }
    setActive(id);
  };
  addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(spy);
    }
  }, { passive: true });
  // First pass after the first frame: measuring now would force a layout of the whole page mid-script.
  requestAnimationFrame(() => setTimeout(spy));

  // The mobile "On this page" menu closes after a jump.
  for (const a of document.querySelectorAll('.docs-toc-mobile a')) a.addEventListener('click', () => a.closest('details')?.removeAttribute('open'));

  // Filter sections by text. Hidden until JavaScript runs, so it never shows a dead control.
  const box = document.querySelector('.docs-search');
  const input = document.getElementById('docs-search');
  const empty = root.querySelector('.docs-empty');
  if (box && input) {
    box.hidden = false;
    const norm = (s) => s.toLocaleLowerCase().replace(/\s+/g, ' ');
    let texts = null; // built on first use: reading all section text up front slows the first load
    input.addEventListener('input', () => {
      texts ??= new Map(sections.map((s) => [s, norm(s.textContent || '')]));
      const q = norm(input.value.trim());
      let shown = 0;
      for (const s of sections) {
        const hit = !q || texts.get(s).includes(q);
        s.hidden = !hit;
        for (const a of linksFor(s.id)) a.parentElement.hidden = !hit;
        if (hit) shown++;
      }
      if (empty) empty.hidden = shown > 0;
      spy();
    });
  }

  // Heading anchors: follow the link and copy the full URL.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a.doc-anchor');
    if (!a) return;
    const url = location.origin + location.pathname + location.search + a.getAttribute('href');
    navigator.clipboard?.writeText(url).then(() => {
      a.classList.add('copied');
      setTimeout(() => a.classList.remove('copied'), 1500);
    }).catch(() => {});
  });
})();
