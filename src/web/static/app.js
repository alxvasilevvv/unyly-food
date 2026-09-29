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
