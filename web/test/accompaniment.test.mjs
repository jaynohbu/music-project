import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { analyzeHarmony, CHORD_NAMES } from '../public/harmony-analysis.mjs';

const source = await readFile(new URL('../src/accompaniment-audio.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const audio = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const regionSource = await readFile(new URL('../src/accompaniment-regions.ts', import.meta.url), 'utf8');
const regionModule = ts.transpileModule(regionSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const regions = await import(`data:text/javascript;base64,${Buffer.from(regionModule).toString('base64')}`);

// Sections of [seconds, amplitude] rendered as a sine at 1 kHz sample rate.
function stem(sections, rate = 1000) {
  const data = [];
  for (const [seconds, amplitude] of sections) {
    for (let i = 0; i < seconds * rate; i++) data.push(amplitude * Math.sin(i * 0.7));
  }
  return Float32Array.from(data);
}
const rmsOf = (data, start = 0, end = data.length) => {
  let energy = 0, count = 0;
  for (let i = start; i < end; i++) if (Math.abs(data[i]) > 1e-6) { energy += data[i] * data[i]; count++; }
  return count ? Math.sqrt(energy / count) : 0;
};

function chordAudio(notes, duration, sampleRate = 11025) {
  const data = new Float32Array(Math.ceil(duration * sampleRate));
  for (let i = 0; i < data.length; i++) {
    for (const note of notes) data[i] += 0.1 * Math.sin(2 * Math.PI * 440 * 2 ** ((note - 69) / 12) * i / sampleRate);
  }
  return data;
}

test('harmony recognizes major/minor triads and silent regions', () => {
  for (const [notes, expected] of [[[48, 60, 64, 67], 'C'], [[57, 60, 64], 'Am'], [[55, 59, 62], 'G']]) {
    const result = analyzeHarmony(chordAudio(notes, 4), 11025, 4, 120);
    assert.equal(result[0].chord, expected);
    assert.equal(result[0].start, 0);
    assert.equal(result.at(-1).end, 4);
  }
  assert.equal(analyzeHarmony(new Float32Array(44100), 11025, 4, 120)[0].chord, 'N');
});

test('analysis covers seven minutes with contiguous, editable, finite intervals', () => {
  const duration = 420;
  const samples = chordAudio([48, 60, 64, 67], duration);
  let progress = 0;
  const chords = analyzeHarmony(samples, 11025, duration, 120, value => { progress = value; });
  assert.equal(chords[0].start, 0);
  assert.equal(chords.at(-1).end, 420);
  assert.equal(progress, 1);
  for (let i = 0; i < chords.length; i++) {
    assert.ok(CHORD_NAMES.includes(chords[i].chord));
    assert.ok(chords[i].end > chords[i].start);
    assert.ok(Number.isFinite(chords[i].confidence));
    if (i) assert.equal(chords[i - 1].end, chords[i].start);
  }
});

test('instrument styles and generated notes stay within samples and timeline', () => {
  const chords = [{ start: 0, end: 2, chord: 'C' }, { start: 2, end: 3.1, chord: 'B' },
    { start: 3.1, end: 4, chord: 'N' }];
  for (const instrument of ['synth', 'piano', 'acoustic-guitar', 'electric-guitar']) {
    for (const style of audio.stylesFor(instrument)) {
      const notes = audio.accompanimentNotes(chords, style, 120);
      assert.ok(notes.length);
      for (const note of notes) {
        assert.ok(note.midi >= 48 && note.midi <= 84);
        assert.ok(note.start >= 0 && note.start + note.duration <= 3.1 + 1e-9);
      }
    }
  }
  assert.throws(() => audio.accompanimentNotes(chords, 'rhythm', 0));
  assert.throws(() => audio.accompanimentNotes([{ start: 0, end: 1, chord: 'bad' }], 'pad', 120));
});

test('WAV encoding uses exact stereo PCM16 frames and preserves leading silence', async () => {
  const left = new Float32Array([0, 0, 2, -2]), right = new Float32Array([0, 0, -1, 1]);
  const blob = audio.encodeWav({ length: 4, getChannelData: channel => channel ? right : left });
  const bytes = await blob.arrayBuffer(), view = new DataView(bytes);
  assert.equal(blob.size, 44 + 4 * 4);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 16);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 0);
  assert.ok(view.getInt16(52, true) > 0);
  assert.ok(Math.abs(view.getInt16(52, true)) < 32767);
  const quiet = new Float32Array([0.5, -0.25]);
  const level = new DataView(await audio.encodeWav({ length: 2, getChannelData: () => quiet }).arrayBuffer());
  assert.equal(level.getInt16(44, true), Math.round(0.5 * 32767), 'in-range audio keeps its level');
});

test('detection finds audible music, ignores separation bleed, and bridges short gaps', () => {
  const channel = stem([[2, 0.0005], [4, 0.2], [0.5, 0], [3, 0.2], [5, 0.002], [2, 0.2], [0.2, 0], [0.2, 0.2], [3, 0]]);
  const analysis = regions.analyzeStem('piano', [channel], 1000);
  const found = regions.detectRegions([analysis], 20);
  assert.equal(found.length, 2);
  assert.ok(Math.abs(found[0].start - 1.9) < 0.11 && Math.abs(found[0].end - 9.6) < 0.11, JSON.stringify(found));
  assert.ok(Math.abs(found[1].start - 14.4) < 0.11);
  assert.deepEqual(regions.detectRegions([regions.analyzeStem('x', [new Float32Array(5000)], 1000)], 5), []);
  const late = regions.analyzeStem('bass', [stem([[12, 0], [2, 0.1]])], 1000);
  assert.ok(regions.detectRegions([analysis, late], 20).some(region => region.start < 12.1 && region.end > 13.9));
});

test('analysis sees hard-panned audio and keeps relative loudness in peaks', () => {
  const silent = new Float32Array(2000), right = stem([[2, 0.5]]);
  const panned = regions.analyzeStem('guitar', [silent, right], 1000);
  assert.ok(panned.levels.some(level => level > 0.1));
  assert.ok(Math.max(...panned.peaks) > 0.4);
  const quiet = regions.analyzeStem('bass', [stem([[2, 0.1]])], 1000);
  assert.ok(Math.max(...quiet.peaks) < Math.max(...panned.peaks) / 3);
  assert.ok(regions.waveformPath(panned.peaks, 0.5).startsWith('M0.0'));
  assert.equal(regions.waveformPath(panned.peaks, 0), '');
});

test('region edits are clamped, ordered, merged, and may go anywhere in the song', () => {
  assert.deepEqual(regions.normalizeRegions([
    { start: 8, end: 12 }, { start: -3, end: 2 }, { start: 1.5, end: 3 }, { start: 5, end: 5.01 }, { start: 11, end: 40 },
  ], 20), [{ start: 0, end: 3 }, { start: 8, end: 20 }]);
  assert.deepEqual(regions.normalizeRegions([{ start: 1, end: 2 }, { start: 2, end: 3 }], 5), [{ start: 1, end: 3 }]);
  assert.deepEqual(regions.normalizeRegions([{ start: 1, end: 2.345678 }], 2.3), [{ start: 1, end: 2.3 }]);
  assert.deepEqual(regions.largestGap([{ start: 1, end: 2 }, { start: 3, end: 4 }], 10), { start: 4, end: 10 });
  assert.equal(regions.largestGap([{ start: 0, end: 10 }], 10), undefined);
  const chords = [{ start: 0, end: 2, chord: 'N' }, { start: 2, end: 4, chord: 'C' }];
  assert.equal(regions.regionHasChord({ start: 0, end: 2 }, chords), false);
  assert.equal(regions.regionHasChord({ start: 1, end: 2.1 }, chords), true);
});

test('every note draws its own onset and length change of 0.01% to 0.05%, repeatably', () => {
  const chords = [{ start: 1, end: 9, chord: 'C' }, { start: 9, end: 17, chord: 'Am' }];
  for (const style of ['pad', 'arpeggio', 'rhythm', 'strum']) {
    const nominal = audio.accompanimentNotes(chords, style, 120);
    const varied = audio.humanizeNotes(nominal, audio.seededRandom(42));
    assert.equal(varied.length, nominal.length);
    const onsets = [], lengths = [];
    nominal.forEach((note, i) => {
      const onset = (varied[i].start - note.start) / note.duration, length = (varied[i].duration - note.duration) / note.duration;
      for (const change of [onset, length]) {
        assert.ok(Math.abs(change) >= 0.0001 - 1e-9 && Math.abs(change) <= 0.0005 + 1e-9, `${style} ${change}`);
      }
      onsets.push(onset);
      lengths.push(length);
    });
    assert.equal(new Set(onsets).size, onsets.length, `${style} onsets are all different`);
    assert.equal(new Set(lengths).size, lengths.length, `${style} lengths are all different`);
    assert.deepEqual(audio.humanizeNotes(nominal, audio.seededRandom(42)), varied);
    assert.notDeepEqual(audio.humanizeNotes(nominal, audio.seededRandom(43)), varied);
  }
  const many = audio.humanizeNotes(audio.accompanimentNotes(chords, 'rhythm', 240), audio.seededRandom(9));
  const nominal = audio.accompanimentNotes(chords, 'rhythm', 240);
  const changes = many.map((note, i) => (note.start - nominal[i].start) / nominal[i].duration);
  assert.ok(changes.some(change => change > 0) && changes.some(change => change < 0), 'varies both ways');
  const sizes = changes.map(Math.abs);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) > 0.0002, 'uses the range, not one fixed amount');
  assert.equal(audio.humanizeNotes([{ midi: 60, start: 0, duration: 1, velocity: 0.1 }], () => 0)[0].start, 0, 'never before the song starts');
});

test('planned notes sit only inside regions and keep the song beat grid', () => {
  const chords = [{ start: 0, end: 4, chord: 'C' }, { start: 4, end: 8, chord: 'N' }, { start: 8, end: 12, chord: 'G' }];
  const selection = [{ start: 1.3, end: 2.6 }, { start: 5, end: 9 }];
  for (const [instrument, style] of [['synth', 'pad'], ['piano', 'pad'], ['piano', 'arpeggio'], ['electric-guitar', 'strum'], ['synth', 'rhythm']]) {
    const notes = audio.planNotes(chords, instrument, style, 120, selection, 5);
    assert.ok(notes.length, style);
    for (const note of notes) {
      assert.ok(selection.some(region => note.start >= region.start && note.start + note.duration <= region.end + 1e-9), JSON.stringify(note));
      assert.ok(note.start < 4 || note.start >= 8 - 0.002 - 1e-9, 'N chords stay silent apart from the 0.05% early onset limit');
    }
  }
  const rhythm = audio.planNotes(chords, 'synth', 'rhythm', 120, [{ start: 1.3, end: 2.6 }], 5);
  for (const note of rhythm.filter(item => item.start > 1.3)) {
    const fromBeat = Math.abs(note.start / 0.5 - Math.round(note.start / 0.5)) * 0.5;
    assert.ok(fromBeat < 0.01, `${note.start} stays near a song beat`);
  }
  assert.equal(audio.planNotes(chords, 'synth', 'rhythm', 120, [{ start: 0.42, end: 2 }], 5)
    .some(note => note.start === 0.42 && note.duration < 0.12), false, 'no short leftover blips');
  const pad = audio.planNotes(chords, 'synth', 'pad', 120, [{ start: 1.3, end: 2.6 }], 5);
  assert.equal(pad[0].start, 1.3, 'a sustained chord starts at the region start');
});

test('the render is exactly silent outside regions and matches the source average level', () => {
  const rate = 44100, seconds = 8;
  const channels = [new Float32Array(rate * seconds), new Float32Array(rate * seconds)];
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] = 0.4 * Math.sin(i * 0.05);
  const left = regions.analyzeStem('piano', [stem([[seconds, 0.2]], 8000)], 8000);
  const selection = [{ start: 1, end: 3 }, { start: 5, end: 7 }];
  const profile = regions.loudnessProfile([left], selection);
  assert.ok(Math.abs(profile.target - 0.2 * Math.SQRT1_2) < 0.01);
  regions.shapeRender(channels, rate, 0, profile, selection, true);
  for (const [start, end] of [[0, 1], [3, 5], [7, 8]]) {
    for (let i = start * rate; i < end * rate; i++) assert.ok(channels[0][i] === 0, `sample ${i}`);
  }
  assert.ok(Math.abs(rmsOf(channels[0]) - profile.target) / profile.target < 0.02, `${rmsOf(channels[0])} vs ${profile.target}`);
  assert.ok(channels[0][rate] === 0, 'starts from zero with no click');
  assert.ok(Math.abs(channels[0][rate * 2]) > 0);
});

test('the render follows source loudness variation, within limits, and never exceeds the peak ceiling', () => {
  const rate = 8000;
  const source = regions.analyzeStem('piano', [stem([[4, 0.4], [4, 0.04], [4, 0.4]], rate)], rate);
  const selection = [{ start: 0, end: 12 }];
  const profile = regions.loudnessProfile([source], selection);
  const data = new Float32Array(rate * 12);
  for (let i = 0; i < data.length; i++) data[i] = 0.3 * Math.sin(i * 0.3);
  regions.shapeRender([data], rate, 0, profile, selection, true);
  const loud = rmsOf(data, rate, rate * 3.5), soft = rmsOf(data, rate * 6, rate * 7.5);
  assert.ok(loud / soft > 4, `loud ${loud} soft ${soft}`);
  const floor = regions.loudnessProfile([regions.analyzeStem('piano', [stem([[4, 0.4], [8, 0]], rate)], rate)], selection);
  assert.ok(Math.min(...floor.gains) >= 10 ** (-18 / 20) - 1e-6, 'a region over silent source stays audible');
  assert.ok(Math.max(...floor.gains) <= 10 ** (6 / 20) + 1e-6);
  const hot = regions.analyzeStem('drums', [stem([[12, 1]], rate)], rate);
  const spiky = new Float32Array(rate * 12).fill(0.001);
  spiky[rate] = 1;
  regions.shapeRender([spiky], rate, 0, regions.loudnessProfile([hot], selection), selection, true);
  assert.ok(Math.max(...spiky.map(Math.abs)) <= 0.85 + 1e-6);
  assert.throws(() => regions.shapeRender([new Float32Array(100)], rate, 0, profile, selection, true), /no audible/);
});

test('a preview excerpt keeps the level of its place in the song instead of being re-normalized', () => {
  const rate = 8000;
  const source = regions.analyzeStem('piano', [stem([[10, 0.4], [10, 0.04]], rate)], rate);
  const selection = [{ start: 0, end: 20 }];
  const profile = regions.loudnessProfile([source], selection);
  const excerpt = offset => {
    const data = new Float32Array(rate * 3);
    for (let i = 0; i < data.length; i++) data[i] = 0.3 * Math.sin(i * 0.3);
    regions.shapeRender([data], rate, offset, profile, selection, false);
    return rmsOf(data);
  };
  assert.ok(excerpt(4) / excerpt(15) > 4);
});
