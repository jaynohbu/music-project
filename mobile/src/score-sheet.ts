// A printable score: the scrolling strip's marks laid out four bars to a line on A4 pages, as HTML for
// expo-print. The website has the same file (web/src/score-sheet.ts). Pure functions only, so they can be unit-tested.
import type { HarmonyGrid, HarmonyPart } from './api';
import {
  BEAM_HEIGHT, CLEFS, CYMBAL_LEDGER, MIDDLE_LINE_Y, STAFF_LINES, UNIT_WIDTH, UNITS_PER_BAR,
  beamNotes, drumScore, keySignature, notePieces, positionAt, scoreRests, signatureMarks, type NotePiece, type ScoreRest,
} from './score';

export const BARS_PER_LINE = 4;
const LINE_UNITS = BARS_PER_LINE * UNITS_PER_BAR;
const MARGIN = 48;
const CLEF_WIDTH = 44, MARK_WIDTH = 8, TIME_WIDTH = 22;
// The title block, then where the first page's lines start and every other page's.
const HEADER = 150, FIRST_TOP = 190, PAGE_TOP = 80, FOOTER = 50, LINE_GAP = 34;
const A4 = 297 / 210;
const INK = '#111', SECOND = '#666';

// `artist` is shown under the title on the right, as a composer is on printed music.
export interface SheetText { title: string; artist?: string; subtitle: string; page: (page: number, pages: number) => string }
export interface SheetPages { width: number; height: number; pages: string[] }

const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

function restMark(rest: ScoreRest) {
  const y = MIDDLE_LINE_Y, x = rest.x;
  if (rest.units === 16) return `<rect x="${x + 6}" y="${y - 8}" width="12" height="4" fill="${INK}"/>`;
  if (rest.units === 8) return `<rect x="${x + 6}" y="${y - 4}" width="12" height="4" fill="${INK}"/>`;
  const line = `fill="none" stroke="${INK}" stroke-width="1.7"`;
  if (rest.units === 4) return `<path d="M${x - 2} ${y - 11} l5 6 l-4 5 l5 6 c-4 -2 -6 0 -3 4" ${line}/>`;
  let mark = `<path d="M${x + 4} ${y - 6} l-4 ${rest.units === 1 ? 17 : 12}" ${line}/>`
    + `<path d="M${x - 3} ${y - 5} q4 2 7 -1" ${line}/><circle r="1.9" cx="${x - 3}" cy="${y - 5}" fill="${INK}"/>`;
  if (rest.units === 1) mark += `<path d="M${x - 4} ${y + 1} q4 2 7 -1" ${line}/><circle r="1.9" cx="${x - 4}" cy="${y + 1}" fill="${INK}"/>`;
  return mark;
}

function noteMark(piece: NotePiece, color: string) {
  const line = `fill="none" stroke="${color}" stroke-width="1.2"`;
  let mark = piece.ledgers.map(y => `<line x1="${piece.x - 8}" x2="${piece.x + 8}" y1="${y}" y2="${y}" ${line}/>`).join('');
  mark += `<ellipse rx="5.2" ry="3.8" cx="${piece.x}" cy="${piece.y}" transform="rotate(-20 ${piece.x} ${piece.y})" `
    + (piece.hollow ? `fill="none" stroke="${color}" stroke-width="1.5"/>` : `fill="${color}"/>`);
  if (piece.stem) mark += `<line x1="${piece.stem.x}" x2="${piece.stem.x}" y1="${piece.y}" y2="${piece.stem.end}" ${line}/>`;
  mark += piece.flags.map(flag => `<path d="${flag}" ${line}/>`).join('');
  if (piece.dot) mark += `<circle r="1.6" cx="${piece.dot.x}" cy="${piece.dot.y}" fill="${color}"/>`;
  if (piece.tie) mark += `<path d="${piece.tie}" ${line}/>`;
  if (piece.accidental) mark += `<text x="${piece.x - 7}" y="${piece.y + 4}" text-anchor="end" font-size="13" fill="${color}">${piece.accidental}</text>`;
  return mark;
}

type Stroke = ReturnType<typeof drumScore>['strokes'][number];
function strokeMark(stroke: Stroke) {
  const line = `fill="none" stroke="${INK}" stroke-width="1.2"`;
  let mark = stroke.ledger ? `<line x1="${stroke.x - 8}" x2="${stroke.x + 8}" y1="${CYMBAL_LEDGER}" y2="${CYMBAL_LEDGER}" ${line}/>` : '';
  for (const head of stroke.heads) {
    const { x } = stroke, { y } = head;
    mark += head.cross
      ? `<path d="M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x - 4} ${y + 4} L${x + 4} ${y - 4}" fill="none" stroke="${INK}" stroke-width="1.5"/>`
      : `<ellipse rx="5.2" ry="3.8" cx="${x}" cy="${y}" transform="rotate(-20 ${x} ${y})" fill="${INK}"/>`;
  }
  mark += stroke.stems.map(stem => `<line x1="${stem.x}" x2="${stem.x}" y1="${stem.from}" y2="${stem.to}" ${line}/>`).join('');
  mark += stroke.flags.map(flag => `<path d="${flag}" ${line}/>`).join('');
  mark += stroke.dots.map(dot => `<circle r="1.6" cx="${dot.x}" cy="${dot.y}" fill="${INK}"/>`).join('');
  return mark;
}

// The tempo from the median beat, rounded to a whole number.
export function tempo(beats: number[]): number | undefined {
  const gaps = beats.slice(1).map((beat, index) => beat - beats[index]).filter(gap => gap > 0).sort((a, b) => a - b);
  return gaps.length ? Math.round(60 / gaps[gaps.length >> 1]) : undefined;
}

// Lines start on bar lines; a pickup before the first bar gets a bar of its own.
export function lineStarts(firstBar: number, lastUnit: number): number[] {
  const barStart = firstBar * 4;
  const origin = barStart - Math.ceil(barStart / UNITS_PER_BAR) * UNITS_PER_BAR;
  const starts: number[] = [];
  for (let unit = origin; unit < Math.max(lastUnit, origin + 1); unit += LINE_UNITS) starts.push(unit);
  return starts;
}

// A mark over a bar (numbered from 1 at the grid's first bar): a label, and a level from 0 (red) to 1 (green) that
// tints the bar, or none.
// anchor: a bar the score was synced with the song on (the anchor of its laying): drawn on blue, with a blue band.
export interface BarMark { text: string; level?: number; anchor?: boolean }
const ANCHOR = '#2f6fdb';
export const levelColor = (level: number) => `hsl(${Math.round(Math.max(0, Math.min(1, level)) * 120)} 70% 42%)`;

// The lines of a part's score laid out (four bars each): where each starts, and each drawn as SVG at its own top.
function sheetLayout(part: HarmonyPart, stem: string, grid: HarmonyGrid, songKey?: string, barMarks?: Map<number, BarMark>) {
  const drums = stem === 'drums';
  const signature = keySignature(drums ? undefined : part.key ?? songKey);
  const voices = !drums && !!part.second?.length;
  const melody = beamNotes(drums ? [] : part.notes.map(note => notePieces(stem, note, grid.firstBar, voices ? 'up' : undefined, signature)),
    voices ? 'up' : undefined);
  const lower = beamNotes(voices ? part.second!.map(note => notePieces(stem, note, grid.firstBar, 'down', signature)) : [], 'down');
  const notes = melody.notes, second = lower.notes;
  const noteBeams = [...lower.beams.map(beam => ({ ...beam, color: SECOND })), ...melody.beams.map(beam => ({ ...beam, color: INK }))];
  const drawn = drumScore(part.hits ?? [], grid.firstBar);
  const rests = drums ? drawn.rests : scoreRests(part.notes, grid.firstBar);
  const chords = drums ? [] : part.chords.map(chord => ({ name: chord.name, unit: Math.round(positionAt(grid.beats, chord.start) / 2) * 2 }));
  const ends = [
    ...part.notes.map(note => note.unit + note.length), ...(part.second ?? []).map(note => note.unit + note.length),
    ...(part.hits ?? []).map(hit => hit.unit + 1), ...chords.map(chord => chord.unit + 1),
  ];
  const starts = lineStarts(grid.firstBar, ends.length ? Math.max(...ends) : 0);
  const lastUnit = starts[starts.length - 1] + LINE_UNITS;

  // Every line has the same height: from the chord names to the lowest mark anywhere in the song.
  let low = STAFF_LINES[4], high = STAFF_LINES[0];
  const reach = (...ys: number[]) => { for (const y of ys) { low = Math.min(low, y); high = Math.max(high, y); } };
  for (const piece of [...notes, ...second].flat()) {
    reach(piece.y - 5, piece.y + 5, ...piece.ledgers);
    if (piece.stem) reach(piece.stem.end);
  }
  for (const stroke of drawn.strokes) {
    reach(...stroke.heads.flatMap(head => [head.y - 5, head.y + 5]), ...stroke.stems.flatMap(item => [item.from, item.to]));
  }
  for (const beam of drawn.beams) reach(beam.y, beam.y + BEAM_HEIGHT);
  for (const beam of noteBeams) reach(beam.y1, beam.y2, beam.y1 + BEAM_HEIGHT, beam.y2 + BEAM_HEIGHT);
  const chordY = low - 8, markY = (chords.length ? chordY - 16 : low) - 6, top = (chords.length ? chordY - 16 : low) - 14 - (barMarks?.size ? 18 : 0);
  const lineHeight = high + 6 - top;

  const clef = CLEFS[stem]?.clef;
  const marks = clef && !drums ? signatureMarks(signature, clef, CLEFS[stem].bottomStep) : [];
  const head = CLEF_WIDTH + (marks.length ? marks.length * MARK_WIDTH + 4 : 0);
  const staffWidth = head + TIME_WIDTH + LINE_UNITS * UNIT_WIDTH + 4;
  const width = staffWidth + 2 * MARGIN, height = Math.round(width * A4);
  const fits = (from: number) => Math.max(1, Math.floor((height - FOOTER - from + LINE_GAP) / (lineHeight + LINE_GAP)));
  const perPage = fits(PAGE_TOP), firstPage = fits(FIRST_TOP);
  const pages: number[][] = [starts.slice(0, firstPage)];
  for (let index = firstPage; index < starts.length; index += perPage) pages.push(starts.slice(index, index + perPage));

  const inside = (x: number, start: number) => x >= start * UNIT_WIDTH - UNIT_WIDTH / 2 && x < (start + LINE_UNITS) * UNIT_WIDTH - UNIT_WIDTH / 2;
  const bar = (unit: number) => Math.floor((unit - grid.firstBar * 4) / UNITS_PER_BAR) + 1;
  const staffLine = (start: number, index: number) => {
    const shift = MARGIN + head + TIME_WIDTH + UNIT_WIDTH / 2 - start * UNIT_WIDTH;
    const left = MARGIN, right = MARGIN + staffWidth;
    const end = start + LINE_UNITS >= lastUnit;
    let svg = STAFF_LINES.map(y => `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${INK}" stroke-width="0.8"/>`).join('');
    svg += `<line x1="${left}" x2="${left}" y1="${STAFF_LINES[4]}" y2="${STAFF_LINES[0]}" stroke="${INK}" stroke-width="1"/>`;
    svg += drums
      ? `<rect x="${left + 12}" y="${STAFF_LINES[4] + 8}" width="3" height="16" fill="${INK}"/><rect x="${left + 19}" y="${STAFF_LINES[4] + 8}" width="3" height="16" fill="${INK}"/>`
      : clef === 'bass'
        ? `<text x="${left + 4}" y="${STAFF_LINES[4] + 27}" font-size="40" fill="${INK}">𝄢</text>`
        : `<text x="${left + 2}" y="${STAFF_LINES[4] + 38}" font-size="56" fill="${INK}">𝄞</text>`;
    svg += marks.map((mark, at) => `<text x="${left + CLEF_WIDTH - 8 + at * MARK_WIDTH + MARK_WIDTH / 2}" y="${mark.y + 5}" text-anchor="middle" font-size="15" fill="${INK}">${mark.symbol}</text>`).join('');
    if (index === 0) {
      const x = left + head + TIME_WIDTH / 2 - 2;
      svg += `<text x="${x}" y="${MIDDLE_LINE_Y - 2}" text-anchor="middle" font-size="17" font-weight="700" font-family="Georgia, serif" fill="${INK}">4</text>`
        + `<text x="${x}" y="${STAFF_LINES[0] - 1}" text-anchor="middle" font-size="17" font-weight="700" font-family="Georgia, serif" fill="${INK}">4</text>`;
    }
    svg += `<text x="${left}" y="${Math.min(chordY, STAFF_LINES[4] - 16)}" font-size="10" fill="${SECOND}">${Math.max(1, bar(start))}</text>`;
    // The marks, moved so this line's first bar meets the clef, and cut at the line's ends.
    svg += `<g clip-path="url(#line)"><g transform="translate(${shift} 0)">`;
    for (let unit = start; unit < start + LINE_UNITS && barMarks?.size; unit += UNITS_PER_BAR) {
      const mark = barMarks.get(bar(unit));
      if (!mark) continue;
      const x = unit * UNIT_WIDTH - UNIT_WIDTH / 2, color = mark.level === undefined ? SECOND : levelColor(mark.level);
      if (mark.anchor) {
        svg += `<rect x="${x}" y="${markY - 12}" width="${UNITS_PER_BAR * UNIT_WIDTH}" height="${high - markY + 12}" fill="${ANCHOR}" opacity="0.13"/>`
          + `<rect x="${x}" y="${markY - 16}" width="${UNITS_PER_BAR * UNIT_WIDTH}" height="3" fill="${ANCHOR}"/>`;
      } else if (mark.level !== undefined) svg += `<rect x="${x}" y="${markY - 12}" width="${UNITS_PER_BAR * UNIT_WIDTH}" height="${high - markY + 12}" fill="${color}" opacity="0.12"/>`;
      svg += `<text x="${x + 4}" y="${markY}" font-size="12" font-weight="700" fill="${color}">${escape(mark.text)}</text>`;
    }
    for (let unit = start + UNITS_PER_BAR; unit < start + LINE_UNITS; unit += UNITS_PER_BAR) {
      const x = unit * UNIT_WIDTH - UNIT_WIDTH / 2;
      svg += `<line x1="${x}" x2="${x}" y1="${STAFF_LINES[4]}" y2="${STAFF_LINES[0]}" stroke="${INK}" stroke-width="1"/>`;
    }
    svg += chords.filter(chord => inside(chord.unit * UNIT_WIDTH, start))
      .map(chord => `<text x="${chord.unit * UNIT_WIDTH}" y="${chordY}" text-anchor="middle" font-size="14" font-weight="700" fill="${INK}">${escape(chord.name)}</text>`).join('');
    // Each bar can be lit (class "on") while it plays, under everything else; each note and drum stroke is a group of
    // its own (data-i: its index in the part's notes, data-s: in its second line, data-u: a stroke's sixteenth).
    for (let unit = start; unit < start + LINE_UNITS; unit += UNITS_PER_BAR) {
      svg += `<rect class="bar-now" data-bar="${bar(unit)}" x="${unit * UNIT_WIDTH - UNIT_WIDTH / 2}" y="${top}" width="${UNITS_PER_BAR * UNIT_WIDTH}" height="${high - top}" fill="#ffd54a" opacity="0"/>`;
    }
    svg += rests.filter(rest => inside(rest.x, start)).map(restMark).join('');
    svg += drawn.beams.filter(beam => drums && inside(beam.x, start))
      .map(beam => `<rect x="${beam.x}" y="${beam.y}" width="${beam.width}" height="${BEAM_HEIGHT}" fill="${INK}"/>`).join('');
    if (drums) svg += drawn.strokes.filter(stroke => inside(stroke.x, start)).map(stroke => `<g class="note" data-u="${stroke.unit}">${strokeMark(stroke)}</g>`).join('');
    svg += noteBeams.filter(beam => inside(beam.x1, start)).map(beam =>
      `<path d="M${beam.x1} ${beam.y1} L${beam.x2} ${beam.y2} L${beam.x2} ${beam.y2 + BEAM_HEIGHT} L${beam.x1} ${beam.y1 + BEAM_HEIGHT} Z" fill="${beam.color}"/>`).join('');
    svg += second.map((pieces, index) => inside(pieces[0].x, start) ? `<g class="note" data-s="${index}">${pieces.map(piece => noteMark(piece, SECOND)).join('')}</g>` : '').join('');
    svg += notes.map((pieces, index) => inside(pieces[0].x, start) ? `<g class="note" data-i="${index}">${pieces.map(piece => noteMark(piece, INK)).join('')}</g>` : '').join('');
    svg += '</g></g>';
    svg += end
      ? `<line x1="${right - 5}" x2="${right - 5}" y1="${STAFF_LINES[4]}" y2="${STAFF_LINES[0]}" stroke="${INK}" stroke-width="1"/><rect x="${right - 3}" y="${STAFF_LINES[4]}" width="3" height="${STAFF_LINES[0] - STAFF_LINES[4]}" fill="${INK}"/>`
      : `<line x1="${right}" x2="${right}" y1="${STAFF_LINES[4]}" y2="${STAFF_LINES[0]}" stroke="${INK}" stroke-width="1"/>`;
    return svg;
  };

  // Only lines move up and down, so one clip serves every line: it hides marks that run past either end.
  const clip = `<clipPath id="line"><rect x="${MARGIN + head + TIME_WIDTH - 12}" y="-1000" width="${staffWidth - head - TIME_WIDTH + 12}" height="3000"/></clipPath>`;
  // Where a point on a line (in its own units) is: the bar under it.
  const barAt = (start: number, x: number) => bar(Math.floor((x - (MARGIN + head + TIME_WIDTH + UNIT_WIDTH / 2 - start * UNIT_WIDTH)) / UNIT_WIDTH + 0.5));
  return { starts, pages, width, height, top, lineHeight, clip, staffLine, barAt, bar };
}

// Each page as an SVG document, for previews and for the printed HTML.
// `part` is already moved to the key being heard; `songKey` is that key, for the bass part.
export function sheetPages(part: HarmonyPart, stem: string, grid: HarmonyGrid, text: SheetText, songKey?: string): SheetPages {
  const { pages, width, height, top, lineHeight, clip, staffLine } = sheetLayout(part, stem, grid, songKey);
  let lineIndex = 0;
  const sheet = pages.map((page, pageIndex) => {
    let y = pageIndex === 0 ? FIRST_TOP : PAGE_TOP;
    let svg = '';
    if (pageIndex === 0) {
      svg += `<text x="${width / 2}" y="${HEADER - 62}" text-anchor="middle" font-size="30" font-weight="700" fill="${INK}">${escape(text.title)}</text>`
        + `<text x="${width / 2}" y="${HEADER - 32}" text-anchor="middle" font-size="15" fill="${SECOND}">${escape(text.subtitle)}</text>`;
      if (text.artist) svg += `<text x="${width - MARGIN}" y="${HEADER - 2}" text-anchor="end" font-size="15" fill="${INK}">${escape(text.artist)}</text>`;
      const bpm = tempo(grid.beats);
      if (bpm) svg += `<text x="${MARGIN}" y="${HEADER + 22}" font-size="14" fill="${INK}">♩ = ${bpm}</text>`;
    }
    for (const start of page) {
      svg += `<g transform="translate(0 ${y - top})">${staffLine(start, lineIndex)}</g>`;
      y += lineHeight + LINE_GAP;
      lineIndex++;
    }
    svg += `<text x="${width / 2}" y="${height - FOOTER / 2}" text-anchor="middle" font-size="11" fill="${SECOND}">${escape(text.page(pageIndex + 1, pages.length))}</text>`;
    return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, Helvetica, Arial, sans-serif">`
      + `<rect width="${width}" height="${height}" fill="#fff"/><defs>${clip}</defs>${svg}</svg>`;
  });
  return { width, height, pages: sheet };
}

// The score as lines of four bars, each its own SVG (for a page that lays them out itself), with marks over bars;
// barAt tells the bar under a point of a line (x as a share of its width).
export interface SheetLine { svg: string; firstBar: number }
export function sheetLines(part: HarmonyPart, stem: string, grid: HarmonyGrid, songKey?: string, barMarks?: Map<number, BarMark>):
  { width: number; height: number; lines: SheetLine[]; barAt: (line: number, share: number) => number } {
  const { starts, width, top, lineHeight, clip, staffLine, barAt, bar } = sheetLayout(part, stem, grid, songKey, barMarks);
  const height = lineHeight + 8;
  const lines = starts.map((start, index) => ({
    firstBar: Math.max(1, bar(start)),
    svg: `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, Helvetica, Arial, sans-serif">`
      + `<rect width="${width}" height="${height}" fill="#fff"/><defs>${clip}</defs><g transform="translate(0 ${4 - top})">${staffLine(start, index)}</g></svg>`,
  }));
  return { width, height, lines, barAt: (line, share) => barAt(starts[line], share * width) };
}

// The pages as one HTML document: A4 sheets when printed, and spaced out on grey when shown on screen.
export function scoreSheet(part: HarmonyPart, stem: string, grid: HarmonyGrid, text: SheetText, songKey?: string): string {
  const { pages } = sheetPages(part, stem, grid, text, songKey);
  const name = text.artist ? `${text.title} - ${text.artist}` : text.title;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(name)}</title><style>`
    + '@page { size: A4; margin: 0 } html, body { margin: 0; padding: 0; background: #fff }'
    + ' .page { width: 210mm; height: 296.5mm; overflow: hidden; page-break-after: always; break-after: page }'
    + ' .page:last-child { page-break-after: auto; break-after: auto } .page svg { display: block; width: 100%; height: 100% }'
    + ' @media screen { body { background: #888; padding: 16px 0 } .page { width: min(210mm, calc(100vw - 32px)); height: auto;'
    + ' aspect-ratio: 210 / 296.5; margin: 0 auto 16px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4) } }'
    + `</style></head><body>${pages.map(page => `<section class="page">${page}</section>`).join('')}</body></html>`;
}

// A file name the share sheet and Files can keep: the title and part, without path characters.
export function sheetFileName(title: string, part: string): string {
  const name = `${title} - ${part}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${name || 'Score'}.pdf`;
}

