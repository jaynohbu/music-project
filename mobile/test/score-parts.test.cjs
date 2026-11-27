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

test('notes are scheduled on the song clock at the speed it plays, started early by their sound\'s attack', () => {
  const { parts } = load();
  const started = [];
  const context = { currentTime: 10,
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, start(at, offset, duration) { started.push({ at, offset, rate: this.playbackRate.value }); }, stop() {}, set onEnded(_) {} }) };
  // The song started at song second 20 at audio time 10.5, playing 1.25 times as fast.
  const clock = { position: () => 20, playing: () => true, end: () => 100, contextTime: song => 10.5 + (song - 20) / 1.25 };
  const voice = new parts.ScoreVoice(context, {}, clock);
  const attacks = samples.pitches.map((_, index) => index === 8 ? 0.1 : 0);
  voice.setNotes([{ time: 19, duration: 1, pitch: 60, velocity: 90 }, { time: 20.1, duration: 0.5, pitch: 60, velocity: 90 }, { time: 20.2, duration: 0.5, pitch: 61, velocity: 90 }],
    {}, samples, attacks);
  voice.start();
  voice.stop();
  // The note before the position is not played; the next at 20.1 → 10.5 + 0.08, less its sample's 0.1 s attack.
  assert.equal(started.length, 2);
  assert.ok(Math.abs(started[0].at - (10.58 - 0.1)) < 1e-9, String(started[0].at));
  assert.equal(started[0].offset, 8 * 3.5);
  assert.ok(Math.abs(started[1].rate - 2 ** (1 / 12)) < 1e-9, 'C#4 from the C4 sample, a semitone faster');
});
