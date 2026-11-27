import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// accompaniment-player.ts imports accompaniment.ts, which has type-only imports.
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, path => load(path.replace('./', '')));
  return modules[name] = module.exports;
}
const player = load('accompaniment-player');

test('a part follows the recording\'s loudness: louder where it is louder, its typical level as the gain', () => {
  // The recording is twice the part's level, and in windows 10-19 four times; the part is silent in 30-34.
  const played = Array.from({ length: 40 }, (_, w) => w >= 30 && w < 35 ? 0 : 0.1);
  const heard = Array.from({ length: 40 }, (_, w) => w >= 10 && w < 20 ? 0.4 : 0.2);
  const { change, typical } = player.levelChanges(heard, played);
  assert.ok(Math.abs(typical - 20 * Math.log10(2)) < 1e-9, 'twice as loud: about 6 dB');
  assert.ok(Math.abs(change[5]) < 1e-9);
  assert.ok(Math.abs(change[15] - 20 * Math.log10(2)) < 1e-9, '6 dB more where the recording is louder');
  assert.ok(Number.isFinite(change[32]), 'a window without the part takes its neighbours change');
  // Never more than four times either way, and nothing to follow when nothing sounds.
  const loud = player.levelChanges([0.2, 0.2, 0.2, 100, 100, 100, 100, 100, 0.2, 0.2, 0.2, 0.2], new Array(12).fill(0.1));
  assert.ok(Math.max(...loud.change) <= 20 * Math.log10(4) + 1e-9);
  assert.deepEqual(player.levelChanges([0, 0], [0, 0]), { change: [0, 0], typical: 0 });
});
