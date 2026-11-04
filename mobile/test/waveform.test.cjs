const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/waveform.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', code)(() => ({}), loaded, loaded.exports);
const { peaksFrom } = loaded.exports;

test('peaks take the loudest sample of either channel per slice, normalised to 1', () => {
  const left = [0, .125, 0, .25, 0, .5, 0, 1], right = [0, -.375, 0, 0, 0, 0, 0, 0];
  assert.deepEqual(peaksFrom([left, right], 8, 4), [.375, .25, .5, 1]);
});

test('peaks cover only the song duration and stay silent for silence', () => {
  assert.deepEqual(peaksFrom([[.5, .5, 1, 1]], 2, 2), [1, 1]);
  assert.deepEqual(peaksFrom([[0, 0, 0, 0]], 4, 2), [0, 0]);
});
