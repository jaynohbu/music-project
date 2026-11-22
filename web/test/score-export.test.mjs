import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// score-export.ts has type-only imports, so it runs as plain JavaScript.
const source = readFileSync(new URL('../src/score-export.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('module', 'exports', 'require', code)(module, module.exports, () => ({}));
const x = module.exports;

const grid = { beats: Array.from({ length: 13 }, (_, i) => i * 0.5), firstBar: 1 };
const note = (unit, length, pitch, extra = {}) => ({ start: unit * 0.125, end: (unit + length) * 0.125, pitch, unit, length, ...extra });
// A pickup beat, then a C chord from beat 2 held over the bar line, and a Bb.
const part = { key: 'F', chords: [{ start: 0.5, name: 'C' }, { start: 2.5, name: 'Bb/D' }],
  notes: [note(8, 16, 60), note(8, 16, 64), note(8, 16, 67, { confidence: 1 }), note(24, 4, 70, { voted: true })] };

test('MIDI: one track, a tempo per beat, chord markers, every note on and off at its sixteenth', () => {
  const midi = x.harmonyMidi(part, grid);
  const ascii = String.fromCharCode(...midi);
  assert.equal(ascii.slice(0, 4), 'MThd');
  assert.deepEqual([...midi.slice(8, 14)], [0, 0, 0, 1, 1, 224], 'Format 0, one track, 480 ticks a quarter');
  assert.ok(ascii.includes('MTrk') && ascii.includes('C') && ascii.includes('Bb/D'));
  assert.equal([...midi].filter((byte, i) => byte === 0x51 && midi[i - 1] === 0xff).length, 12, 'A tempo on each beat');
  const ons = [...midi].map((byte, i) => byte === 0x90 ? midi[i + 1] : null).filter(pitch => pitch !== null);
  assert.deepEqual(ons, [60, 64, 67, 70]);
  assert.ok(midi.indexOf(0x58) > 0 && midi[midi.indexOf(0x58) + 2] === 1, 'A one-beat first bar');
  assert.deepEqual([...midi.slice(-3)], [0xff, 0x2f, 0x00]);
});

test('MusicXML: a pickup, the chord tied over the bar line, chord names, the key, rests filling each bar', () => {
  const xml = x.harmonyMusicXml(part, grid, 'Song & Co');
  assert.ok(xml.includes('<work-title>Song &amp; Co</work-title>'));
  assert.ok(xml.includes('<measure number="0" implicit="yes">'), 'Pickup bar');
  assert.ok(xml.includes('<fifths>-1</fifths>'), 'F major');
  const measures = xml.split('<measure ').slice(1);
  for (const [index, measure] of measures.entries()) {
    const total = [...measure.matchAll(/<note>(<chord\/>)?.*?<duration>(\d+)<\/duration>/g)].filter(m => !m[1]).reduce((sum, m) => sum + +m[2], 0);
    assert.equal(total, index ? 16 : 4, `Bar ${index} is full`);
  }
  assert.ok(measures[1].includes('<chord/>') && measures[1].includes('<tie type="start"/>'), 'The chord is held into the next bar');
  assert.ok(measures[2].includes('<tie type="stop"/>'));
  assert.equal(xml.split('<root-step>C</root-step>').length, 2, 'Each chord name once');
  assert.ok(measures[2].includes('<root-step>B</root-step><root-alter>-1</root-alter>') && measures[2].includes('<bass-step>D</bass-step>'));
  assert.ok(measures[2].includes('<step>B</step><alter>-1</alter><octave>4</octave>'), 'Bb, spelled with flats in F');
  assert.equal(x.keyFifths('F#m'), 3);
  assert.equal(x.keyFifths('Eb'), -3);
});
