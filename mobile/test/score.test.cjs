const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// score.ts is pure, with type-only imports, so it runs as plain CommonJS.
function load() {
  const source = fs.readFileSync(path.join(__dirname, '../src/score.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(() => ({}), module, module.exports);
  return module.exports;
}
const score = load();

test('positionAt counts sixteenths between beats', () => {
  assert.equal(score.positionAt([0, 0.5, 1, 1.5], 0.75), 6);
  assert.equal(score.positionAt([0, 0.5, 1, 1.5], 0), 0);
  assert.equal(score.positionAt([1], 5), 0);
});

test('splitValues never crosses a bar line', () => {
  assert.deepEqual(score.splitValues(14, 6, 0, [16, 12, 8, 6, 4, 3, 2, 1]), [{ unit: 14, value: 2 }, { unit: 16, value: 4 }]);
  // A pickup bar shifts the bar lines.
  assert.deepEqual(score.splitValues(0, 8, 1, [16, 8, 4, 2, 1]), [{ unit: 0, value: 4 }, { unit: 4, value: 4 }]);
});

test('notePieces places middle C under the treble staff with a ledger line', () => {
  const [piece] = score.notePieces('other', { start: 0, end: 1, pitch: 60, unit: 0, length: 4 }, 0);
  assert.equal(piece.y, 96);
  assert.deepEqual(piece.ledgers, [96]);
  assert.equal(piece.hollow, false);
  assert.deepEqual(piece.stem, { x: 4.8, end: 70 });
  assert.deepEqual(piece.flags, []);
  assert.equal(piece.accidental, '');
});

test('notePieces ties a note across the bar', () => {
  const pieces = score.notePieces('other', { start: 0, end: 1, pitch: 61, unit: 12, length: 8 }, 0);
  assert.deepEqual(pieces.map(piece => piece.x), [12 * 16, 16 * 16]);
  assert.ok(pieces[0].tie && !pieces[1].tie);
  assert.equal(pieces[0].accidental, '♯');
  assert.equal(pieces[1].accidental, '');
});

test('scoreRests fill silences before and between notes', () => {
  const notes = [{ start: 0, end: 1, pitch: 60, unit: 4, length: 4 }, { start: 1, end: 2, pitch: 62, unit: 12, length: 4 }];
  assert.deepEqual(score.scoreRests(notes, 0), [{ x: 0, units: 4 }, { x: 128, units: 4 }]);
});

test('reachedIndex and lyricIndex find the last started item', () => {
  assert.equal(score.reachedIndex([0, 4, 8], 5), 1);
  assert.equal(score.reachedIndex([0, 4, 8], -1), -1);
  const words = [{ start: 1, end: 1.4, text: 'a' }, { start: 2, end: 2.5, text: 'b' }];
  assert.equal(score.lyricIndex(words, 0.5), -1);
  assert.equal(score.lyricIndex(words, 2.1), 1);
});

test('retimedWords keeps word timing or shares the line by length', () => {
  const words = [{ start: 1, end: 2, text: 'hello' }, { start: 2, end: 3, text: 'world' }];
  assert.deepEqual(score.retimedWords({ id: 0, start: 1, end: 3, text: 'Hello  there', words }),
    [{ start: 1, end: 2, text: 'Hello' }, { start: 2, end: 3, text: 'there' }]);
  assert.deepEqual(score.retimedWords({ id: 0, start: 0, end: 4, text: 'a b ccccc', words }),
    [{ start: 0, end: 0.57, text: 'a' }, { start: 0.57, end: 1.14, text: 'b' }, { start: 1.14, end: 4, text: 'ccccc' }]);
});

test('editedLines drops empty rows and keeps starts in order', () => {
  const lines = score.editedLines([
    { id: 0, start: 2, end: 4, text: 'one two' },
    { id: 1, start: 5, end: 6, text: '   ' },
    { id: 2, start: 1, end: 3, text: 'late' },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].words[0].start, 3);
  assert.ok(lines[1].words[0].end >= lines[1].words[0].start);
});

test('firstChange finds the earliest edited line', () => {
  const line = (start, text) => ({ start, end: start + 1, words: [{ start, end: start + 1, text }] });
  const before = [line(1, 'a'), line(5, 'b')];
  assert.equal(score.firstChange(before, [line(1, 'a'), line(5, 'b')]), null);
  assert.equal(score.firstChange(before, [line(1, 'a'), line(4, 'c')]), 4);
  assert.equal(score.firstChange(before, [line(1, 'a')]), 5);
});

test('gapAfter offers room for a new line only where there is time', () => {
  const rows = [{ id: 0, start: 2, end: 4, text: 'x' }, { id: 1, start: 4.1, end: 6, text: 'y' }];
  assert.deepEqual(score.gapAfter(rows, -1, 60), { start: 0, end: 2 });
  assert.equal(score.gapAfter(rows, 0, 60), null);
  assert.deepEqual(score.gapAfter(rows, 1, 60), { start: 6, end: 9 });
});

test('drumScore beams hands together and gives the kick its own voice', () => {
  const drawn = score.drumScore([{ unit: 0, drum: 'kick' }, { unit: 0, drum: 'hihat' }, { unit: 2, drum: 'hihat' }, { unit: 4, drum: 'cymbal' }], 0);
  assert.deepEqual(drawn.strokes.map(stroke => stroke.unit), [0, 2, 4]);
  assert.equal(drawn.strokes[0].stems.length, 2);
  assert.equal(drawn.strokes[2].ledger, true);
  assert.equal(drawn.beams.length, 1);
  assert.deepEqual({ ...drawn.beams[0], width: Math.round(drawn.beams[0].width) }, { x: 4.8, y: 30, width: 32 });
  // The hands play on beats one and two, so the rest of the bar is quarter rests.
  assert.deepEqual(drawn.rests, [{ x: 128, units: 4 }, { x: 192, units: 4 }]);
});

test('a key change moves chords, slash basses, notes and the key, spelled for the new key', () => {
  assert.equal(score.transposeKey('E', 3), 'G');
  assert.equal(score.transposeKey('C', 5), 'F');
  assert.equal(score.transposeKey('C', -2), 'Bb', 'Flat keys keep flats');
  assert.equal(score.transposeKey('Am', 1), 'Bbm');
  assert.equal(score.transposeKey('Am', 2), 'Bm');
  assert.equal(score.transposeKey('E', 2), 'F#', 'F sharp rather than G flat');
  assert.equal(score.transposeChord('Cmaj7/E', 2, false), 'Dmaj7/F#');
  assert.equal(score.transposeChord('G/B', -2, true), 'F/A');
  assert.equal(score.transposeChord('Ebm7', 1, false), 'Em7');
  const part = { key: 'C', chords: [{ start: 0, name: 'Am7' }], notes: [{ start: 0, end: 1, pitch: 60, unit: 0, length: 4 }],
    second: [{ start: 0, end: 1, pitch: 55, unit: 0, length: 4 }] };
  const moved = score.transposePart(part, -2);
  assert.equal(moved.key, 'Bb');
  assert.equal(moved.chords[0].name, 'Gm7');
  assert.equal(moved.notes[0].pitch, 58);
  assert.equal(moved.second[0].pitch, 53);
  assert.equal(score.transposePart(part, 0), part, 'No change keeps the same part');
  // The bass has no key of its own; it is spelled like the song.
  const bass = { chords: [{ start: 0, name: 'G' }, { start: 1, name: 'C#m' }], notes: [] };
  assert.deepEqual(score.transposePart(bass, 3, 'C').chords.map(chord => chord.name), ['Bb', 'Em']);
  assert.deepEqual(score.transposePart(bass, 3).chords.map(chord => chord.name), ['A#', 'Em']);
});

test('key signatures count their sharps or flats and sit where they are written on each clef', () => {
  assert.deepEqual(score.keySignature('G'), { flats: false, count: 1, known: true, altered: { 3: '♯' } });
  assert.equal(score.keySignature('Bb').count, 2);
  assert.equal(score.keySignature('Bb').flats, true);
  assert.equal(score.keySignature('F#m').count, 3);
  assert.equal(score.keySignature('Dm').flats, true);
  assert.equal(score.keySignature(undefined).known, false);
  // Treble: F♯ on the top line (y 56); bass: B♭ on the second line (y 80).
  assert.deepEqual(score.signatureMarks(score.keySignature('G'), 'treble', 30), [{ symbol: '♯', y: 56 }]);
  assert.equal(score.signatureMarks(score.keySignature('F'), 'bass', 18)[0].y, 80);
  assert.equal(score.signatureMarks(score.keySignature('C'), 'treble', 30).length, 0);
});

test('notes are spelled for the key: signature notes plain, naturals marked, black keys in the key\'s sharps or flats', () => {
  const sign = (pitch, key) => score.notePieces('other', { start: 0, end: 1, pitch, unit: 0, length: 4 }, 0, undefined, score.keySignature(key))[0];
  assert.equal(sign(66, 'G').accidental, '', 'F♯ is in G major');
  assert.equal(sign(65, 'G').accidental, '♮', 'F natural in G major');
  assert.equal(sign(70, 'F').accidental, '', 'B♭ is in F major');
  assert.equal(sign(63, 'F').accidental, '♭', 'E♭ in a flat key');
  assert.equal(sign(63, 'D').accidental, '♯', 'D♯ in a sharp key');
  assert.equal(sign(63, undefined).accidental, '♭', 'Unknown key keeps the mixed spelling');
  // D♯ and E♭ sound the same but sit on different lines.
  assert.notEqual(sign(63, 'D').y, sign(63, 'F').y);
  assert.equal(sign(72, 'C#').y, sign(71, 'C').y, 'B♯ in C♯ major sits where B does');
});

test('beamNotes joins eighths and sixteenths within a beat and drops their flags', () => {
  const note = (unit, pitch, length) => ({ start: 0, end: 0, unit, pitch, length });
  // Two eighths, then four sixteenths, then a quarter: two groups and one note left alone.
  const written = [note(0, 67, 2), note(2, 71, 2), note(4, 72, 1), note(5, 74, 1), note(6, 72, 1), note(7, 71, 1), note(8, 67, 4)]
    .map(item => score.notePieces('other', item, 0));
  const { notes, beams } = score.beamNotes(written);
  assert.ok(notes.slice(0, 6).every(([piece]) => piece.flags.length === 0), 'Beamed notes have no flags');
  assert.equal(notes[6][0].flags.length, 0, 'A quarter never had a flag');
  // One beam over the eighths; over the sixteenths a main beam and a second one.
  assert.equal(beams.length, 3);
  const [eighths, main, second] = beams;
  assert.equal(eighths.x1, notes[0][0].stem.x);
  assert.equal(eighths.x2, notes[1][0].stem.x);
  assert.ok(Math.abs((eighths.y2 - eighths.y1) / (eighths.x2 - eighths.x1)) <= 0.2, 'The beam tilts only a little');
  for (const [piece] of notes.slice(0, 2)) {
    const at = eighths.y1 + (eighths.y2 - eighths.y1) * (piece.stem.x - eighths.x1) / (eighths.x2 - eighths.x1);
    assert.ok(Math.abs(piece.stem.end - at) < 0.01, 'Every stem reaches the beam');
    assert.ok(Math.abs(piece.y - piece.stem.end) >= 20, 'Stems stay long enough');
  }
  assert.ok(Math.abs(Math.abs(second.y1 - main.y1) - 5) < 1e-9, 'The second beam sits 5 inside the first, toward the notes');
  assert.equal(second.x1, main.x1);
  assert.equal(second.x2, main.x2, 'One second beam spans the run of sixteenths');
  assert.deepEqual(written[0][0].flags.length, 1, 'The input is left as it was');
});

test('notes starting together are one chord: one stem past the nearest head, beamed as one note', () => {
  const note = (unit, pitch, length) => ({ start: 0, end: 0, unit, pitch, length });
  // A C major triad held a quarter, then two eighth-note chords of E-G in one beat.
  const written = [note(0, 60, 4), note(0, 64, 4), note(0, 67, 4), note(4, 64, 2), note(4, 67, 2), note(6, 64, 2), note(6, 67, 2)]
    .map(item => score.notePieces('other', item, 0));
  const { notes, beams } = score.beamNotes(written);
  const [c, e, g] = notes.slice(0, 3).map(([piece]) => piece);
  assert.ok(c.stem && !e.stem && !g.stem, 'One stem, on the lowest head when stems go up');
  assert.ok(c.stem.end < g.y - 20, 'It reaches past the top head');
  assert.equal(beams.length, 1, 'The two eighth chords share one beam');
  const stems = notes.slice(3).map(([piece]) => piece).filter(piece => piece.stem);
  assert.equal(stems.length, 2, 'One stem per chord');
  assert.ok(stems.every(piece => piece.flags.length === 0 && piece.y === Math.max(...notes.slice(3).map(([p]) => p.y))));
  assert.ok(stems.every(piece => Math.abs(piece.stem.end - beams[0].y1 - (piece.stem.x - beams[0].x1) * (beams[0].y2 - beams[0].y1) / (beams[0].x2 - beams[0].x1)) < 0.01));
});

test('beamNotes keeps a fixed stem side, and does not join across a beat or a rest', () => {
  const note = (unit, pitch, length) => ({ start: 0, end: 0, unit, pitch, length });
  const low = [note(2, 60, 2), note(4, 60, 2), note(8, 60, 2), note(12, 60, 2), note(14, 60, 2)].map(item => score.notePieces('other', item, 0, 'down'));
  const { notes, beams } = score.beamNotes(low, 'down');
  assert.equal(beams.length, 1, 'Only the last two share a beat back to back');
  assert.ok(notes[3][0].stem.end > notes[3][0].y, 'Stems go down');
  assert.equal(notes[0][0].flags.length, 1, 'A lone eighth keeps its flag');
});
