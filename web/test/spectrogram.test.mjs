import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// spectrogram.ts has no imports, so it runs as plain JavaScript.
const source = readFileSync(new URL('../src/spectrogram.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('module', 'exports', 'require', code)(module, module.exports, () => ({}));
const s = module.exports;

test('a tone shows on its own row: A2 with the long window, A4 and A6 with shorter ones; silence is at the bottom of the range', async () => {
  const rate = 44100, seconds = 1;
  const channel = new Float32Array(rate * seconds);
  // A2 for the first third, A4 for the second, A6 for the last.
  for (let i = 0; i < channel.length; i++) {
    const pitch = i < rate / 3 ? 45 : i < 2 * rate / 3 ? 69 : 93;
    channel[i] = 0.5 * Math.sin(2 * Math.PI * 440 * 2 ** ((pitch - 69) / 12) * i / rate);
  }
  const { signal, rate: down } = s.monoSignal([channel, channel], rate);
  assert.equal(down, 22050);
  const found = await s.spectrogramOf(signal, down);
  const loudestPitch = frame => {
    let best = 0;
    for (let row = 1; row < s.ROWS; row++) if (found.levels[frame * s.ROWS + row] > found.levels[frame * s.ROWS + best]) best = row;
    return s.rowPitch(best);
  };
  const frameAt = time => Math.round(time * down / s.HOP);
  assert.deepEqual([loudestPitch(frameAt(1 / 6)), loudestPitch(frameAt(0.5)), loudestPitch(frameAt(5 / 6))], [45, 69, 93]);
  assert.ok(Math.max(...found.levels) === 0 && Math.min(...found.levels) === -s.RANGE_DB);
});

test('grid positions turn back into song seconds', () => {
  const beats = [1, 1.5, 2.25, 3];
  assert.equal(s.timeAtPosition(beats, 0), 1);
  assert.equal(s.timeAtPosition(beats, 6), 2.25 - 0.375);
  assert.equal(s.timeAtPosition(beats, 16), 3.75);
  assert.equal(s.timeAtPosition(beats, -4), 0.5);
  assert.equal(s.heatColors().length, 768);
});

test('meaningful energy keeps a held tone over noise and drops the noise and a short blip', async () => {
  const rate = 22050, channel = new Float32Array(rate * 4);
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
  for (let i = 0; i < channel.length; i++) {
    const tone = i > rate && i < 3 * rate ? 0.3 * Math.sin(2 * Math.PI * 440 * i / rate) : 0;
    // A 20 ms blip at C6.
    const blip = i > 3.5 * rate && i < 3.52 * rate ? 0.3 * Math.sin(2 * Math.PI * 1046.5 * i / rate) : 0;
    channel[i] = tone + blip + noise();
  }
  const found = await s.spectrogramOf(channel, rate);
  const kept = s.meaningful(found);
  const rowsAt = time => {
    const frame = Math.round(time * rate / s.HOP), rows = [];
    for (let row = 0; row < s.ROWS; row++) if (kept[frame * s.ROWS + row]) rows.push(s.rowPitch(row));
    return rows;
  };
  assert.deepEqual(rowsAt(2), [69], 'Only the A4 while it sounds');
  assert.deepEqual(rowsAt(0.5), [], 'Noise alone is nothing');
  assert.deepEqual(rowsAt(3.51), [], 'The blip is too short');
});

test('masking keeps only the kept notes: A4 stays, C6 goes; with everything kept the signal comes back', async () => {
  const rate = 22050, channel = new Float32Array(rate);
  for (let i = 0; i < channel.length; i++) channel[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / rate) + 0.3 * Math.sin(2 * Math.PI * 1046.5 * i / rate);
  const frames = Math.ceil(channel.length / s.HOP);
  const kept = new Uint8Array(frames * s.ROWS);
  const a4 = (69 - s.LOWEST_PITCH) * s.ROWS_PER_SEMITONE;
  for (let frame = 0; frame < frames; frame++) kept[frame * s.ROWS + a4] = 10;
  const only = await s.maskedSignal(channel, rate, kept, frames);
  // Correlation with each tone over the middle half second.
  const against = (signal, freq) => {
    let sum = 0;
    for (let i = Math.floor(rate / 4); i < 3 * rate / 4; i++) sum += signal[i] * Math.sin(2 * Math.PI * freq * i / rate);
    return Math.abs(sum / (rate / 2));
  };
  assert.ok(against(only, 440) > 0.13 && against(only, 1046.5) < 0.005, `${against(only, 440)} ${against(only, 1046.5)}`);
  const all = await s.maskedSignal(channel, rate, new Uint8Array(frames * s.ROWS).fill(1), frames);
  let error = 0;
  for (let i = Math.floor(rate / 4); i < 3 * rate / 4; i++) error = Math.max(error, Math.abs(all[i] - channel[i]));
  assert.ok(error < 1e-3, `Rebuilt within ${error}`);
});
