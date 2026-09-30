// Documentation content per interface language. English, Russian and Thai are written out;
// the other interface languages show the English text with a note (see docs-routes.ts).
import type { Locale } from '../../domain/locales.js';
import { DOCS_EN, META_EN } from './en.js';
import { DOCS_RU, META_RU } from './ru.js';
import { DOCS_TH, META_TH } from './th.js';
import type { DocSet } from './types.js';

export type DocsLang = 'en' | 'ru' | 'th';
export const DOCS_LANGS: DocsLang[] = ['en', 'ru', 'th'];

const SETS: Record<DocsLang, DocSet> = {
  en: { meta: META_EN, sections: DOCS_EN },
  ru: { meta: META_RU, sections: DOCS_RU },
  th: { meta: META_TH, sections: DOCS_TH },
};

export const isDocsLang = (l: string): l is DocsLang => (DOCS_LANGS as string[]).includes(l);

/** Content for an interface language; `translated` is false when English is shown as a fallback. */
export function docsFor(locale: Locale | DocsLang): { lang: DocsLang; translated: boolean; docs: DocSet } {
  if (isDocsLang(locale)) return { lang: locale, translated: true, docs: SETS[locale] };
  return { lang: 'en', translated: false, docs: SETS.en };
}
