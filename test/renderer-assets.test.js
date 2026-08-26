'use strict';

// Structural checks on the renderer's assets.
//
// A stylesheet with one unbalanced brace still "loads": the browser swallows
// everything after it and every rule below simply stops existing. Nothing fails,
// nothing logs, the classes are still applied — only the design quietly goes
// missing. That is exactly what happened when two branches that both appended
// rules at the end of the file were merged and the shared closing brace was lost
// with the conflict markers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');

// Braces inside strings, comments and url() would confuse a naive count; the
// stylesheet uses none of those with braces, so a plain scan is honest here.
function braceDepth(text) {
  let depth = 0;
  let min = 0;
  let line = 1;
  let firstNegative = null;

  for (const ch of text) {
    if (ch === '\n') line += 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < min) { min = depth; if (firstNegative === null) firstNegative = line; }
    }
  }

  return { depth, firstNegative };
}

test('the stylesheet has balanced braces', () => {
  const { depth, firstNegative } = braceDepth(css);

  assert.equal(firstNegative, null, `лишняя закрывающая скобка около строки ${firstNegative}`);
  assert.equal(depth, 0, `не закрыто правил: ${depth} — всё, что ниже, браузер проигнорирует`);
});

test('every rule the renderer toggles by class actually exists', () => {
  // Classes the renderer adds or removes at runtime. A class without a rule is
  // indistinguishable from a working feature until someone looks at the screen.
  for (const selector of [
    '.logs-action',
    '.logs-action.is-done',
    '.logs-action.is-failed',
    '.service-badge.is-blocked',
    '.partial-note',
    '.status-indicator.connected.partial'
  ]) {
    assert.ok(css.includes(selector), `в styles.css нет правила для ${selector}`);
  }
});

test('every element the renderer looks up by id exists in the markup', () => {
  const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(ids.length > 0);
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `в index.html нет элемента с id="${id}"`);
  }
});
