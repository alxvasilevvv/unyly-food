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
  if (e.key === 'Escape') for (const d of document.querySelectorAll('details.lang-menu[open]')) d.removeAttribute('open');
});
