const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Both files are pure, with type-only imports apart from score-sheet's use of score.
function load(name, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, `../src/${name}.ts`), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(request => modules[request] ?? {}, module, module.exports);
  return module.exports;
}
const sheet = load('score-sheet', { './score': load('score') });
const text = { title: 'Song <1>', artist: 'The Band', subtitle: 'Other · Key G', page: (page, pages) => `${page} / ${pages}` };
// Four beats a second from time 0, with the first bar starting on the first beat.
const grid = { beats: Array.from({ length: 200 }, (_, beat) => beat * 0.5), firstBar: 0 };
const note = (unit, pitch, length = 4) => ({ start: 0, end: 0, unit, pitch, length });

test('tempo is the median beat', () => {
  assert.equal(sheet.tempo([0, 0.5, 1, 1.5, 3]), 120);
  assert.equal(sheet.tempo([0]), undefined);
});

test('lines start on bar lines, with a pickup bar of its own', () => {
  assert.deepEqual(sheet.lineStarts(0, 130), [0, 64, 128]);
  // Bar one starts on the second beat: the beat before it gets an empty first bar.
  assert.deepEqual(sheet.lineStarts(1, 70), [-12, 52]);
  assert.deepEqual(sheet.lineStarts(0, 0), [0]);
});

test('scoreSheet writes A4 pages with the title, notes and chords, escaped', () => {
  const part = { key: 'G', chords: [{ start: 0, name: 'G' }, { start: 8, name: 'C/E' }], notes: [note(0, 67), note(4, 66), note(68, 72, 8)] };
  const html = sheet.scoreSheet(part, 'other', grid, text);
  assert.match(html, /Song &lt;1&gt;/);
  assert.match(html, /<title>Song &lt;1&gt; - The Band<\/title>/);
  assert.match(html, /text-anchor="end" font-size="15" fill="#111">The Band</);
  assert.equal((html.match(/class="page"/g) ?? []).length, 1);
  assert.match(html, />C\/E</);
  assert.match(html, />1 \/ 1</);
  // Two lines, each with its clef and G major's one sharp; F♯ needs no sign of its own.
  assert.equal((html.match(/>𝄞</g) ?? []).length, 2);
  assert.equal((html.match(/>♯</g) ?? []).length, 2);
  // The time signature only on the first line.
  assert.equal((html.match(/>4</g) ?? []).length, 2);
});

test('long scores run onto more pages', () => {
  const notes = Array.from({ length: 400 }, (_, index) => note(index * 4, 60 + (index % 12)));
  const html = sheet.scoreSheet({ chords: [], notes }, 'other', { ...grid, beats: grid.beats.concat(grid.beats.map(b => b + 100)) }, text);
  assert.ok((html.match(/class="page"/g) ?? []).length > 1);
  assert.match(html, />2 \/ \d+</);
});

test('sheetPages gives each page as its own SVG', () => {
  const { pages, width, height } = sheet.sheetPages({ chords: [], notes: [note(0, 60)] }, 'other', grid, { ...text, artist: undefined });
  assert.equal(pages.length, 1);
  assert.match(pages[0], /^<svg viewBox="0 0 \d+ \d+"/);
  assert.ok(Math.abs(height / width - 297 / 210) < 0.01);
  assert.doesNotMatch(pages[0], /The Band/);
});

test('drums are written without a clef or chords', () => {
  const html = sheet.scoreSheet({ chords: [], notes: [], hits: [{ unit: 0, drum: 'kick' }, { unit: 2, drum: 'hihat' }] }, 'drums', grid, text);
  assert.doesNotMatch(html, /𝄞|𝄢/);
  assert.match(html, /<rect x="\d+" y="\d+" width="3" height="16"/);
});

test('sheetFileName keeps the title and drops path characters', () => {
  assert.equal(sheet.sheetFileName('AC/DC: Back?', 'Bass'), 'AC DC Back - Bass.pdf');
  assert.equal(sheet.sheetFileName('가질수 없는 너', '베이스'), '가질수 없는 너 - 베이스.pdf');
});

// SHEET_SAMPLE=<harmony.json> writes a sheet next to it, to look at.
if (process.env.SHEET_SAMPLE) {
  const result = JSON.parse(fs.readFileSync(process.env.SHEET_SAMPLE, 'utf8'));
  const parts = { other: result.ensemble, ...result.stems };
  for (const stem of ['other', 'bass', 'drums']) {
    if (!parts[stem]) continue;
    const html = sheet.scoreSheet(parts[stem], stem, result, { title: 'Enter Sandman', artist: 'Metallica', subtitle: stem, page: (page, pages) => `${page} / ${pages}` }, result.ensemble?.key);
    fs.writeFileSync(path.join(path.dirname(process.env.SHEET_SAMPLE), `${stem}.html`), html);
  }
}
