import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// pitch-shift.ts has no imports; its pure function runs here as plain JavaScript.
const source = readFileSync(new URL('../src/pitch-shift.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('module', 'exports', code)(module, module.exports);
const { pitchShift } = module.exports;

const RATE = 44100;
const tone = (frequency, seconds) => Float32Array.from({ length: RATE * seconds }, (_, index) => 0.5 * Math.sin(2 * Math.PI * frequency * index / RATE));
// The frequency from upward zero crossings, away from the ends.
function frequency(samples) {
  const from = Math.floor(samples.length * 0.2), to = Math.floor(samples.length * 0.8);
  let crossings = 0;
  for (let index = from + 1; index < to; index++) if (samples[index - 1] < 0 && samples[index] >= 0) crossings++;
  return crossings / ((to - from) / RATE);
}

test('moves the pitch by semitones and keeps the length', () => {
  for (const [semitones, expected] of [[12, 880], [-12, 220], [3, 440 * 2 ** 0.25], [-2, 440 * 2 ** (-2 / 12)]]) {
    const [shifted] = pitchShift([tone(440, 2)], semitones, RATE);
    assert.equal(shifted.length, RATE * 2);
    assert.ok(Math.abs(frequency(shifted) - expected) < expected * 0.01, `${semitones}: ${frequency(shifted)} Hz, not ${expected}`);
  }
});

test('keeps the level steady and both channels together', () => {
  const left = tone(330, 1), right = tone(330, 1);
  const [shiftedLeft, shiftedRight] = pitchShift([left, right], 2, RATE);
  assert.deepEqual(shiftedLeft, shiftedRight);
  const middle = shiftedLeft.subarray(RATE * 0.2, RATE * 0.8);
  const peak = middle.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert.ok(peak > 0.4 && peak < 0.6, `peak ${peak}`);
});

test('no change returns a copy', () => {
  const input = tone(440, 0.1);
  const [output] = pitchShift([input], 0, RATE);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
});

test('a five-minute stereo stem takes a few seconds at most', () => {
  const minutes = Float32Array.from({ length: RATE * 300 }, () => Math.random() - 0.5);
  const started = Date.now();
  pitchShift([minutes, minutes.slice()], 3, RATE);
  const seconds = (Date.now() - started) / 1000;
  console.log(`five minutes stereo: ${seconds.toFixed(1)} s`);
  assert.ok(seconds < 8);
});
