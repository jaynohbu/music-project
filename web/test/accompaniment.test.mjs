import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// accompaniment.ts has type-only imports, so it runs as plain JavaScript.
const source = readFileSync(new URL('../src/accompaniment.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('module', 'exports', 'require', code)(module, module.exports, () => ({}));
const a = module.exports;
const pc = pitches => [...new Set(pitches.map(pitch => pitch % 12))].sort((x, y) => x - y);

test('every chord tone is voiced, with the slash bass at the bottom', () => {
  for (const [name, tones] of [['E', [4, 8, 11]], ['Asus2', [9, 11, 4]], ['G7', [7, 11, 2, 5]], ['Fadd9', [5, 9, 0, 7]], ['C/E', [0, 4, 7]]]) {
    for (const family of ['guitar', 'keys']) {
      const notes = a.voicing(name, family);
      assert.deepEqual(pc(notes), [...tones].sort((x, y) => x - y), `${name} on ${family}: ${notes}`);
    }
  }
  assert.equal(a.voicing('C/E', 'guitar')[0] % 12, 4, 'Slash bass lowest');
  assert.equal(a.voicing('C/E', 'keys')[0] % 12, 4);
  assert.ok(a.voicing('E', 'guitar').every(pitch => pitch >= 40 && pitch <= 79), 'Within a guitar');
  assert.deepEqual(a.voicing('N.C.', 'keys'), []);
});

test('a chord sits where the Harmonic stem played it: high chords high, low chords low', () => {
  const pc = pitches => [...new Set(pitches.map(pitch => pitch % 12))].sort((x, y) => x - y);
  for (const family of ['guitar', 'keys']) {
    const high = a.voicing('A', family, { low: 57, high: 76 });
    const low = a.voicing('A', family, { low: 45, high: 57 });
    assert.deepEqual(pc(high), [1, 4, 9], `${family} high: ${high}`);
    assert.deepEqual(pc(low), [1, 4, 9], `${family} low: ${low}`);
    assert.ok(Math.max(...high) > Math.max(...low) + 10 && Math.max(...high) <= 76, `${family}: ${high} over ${low}`);
    assert.ok(high.every((pitch, i) => !i || pitch > high[i - 1]), 'Bass first, rising');
  }
  assert.equal(a.voicing('C/E', 'guitar', { low: 52, high: 72 })[0] % 12, 4, 'Slash bass lowest');
  const notes = [50, 57, 62, 66, 69].map(pitch => ({ start: 1, end: 2, pitch, unit: 0, length: 4 }));
  assert.deepEqual(a.registerOf(notes, 0.5, 3), { low: 50, high: 69 });
  assert.equal(a.registerOf(notes.slice(0, 1), 0.5, 3), null);
  const grid = { beats: Array.from({ length: 9 }, (_, i) => i * 0.5), firstBar: 0 };
  const struck = a.comping({ chords: [{ start: 0, name: 'D' }], notes }, grid, [[[0, 4, 100]]], 'keys');
  assert.ok(Math.max(...struck.map(event => event.pitch)) <= 69 && Math.max(...struck.map(event => event.pitch)) >= 62, 'Comping follows the score');
});

test('comping strikes the style rhythm on the song beats with the chord of the moment', () => {
  const grid = { beats: Array.from({ length: 17 }, (_, i) => i * 0.5), firstBar: 1 };
  const part = { chords: [{ start: 0, name: 'C' }, { start: 2.5, name: 'G' }], notes: [] };
  // Two strokes a bar: beat 0 for a beat, beat 2 for two beats.
  const events = a.comping(part, grid, [[[0, 1, 100], [2, 2, 80]]], 'keys');
  const starts = [...new Set(events.map(event => event.time))];
  assert.deepEqual(starts, [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5], 'Bars start on the first bar, strokes on beats 1 and 3');
  assert.deepEqual(pc(events.filter(event => event.time === 0.5).map(event => event.pitch)), [0, 4, 7]);
  assert.deepEqual(pc(events.filter(event => event.time === 2.5).map(event => event.pitch)), [2, 7, 11]);
  assert.equal(events.find(event => event.time === 1.5).velocity, 80);
  assert.equal(events.find(event => event.time === 0.5).duration, 0.5);
});

test('guitar strums roll upward, and no chord is silence', () => {
  const grid = { beats: Array.from({ length: 17 }, (_, i) => i * 0.5), firstBar: 0 };
  const part = { chords: [{ start: 0, name: 'C' }, { start: 1.5, name: 'N.C.' }, { start: 4, name: 'G' }], notes: [] };
  const events = a.comping(part, grid, [[[0, 4, 100]]], 'guitar');
  assert.ok(events[1].time > events[0].time && events[1].pitch > events[0].pitch);
  const before = events.filter(event => event.time < 2);
  assert.ok(before.length > 0 && before.every(event => event.time + event.duration <= 1.5 + 1e-9), 'What rings stops at N.C.');
  assert.ok(events.some(event => event.time >= 4) && !events.some(event => event.time >= 1.5 && event.time < 4), 'Silent until the chord comes back');
});

test('melody + chords parts play the score as written, moved by the key change', () => {
  const grid = { beats: Array.from({ length: 9 }, (_, i) => i * 0.5), firstBar: 0 };
  const part = { chords: [{ start: 0, name: 'C' }], notes: [{ start: 0.5, end: 1, pitch: 60, unit: 4, length: 4 },
    { start: 0.5, end: 1, pitch: 64, unit: 4, length: 4 }, { start: 1, end: 1.5, pitch: 43, unit: 8, length: 4 }] };
  const played = a.accompanimentEvents('keys-melody', part, grid, [[[0, 4, 100]]], 2);
  assert.deepEqual(played.map(event => [event.time, event.pitch]), [[0.5, 62], [0.5, 66], [1, 45]]);
  assert.ok(played.every(event => event.velocity === 100));
});

test('the nearest sample plays at the rate of the missing semitones', () => {
  assert.deepEqual(a.sampleFor([36, 39, 42], 40), { index: 1, rate: 2 ** (1 / 12) });
  assert.deepEqual(a.sampleFor([36, 39, 42], 30), { index: 0, rate: 2 ** (-6 / 12) });
});

test('the song choices are offered first, then the rest of the family', () => {
  const library = JSON.parse(readFileSync(new URL('../public/accompaniment/styles.json', import.meta.url), 'utf8'));
  const choices = { genre: 'worship', guitar: { styles: ['PopBallad2Sus', 'PopBallad2'], sounds: [27, 24] }, keys: { styles: [], sounds: [48] } };
  const guitar = a.offered(library, choices, 'guitar');
  assert.deepEqual(guitar.styles, ['PopBallad2Sus', 'PopBallad2']);
  assert.deepEqual(guitar.sounds.slice(0, 2), [27, 24]);
  assert.ok(guitar.sounds.includes(30) && guitar.sounds.every(id => library.sounds[id].family === 'guitar'));
  assert.deepEqual(a.offered(library, choices, 'keys').styles, library.groups.worship.styles, 'No ranking: the group order');
  assert.ok(a.offered(library, undefined, 'keys').styles.length > 0, 'No choices at all: the pop group');
  for (const [name, families] of Object.entries(library.styles)) {
    assert.equal(families.guitar.length, 8, name);
    assert.ok(families.guitar.flat().every(([beat, length, velocity]) => beat >= 0 && beat < 4 && length > 0 && velocity > 0), name);
  }
});
