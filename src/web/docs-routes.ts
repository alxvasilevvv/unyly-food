// User-facing documentation: /docs (HTML) and /docs/unyly-docs-{en,ru,th}.md (Markdown).
import type { FastifyInstance } from 'fastify';
import { icon } from './art.js';
import { DOCS_LANGS, DocsLang, docsFor } from './docs/index.js';
import { docsMarkdown, HtmlLabels, sectionHtml } from './docs/render.js';
import { html } from './html.js';
import { intlLocale, Locale, tr } from './messages.js';
import type { Kit } from './routes.js';

const LANG_NAME: Record<DocsLang, string> = { en: 'English', ru: 'Русский', th: 'ไทย' };
export const docsMdPath = (l: DocsLang) => `/docs/unyly-docs-${l}.md`;

function updatedLabel(iso: string, l: Locale) {
  return new Intl.DateTimeFormat(intlLocale(l), { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

export function registerDocsRoutes(app: FastifyInstance, kit: Kit) {
  const { ctx, base, send } = kit;

  app.get('/docs', async (req, reply) => {
    const r = await base(req, reply);
    const l = r.l;
    const { lang, translated, docs } = docsFor(l);
    const { meta, sections } = docs;
    const labels: HtmlLabels = {
      copy: r.m.copy,
      copied: r.m.copied,
      copyLink: tr(l, { ru: 'Скопировать ссылку', en: 'Copy link', th: 'คัดลอกลิงก์' }),
      tableLabel: tr(l, { ru: 'Таблица, прокручивается по горизонтали', en: 'Table, scrolls horizontally', th: 'ตาราง เลื่อนในแนวนอนได้' }),
    };
    const onPage = tr(l, { ru: 'На этой странице', en: 'On this page', th: 'ในหน้านี้' });
    const title = translated ? meta.title : tr(l, { ru: 'Документация Unyly', en: 'Unyly documentation', th: 'เอกสาร Unyly' });
    const toc = html`<ol class="docs-toc-list">${sections.map((s, i) => html`<li><a href="#${s.id}"><span class="n" aria-hidden="true">${String(i + 1)}</span>${s.title}</a></li>`)}</ol>`;
    const downloads = html`<p class="docs-dl"><span>${icon('receipt')} ${tr(l, { ru: 'Скачать Markdown', en: 'Download Markdown', th: 'ดาวน์โหลด Markdown' })}:</span>
${DOCS_LANGS.map((x) => html`<a href="${docsMdPath(x)}" hreflang="${x}" lang="${x}" type="text/markdown">${LANG_NAME[x]}</a>`)}</p>`;
    const otherNote = translated
      ? ''
      : html`<div class="notice docs-lang-note" role="note">${tr(l, {
        ru: 'Документация доступна на английском, русском и тайском. Ниже английская версия.',
        en: 'The documentation is available in English, Russian and Thai. The English version is shown below.',
        th: 'เอกสารมีให้อ่านเป็นภาษาอังกฤษ รัสเซีย และไทย ด้านล่างเป็นฉบับภาษาอังกฤษ',
      })} ${DOCS_LANGS.map((x, i) => html`${i ? ' · ' : ''}<a href="/docs?lang=${x}" hreflang="${x}" lang="${x}">${LANG_NAME[x]}</a>`)}</div>`;
    return send(reply, r, title, html`
<div class="docs">
  <div class="page-head docs-head">
    <span class="eyebrow">${icon('code')} ${tr(l, { ru: 'Документация', en: 'Documentation', th: 'เอกสาร' })}</span>
    <h1 lang="${lang}">${meta.title}</h1>
    <p class="lead" lang="${lang}">${meta.description}</p>
    <p class="small muted docs-meta"><span lang="${lang}">${meta.labels.updated}</span>: <time datetime="${meta.updated}">${updatedLabel(meta.updated, l)}</time></p>
    ${downloads}
  </div>
  ${otherNote}
  <details class="docs-toc-mobile"><summary>${onPage}</summary><nav class="docs-toc" aria-label="${onPage}" lang="${lang}">${toc}</nav></details>
  <div class="docs-layout">
    <aside class="docs-side">
      <nav class="docs-toc" aria-label="${onPage}"><p class="docs-toc-h">${onPage}</p><div lang="${lang}">${toc}</div></nav>
    </aside>
    <div class="docs-main">
      <div class="docs-search">
        <label for="docs-search" class="sr-only">${tr(l, { ru: 'Поиск по документации', en: 'Search docs', th: 'ค้นหาในเอกสาร' })}</label>
        <input id="docs-search" type="search" autocomplete="off" spellcheck="false" placeholder="${tr(l, { ru: 'Поиск по документации', en: 'Search docs', th: 'ค้นหาในเอกสาร' })}">
      </div>
      <article class="docs-content" data-docs lang="${lang}">
        ${sections.map((s) => sectionHtml(s, labels, meta.labels))}
        <p class="docs-empty muted" hidden role="status">${tr(l, { ru: 'Ничего не найдено. Попробуйте другое слово.', en: 'No sections match. Try another word.', th: 'ไม่พบหัวข้อที่ตรงกัน ลองใช้คำอื่น' })}</p>
      </article>
    </div>
  </div>
</div>`, { description: meta.description });
  });

  for (const x of DOCS_LANGS) {
    app.get(docsMdPath(x), async (_req, reply) =>
      reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', `inline; filename="unyly-docs-${x}.md"`)
        .header('cache-control', 'public, max-age=600')
        .send(docsMarkdown(docsFor(x).docs, ctx.cfg.webOrigin)));
  }
}
