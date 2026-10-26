// Builds dist/harvestiq.html: index.html + CSS + every ES module inlined into ONE classic script.
// Why: browsers refuse to load <script type="module"> from file://, so double-clicking index.html
// leaves the app dead. The single file works from anywhere (including file://) with no server.
// Zero dependencies: a tiny import/export rewriter that fits this codebase's module style
// (single-style `import {..} from './x.js'` and `export const|function|class`).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ENTRY = 'src/ui/app.js';

const key = (file) => relative(ROOT, file).split(sep).join('/');

function listModules(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listModules(full);
    return name.endsWith('.js') ? [full] : [];
  });
}

function transform(file) {
  let src = readFileSync(file, 'utf8');
  const exported = [];
  src = src.replace(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';?[ \t]*$/gm, (_, clause, spec) => {
    const target = key(resolve(dirname(file), spec));
    const trimmed = clause.trim();
    if (trimmed.startsWith('* as ')) return `const ${trimmed.slice(5).trim()} = __mod(${JSON.stringify(target)});`;
    if (trimmed.startsWith('{')) return `const ${trimmed.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')} = __mod(${JSON.stringify(target)});`;
    throw new Error(`Unsupported import form in ${key(file)}: ${clause}`);
  });
  src = src.replace(/^export\s+(?:async\s+)?(const|let|function|class)\s+([A-Za-z0-9_$]+)/gm, (match, kind, name) => {
    exported.push(name);
    return match.replace(/^export\s+/, '');
  });
  if (/^export\s/m.test(src) || /^import\s/m.test(src)) throw new Error(`Unrewritten import/export left in ${key(file)}`);
  const tail = exported.map((n) => `__e.${n} = ${n};`).join(' ');
  return `__defs[${JSON.stringify(key(file))}] = function () {\nconst __e = {};\n${src}\n${tail}\nreturn __e;\n};`;
}

export function buildBundle() {
  const modules = listModules(join(ROOT, 'src')).map(transform).join('\n\n');
  const script = `'use strict';
const __defs = {};
const __cache = {};
function __mod(name) {
  if (!(name in __cache)) {
    if (!__defs[name]) throw new Error('Bundle is missing module ' + name);
    __cache[name] = null;
    __cache[name] = __defs[name]();
  }
  return __cache[name];
}
${modules}
__mod(${JSON.stringify(ENTRY)});`;

  const css = readFileSync(join(ROOT, 'css/style.css'), 'utf8');
  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const swaps = [
    ['<link rel="stylesheet" href="css/style.css">', `<style>\n${css}\n</style>`],
    ['<script>\n  /* Classic (non-module) script', '<script>window.__HARVESTIQ_BUNDLED__ = true;</script>\n<script>\n  /* Classic (non-module) script'],
    ['<script type="module" src="src/ui/app.js"></script>', `<script>\n${script.replace(/<\/script/gi, '<\\/script')}\n</script>`],
  ];
  for (const [from, to] of swaps) {
    if (!html.includes(from)) throw new Error(`index.html no longer contains: ${from.slice(0, 50)}`);
    html = html.replace(from, () => to);
  }
  return { html, script };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { html } = buildBundle();
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  writeFileSync(join(ROOT, 'dist/harvestiq.html'), html);
  process.stdout.write(`Wrote dist/harvestiq.html (${(html.length / 1024).toFixed(0)} KB). Double-click it to run; no server needed.\n`);
}
