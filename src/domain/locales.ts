// Interface languages: the languages of every Grab market, plus Russian.
export const LOCALE_CODES = ['en', 'th', 'vi', 'id', 'ms', 'fil', 'km', 'my', 'zh', 'ru'] as const;
export type Locale = (typeof LOCALE_CODES)[number];

/** BCP 47 tag used for dates and money. th-TH uses the Buddhist calendar, as Thai users expect. */
export const INTL_LOCALE: Record<Locale, string> = {
  en: 'en-GB', th: 'th-TH', vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY', fil: 'fil-PH', km: 'km-KH', my: 'my-MM', zh: 'zh-SG', ru: 'ru-RU',
};

/** Name of each language in that language, for the switcher. */
export const LOCALE_NATIVE: Record<Locale, string> = {
  en: 'English', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', fil: 'Filipino', km: 'ខ្មែរ', my: 'မြန်မာ', zh: '中文', ru: 'Русский',
};

export const isLocaleCode = (v: unknown): v is Locale => typeof v === 'string' && (LOCALE_CODES as readonly string[]).includes(v);

/** Map an Accept-Language tag to a supported locale (tl is the older code for Filipino, in for Indonesian). */
export function localeFromTag(tag: string): Locale | null {
  const t = tag.toLowerCase().trim();
  const base = t.split('-')[0];
  const alias: Record<string, Locale> = { tl: 'fil', in: 'id', zh: 'zh' };
  const c = alias[base] ?? base;
  return isLocaleCode(c) ? c : null;
}
