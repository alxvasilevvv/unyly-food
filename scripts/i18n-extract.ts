// Collects every English UI string that needs translating into src/i18n/source.json.
// Sources: inline { en, ru, th } literals, the English Messages object, and demo catalog text.
// Template literals with ${...} inside an { en } literal are reported: they must be rewritten with fmt().
import { createRequire } from 'node:module';
const tsm = createRequire(import.meta.url)(process.env.TS5 ?? 'typescript');
const ts: any = tsm;
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.includes('/i18n/') && !p.endsWith('domain/locales.ts')) files.push(p); } };
walk(join(root, 'src'));

const out = new Map<string, Set<string>>();
const dynamic: string[] = [];
const add = (s: string, where: string) => { const t = s.trim(); if (!t || !/[A-Za-z]/.test(t)) return; if (!out.has(t)) out.set(t, new Set()); out.get(t)!.add(where); };

for (const f of files) {
  const src = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
  const rel = f.slice(root.length);
  const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map<string, ts.Expression>();
      for (const p of n.properties) if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) props.set(p.name.text, p.initializer);
      const en = props.get('en');
      if (en && (props.has('ru') || props.has('th'))) {
        if (ts.isStringLiteral(en) || ts.isNoSubstitutionTemplateLiteral(en)) add(en.text, at(en));
        else dynamic.push(`${at(en)}  ${en.getText().slice(0, 100)}`);
      }
      // Demo catalog: names, descriptions, notices, option and group names.
      if (rel.startsWith('src/providers/demo/catalog.ts')) {
        for (const k of ['name', 'description', 'notice', 'category', 'opening_note']) {
          const v = props.get(k);
          if (v && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) add(v.text, at(v));
        }
      }
    }
    // The English Messages object: const en: Messages = { ... }
    if (ts.isVariableDeclaration(n) && rel === 'src/web/messages.ts' && ts.isIdentifier(n.name) && n.name.text === 'en' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      for (const p of n.initializer.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) && ts.isIdentifier(p.name) && p.name.text !== 'lang') add(p.initializer.text, at(p.initializer));
      }
    }
    // Demo catalog helpers: goods({ ... name: '...' }) and vehicle('id', 'Name', fare, 'Description')
    if (rel === 'src/providers/demo/catalog.ts' && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'vehicle') {
      for (const a of [n.arguments[1], n.arguments[3]]) if (a && ts.isStringLiteral(a)) add(a.text, at(a));
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}
// Vehicle notes live inside fare(...) extras: { note: '...' }
const entries = [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([en, w]) => ({ en, where: [...w].slice(0, 3) }));
writeFileSync(join(root, 'src/i18n/source.json'), JSON.stringify(entries, null, 1) + '\n');
console.log(`strings: ${entries.length}`);
if (dynamic.length) { console.log(`dynamic (rewrite with fmt): ${dynamic.length}`); for (const d of dynamic) console.log('  ' + d); }
