const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// score-parts.ts with its native neighbours stood in for.
function load() {
  const gains = [];
  const param = () => ({ value: 1, events: [], setValueAtTime(v, t) { this.events.push(['set', v, t]); }, linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]); } });
  const mocks = {
    'expo-file-system': { Directory: class { create() {} }, File: class { get exists() { return true; } }, Paths: { cache: '/cache' } },
    './effects': { stereoGain: (_context, gain = 1) => { const node = { gain: { ...param(), value: gain }, connect() {}, disconnect() {} }; gains.push(node); return node; } },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/score-parts.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => mocks[name] ?? require(name), module, module.exports);
  return { parts: module.exports, gains };
}

const samples = { rate: 1000, pitches: [36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72], slot: 3.5, length: 3 };

test('sounds are offered with the song\'s ranked ones first, then every other of the family', () => {
  const { parts } = load();
  const library = { groups: { pop: { styles: [], guitar: [27, 25], keys: [0] } }, samples,
    sounds: { 0: { name: 'Piano', family: 'keys' }, 25: { name: 'Steel', family: 'guitar' }, 27: { name: 'Clean', family: 'guitar' }, 220: { name: 'Shiny', family: 'guitar' } } };
  assert.deepEqual(parts.offered(library, { genre: 'pop', guitar: { sounds: [25, 27] } }, 'guitar'), [25, 27, 220]);
  assert.deepEqual(parts.offered(library, undefined, 'guitar'), [27, 25, 220]);
  assert.deepEqual(parts.offered(library, undefined, 'keys'), [0]);
});

test('the score\'s events: every note and its sung line, moved by the key change, in time order', () => {
  const { parts } = load();
  const part = { chords: [], notes: [{ start: 1, end: 1.5, pitch: 60, unit: 0, length: 4, velocity: 70 }], melody: [{ start: 0.5, end: 1, pitch: 72, unit: 0, length: 2 }] };
  assert.deepEqual(parts.scoreEvents(part, 2), [{ time: 0.5, duration: 0.5, pitch: 74, velocity: 90 }, { time: 1, duration: 0.5, pitch: 62, velocity: 70 }]);
  assert.equal(parts.scoreEvents(part, 0, false).length, 1);
});

test('a part follows the stem\'s loudness: notes where the stem is louder are played louder, the typical ratio is the gain', () => {
  const { parts } = load();
  const levels = samples.pitches.map(() => new Array(12).fill(0.2));
  const events = Array.from({ length: 40 }, (_, k) => ({ time: k * 0.25, duration: 0.25, pitch: 60, velocity: 64 }));
  // The stem is twice as loud in its second half.
  const loudness = { window: 0.25, other: Array.from({ length: 40 }, (_, k) => k < 20 ? 0.05 : 0.1) };
  const { events: moved, gain } = parts.matchLoudness(events, events, loudness, samples, levels);
  assert.ok(gain > 0);
  assert.ok(moved[30].velocity > moved[5].velocity, `${moved[30].velocity} > ${moved[5].velocity}`);
  assert.equal(moved[5].velocity, moved[6].velocity);
});

test('a part is rendered whole: each note its sample at its pitch, started early by the sample\'s attack', () => {
  const { parts } = load();
  // A sound of one sample per slot, its value the slot's number + 1 (a constant level), at 100 samples a second.
  const soundRate = 100, small = { ...samples, slot: 3.5, length: 3 };
  const sound = new Float32Array(Math.round(samples.pitches.length * 3.5 * soundRate)).fill(0);
  samples.pitches.forEach((_, index) => sound.fill(index + 1, index * 350, index * 350 + 300));
  const attacks = samples.pitches.map((_, index) => index === 8 ? 0.1 : 0);
  const out = parts.renderPart([{ time: 1, duration: 0.5, pitch: 60, velocity: 127 }], sound, soundRate, small, attacks, 3, 1000);
  assert.equal(out.length, 3000);
  // Heard from 0.9 s (its 0.1 s attack before the note), not before; the C4 slot's value at the full level.
  assert.equal(out[890], 0);
  assert.ok(out[905] > 0);
  assert.ok(Math.abs(out[1200] - 9 * 0.5) < 1e-6, String(out[1200]));
  // Held for the note and its lead, then released within RELEASE.
  assert.ok(out[1550] > 0 && out[1800] === 0);
  // Two notes together share their level.
  const chord = parts.renderPart([{ time: 1, duration: 0.5, pitch: 60, velocity: 127 }, { time: 1, duration: 0.5, pitch: 60, velocity: 127 }],
    sound, soundRate, small, attacks, 3, 1000);
  assert.ok(Math.abs(chord[1200] - 2 * 9 * 0.5) < 1e-6);
});

test('the bass and drum parts play from their own parts: a kit\'s drums are its slots, basses on their own pitches', () => {
  const { parts } = load();
  const grid = { beats: [0, 0.5, 1, 1.5, 2], firstBar: 0 };
  const drums = { chords: [], notes: [], hits: [{ unit: 4, drum: 'snare' }, { unit: 0, drum: 'kick' }, { unit: 2, drum: 'hihat' }, { unit: 6, drum: 'cowbell' }] };
  const played = parts.familyEvents('drums', { drums }, grid, 5);
  // In time order, each drum its slot (kick 0, snare 1, hi-hat 3), not moved by the key; an unknown drum is left out.
  assert.deepEqual(played.events.map(event => [event.time, event.pitch]), [[0, 0], [0.25, 3], [0.5, 1]]);
  const bass = { chords: [], notes: [{ start: 1, end: 1.5, pitch: 40, unit: 8, length: 4, velocity: 80 }], melody: [{ start: 0, end: 1, pitch: 72, unit: 0, length: 8 }] };
  const line = parts.familyEvents('bass', { bass }, grid, 2);
  assert.deepEqual(line.events.map(event => event.pitch), [42], 'the bass plays its notes, moved by the key, no sung line');
  assert.equal(parts.familyEvents('keys', { bass }, grid, 0), null, 'no Harmonic part, nothing for keys');
  const library = { samples, sounds: {}, groups: {}, layouts: { bass: { ...samples, pitches: [24, 27] } } };
  assert.deepEqual(parts.samplesFor(library, 'bass').pitches, [24, 27]);
  assert.equal(parts.samplesFor(library, 'keys'), samples);
});
