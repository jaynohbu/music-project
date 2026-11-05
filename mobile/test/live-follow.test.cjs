const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// live-follow.ts is pure, so it runs as plain CommonJS.
function load() {
  const source = fs.readFileSync(path.join(__dirname, '../src/live-follow.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(() => ({}), module, module.exports);
  return module.exports;
}
const live = load();

// A seeded random source, so the jittered tests always see the same notes.
function random(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

test('tempo log maps take time to song position and back', () => {
  const points = [{ at: 1, pos: 10, rate: 1 }, { at: 3, pos: 12, rate: 1.2 }, { at: 8, pos: 18, rate: 0.9 }];
  assert.equal(live.songPositionAt(points, 0.5), 9.5);
  assert.equal(live.songPositionAt(points, 2), 11);
  assert.ok(Math.abs(live.songPositionAt(points, 5) - 14.4) < 1e-9);
  assert.ok(Math.abs(live.songPositionAt(points, 10) - 19.8) < 1e-9);
  for (const at of [0, 1.5, 4.2, 7.9, 9.3]) assert.ok(Math.abs(live.takeTimeAt(points, live.songPositionAt(points, at)) - at) < 1e-9);
  assert.equal(live.rateAt(points, 0.5), 1);
  assert.equal(live.rateAt(points, 4), 1.2);
  assert.equal(live.rateAt(points, 9), 0.9);
  assert.equal(live.songPositionAt([], 4), 4);
});

test('onset detector finds plucked notes and ignores their ringing', () => {
  const rate = 44100, length = rate * 3, signal = new Float32Array(length), next = random(7);
  const plucks = [0.5, 1.0, 1.37, 2.0, 2.25];
  for (let index = 0; index < length; index++) signal[index] = (next() - 0.5) * 0.002;
  for (const start of plucks) {
    for (let index = Math.round(start * rate); index < length; index++) {
      const time = index / rate - start;
      signal[index] += 0.4 * Math.exp(-time / 0.3) * (Math.sin(2 * Math.PI * 196 * time) + 0.5 * Math.sin(2 * Math.PI * 392 * time) + 0.3 * Math.sin(2 * Math.PI * 1176 * time));
    }
  }
  const detector = new live.OnsetDetector(rate), found = [];
  for (let start = 0; start < length; start += 512) found.push(...detector.push(signal.subarray(start, start + 512), start / rate));
  assert.equal(found.length, plucks.length, `found ${found.map(time => time.toFixed(3))}`);
  found.forEach((time, index) => assert.ok(Math.abs(time - plucks[index]) < 0.012, `${time} vs ${plucks[index]}`));
});

test('beatAt continues the edge tempo outside the beat map', () => {
  const beats = [1, 1.5, 2, 2.5];
  assert.equal(live.beatAt(beats, 1.75), 1.5);
  assert.equal(live.beatAt(beats, 0.5), -1);
  assert.equal(live.beatAt(beats, 3), 4);
});

// Plays a song at 120 BPM with a player whose tempo changes, and lets the follower drive the band.
function perform({ profile, strength = 0.5, jitter = 0, extras = 0, beatsTotal = 64, seed = 3 }) {
  const beats = Array.from({ length: beatsTotal + 8 }, (_, index) => index * 0.5);
  const follower = new live.Follower(beats, strength), next = random(seed);
  // The player's beat k happens when their own clock, running at profile(beat) times the song tempo, reaches it.
  const notes = [];
  let time = 0;
  for (let beat = 0; beat < beatsTotal; beat++) {
    notes.push({ at: time + (next() - 0.5) * 2 * jitter, beat });
    if (next() < extras) notes.push({ at: time + 0.25 / profile(beat) + (next() - 0.5) * 0.12, beat: beat + 0.5 });
    time += 0.5 / profile(beat);
  }
  notes.sort((a, b) => a.at - b.at);
  let pos = 0, rate = 1, now = 0, index = 0;
  const errors = [], rates = [];
  const step = 0.002;
  while (index < notes.length) {
    while (index < notes.length && notes[index].at <= now) {
      const note = notes[index++];
      if (Number.isInteger(note.beat)) errors.push({ beat: note.beat, error: live.beatAt(beats, pos) - note.beat });
      const changed = follower.onset(note.at, pos);
      if (changed !== null) rate = changed;
    }
    const settled = follower.idle(now);
    if (settled !== null) rate = settled;
    rates.push({ now, rate });
    pos += rate * step; now += step;
  }
  return { errors, follower };
}

test('the band follows a player who speeds up then slows down', () => {
  const profile = beat => beat < 8 ? 1 : beat < 24 ? 1 + 0.15 * (beat - 8) / 16 : beat < 32 ? 1.15 : beat < 48 ? 1.15 - 0.25 * (beat - 32) / 16 : 0.9;
  const { errors, follower } = perform({ profile });
  const late = errors.filter(item => item.beat >= 56);
  const worst = Math.max(...late.map(item => Math.abs(item.error)));
  assert.ok(worst < 0.08, `band is ${worst.toFixed(3)} beats off the player at the end`);
  assert.ok(Math.abs(follower.tempo - 0.9) < 0.04, `tempo ${follower.tempo}`);
  // Never further than a quarter beat off, even while the tempo moves.
  assert.ok(Math.max(...errors.map(item => Math.abs(item.error))) < 0.25);
});

test('the band holds steady through a human player\'s timing wobble and extra notes', () => {
  const { errors, follower } = perform({ profile: () => 1, jitter: 0.02, extras: 0.4, seed: 11 });
  assert.ok(Math.abs(follower.tempo - 1) < 0.05, `tempo ${follower.tempo}`);
  const late = errors.filter(item => item.beat >= 16);
  const mean = late.reduce((sum, item) => sum + Math.abs(item.error), 0) / late.length;
  assert.ok(mean < 0.06, `mean error ${mean.toFixed(3)} beats`);
});

test('a sudden tempo jump is caught again within a few beats', () => {
  const { errors } = perform({ profile: beat => beat < 16 ? 1 : 1.25, strength: 0.8 });
  const after = errors.filter(item => item.beat >= 28);
  assert.ok(Math.max(...after.map(item => Math.abs(item.error))) < 0.1);
});

test('a loose player drifting in tempo with extra notes stays followed', () => {
  const profile = beat => 1 + 0.12 * Math.sin(beat / 10);
  for (const seed of [1, 2, 3, 4, 5]) {
    const { errors } = perform({ profile, jitter: 0.015, extras: 0.3, seed, beatsTotal: 96 });
    const late = errors.filter(item => item.beat >= 16);
    const mean = late.reduce((sum, item) => sum + Math.abs(item.error), 0) / late.length;
    assert.ok(mean < 0.08, `seed ${seed}: mean error ${mean.toFixed(3)} beats`);
  }
});

test('without a beat map the follower leaves the band alone', () => {
  const follower = new live.Follower([0], 0.5);
  assert.equal(follower.onset(1, 1), null);
  assert.equal(follower.rate, 1);
});
