// Money is always an integer amount in the currency's minor unit.
// Exponents must follow the provider's rules. THB exponent 2 is taken from the
// GrabFood POS API docs ("Thailand TH THB ฿ 2"), developer.grab.com, checked 2026-09-30.
export const CURRENCY_EXPONENT: Record<string, number> = {
  THB: 2,
};

export interface Money {
  amount_minor: number;
  currency: string;
  formatted: string;
}

export function exponentOf(currency: string): number {
  const e = CURRENCY_EXPONENT[currency];
  if (e === undefined) throw new Error(`Unsupported currency ${currency}`);
  return e;
}

export function formatMinor(amountMinor: number, currency: string, locale: 'ru' | 'en' = 'en'): string {
  const exp = exponentOf(currency);
  const major = amountMinor / 10 ** exp;
  return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(major);
}

export function money(amountMinor: number, currency: string, locale: 'ru' | 'en' = 'en'): Money {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('amount must be an integer in minor units');
  return { amount_minor: amountMinor, currency, formatted: formatMinor(amountMinor, currency, locale) };
}

/** Parse a major-unit decimal string ("600", "600.50") into minor units without float drift. */
export function parseMajor(input: string, currency: string): number {
  const exp = exponentOf(currency);
  const m = /^\s*(\d{1,9})(?:[.,](\d+))?\s*$/.exec(input);
  if (!m) throw new Error('invalid amount');
  const frac = (m[2] || '').padEnd(exp, '0');
  if (frac.length > exp) throw new Error('too many decimal places');
  return Number(m[1]) * 10 ** exp + (exp ? Number(frac) : 0);
}
