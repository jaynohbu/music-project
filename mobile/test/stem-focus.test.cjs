const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/stem-focus.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', code)(() => ({}), loaded, loaded.exports);
const { focusedStem } = loaded.exports;

const frames = [
  { name: 'vocals', top: -500, bottom: 100 },
  { name: 'guitar', top: 116, bottom: 500 },
  { name: 'bass', top: 516, bottom: 900 },
  { name: 'drums', top: 916, bottom: 1300 },
];

test('opens the stem crossing the upper third of the screen', () => {
  assert.equal(focusedStem(frames, { top: 0, bottom: 800, atEnd: false }), 'guitar');
  assert.equal(focusedStem(frames, { top: 300, bottom: 1100, atEnd: false }), 'bass');
});

test('keeps the current stem when the line falls between cards', () => {
  assert.equal(focusedStem(frames, { top: 0, bottom: 309, atEnd: false }), null);
});

test('at the end of the page opens the last stem whose header is in view', () => {
  assert.equal(focusedStem(frames, { top: 0, bottom: 1000, atEnd: true }), 'drums');
  assert.equal(focusedStem(frames, { top: 0, bottom: 980, atEnd: true }), 'bass');
});
