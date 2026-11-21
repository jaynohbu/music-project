const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// instrument-detect.ts and live-follow.ts are pure, so they run as plain CommonJS.
function load(file, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, `../src/${file}`), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => modules[name] ?? {}, module, module.exports);
  return module.exports;
}
const follow = load('live-follow.ts');
const detect = load('instrument-detect.ts', { './live-follow': follow });
const RATE = 44100;

function random(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

// A note with harmonics that fall off by `brightness` per harmonic, held for `seconds`.
function tone(frequency, seconds, brightness = .5, level = .3) {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let harmonic = 1; harmonic * frequency < 10000; harmonic++) {
    const amplitude = level * brightness ** (harmonic - 1);
    for (let index = 0; index < samples.length; index++) samples[index] += amplitude * Math.sin(2 * Math.PI * frequency * harmonic * index / RATE);
  }
  return samples;
}

function noise(seconds, level = .3) {
  const next = random(7);
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => level * (next() * 2 - 1));
}

// Band levels of a sound, as the player's analysers would report them for a stem.
function levelsOf(samples) {
  const size = 2048, real = new Float64Array(size), imag = new Float64Array(size);
  for (let index = 0; index < size; index++) real[index] = samples[index] * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / size));
  follow.fft(real, imag);
  const magnitudes = Array.from({ length: size / 2 }, (_, bin) => Math.hypot(real[bin], imag[bin]) * 2 / size);
  return detect.bandLevels(magnitudes, RATE / size, false);
}

function feed(detector, samples) {
  for (let start = 0; start < samples.length; start += 512) detector.push(samples.subarray(start, start + 512));
}

test('waits for about three seconds of playing before deciding', () => {
  const detector = new detect.InstrumentDetector(RATE, () => null);
  feed(detector, tone(220, 1));
  assert.equal(detector.detection.instrument, null);
  assert.equal(detector.detection.confident, false);
});

test('silence never counts towards a decision', () => {
  const detector = new detect.InstrumentDetector(RATE, () => null);
  feed(detector, new Float32Array(RATE * 5));
  assert.equal(detector.detection.frames, 0);
});

test('noise without a clear pitch is drums', () => {
  const detector = new detect.InstrumentDetector(RATE, () => null);
  feed(detector, noise(4));
  assert.equal(detector.detection.instrument, 'drums');
});

test('a low clear pitch with no song to compare is a bass', () => {
  const detector = new detect.InstrumentDetector(RATE, () => null);
  feed(detector, tone(82.4, 4, .4));
  assert.equal(detector.detection.instrument, 'bass');
});

test('the stem whose spectrum matches the input names the instrument', () => {
  const played = tone(523.25, 4, .7);
  const stems = { piano: levelsOf(tone(523.25, .1, .7)), guitar: levelsOf(tone(196, .1, .25)), bass: levelsOf(tone(65.4, .1, .3)),
    vocals: levelsOf(tone(330, .1, .15)) };
  const detector = new detect.InstrumentDetector(RATE, () => stems);
  feed(detector, played);
  assert.equal(detector.detection.instrument, 'piano');
});

test('silent stems are left out of the comparison', () => {
  const quiet = new Float64Array(detect.BAND_COUNT).fill(-120);
  const stems = { guitar: levelsOf(tone(196, .1, .5)), piano: quiet };
  const detector = new detect.InstrumentDetector(RATE, () => stems);
  feed(detector, tone(196, 4, .5));
  assert.equal(detector.detection.instrument, 'guitar');
});

test('shape similarity ignores overall level', () => {
  const a = Float64Array.from({ length: detect.BAND_COUNT }, (_, index) => -20 - index);
  const louder = a.map(value => value + 30);
  assert.ok(Math.abs(detect.shapeSimilarity(a, louder) - 1) < 1e-9);
  assert.ok(detect.shapeSimilarity(a, a.map(value => -value)) < -.99);
});

test('pitch finds the fundamental of a harmonic tone', () => {
  const frame = tone(110, .05, .6).subarray(0, 2048);
  const quarter = Float32Array.from({ length: 512 }, (_, index) => (frame[index * 4] + frame[index * 4 + 1] + frame[index * 4 + 2] + frame[index * 4 + 3]) / 4);
  const found = detect.pitch(quarter, RATE / 4);
  assert.ok(Math.abs(found.frequency - 110) < 3, `found ${found.frequency}`);
  assert.ok(found.clarity > .8);
});
