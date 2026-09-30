// Renders the documentation content (types.ts) to HTML fragments and to Markdown.
import { esc, html, raw, SafeHtml } from '../html.js';
import type { Block, DocSection, DocSet, Inline } from './types.js';

/** Only site paths, in-page anchors, https and mailto links are rendered as links. */
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^\/(?!\/)[^\s]*$/.test(u) || /^#[A-Za-z0-9_-]+$/.test(u) || /^https:\/\/[^\s]+$/.test(u) || /^mailto:[^\s]+$/.test(u)) return u;
  return null;
}

/** Every link target used in an inline string ([text](url)). */
export function inlineLinks(s: Inline): string[] {
  return [...s.replace(/`[^`]*`/g, '').matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => m[2]);
}

/**
 * Inline markup to HTML: escape everything first, then turn the limited markup into tags.
 * Code spans are cut out before the other rules so their contents stay literal.
 */
export function inlineHtml(s: Inline): SafeHtml {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, href: string) => {
    // href is already escaped (&amp; etc.), which is correct inside an attribute. Validate the unescaped form.
    const plain = href.replace(/&amp;/g, '&');
    if (!safeHref(plain)) return m;
    const ext = plain.startsWith('https://') ? ' rel="noopener"' : '';
    return `<a href="${href}"${ext}>${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
  return raw(out);
}

/** Plain text of an inline string, for search and descriptions. */
export const inlineText = (s: Inline) => s.replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');

export interface HtmlLabels {
  copy: string;
  copied: string;
  copyLink: string;
  tableLabel: string;
}

export function blockHtml(b: Block, sectionId: string, idx: number, t: HtmlLabels, labels: DocSet['meta']['labels']): SafeHtml {
  switch (b.type) {
    case 'paragraph':
      return html`<p>${inlineHtml(b.text)}</p>`;
    case 'list':
      return b.ordered
        ? html`<ol>${b.items.map((i) => html`<li>${inlineHtml(i)}</li>`)}</ol>`
        : html`<ul>${b.items.map((i) => html`<li>${inlineHtml(i)}</li>`)}</ul>`;
    case 'table':
      return html`<div class="doc-table-wrap" role="region" tabindex="0" aria-label="${t.tableLabel}: ${b.header.map(inlineText).join(', ')}"><table class="doc-table cols-${String(Math.min(b.header.length, 4))}">
<thead><tr>${b.header.map((h) => html`<th scope="col">${inlineHtml(h)}</th>`)}</tr></thead>
<tbody>${b.rows.map((r) => html`<tr>${r.map((c) => html`<td>${inlineHtml(c)}</td>`)}</tr>`)}</tbody></table></div>`;
    case 'code': {
      const id = `code-${sectionId}-${idx}`;
      return html`<div class="doc-code"><div class="doc-code-bar"><span>${b.lang === 'text' ? '' : b.lang}</span><button class="doc-copy" type="button" data-copy="${id}" data-copied="${t.copied}">${t.copy}</button></div><pre id="${id}"><code>${b.text}</code></pre></div>`;
    }
    case 'callout':
      return html`<div class="doc-callout ${b.kind}" role="note"><strong class="doc-callout-label">${labels[b.kind]}</strong> ${inlineHtml(b.text)}</div>`;
    case 'steps':
      return html`<ol class="doc-steps">${b.items.map((s) => html`<li><strong>${inlineHtml(s.title)}</strong><span>${inlineHtml(s.text)}</span></li>`)}</ol>`;
    case 'subheading':
      return b.id
        ? html`<h3 id="${b.id}" class="doc-h3">${b.text}<a class="doc-anchor" href="#${b.id}" aria-label="${t.copyLink}: ${b.text}" data-copied="${t.copied}">#</a></h3>`
        : html`<h3 class="doc-h3">${b.text}</h3>`;
  }
}

export function sectionHtml(s: DocSection, t: HtmlLabels, labels: DocSet['meta']['labels']): SafeHtml {
  return html`<section class="doc-section" id="${s.id}" aria-labelledby="h-${s.id}">
<h2 id="h-${s.id}">${s.title}<a class="doc-anchor" href="#${s.id}" aria-label="${t.copyLink}: ${s.title}" data-copied="${t.copied}">#</a></h2>
${s.summary ? html`<p class="doc-summary">${inlineHtml(s.summary)}</p>` : ''}
${s.blocks.map((b, i) => blockHtml(b, s.id, i, t, labels))}
</section>`;
}

// ---------------- Markdown ----------------

/** Site-relative links become absolute so the downloaded file works anywhere. */
function mdInline(s: Inline, origin: string): string {
  return s.replace(/(`[^`]*`)|\[([^\]]+)\]\(([^)\s]+)\)/g, (m, code: string | undefined, text: string, href: string) => {
    if (code) return code;
    return href.startsWith('/') ? `[${text}](${origin}${href})` : `[${text}](${href})`;
  });
}

const mdCell = (s: string, origin: string) => mdInline(s, origin).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function blockMd(b: Block, origin: string, labels: DocSet['meta']['labels']): string {
  switch (b.type) {
    case 'paragraph':
      return mdInline(b.text, origin);
    case 'list':
      return b.items.map((i, n) => `${b.ordered ? `${n + 1}.` : '-'} ${mdInline(i, origin)}`).join('\n');
    case 'table':
      return [
        `| ${b.header.map((h) => mdCell(h, origin)).join(' | ')} |`,
        `| ${b.header.map(() => '---').join(' | ')} |`,
        ...b.rows.map((r) => `| ${r.map((c) => mdCell(c, origin)).join(' | ')} |`),
      ].join('\n');
    case 'code':
      return `\`\`\`${b.lang}\n${b.text}\n\`\`\``;
    case 'callout':
      return `> **${labels[b.kind]}:** ${mdInline(b.text, origin)}`;
    case 'steps':
      return b.items.map((s, n) => `${n + 1}. **${mdInline(s.title, origin)}**: ${mdInline(s.text, origin)}`).join('\n');
    case 'subheading':
      return `### ${b.text}`;
  }
}

export function docsMarkdown(d: DocSet, origin: string): string {
  const out: string[] = [];
  out.push(`# ${d.meta.title}`, '', d.meta.description, '', `${d.meta.labels.updated}: ${d.meta.updated} · ${origin}/docs`, '');
  out.push(`## ${d.meta.labels.contents}`, '');
  d.sections.forEach((s, i) => out.push(`${i + 1}. [${s.title}](#${s.id})`));
  out.push('');
  for (const s of d.sections) {
    out.push(`<a id="${s.id}"></a>`, '', `## ${s.title}`, '');
    if (s.summary) out.push(`*${mdInline(s.summary, origin)}*`, '');
    for (const b of s.blocks) out.push(blockMd(b, origin, d.meta.labels), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
