import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/score-blast.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const blast = { exports: {} };
new Function('module', 'exports', code)(blast, blast.exports);
const { findAnchor } = blast.exports;

// Measures (of the score as played) and song bars are letters, one bar a measure; offsets are in bars here. A measure
// is like the song (0.9) where the song plays it, a little like it elsewhere (0.3 to 0.4); outside the song, null.
function likeness(score, song, noise = (i, j) => 0.3 + 0.1 * (((i * 7 + j * 3) % 5) / 5)) {
  return (measure, offset) => {
    const bar = offset + measure;
    if (bar < 0 || bar >= song.length) return null;
    return song[bar] === score[measure] ? 0.9 : noise(measure, bar);
  };
}
const offsets = (score, song) => Array.from({ length: score.length + song.length }, (_, k) => k - score.length);

test('the anchor is the longest stretch alike along one offset; neither end of the score has to be in it', () => {
  // The score as played: an intro (I J) the song does not have, A–H, an outro (O) the song does not have. The song:
  // two bars of its own (x), then A–H, then its own ending (z z).
  const score = [...'IJABCDEFGHO'], song = [...'xxABCDEFGHzz'];
  const anchor = findAnchor(score.length, offsets(score, song), likeness(score, song));
  assert.equal(anchor.offset, 0);   // Measure 2 (A) on bar 2.
  assert.deepEqual([anchor.from, anchor.to], [2, 9]);
});

test('a few unlike measures inside a passage alike around them stay in the anchor', () => {
  const score = [...'ABCDEFGH'], song = [...'ABCxEFGH'];
  const anchor = findAnchor(score.length, offsets(score, song), likeness(score, song));
  assert.deepEqual([anchor.offset, anchor.from, anchor.to], [0, 0, 7]);
});

test('the song plays a passage more times than the score: the longest alike stretch wins, the rest is not matched', () => {
  // The score as played has the chorus (C D) once; the song has it twice. Along offset 0, A B C D are alike; along
  // offset 2, C D E F G H (from the second chorus): the longer is the anchor.
  const score = [...'ABCDEFGH'], song = [...'ABCDCDEFGH'];
  const anchor = findAnchor(score.length, offsets(score, song), likeness(score, song));
  assert.equal(anchor.offset, 2);
  assert.deepEqual([anchor.from, anchor.to], [2, 7]);
});

test('nothing alike: no anchor', () => {
  assert.equal(findAnchor(4, [0, 1, 2], () => 0.3), null);
  assert.equal(findAnchor(4, [0], () => null), null);
});
