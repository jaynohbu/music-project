import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/scene-settings.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { captureSceneSettings, restoredSceneInterval } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const track = {
  name: 'vocals', volume: 39, preGain: 120, compression: 33, distortion: 16,
  bass: -2.5, mid: 3, treble: 6, pan: -24, reverb: 12,
  muted: true, solo: true, bypassed: true, useCleaned: true,
};

test('scene snapshots persist all nine controls and flags, not transient/audio state', () => {
  const settings = captureSceneSettings(52, 4, 17, true, [
    { ...track, status: 'ready', downloadUrl: 'private-url', peaks: [1, 2] },
  ]);
  const { name, ...saved } = track;
  assert.deepEqual(settings, {
    masterVolume: 52, sectionStart: 4, sectionEnd: 17, loop: true, tracks: { vocals: saved },
  });
  track.volume = 88;
  assert.equal(settings.tracks.vocals.volume, 39);
  track.volume = 39;
});

test('snapshots keep sample-rate rounding inside the original source duration', () => {
  assert.equal(captureSceneSettings(80, 0, 60.00002, false, [track], 60).sectionEnd, 60);
  const shortened = captureSceneSettings(80, 60, 60.1, false, [track], 60);
  assert.equal(shortened.sectionStart, 59.95);
  assert.ok(shortened.sectionEnd > shortened.sectionStart);
});

test('each scene entry has independent track settings', () => {
  const a = captureSceneSettings(80, 0, 10, false, [track]);
  const b = captureSceneSettings(80, 0, 10, false, [track]);
  a.tracks.vocals.volume = 5;
  assert.equal(b.tracks.vocals.volume, 39);
  assert.equal(track.volume, 39);
});

test('saved markers restore within the newly decoded audio bounds', () => {
  const settings = captureSceneSettings(80, 19.99, 20, false, [track]);
  assert.deepEqual(restoredSceneInterval(settings, 20), { start: 19.95, end: 20 });
  assert.deepEqual(restoredSceneInterval(settings, 0.02), { start: 0, end: 0.02 });
  assert.deepEqual(restoredSceneInterval({ ...settings, sectionStart: 2, sectionEnd: 9 }, 20), { start: 2, end: 9 });
});
