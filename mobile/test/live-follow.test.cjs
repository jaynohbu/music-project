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

test('the bass settings find low plucked notes', () => {
  const rate = 44100, length = rate * 3, signal = new Float32Array(length), next = random(11);
  const plucks = [0.4, 0.9, 1.4, 1.65, 2.4];
  for (let index = 0; index < length; index++) signal[index] = (next() - 0.5) * 0.002;
  for (const start of plucks) {
    for (let index = Math.round(start * rate); index < length; index++) {
      const time = index / rate - start;
      // A low E string: mostly fundamental, a little second harmonic, slow decay.
      signal[index] += 0.5 * Math.exp(-time / 0.6) * (Math.sin(2 * Math.PI * 41.2 * time) + 0.4 * Math.sin(2 * Math.PI * 82.4 * time) + 0.1 * Math.sin(2 * Math.PI * 164.8 * time));
    }
  }
  const detector = new live.OnsetDetector(rate, live.instrument('bass').onsets), found = [];
  for (let start = 0; start < length; start += 512) found.push(...detector.push(signal.subarray(start, start + 512), start / rate));
  assert.equal(found.length, plucks.length, `found ${found.map(time => time.toFixed(3))}`);
  found.forEach((time, index) => assert.ok(Math.abs(time - plucks[index]) < 0.02, `${time} vs ${plucks[index]}`));
});

// Renders notes that each replace the one before, like a monophonic line, over faint noise.
function line(notes, voice, length = 3, seed = 7) {
  const rate = 44100, signal = new Float32Array(rate * length), next = random(seed);
  for (let index = 0; index < signal.length; index++) signal[index] = (next() - 0.5) * 0.002;
  notes.forEach((note, number) => {
    const stop = Math.min(signal.length, Math.round((notes[number + 1]?.at ?? length) * rate));
    for (let index = Math.round(note.at * rate); index < stop; index++) signal[index] += voice(index / rate - note.at, note.f);
  });
  return signal;
}

function onsets(id, signal) {
  const detector = new live.OnsetDetector(44100, live.instrument(id).onsets), found = [];
  for (let start = 0; start < signal.length; start += 512) found.push(...detector.push(signal.subarray(start, start + 512), start / 44100));
  return found;
}

const tone = (f, time, weights) => weights.reduce((sum, weight, k) => sum + weight * Math.sin(2 * Math.PI * f * (k + 1) * time), 0);

test('keyboard notes are found by their change of pitch, not only by loudness', () => {
  const notes = [0.3, 0.8, 1.3, 1.55, 2.2].map((at, index) => ({ at, f: [392, 494, 588, 440, 660][index] }));
  // A soft organ-like attack with no level jump between legato notes.
  const found = onsets('keyboard', line(notes, (time, f) => 0.2 * Math.min(1, time / 0.01) * tone(f, time, [1, 0.3, 0.1])));
  assert.equal(found.length, notes.length, `found ${found.map(time => time.toFixed(3))}`);
  found.forEach((time, index) => assert.ok(Math.abs(time - notes[index].at) < 0.02, `${time} vs ${notes[index].at}`));
});

test('a held sung note with vibrato counts once', () => {
  // A 3% vibrato at 6 Hz, with the phase integrated so the swing stays the same.
  const voice = (time, f) => {
    const phase = f * time - f * 0.03 * Math.cos(2 * Math.PI * 6 * time) / (2 * Math.PI * 6);
    return 0.2 * Math.min(1, time / 0.03) * [1, 0.5, 0.25].reduce((sum, weight, k) => sum + weight * Math.sin(2 * Math.PI * phase * (k + 1)), 0);
  };
  const found = onsets('vocals', line([{ at: 0.3, f: 300 }], voice));
  assert.equal(found.length, 1, `found ${found.map(time => time.toFixed(3))}`);
});

test('noise alone gives no notes for any instrument', () => {
  const signal = line([], () => 0, 3, 5).map((_, index, all) => all[index] * 10);
  for (const item of live.INSTRUMENTS) assert.deepEqual(onsets(item.id, signal), [], item.id);
});

test('every instrument stands in for a band stem or none', () => {
  const stems = ['vocals', 'guitar', 'bass', 'piano', 'drums', 'other'];
  for (const item of live.INSTRUMENTS) assert.ok(item.stem === null || stems.includes(item.stem), item.id);
  assert.equal(live.instrument('keyboard').stem, 'piano');
  assert.equal(live.instrument(undefined).id, 'guitar');
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
