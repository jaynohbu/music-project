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
  assert.deepEqual(score.chords, [{ start: 1, pitchClasses: [0, 4, 7] }, { start: 5, pitchClasses: [10, 1, 5, 8] }]);
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
    assert.ok(found.velocity >= 20 && found.velocity <= 127);
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
