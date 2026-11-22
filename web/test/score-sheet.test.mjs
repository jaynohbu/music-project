import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
// Everything after the imports and the staff lines the app's score.ts exports.
const body = source => source.slice(source.indexOf('export const BARS_PER_LINE'));

test('the printed score is the same as the app\'s', () => {
  assert.equal(body(read('../src/score-sheet.ts')), body(read('../../mobile/src/score-sheet.ts')));
});

test('key signatures are spelled the same as in the app', () => {
  const block = source => source.slice(source.indexOf('// Key signatures:'), source.indexOf('// Steps count letter names'));
  assert.equal(block(read('../src/harmony-strip.ts')), block(read('../../mobile/src/score.ts')));
});
