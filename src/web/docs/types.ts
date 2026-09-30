// Structure of the user-facing documentation (/docs). Plain serializable data so translators can
// edit ru.ts / th.ts without touching rendering code.
//
// Inline markup (every "Inline" string) is limited to:
//   **bold**   `code`   [text](url)
// url is a site path (/try), an in-page anchor (#modes), https://... or mailto:...
// Everything else is plain text and is HTML-escaped when rendered.

/** Text with the limited inline markup described above. */
export type Inline = string;

export type Block =
  | { type: 'paragraph'; text: Inline }
  | { type: 'list'; ordered?: boolean; items: Inline[] }
  | { type: 'table'; header: Inline[]; rows: Inline[][] }
  /** Code is never translated. lang is a hint only (bash, json, http, text). */
  | { type: 'code'; lang: string; text: string }
  | { type: 'callout'; kind: 'info' | 'warn' | 'safety'; text: Inline }
  | { type: 'steps'; items: { title: Inline; text: Inline }[] }
  /** Sub-heading inside a section. id is an optional URL anchor slug (never translated). */
  | { type: 'subheading'; text: string; id?: string };

export interface DocSection {
  /** URL anchor slug. Identical in every language; never translate. */
  id: string;
  title: string;
  summary?: Inline;
  blocks: Block[];
}

export interface DocMeta {
  title: string;
  description: string;
  /** ISO date, YYYY-MM-DD. */
  updated: string;
  /** Labels used inside the content (callouts, Markdown export). Translate these too. */
  labels: {
    info: string;
    warn: string;
    safety: string;
    contents: string;
    updated: string;
  };
}

export interface DocSet {
  meta: DocMeta;
  sections: DocSection[];
}
