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
  const [piece] = score.notePieces('piano', { start: 0, end: 1, pitch: 60, unit: 0, length: 4 }, 0);
  assert.equal(piece.y, 96);
  assert.deepEqual(piece.ledgers, [96]);
  assert.equal(piece.hollow, false);
  assert.deepEqual(piece.stem, { x: 4.8, end: 70 });
  assert.deepEqual(piece.flags, []);
  assert.equal(piece.accidental, '');
});

test('notePieces ties a note across the bar and writes guitar an octave up', () => {
  const pieces = score.notePieces('guitar', { start: 0, end: 1, pitch: 49, unit: 12, length: 8 }, 0);
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
