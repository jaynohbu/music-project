import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// score-written.ts imports accompaniment.ts (types aside); musicxml.ts has no imports.
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, path => load(path.replace('./', '')));
  return modules[name] = module.exports;
}
const written = load('score-written');

const score = {
  title: 'Song', parts: [{ id: 'P1', name: 'Piano' }],
  // A one-quarter pickup, then a bar of 4/4.
  measures: [{ number: '0', start: 0, length: 1, beats: 4, beatType: 4 }, { number: '1', start: 1, length: 4, beats: 4, beatType: 4 }],
  notes: [{ pitch: 64, start: 1, length: 2, measure: 1, part: 0, staff: 1 }, { pitch: 60, start: 0, length: 1, measure: 0, part: 0, staff: 1 }],
  chords: [{ start: 1, pitchClasses: [7, 11, 2], root: 7, quality: '', bass: 7, measure: 1 }],
  hits: [{ start: 1, measure: 1, part: 0, drum: 'kick' }, { start: 2, measure: 1, part: 0, drum: 'snare' }],
};
const name = (chord, key) => `${['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][chord.root]}${chord.quality} in ${key}`;

test('an uploaded score as printed: its own grid at its tempo, a pickup bar of its own, its notes and chords to draw and play', () => {
  const made = written.writtenPart(score, 'other', 120, 'G', name);
  assert.equal(made.grid.firstBar, 1, 'the pickup quarter comes before the first bar');
  assert.equal(made.grid.beats[2], 1);
  assert.deepEqual(made.part.notes.map(note => [note.pitch, note.start, note.end, note.unit, note.length]), [[60, 0, 0.5, 0, 4], [64, 0.5, 1.5, 4, 8]]);
  assert.deepEqual(made.part.chords, [{ start: 0.5, name: 'G in G' }]);
  assert.equal(made.part.key, 'G');
  assert.deepEqual(made.events.map(event => [event.time, event.pitch]), [[0, 60], [0.5, 64]]);
  assert.equal(made.seconds, 5 * 0.5 + 2);
  const drums = written.writtenPart(score, 'drums', 60, undefined, name);
  assert.deepEqual(drums.part.hits, [{ unit: 4, drum: 'kick' }, { unit: 8, drum: 'snare' }]);
  assert.deepEqual(drums.events.map(event => event.time), [1, 2]);
});

test('the written key from the signature, and the notes laid on the song as played', () => {
  assert.equal(written.writtenKey('<key><fifths>-2</fifths><mode>major</mode></key>'), 'Bb');
  assert.equal(written.writtenKey('<key><fifths>1</fifths><mode>minor</mode></key>'), 'Em');
  assert.equal(written.writtenKey('<part/>'), undefined);
  const grid = { beats: [0, 0.5, 1, 1.5, 2], firstBar: 0 };
  const laid = { chords: [], notes: [{ start: 1, end: 1.4, pitch: 50, unit: 8, length: 4, velocity: 70 }, { start: 0.2, end: 0.6, pitch: 55, unit: 2, length: 4, velocity: 80 }],
    hits: [{ unit: 4, drum: 'snare' }] };
  assert.deepEqual(written.laidEvents({ part: 'bass', laid, grid }).map(event => event.time), [0.2, 1]);
  assert.deepEqual(written.laidEvents({ part: 'drums', laid, grid }).map(event => event.time), [0.5]);
  assert.equal(written.percent(0.734), '73%');
  assert.equal(written.percent(undefined), '–');
});
