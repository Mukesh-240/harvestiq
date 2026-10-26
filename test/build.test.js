import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildBundle } from '../build.mjs';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const listJs = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? listJs(join(dir, n)) : n.endsWith('.js') ? [join(dir, n)] : []));

test('single-file bundle has no ES module syntax and compiles as a classic script', () => {
  const { html, script } = buildBundle();
  assert.doesNotMatch(script, /^\s*(import|export)\s/m);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(html, /type="module"/);
  assert.doesNotMatch(html, /<link rel="stylesheet"/);
  assert.match(html, /__HARVESTIQ_BUNDLED__ = true/);
  for (const id of ['heroScene', 'cards', 'summary', 'healthGrid', 'serialPanel', 'demoToggle', 'scenarioSelect', 'speedButtons', 'verifyBody', 'diagList', 'timelineList']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});

test('every source module is included in the bundle', () => {
  const { script } = buildBundle();
  for (const file of listJs(SRC)) {
    const key = `src/${relative(SRC, file).split(sep).join('/')}`;
    assert.ok(script.includes(`__defs["${key}"]`), `bundle is missing ${key}`);
  }
});

test('every module reference in the bundle resolves, and all non-UI-entry modules execute', () => {
  const { script } = buildBundle();
  const defined = new Set([...script.matchAll(/__defs\["([^"]+)"\] = function/g)].map((m) => m[1]));
  const referenced = new Set([...script.matchAll(/__mod\("([^"]+)"\)/g)].map((m) => m[1]));
  for (const ref of referenced) assert.ok(defined.has(ref), `unresolved module reference ${ref}`);
  const loadAllButEntry = script.replace(/__mod\("src\/ui\/app\.js"\);\s*$/, `${JSON.stringify([...defined].filter((k) => k !== 'src/ui/app.js'))}.forEach(__mod);`);
  assert.notEqual(loadAllButEntry, script, 'entry call not found at end of bundle');
  assert.doesNotThrow(() => vm.runInNewContext(loadAllButEntry, { console, URLSearchParams, navigator: {}, document: {}, window: {}, location: {} }));
});

test('every named import has a matching export in its target module', () => {
  const { script } = buildBundle();
  const exportsOf = new Map();
  for (const m of script.matchAll(/__defs\["([^"]+)"\] = function \(\) \{([\s\S]*?)\nreturn __e;\n\};/g)) {
    exportsOf.set(m[1], new Set([...m[2].matchAll(/__e\.(\w+) = /g)].map((x) => x[1])));
  }
  assert.ok(exportsOf.size >= 12, 'could not parse module table');
  let checked = 0;
  for (const m of script.matchAll(/const \{([^}]+)\} = __mod\("([^"]+)"\);/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim();
      assert.ok(exportsOf.get(m[2])?.has(name), `${name} is imported from ${m[2]} but not exported there`);
      checked += 1;
    }
  }
  assert.ok(checked > 40, `only ${checked} imports checked`);
});

test('dist/harvestiq.html is current (npm test rebuilds it first)', async () => {
  const { readFileSync } = await import('node:fs');
  const dist = readFileSync(new URL('../dist/harvestiq.html', import.meta.url), 'utf8');
  assert.equal(dist, buildBundle().html, 'dist is stale: run `npm run build`');
});

test('stylesheet: particle selectors are scoped to circles so label pills can never be hidden by them', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
  const bare = css.match(/(^|[\s,}])\.p-(solar|charge|wind|piezo|control)(:nth-of-type|\s*\{)/g) ?? [];
  assert.deepEqual(bare, [], 'bare .p-* particle rules would also match the label pill groups');
  assert.ok(/circle\.p-solar:nth-of-type\(n \+ 2\)/.test(css));
});
