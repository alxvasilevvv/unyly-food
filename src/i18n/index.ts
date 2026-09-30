import type { Locale } from '../domain/locales.js';
import { CATALOGS, PACKS } from './generated.js';
import type { LangPack } from './types.js';

/** Translation of an English UI string, if the catalog for this language has it. */
export function lookup(l: Locale, en: string): string | undefined {
  return CATALOGS[l]?.[en];
}
export function packs(): [string, LangPack][] {
  return Object.entries(PACKS);
}
export function pack(l: Locale): LangPack | undefined {
  return PACKS[l];
}
