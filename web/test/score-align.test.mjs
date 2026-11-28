import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import ts from 'typescript';

// musicxml.ts and spectrogram.ts have no imports; score-align.ts imports only spectrogram.ts (and types).
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, path => load(path.replace('./', '')));
  return modules[name] = module.exports;
}
const xml = load('musicxml');
const spectrogram = load('spectrogram');
const align = load('score-align');

const note = (step, octave, duration, extra = '') => `<note>${extra.includes('<chord/>') ? '<chord/>' : ''}<pitch><step>${step[0]}</step>`
  + `${step[1] === '#' ? '<alter>1</alter>' : step[1] === 'b' ? '<alter>-1</alter>' : ''}<octave>${octave}</octave></pitch>`
  + `<duration>${duration}</duration>${extra.replace('<chord/>', '')}</note>`;
const rest = duration => `<note><rest/><duration>${duration}</duration></note>`;
const scoreXml = (parts, partList) => `<?xml version="1.0"?><!DOCTYPE score-partwise PUBLIC "x" "y"><!-- a comment -->
  <score-partwise version="4.0"><work><work-title>Test &amp; song</work-title></work><part-list>${partList}</part-list>${parts}</score-partwise>`;

test('MusicXML: chords, ties across a bar line, two staves with backup, a pickup, a transposing part, chord symbols and the tempo', () => {
  const piano = '<part id="P1">'
    + '<measure number="0" implicit="yes"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>'
    + '<direction><sound tempo="96"/></direction>' + note('G', 4, 2, '<staff>1</staff>') + '</measure>'
    + '<measure number="1"><harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>'
    + note('C', 5, 4, '<staff>1</staff>') + note('E', 5, 4, '<chord/><staff>1</staff>') + note('D', 5, 4, '<tie type="start"/><staff>1</staff>')
    + '<backup><duration>8</duration></backup>' + note('C', 3, 8, '<staff>2</staff>') + '</measure>'
    + '<measure number="2"><harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind>minor-seventh</kind></harmony>'
    + note('D', 5, 2, '<tie type="stop"/><staff>1</staff>') + rest(2) + '<note><grace/><pitch><step>A</step><octave>4</octave></pitch><duration>0</duration></note>'
    + note('F#', 4, 4, '<staff>1</staff>') + '</measure></part>';
  // A B-flat clarinet: written D sounds C.
  const clarinet = '<part id="P2"><measure number="0"><attributes><divisions>1</divisions><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>'
    + rest(1) + '</measure><measure number="1">' + note('D', 5, 4) + '</measure><measure number="2"><forward><duration>2</duration></forward>' + note('E', 5, 2) + '</measure></part>';
  const score = xml.parseMusicXml(scoreXml(piano + clarinet,
    '<score-part id="P1"><part-name>Piano</part-name></score-part><score-part id="P2"><part-name>Clarinet</part-name></score-part>'));
  assert.equal(score.title, 'Test & song');
  assert.deepEqual(score.parts.map(part => part.name), ['Piano', 'Clarinet']);
  assert.equal(score.tempo, 96);
  assert.deepEqual(score.measures.map(measure => [measure.number, measure.start, measure.length]), [['0', 0, 1], ['1', 1, 4], ['2', 5, 4]]);
  const notes = score.notes.map(n => [n.pitch, n.start, n.length, n.part, n.staff]);
  assert.deepEqual(notes, [
    [67, 0, 1, 0, 1],
    [48, 1, 4, 0, 2], [72, 1, 2, 0, 1], [72, 1, 4, 1, 1], [76, 1, 2, 0, 1],
    [74, 3, 3, 0, 1],                        // D5 held over the bar line: one note, three quarters.
    [66, 7, 2, 0, 1], [74, 7, 2, 1, 1],      // The grace note is left out; the clarinet sounds a tone below written.
  ]);
  assert.deepEqual(score.chords, [
    { start: 1, pitchClasses: [0, 4, 7], root: 0, quality: '', bass: 0, measure: 1 },
    { start: 5, pitchClasses: [10, 1, 5, 8], root: 10, quality: 'm7', bass: 10, measure: 2 },
  ]);
});

test('MusicXML: a compressed .mxl is unzipped through its container, and what is not a score is refused', async () => {
  const score = scoreXml('<part id="P1"><measure number="1">' + note('A', 4, 4) + '</measure></part>', '<score-part id="P1"><part-name>A</part-name></score-part>');
  const container = '<container><rootfiles><rootfile full-path="music/song.musicxml"/></rootfiles></container>';
  const files = [['META-INF/container.xml', container, 0], ['music/song.musicxml', score, 8]];
  const local = [], central = [];
  let offset = 0;
  for (const [name, text, method] of files) {
    const raw = Buffer.from(text), data = method ? deflateRawSync(raw) : raw, nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(method, 8); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(method, 10); entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const text = await xml.unzipMusicXml(new Uint8Array(Buffer.concat([...local, directory, end])));
  assert.equal(xml.parseMusicXml(text).notes[0].pitch, 69);
  assert.throws(() => xml.parseMusicXml('<html><body>not a score</body></html>'), /not a MusicXML score/);
});

// A song made from a score: the other stem plays its chords (struck tones that fade), the vocals its melody, the
// bass its roots, drums a click on every beat, starting `offset` seconds in at `beat` seconds per quarter.
function synthesize(score, { offset, beat, shift = 0, seconds, rate = 22050, skip = () => false }) {
  const length = Math.round(seconds * rate);
  const stems = { other: new Float32Array(length), vocals: new Float32Array(length), bass: new Float32Array(length), drums: new Float32Array(length) };
  const partStem = ['other', 'vocals', 'bass'];
  for (const n of score.notes) {
    if (skip(n)) continue;
    const stem = stems[partStem[n.part]];
    const start = Math.round((offset + n.start * beat) * rate), end = Math.round((offset + (n.start + n.length) * beat) * rate);
    const hz = 440 * 2 ** ((n.pitch + shift - 69) / 12);
    for (let i = start; i < Math.min(end, length); i++) {
      const t = (i - start) / rate, fade = n.part === 1 ? 1 : Math.exp(-t * 2.5), edge = Math.min(1, (end - i) / (0.01 * rate));
      stem[i] += 0.15 * fade * edge * (Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t));
    }
  }
  const total = score.measures.at(-1).start + score.measures.at(-1).length;
  let noise = 1;
  for (let quarter = 0; quarter < total; quarter++) {
    const start = Math.round((offset + quarter * beat) * rate);
    for (let i = start; i < Math.min(start + 0.03 * rate, length); i++) {
      noise = (noise * 16807) % 2147483647;
      stems.drums[i] += 0.3 * (noise / 2147483647 - 0.5) * Math.exp(-(i - start) / (0.01 * rate));
    }
  }
  // A little hiss everywhere, as a separated stem has.
  for (const stem of Object.values(stems)) for (let i = 0; i < length; i++) { noise = (noise * 16807) % 2147483647; stem[i] += 0.0005 * (noise / 2147483647 - 0.5); }
  return stems;
}

// Eight bars: I vi IV V twice in C, chords as half notes (part 0), a melody in quarters (part 1), roots (part 2).
function songScore() {
  const progression = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
  const melody = [72, 74, 76, 74, 72, 71, 69, 71, 72, 72, 69, 67, 67, 69, 71, 74];
  const measures = [], notes = [];
  for (let bar = 0; bar < 8; bar++) {
    measures.push({ number: String(bar + 1), start: bar * 4, length: 4, beats: 4, beatType: 4 });
    const chord = progression[bar % 4];
    for (const half of [0, 2]) for (const pitch of chord) notes.push({ pitch, start: bar * 4 + half, length: 2, measure: bar, part: 0, staff: 1 });
    for (let q = 0; q < 4; q++) notes.push({ pitch: melody[(bar * 4 + q) % 16] + (bar >= 4 ? 0 : 0), start: bar * 4 + q, length: 1, measure: bar, part: 1, staff: 1 });
    notes.push({ pitch: chord[0] - 24, start: bar * 4, length: 4, measure: bar, part: 2, staff: 1 });
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { title: 'Song', parts: [{ id: 'P1', name: 'Guitar' }, { id: 'P2', name: 'Voice' }, { id: 'P3', name: 'Bass' }], measures, notes, chords: [], tempo: 80 };
}

async function spectrogramsOf(stems, rate = 22050) {
  const out = {};
  for (const [name, signal] of Object.entries(stems)) out[name] = await spectrogram.spectrogramOf(signal, rate, undefined, 1e9);
  return out;
}

test('a score is found in the song: measures on the song beats, parts on their stems, the other stem restored', async () => {
  const score = songScore(), offset = 3.1, beat = 0.52, seconds = 24;
  const spectrograms = await spectrogramsOf(synthesize(score, { offset, beat, seconds }));
  // The song's beats, as the chord analysis gives them: every beat from the start.
  const beats = Array.from({ length: Math.floor(seconds / beat) }, (_, k) => offset - 5 * beat + k * beat).filter(time => time >= 0);
  const result = align.alignScore({ score, spectrograms, seconds, beats });
  assert.equal(result.shift, 0);
  result.measures.forEach((measure, index) => {
    assert.ok(Math.abs(measure.start - (offset + index * 4 * beat)) < 0.03, `measure ${index + 1} at ${measure.start}`);
    assert.ok(measure.onBeat);
  });
  assert.ok(Math.abs(result.secondsPerQuarter - beat) < 0.01);
  assert.deepEqual(result.parts.map(part => [part.name, part.stem]), [['Guitar', 'other'], ['Voice', 'vocals'], ['Bass', 'bass']]);
  // Every chord tone is restored on the other stem, where and as long as it was played; the melody and bass are not.
  const chordTones = score.notes.filter(n => n.part === 0);
  assert.equal(result.notes.length, chordTones.length);
  for (const n of chordTones) {
    const found = result.notes.find(r => r.pitch === n.pitch && Math.abs(r.start - (offset + n.start * beat)) < 0.05);
    assert.ok(found, `chord tone ${n.pitch} at quarter ${n.start}`);
    // Held on no later than half a beat past its written end (a neighbour's overtones can keep its pitch lit).
    assert.ok(found.end > found.start + 0.3 && found.end <= offset + (n.start + n.length + 0.5) * beat + 0.05, `ends at ${found.end}`);
    assert.ok(found.velocity >= 12 && found.velocity <= 127);
  }
  const melodyMissing = result.missing.filter(m => score.notes.some(n => n.part === 1 && n.pitch === m.pitch));
  assert.ok(melodyMissing.length >= 12 && melodyMissing.every(m => m.stems.includes('vocals')));
  assert.ok(Math.abs(result.timeAt(6) - (offset + 6 * beat)) < 0.03);
});

test('the song in another key and at another tempo than the score marks; a note the stem leaves out is not restored', async () => {
  const score = songScore(), offset = 7.4, beat = 0.6, seconds = 30;
  const dropped = score.notes.find(n => n.part === 0 && n.start === 10 && n.pitch === 57);
  const spectrograms = await spectrogramsOf(synthesize(score, { offset, beat, seconds, shift: 2, skip: n => n === dropped }));
  // No beats from the song: the score's marking (80 a minute, 0.75 s) is the only guess.
  const result = align.alignScore({ score, spectrograms, seconds });
  assert.equal(result.shift, 2);
  result.measures.forEach((measure, index) => {
    // Without the song's beats, to within about two feature steps.
    assert.ok(Math.abs(measure.start - (offset + index * 4 * beat)) < 0.1, `measure ${index + 1} at ${measure.start}`);
  });
  assert.ok(!result.notes.some(r => r.pitch === 59 && Math.abs(r.start - (offset + 10 * beat)) < 0.1));
  assert.ok(result.missing.some(m => m.pitch === 59 && Math.abs(m.start - (offset + 10 * beat)) < 0.1));
  assert.ok(result.notes.some(r => r.pitch === 62 && Math.abs(r.start - (offset + 10 * beat)) < 0.06));
});

test('warp: a sequence found inside a longer one, slower', () => {
  const pattern = [0, 1, 2, 3, 2, 1, 0];
  const song = [9, 9, 9, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 1, 1, 0, 0, 9, 9];
  const { path } = align.warp(pattern.length, song.length, (i, j) => Math.abs(pattern[i] - song[j]));
  assert.ok(path[0] === 3 || path[0] === 4);
  assert.ok(path[6] >= 15 && path[6] <= 16);
  for (let i = 1; i < path.length; i++) assert.ok(path[i] >= path[i - 1]);
});

test('an excerpt of a score: measures from one to another, starting at zero, notes cut at its end', () => {
  const score = songScore();
  score.notes.push({ pitch: 40, start: 11, length: 3, measure: 2, part: 2, staff: 1 });
  const part = xml.scoreExcerpt(score, 3, 4);
  assert.deepEqual(part.measures.map(m => [m.number, m.start]), [['3', 0], ['4', 4]]);
  assert.ok(part.notes.every(n => n.start >= 0 && n.start + n.length <= 8 + 1e-9));
  assert.equal(part.notes.filter(n => n.part === 1).length, 8);
  assert.equal(part.notes.find(n => n.pitch === 40).length, 3);
  assert.deepEqual(xml.scoreExcerpt(score, 7, 99).measures.map(m => m.number), ['7', '8']);
});

test('the restored notes separated from the stem: a scored note and its overtones kept, an unscored one left out', async () => {
  const rate = 22050, length = rate * 2;
  const tone = (pitch, from, to) => {
    const out = new Float32Array(length), hz = 440 * 2 ** ((pitch - 69) / 12);
    for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) {
      const t = i / rate;
      out[i] = 0.2 * (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.3 * Math.sin(6 * Math.PI * hz * t));
    }
    return out;
  };
  // No overtone of one is an overtone of the other (A3 and D4); one they shared would be kept with the scored note.
  const scored = tone(57, 0.3, 1.2), other = tone(62, 0.6, 1.6);
  const stem = scored.map((value, i) => value + other[i]);
  const frames = Math.ceil(length / spectrogram.HOP);
  const note = { pitch: 57, start: 0.3, end: 1.2, velocity: 90, measure: 0, written: { pitch: 57, start: 0, length: 2 }, heard: {}, octave: 0 };
  const kept = align.scoreMask([note], frames, rate);
  const separated = await spectrogram.maskedSignal(stem, rate, kept, frames, undefined, 1e9);
  const rms = (signal, from, to) => {
    let sum = 0;
    for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) sum += signal[i] ** 2;
    return Math.sqrt(sum / ((to - from) * rate));
  };
  // Where only the scored note sounds, it is all there; where only the other one does, nothing is.
  assert.ok(Math.abs(rms(separated, 0.35, 0.55) / rms(scored, 0.35, 0.55) - 1) < 0.1);
  assert.ok(rms(separated, 1.3, 1.55) < 0.05 * rms(other, 1.3, 1.55));
  // Where both sound, the scored one is kept and the other mostly left out (about 12 dB down: what the window
  // spreads of it into the scored note's bins stays).
  let error = 0;
  for (let i = Math.round(0.7 * rate); i < Math.round(1.1 * rate); i++) error += (separated[i] - scored[i]) ** 2;
  assert.ok(Math.sqrt(error / (0.4 * rate)) < 0.35 * rms(other, 0.7, 1.1));
});

test('restored from the bass and other stems together: the bass line comes back with the chords, the melody stays the singer\'s', async () => {
  const score = songScore(), offset = 3.1, beat = 0.52, seconds = 24;
  const stems = synthesize(score, { offset, beat, seconds });
  const spectrograms = await spectrogramsOf(stems);
  const mixed = await spectrogram.spectrogramOf(stems.other.map((value, i) => value + stems.bass[i]), 22050, undefined, 1e9);
  const beats = Array.from({ length: Math.floor(seconds / beat) }, (_, k) => offset - 5 * beat + k * beat).filter(time => time >= 0);
  const result = align.alignScore({ score, spectrograms, seconds, beats, target: { spectrogram: mixed, stems: ['other', 'bass'] } });
  const roots = score.notes.filter(n => n.part === 2), chordTones = score.notes.filter(n => n.part === 0);
  for (const n of [...roots, ...chordTones]) {
    assert.ok(result.notes.some(r => r.pitch === n.pitch && Math.abs(r.start - (offset + n.start * beat)) < 0.06), `note ${n.pitch} at quarter ${n.start}`);
  }
  assert.equal(result.notes.length, roots.length + chordTones.length);
  assert.ok(result.missing.filter(m => m.stems.includes('vocals')).length >= 12);
});

test('repeats taken: first and second endings, an ending read in pieces, a second repeat, a stray ending mark', () => {
  // Printed: 1 |: 2 3 [1. 4 5 :|] [2. 6] 7 [1. 8] |: 9 :| 10 — the ending over 4–5 read as start, stop, start, stop;
  // the ending at 8 has no repeat to belong to and no stop.
  const measures = Array.from({ length: 10 }, (_, i) => ({ number: String(i + 1), start: i * 4, length: 4, beats: 4, beatType: 4 }));
  const notes = measures.map((m, i) => ({ pitch: 60 + i, start: m.start, length: 4, measure: i, part: 0, staff: 1 }));
  const marks = {
    1: { forward: true }, 3: { endingStart: [1], endingStop: [1] }, 4: { endingStart: [1], endingStop: [1], backward: 2 },
    5: { endingStart: [2], endingStop: [2] }, 7: { endingStart: [1] }, 8: { forward: true, backward: 2 },
  };
  const played = xml.unrollRepeats({ title: '', parts: [], measures, notes, chords: [], marks });
  assert.deepEqual(played.measures.map(m => m.number), ['1', '2', '3', '4', '5', '2', '3', '6', '7', '8', '9', '9', '10']);
  assert.deepEqual(played.measures.map(m => m.start), played.measures.map((_, i) => i * 4));
  assert.deepEqual(played.notes.map(n => n.pitch), [60, 61, 62, 63, 64, 61, 62, 65, 66, 67, 68, 68, 69]);
  assert.deepEqual(played.notes.map(n => n.measure), played.notes.map((_, i) => i));
  // Without repeats the score is as printed.
  const plain = { title: '', parts: [], measures, notes, chords: [] };
  assert.equal(xml.unrollRepeats(plain), plain);
});

test('MusicXML: repeat barlines and endings are read from every part, and taken', () => {
  const bar = (n, barlines = '') => `<measure number="${n}">${barlines}${note('C', 4, 4)}</measure>`;
  const piano = '<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>' + note('C', 4, 4) + '</measure>'
    + bar(2, '<barline location="left"><repeat direction="forward"/></barline>')
    + bar(3, '<barline location="left"><ending number="1" type="start"/></barline><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>')
    + bar(4) + '</part>';
  // The second ending is marked only on the voice part.
  const voice = '<part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>' + note('E', 4, 4) + '</measure>'
    + bar(2) + bar(3) + bar(4, '<barline location="left"><ending number="2" type="start"/></barline><barline location="right"><ending number="2" type="stop"/></barline>') + '</part>';
  const score = xml.parseMusicXml(scoreXml(piano + voice, '<score-part id="P1"><part-name>A</part-name></score-part><score-part id="P2"><part-name>B</part-name></score-part>'));
  assert.deepEqual(score.marks, { 1: { forward: true }, 2: { endingStart: [1], endingStop: [1], backward: 2 }, 3: { endingStart: [2], endingStop: [2] } });
  assert.deepEqual(xml.unrollRepeats(score).measures.map(m => m.number), ['1', '2', '3', '2', '4']);
});

test('measure by measure: a repeat and a bar the score lacks are found, a drum bar with a beat too many is corrected', async () => {
  // Eight bars, each its own chord (guitar, part 0) and melody (voice, part 1).
  const chords = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59], [50, 53, 57], [58, 62, 65], [52, 56, 59]];
  const melodies = [[72, 74, 76, 74], [72, 71, 69, 71], [69, 72, 77, 76], [74, 71, 67, 74], [71, 67, 64, 67], [69, 65, 62, 65], [70, 74, 77, 74], [68, 71, 76, 71]];
  const score = { title: '', parts: [{ id: 'P1', name: 'Guitar' }, { id: 'P2', name: 'Voice' }], chords: [], notes: [],
    measures: chords.map((_, bar) => ({ number: String(bar + 1), start: bar * 4, length: 4, beats: 4, beatType: 4 })) };
  chords.forEach((chord, bar) => {
    for (const half of [0, 2]) for (const pitch of chord) score.notes.push({ pitch, start: bar * 4 + half, length: 2, measure: bar, part: 0, staff: 1 });
    melodies[bar].forEach((pitch, q) => score.notes.push({ pitch, start: bar * 4 + q, length: 1, measure: bar, part: 1, staff: 1 }));
  });
  score.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  // As played: 1 2 3 4, a bar of its own (C# minor, no voice), 1 2 3 4 again, 5 6 7 8; from 2 s, half a second a beat.
  const order = [0, 1, 2, 3, null, 0, 1, 2, 3, 4, 5, 6, 7], offset = 2, beat = 0.5;
  const played = { ...score, measures: order.map((_, k) => ({ number: String(k + 1), start: k * 4, length: 4, beats: 4, beatType: 4 })), notes: [] };
  order.forEach((bar, k) => {
    const notes = bar === null ? [61, 64, 68].flatMap(pitch => [0, 2].map(half => ({ pitch, start: half, length: 2, part: 0 })))
      : score.notes.filter(n => n.measure === bar).map(n => ({ ...n, start: n.start - bar * 4 }));
    for (const n of notes) played.notes.push({ ...n, start: n.start + k * 4, measure: k, staff: 1 });
  });
  const seconds = offset + order.length * 4 * beat + 2;
  const spectrograms = await spectrogramsOf(synthesize(played, { offset, beat, seconds }));
  // The drum analysis's beats: right, but one too many in the third bar, and its bars counted from the second beat.
  const truth = Array.from({ length: Math.floor((seconds - 0.5) / beat) }, (_, k) => k * beat);
  const drum = [...truth.slice(0, 13), offset + 8 * beat + 0.25, ...truth.slice(13)].sort((a, b) => a - b);
  const base = align.alignScore({ score, spectrograms, seconds, beats: drum, intro: true });
  const fit = align.fitMeasures({ score, spectrograms, seconds, beats: drum }, base, 1);
  assert.deepEqual(fit.placed.map(p => p.number), ['1', '2', '3', '4', '–', '1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(fit.corrections.extraBeats, 1);
  assert.equal(fit.placed[2].corrected, 'extra-beat');
  assert.equal(fit.placed[0].corrected, 'moved');   // The drum analysis's bars started a beat late.
  // The corrected beats are the true ones from the first measure on, bars of four from it.
  const first = fit.beats.findIndex(time => Math.abs(time - offset) < 0.03);
  assert.equal(fit.firstBar, first);
  for (let k = 0; k < order.length * 4; k++) assert.ok(Math.abs(fit.beats[first + k] - (offset + k * beat)) < 0.03, `beat ${k} at ${fit.beats[first + k]}`);
  // The guitar is restored in every bar it plays; the free bar has no score notes.
  assert.ok(fit.alignment.notes.length >= 70);
  assert.ok(!fit.alignment.notes.some(n => n.measure === 4));
  // Each measure is as like the song as it was found where it was laid; the synthesized guitar is close everywhere.
  assert.ok(fit.placed.filter(p => p.measure !== null).every(p => p.cost >= 0 && p.cost < 0.5), JSON.stringify(fit.placed.map(p => p.cost)));
  assert.equal(fit.placed[4].cost, 0);
  assert.ok(align.similarityOf(fit.placed) > 0.5);
});

test('drum hits moved to corrected beats: the same moments, on the new grid', () => {
  const from = [0, 0.5, 1, 1.25, 1.5, 2, 2.5];   // A false beat at 1.25.
  const to = [0, 0.5, 1, 1.5, 2, 2.5];
  const hits = [{ unit: 0, drum: 'kick' }, { unit: 8, drum: 'snare' }, { unit: 16, drum: 'kick' }, { unit: 20, drum: 'snare' }];
  assert.deepEqual(align.regridHits(hits, from, to).map(hit => hit.unit), [0, 8, 12, 16]);
  assert.deepEqual(align.measureBeats(from, 0, 5, 4), [0, 0.5, 1, 1.5]);
  assert.deepEqual(align.measureBeats([0, 0.5, 1.5, 2], 0, 3, 4), [0, 0.5, 1, 1.5]);
});

test('the harmony result from a score: only the restored notes, on the corrected beats; bass and drums moved there', () => {
  const analysis = {
    beats: [0, 0.5, 1, 1.25, 1.5, 2, 2.5, 3], firstBar: 0, accompaniment: { genre: 'rock' },
    ensemble: { key: 'C', chords: [{ start: 0, name: 'C' }], notes: [{ start: 0.1, end: 0.3, pitch: 99, unit: 0, length: 1 }], second: [{ start: 0, end: 1, pitch: 50, unit: 0, length: 4 }], repeats: [] },
    stems: { bass: { chords: [], notes: [{ start: 1.5, end: 2, pitch: 36, unit: 16, length: 4 }] }, drums: { chords: [], notes: [], hits: [{ unit: 16, drum: 'kick' }] } },
  };
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  const alignment = {
    measures: [{ index: 0, number: '1', start: 0, end: 2, onBeat: true }], shift: 0, secondsPerQuarter: 0.5, likeness: 1, parts: [],
    missing: [{ pitch: 72, start: 1, end: 1.5, measure: 0, stems: ['vocals'], part: 'vocals' }, { pitch: 40, start: 0, end: 2, measure: 0, stems: [], part: 'other' }],
    notes: [{ pitch: 60, start: 0.52, end: 0.98, velocity: 80, measure: 0, written: { pitch: 60, start: 1, length: 1 }, heard: {}, octave: 0 }],
    timeAt: quarter => quarter * 0.5,
  };
  const fit = { beats, firstBar: 0, placed: [{ measure: 0, number: '1', from: 0, drumBeats: 4, start: 0, end: 2, cost: 0.25, corrected: '' }], corrections: { bars: 1, extraBeats: 1, missingBeats: 0, moved: 0, checked: 1 }, alignment,
    chords: [{ start: 0, root: 9, quality: 'm7', bass: 9 }, { start: 1, root: 2, quality: '', bass: 6 }, { start: 2, root: 0, quality: 'N.C.', bass: 0 }],
    bass: [{ pitch: 33, start: 0.5, end: 1, velocity: 70, measure: 0, written: { pitch: 45, start: 1, length: 1 }, heard: {}, octave: -12 }] };
  const made = align.harmonyFromScore(analysis, alignment, fit, { title: 'Song', correctedBars: 1, family: 'keys' });
  assert.deepEqual(made.beats, beats);
  assert.deepEqual(made.ensemble.notes, [{ start: 0.52, end: 0.98, pitch: 60, unit: 4, length: 4, velocity: 80, confidence: 1 }]);
  assert.equal(made.ensemble.second, undefined);
  // The score's sung line goes with it, for parts that play the score; a note the stem does not play does not.
  assert.deepEqual(made.ensemble.melody, [{ start: 1, end: 1.5, pitch: 72, unit: 8, length: 4, velocity: 100, confidence: 1 }]);
  // The chords and the bass line are the score's: the analysis's C chord and its bass note are gone.
  assert.deepEqual(made.ensemble.chords, [{ start: 0, name: 'Am7' }, { start: 1, name: 'D/F#' }, { start: 2, name: 'N.C.' }]);
  assert.deepEqual(made.stems.bass.chords, made.ensemble.chords);
  assert.deepEqual(made.stems.bass.notes, [{ start: 0.5, end: 1, pitch: 33, unit: 4, length: 4, velocity: 70, confidence: 1 }]);
  assert.deepEqual(made.stems.drums.hits.map(h => h.unit), [12]);
  assert.deepEqual(made.accompaniment, { genre: 'rock' });
  assert.deepEqual(made.fromScore, { title: 'Song', measures: 1, notes: 1, heard: 1, correctedBars: 1, family: 'keys',
    similarity: 0.75, bars: [{ number: '1', start: 0, end: 2, similarity: 0.75 }] }, 'how like the stem each measure is where it was laid');
});

test('chords named from a score\'s notes: the shape that fits, on the lowest note when two fit alike, a slash for another bass', () => {
  const weights = pcs => { const w = new Array(12).fill(0); for (const [pc, value] of pcs) w[pc] += value; return w; };
  const name = (pcs, lowest) => align.chordName(align.nameChord(weights(pcs), lowest), 'B');
  assert.equal(name([[0, 2], [4, 1], [7, 1]], 0), 'C');
  assert.equal(name([[9, 2], [0, 1], [4, 1], [7, 1]], 9), 'Am7');
  // G#, B and F# with G# lowest: G#m7 (E/G# fits the notes no better, and its root is not the bass).
  assert.equal(name([[8, 4], [11, 1.5], [6, 1]], 8), 'G#m7');
  assert.equal(name([[2, 1], [6, 2], [9, 1]], 6), 'D/F#');
  assert.equal(align.chordName({ root: 3, quality: '', bass: 3 }, 'Eb'), 'Eb');
  assert.equal(align.nameChord(new Array(12).fill(0), null), null);
});

test('with the score aligned, every score note is kept: one the stem leaves out is filled in where written, as loud as its neighbours', async () => {
  const score = songScore(), offset = 3.1, beat = 0.52, seconds = 24;
  const dropped = score.notes.find(n => n.part === 0 && n.start === 10 && n.pitch === 57);
  const spectrograms = await spectrogramsOf(synthesize(score, { offset, beat, seconds, skip: n => n === dropped }));
  const beats = Array.from({ length: Math.floor(seconds / beat) }, (_, k) => offset - 5 * beat + k * beat).filter(time => time >= 0);
  const result = align.alignScore({ score, spectrograms, seconds, beats, fill: true });
  // Every guitar and bass note of the score; the melody stays the singer's.
  assert.equal(result.notes.length, score.notes.filter(n => n.part !== 1).length);
  const filled = result.notes.filter(n => n.found === false);
  assert.ok(filled.some(n => n.pitch === 57 && Math.abs(n.start - (offset + 10 * beat)) < 0.05), 'the left-out note, where written');
  assert.ok(filled.every(n => n.velocity >= 12 && n.velocity <= 127));
  assert.ok(result.notes.filter(n => n.part === undefined && n.found !== false).length > 40);
  assert.ok(result.missing.every(m => m.part === 'vocals'));
  // Nothing is extracted for a note that was not heard.
  const kept = align.scoreMask(filled, spectrograms.other.frames, 22050);
  assert.equal(kept.some(value => value), false);
});

test('chord symbols as printed: their written kind and slash bass, and in a laid score the printed ones win where they are', () => {
  const harmony = (step, alter, kind, text, bass = '') => `<harmony><root><root-step>${step}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ''}</root>`
    + `<kind${text === undefined ? '' : ` text="${text}"`}>${kind}</kind>${bass}</harmony>`;
  const part = '<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>'
    + harmony('E', 0, 'minor-seventh', 'm7') + note('E', 3, 4) + '</measure>'
    + '<measure number="2">' + note('C', 3, 4) + '</measure>'
    + '<measure number="3">' + harmony('D', 0, 'major', undefined, '<bass><bass-step>F</bass-step><bass-alter>1</bass-alter></bass>') + note('F#', 2, 4) + '</measure></part>';
  const score = xml.parseMusicXml(scoreXml(part, '<score-part id="P1"><part-name>Piano</part-name></score-part>'));
  assert.deepEqual(score.chords.map(c => [c.start, c.root, c.quality, c.bass, c.measure]), [[0, 4, 'm7', 4, 0], [8, 2, '', 6, 2]]);
  // Laid four semitones up: the printed chords moved, the measure without one named from its notes.
  const chords = align.scoreChords(score, [true, true, true], quarter => quarter, 4, () => null);
  assert.deepEqual(chords.map(c => [c.start, align.chordName(c, 'B')]), [[0, 'G#m7'], [4, 'E'], [8, 'F#/A#']]);
});

// A drum part: kick on 1 and 3, snare on 2 and 4, hi-hat eighths; `bars` measures of 4/4.
function drumXml(bars) {
  const hit = (step, octave, duration, chord, head) => `<note>${chord ? '<chord/>' : ''}<unpitched><display-step>${step}</display-step>`
    + `<display-octave>${octave}</display-octave></unpitched><duration>${duration}</duration>${head ? `<notehead>${head}</notehead>` : ''}</note>`;
  let measures = '';
  for (let bar = 0; bar < bars; bar++) {
    let body = bar === 0 ? '<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes>' : '';
    for (let eighth = 0; eighth < 8; eighth++) {
      body += hit('G', 5, 1, false, 'x');
      if (eighth % 4 === 0) body += hit('F', 4, 1, true);
      if (eighth % 4 === 2) body += hit('C', 5, 1, true);
    }
    measures += `<measure number="${bar + 1}">${body}</measure>`;
  }
  return scoreXml(`<part id="P1">${measures}</part>`, '<score-part id="P1"><part-name>Drums</part-name></score-part>');
}

test('MusicXML: a drum part\'s unpitched notes are its hits, named by where they are written (or their instrument)', () => {
  const score = xml.parseMusicXml(drumXml(1));
  assert.equal(score.notes.length, 0);
  const at = drum => score.hits.filter(hit => hit.drum === drum).map(hit => hit.start);
  assert.deepEqual(at('kick'), [0, 2]);
  assert.deepEqual(at('snare'), [1, 3]);
  assert.deepEqual(at('hihat'), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  // By General MIDI key: midi-unpitched 50 is key 49, a crash.
  const named = scoreXml('<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>'
    + '<note><unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched><duration>4</duration><instrument id="I1"/></note></measure></part>',
    '<score-part id="P1"><part-name>Drums</part-name><score-instrument id="I1"><instrument-name>Thing</instrument-name></score-instrument>'
    + '<midi-instrument id="I1"><midi-unpitched>50</midi-unpitched></midi-instrument></score-part>');
  assert.deepEqual(xml.parseMusicXml(named).hits.map(hit => hit.drum), ['cymbal']);
});

test('the drum analysis\'s plain mistakes are mended before a score is laid: a lost beat put back, a false one taken out', () => {
  const even = Array.from({ length: 20 }, (_, index) => index * 0.5);
  const lost = even.filter((_, index) => index !== 7);
  assert.deepEqual(align.repairBeats(lost).map(time => +time.toFixed(3)), even);
  const extra = [...even.slice(0, 12), 5.74, ...even.slice(12)];
  assert.deepEqual(align.repairBeats(extra), even);
  assert.deepEqual(align.repairBeats(even), even);
});

test('a drum score is laid on the drum transcription bar by bar, and a beat the analysis lost is put back where it was', () => {
  const score = xml.parseMusicXml(drumXml(12));
  const truth = Array.from({ length: 4 * 14 + 1 }, (_, index) => 0.3 + index * 0.5);
  // The song's drums: the score's from its second bar (one bar of count-in first), with a beat lost in bar 6.
  const heard = [];
  for (let bar = 0; bar < 12; bar++) for (const hit of score.hits.filter(found => found.measure === bar)) {
    heard.push({ unit: Math.round((4 + bar * 4 + hit.start - score.measures[bar].start) * 4), drum: hit.drum });
  }
  const lostAt = 4 + 5 * 4 + 2, beats = truth.filter((_, index) => index !== lostAt);
  const fit = align.fitDrumScore(score, align.regridHits(heard, truth, beats), beats, 0);
  assert.equal(fit.beats.length, truth.length);
  assert.ok(fit.beats.every((time, index) => Math.abs(time - truth[index]) < 1e-6), 'the beats are the true ones again');
  const laid = fit.placed.filter(place => place.measure !== null);
  assert.deepEqual(laid.map(place => place.measure), [...Array(12).keys()]);
  assert.ok(laid.every(place => Math.abs(place.start - truth[4 + place.measure * 4]) < 1e-6));
  assert.equal(fit.corrections.missingBeats, 1);
  assert.equal(fit.hits.length, score.hits.length);
  assert.equal(fit.heard, score.hits.length);
  assert.ok(laid.every(place => place.cost < 0.05), 'every written hit heard: each measure all but the same as the drums');
});

test('a staff in layers: the layer that sounds like the singer is the vocals\', and its notes are not the Harmonic stem\'s', async () => {
  const score = songScore(), offset = 3.1, beat = 0.52, seconds = 24;
  const spectrograms = await spectrogramsOf(synthesize(score, { offset, beat, seconds }));
  const beats = Array.from({ length: Math.floor(seconds / beat) }, (_, k) => offset - 5 * beat + k * beat).filter(time => time >= 0);
  // The tune written as a second layer on the guitar's staff, the chords its first; no Voice part.
  const layered = { ...score, parts: [score.parts[0], score.parts[2]],
    notes: score.notes.map(n => n.part === 1 ? { ...n, part: 0, voice: 2 } : n.part === 2 ? { ...n, part: 1 } : { ...n, voice: 1 }) };
  const result = align.alignScore({ score: layered, spectrograms, seconds, beats });
  assert.ok(result.parts.some(part => part.part === 0 && part.voice === 2 && part.stem === 'vocals'), JSON.stringify(result.parts.map(p => [p.name, p.stem])));
  assert.equal(result.parts.find(part => part.part === 0 && part.voice === undefined).stem, 'other');
  const tune = layered.notes.filter(n => n.voice === 2);
  assert.ok(!result.notes.some(r => tune.some(n => n.pitch === r.pitch && Math.abs(r.start - (offset + n.start * beat)) < 0.05 && !layered.notes.some(c => c.voice === 1 && c.pitch === n.pitch && c.start === n.start))),
    'no note of the tune is restored');
});

test('notes doubling the sung line are the vocals\', and a layer made of them is the vocals\' as a whole', () => {
  const notes = [
    // The Voice part.
    { pitch: 72, start: 0, length: 1, measure: 0, part: 1, staff: 1, voice: 1 }, { pitch: 74, start: 1, length: 1, measure: 0, part: 1, staff: 1, voice: 1 },
    // The piano's right hand: one layer of chords with the tune's first note on top, one layer doubling the tune.
    { pitch: 64, start: 0, length: 2, measure: 0, part: 0, staff: 1, voice: 1 }, { pitch: 72, start: 0, length: 2, measure: 0, part: 0, staff: 1, voice: 1 },
    ...Array.from({ length: 8 }, (_, k) => ({ pitch: k % 2 ? 74 : 72, start: k, length: 1, measure: 0, part: 0, staff: 1, voice: 2 })),
  ];
  // The tune again on the Voice part for every beat the second layer plays.
  for (let k = 2; k < 8; k++) notes.push({ pitch: k % 2 ? 74 : 72, start: k, length: 1, measure: 0, part: 1, staff: 1, voice: 1 });
  const parts = [{ part: 0, staff: 1, name: 'Piano', stem: 'other', likeness: {} }, { part: 1, staff: 1, name: 'Voice', stem: 'vocals', likeness: {} }];
  const stemOf = align.noteStems({ notes }, parts);
  assert.equal(stemOf(notes[2]), 'other', 'a chord tone under the tune');
  assert.equal(stemOf(notes[3]), 'vocals', 'the tune\'s note on top of the chord');
  assert.ok(notes.filter(n => n.part === 0 && n.voice === 2).every(n => stemOf(n) === 'vocals'), 'the doubling layer');
});
