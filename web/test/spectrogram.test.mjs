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
