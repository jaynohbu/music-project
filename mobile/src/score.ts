// Lyrics timing and staff layout, ported from the website (web/src/lyrics-strip.ts, lyrics-editor.ts and
// harmony-strip.ts) so both draw the same score. Pure functions only, so they can be unit-tested.
import type { DrumHit, DrumName, HarmonyNote, HarmonyPart, LyricLine, LyricWord } from './api';

export const HELD_AFTER_WORD = 0.25;
export const LYRICS_REPLAY_LEAD = 1;
const NEW_LINE_SECONDS = 3;
const SHORTEST_NEW_LINE = 0.3;

export const UNIT_WIDTH = 16; // Pixels per sixteenth note.
export const UNITS_PER_BAR = 16;
export const LINE_GAP = 8;
export const BOTTOM_LINE_Y = 88;
export const MIDDLE_LINE_Y = BOTTOM_LINE_Y - 2 * LINE_GAP;
export const STAFF_LINES = [0, 1, 2, 3, 4].map(line => BOTTOM_LINE_Y - line * LINE_GAP);
const STEM_LENGTH = 26;
const HEAD_OFFSET = 4.8;
const NOTE_VALUES = [16, 12, 8, 6, 4, 3, 2, 1];
const REST_VALUES = [16, 8, 4, 2, 1];
// Key signatures: how many sharps or flats each key has. Letters count from C (C=0 … B=6).
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
const SHARP_KEYS: Record<string, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, Am: 0, Em: 1, Bm: 2, 'F#m': 3, 'C#m': 4, 'G#m': 5, 'D#m': 6, 'A#m': 7,
};
const FLAT_KEY_COUNTS: Record<string, number> = {
  F: 1, Bb: 2, Eb: 3, Ab: 4, Db: 5, Gb: 6, Cb: 7, Dm: 1, Gm: 2, Cm: 3, Fm: 4, Bbm: 5, Ebm: 6, Abm: 7,
};
// Staff steps (letters from C0) where each sharp or flat of the signature is written, in order.
const SIGNATURE_STEPS = {
  treble: { sharp: [38, 35, 39, 36, 33, 37, 34], flat: [34, 37, 33, 36, 32, 35, 31] },
  bass: { sharp: [24, 21, 25, 22, 19, 23, 20], flat: [20, 23, 19, 22, 18, 21, 17] },
};

// `known` is false when the song's key is not found yet; black keys then use the common mixed spelling.
export interface KeySignature { flats: boolean; count: number; altered: Record<number, string>; known: boolean }
// Letter and sign of each pitch class when the key is unknown: C♯ E♭ F♯ A♭ B♭.
const MIXED: [number, string][] = [
  [0, ''], [0, '♯'], [1, ''], [2, '♭'], [2, ''], [3, ''], [3, '♯'], [4, ''], [5, '♭'], [5, ''], [6, '♭'], [6, ''],
];

// The signature of a key such as 'G', 'Bb' or 'F#m'; an unknown key is written as C major.
export function keySignature(key?: string): KeySignature {
  const flats = !!key && key in FLAT_KEY_COUNTS;
  const count = !key ? 0 : flats ? FLAT_KEY_COUNTS[key] : SHARP_KEYS[key] ?? 0;
  const order = flats ? FLAT_ORDER : SHARP_ORDER;
  return { flats, count, known: !!key && (key in FLAT_KEY_COUNTS || key in SHARP_KEYS),
    altered: Object.fromEntries(order.slice(0, count).map(letter => [letter, flats ? '♭' : '♯'])) };
}

// Where the signature's sharps or flats sit on this clef's staff.
export function signatureMarks(signature: KeySignature, clef: 'treble' | 'bass', bottomStep: number) {
  const steps = SIGNATURE_STEPS[clef][signature.flats ? 'flat' : 'sharp'].slice(0, signature.count);
  return steps.map(step => ({ symbol: signature.flats ? '♭' : '♯', y: BOTTOM_LINE_Y - (step - bottomStep) * LINE_GAP / 2 }));
}

// Spells a pitch class in the key: a note in the signature needs no sign, a natural on an altered letter shows ♮,
// and other black keys follow the key's sharps or flats. Returns the letter, the sign shown, and an octave shift
// for B♯ and C♭, whose letter sits in the octave next to their pitch.
function spell(pitchClass: number, signature: KeySignature): [number, string, number] {
  if (!signature.known) return [...MIXED[pitchClass], 0];
  const options: [number, string][] = [];
  NATURAL.forEach((natural, letter) => {
    const difference = (pitchClass - natural + 12) % 12;
    const sign = difference === 0 ? '' : difference === 1 ? '♯' : difference === 11 ? '♭' : null;
    if (sign !== null) options.push([letter, sign]);
  });
  const octave = (letter: number) => (letter === 6 && pitchClass === 0 ? -1 : letter === 0 && pitchClass === 11 ? 1 : 0);
  const inKey = options.find(([letter, sign]) => (signature.altered[letter] ?? '') === sign);
  if (inKey) return [inKey[0], '', octave(inKey[0])];
  const natural = options.find(([, sign]) => sign === '');
  if (natural) return [natural[0], signature.altered[natural[0]] ? '♮' : '', 0];
  const chosen = options.find(([, sign]) => sign === (signature.flats ? '♭' : '♯')) ?? options[0];
  return [chosen[0], chosen[1], octave(chosen[0])];
}
// Steps count letter names from C0; bottom is E4 or G2. Bass is written an octave above its sound.
export const CLEFS: Record<string, { clef: 'treble' | 'bass'; bottomStep: number; lift: number; low: number; high: number }> = {
  other: { clef: 'treble', bottomStep: 30, lift: 0, low: 52, high: 84 },
  bass: { clef: 'bass', bottomStep: 18, lift: 12, low: 36, high: 64 },
};

// The last word started by this time, or -1 before the first.
export function lyricIndex(words: LyricWord[], time: number): number {
  return reachedIndex(words.map(word => word.start), time);
}

export interface LyricRow { id: number; start: number; end: number; text: string; words?: LyricWord[] }

export const lineText = (line: LyricLine): string => line.words.map(word => word.text).join(' ');

// Same word count keeps every word's timing; otherwise words share the line's span by length.
export function retimedWords(row: LyricRow): LyricWord[] {
  const texts = row.text.trim().split(/\s+/).filter(Boolean);
  if (row.words?.length === texts.length) return row.words.map((word, index) => ({ ...word, text: texts[index] }));
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  let at = row.start;
  return texts.map(text => {
    const start = at;
    at += (row.end - row.start) * text.length / total;
    return { start: Math.round(start * 100) / 100, end: Math.round(at * 100) / 100, text };
  });
}

// Empty rows are removed, and word starts never go backward, which playback relies on.
export function editedLines(rows: LyricRow[]): LyricLine[] {
  let latest = 0;
  const lines: LyricLine[] = [];
  for (const row of rows) {
    if (!row.text.trim()) continue;
    const words = retimedWords(row).map(word => {
      const start = Math.max(word.start, latest);
      latest = start;
      return { ...word, start, end: Math.max(word.end, start) };
    });
    lines.push({ start: words[0].start, end: Math.max(row.end, words[words.length - 1].end), words });
  }
  return lines;
}

// When the first difference begins, to replay from there; null when nothing changed.
export function firstChange(before: LyricLine[], after: LyricLine[]): number | null {
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    const old = before[index], now = after[index];
    if (!old || !now) return (now ?? old).start;
    if (lineText(old) !== lineText(now)) return Math.min(old.start, now.start);
  }
  return null;
}

// The free time after a row, for a new line there; null when there is too little.
export function gapAfter(rows: LyricRow[], index: number, duration: number): { start: number; end: number } | null {
  const next = rows[index + 1];
  const limit = next ? next.start : duration;
  const start = index >= 0 ? rows[index].end : Math.max(0, limit - NEW_LINE_SECONDS);
  const end = Math.min(limit, start + NEW_LINE_SECONDS);
  return end - start >= SHORTEST_NEW_LINE ? { start, end } : null;
}

// `unit` and `value` are the written note's start and length in sixteenths.
export interface NotePiece {
  unit: number; value: number; x: number; y: number; hollow: boolean; stem?: { x: number; end: number };
  flags: string[]; dot?: { x: number; y: number }; tie?: string; ledgers: number[]; accidental: string;
}
export interface ScoreRest { x: number; units: number }

// Song time to sixteenth-note position, between the detected beats.
export function positionAt(beats: number[], time: number): number {
  if (beats.length < 2) return 0;
  let low = 0, high = beats.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (beats[middle] <= time) low = middle; else high = middle - 1;
  }
  return (low + (time - beats[low]) / (beats[low + 1] - beats[low])) * 4;
}

// Splits a span into written values, never crossing a bar line.
export function splitValues(unit: number, length: number, firstBar: number, values: number[]): { unit: number; value: number }[] {
  const pieces: { unit: number; value: number }[] = [];
  const barStart = firstBar * 4;
  let at = unit, left = length;
  while (left > 0) {
    const room = UNITS_PER_BAR - (((at - barStart) % UNITS_PER_BAR + UNITS_PER_BAR) % UNITS_PER_BAR);
    const value = values.find(item => item <= Math.min(left, room))!;
    pieces.push({ unit: at, value });
    at += value;
    left -= value;
  }
  return pieces;
}

// `voice` fixes the stem direction when two lines share the staff: the melody up, the second line down.
export function notePieces(stem: string, note: HarmonyNote, firstBar: number, voice?: 'up' | 'down',
  signature: KeySignature = keySignature()): NotePiece[] {
  const { bottomStep, lift, low, high } = CLEFS[stem];
  let written = note.pitch + lift;
  while (written < low) written += 12;
  while (written > high) written -= 12;
  const [letter, accidental, octaveShift] = spell(written % 12, signature);
  const step = (Math.floor(written / 12) - 1 + octaveShift) * 7 + letter;
  const yOf = (value: number) => BOTTOM_LINE_Y - (value - bottomStep) * LINE_GAP / 2;
  const y = yOf(step);
  const ledgers: number[] = [];
  for (let value = bottomStep - 2; value >= step; value -= 2) ledgers.push(yOf(value));
  for (let value = bottomStep + 10; value <= step; value += 2) ledgers.push(yOf(value));
  const up = voice ? voice === 'up' : y >= MIDDLE_LINE_Y;
  const parts = splitValues(note.unit, note.length, firstBar, NOTE_VALUES);
  return parts.map((part, index) => {
    const x = part.unit * UNIT_WIDTH;
    const stemX = x + (up ? HEAD_OFFSET : -HEAD_OFFSET);
    const end = y + (up ? -STEM_LENGTH : STEM_LENGTH);
    const flags = flagPaths(stemX, end, part.value, up);
    const next = parts[index + 1];
    const bow = up ? 7 : -7;
    return {
      unit: part.unit, value: part.value, x, y, ledgers, flags,
      hollow: part.value >= 8,
      stem: part.value === 16 ? undefined : { x: stemX, end },
      dot: [3, 6, 12].includes(part.value) ? { x: x + 9, y: Math.round(y / LINE_GAP) * LINE_GAP === y ? y - 4 : y } : undefined,
      tie: next ? `M${x + 5} ${y + bow} Q${(x + next.unit * UNIT_WIDTH) / 2} ${y + bow * 2} ${next.unit * UNIT_WIDTH - 5} ${y + bow}` : undefined,
      accidental: index === 0 ? accidental : '',
    };
  });
}

// Printed music joins eighths and shorter that fall in the same beat with beams instead of flags.
export interface NoteBeam { x1: number; y1: number; x2: number; y2: number }
const BEAM_THICKNESS = 3, BEAM_SPACE = 5, BEAM_STUB = 6, MAX_SLANT = 0.2, SHORTEST_STEM = 20;
const flagPaths = (stemX: number, end: number, value: number, up: boolean) =>
  Array.from({ length: value === 1 ? 2 : value === 2 || value === 3 ? 1 : 0 }, (_, flag) =>
    `M${stemX} ${end + (up ? flag * 6 : -flag * 6)} q7 ${up ? 6 : -6} 6 ${up ? 14 : -14}`);
// Notes starting together with the same value are one chord: one stem, drawn from the head farthest from its
// end, reaching past the nearest; the other heads have none. A chord counts as one note below.
// Notes back to back within one beat are joined; a rest, a longer note or a new beat ends the group. Their stems
// all go one way (`voice` when two lines share the staff, else the side most of them sit on) and reach a beam
// that follows the line of the notes, tilted at most a little, with a second beam over sixteenths.
// The beams are returned by their top edge, BEAM_THICKNESS deep.
export function beamNotes(notes: NotePiece[][], voice?: 'up' | 'down'): { notes: NotePiece[][]; beams: NoteBeam[] } {
  const copies = notes.map(pieces => pieces.map(piece => ({ ...piece })));
  const together = new Map<string, NotePiece[]>();
  for (const piece of copies.flat()) {
    const key = `${piece.unit}:${piece.value}`;
    together.set(key, [...(together.get(key) ?? []), piece]);
  }
  const chords = [...together.values()].sort((a, b) => a[0].unit - b[0].unit);
  const middle = (heads: NotePiece[]) => heads.reduce((sum, head) => sum + head.y, 0) / heads.length;
  const near = (heads: NotePiece[], up: boolean) => up ? Math.min(...heads.map(head => head.y)) : Math.max(...heads.map(head => head.y));
  // The stem goes on the far head; the others lose theirs.
  const stemOn = (heads: NotePiece[], up: boolean, end: number) => {
    const far = heads.reduce((best, head) => (up ? head.y > best.y : head.y < best.y) ? head : best);
    for (const head of heads) { head.stem = undefined; head.flags = []; }
    if (far.value === 16) return far;
    const x = far.x + (up ? HEAD_OFFSET : -HEAD_OFFSET);
    far.stem = { x, end };
    far.flags = flagPaths(x, end, far.value, up);
    return far;
  };
  for (const heads of chords) {
    if (heads.length < 2) continue;
    const up = voice ? voice === 'up' : middle(heads) >= MIDDLE_LINE_Y;
    stemOn(heads, up, near(heads, up) + (up ? -STEM_LENGTH : STEM_LENGTH));
  }
  const beams: NoteBeam[] = [];
  const groups: NotePiece[][][] = [];
  for (const heads of chords) {
    const piece = heads[0];
    const group = groups[groups.length - 1], last = group?.[group.length - 1][0];
    const joins = piece.value < 4 && last && last.value < 4 && last.unit + last.value === piece.unit
      && Math.floor(last.unit / 4) === Math.floor(piece.unit / 4);
    if (joins) group.push(heads); else groups.push([heads]);
  }
  for (const group of groups) {
    if (group.length < 2) continue;
    const up = voice ? voice === 'up' : group.filter(heads => middle(heads) >= MIDDLE_LINE_Y).length * 2 >= group.length;
    const side = up ? -1 : 1;
    const stemX = (heads: NotePiece[]) => heads[0].x + (up ? HEAD_OFFSET : -HEAD_OFFSET);
    const first = group[0], last = group[group.length - 1];
    const x1 = stemX(first), x2 = stemX(last);
    const slope = Math.max(-MAX_SLANT, Math.min(MAX_SLANT, (near(last, up) - near(first, up)) / Math.max(x2 - x1, 1)));
    // Through the first stem's end, then moved away from the notes until every stem is long enough.
    const shortest = SHORTEST_STEM + (group.some(heads => heads[0].value === 1) ? BEAM_SPACE : 0);
    let start = near(first, up) + side * STEM_LENGTH;
    for (const heads of group) {
      const at = start + slope * (stemX(heads) - x1), limit = near(heads, up) + side * shortest;
      if (up ? at > limit : at < limit) start += limit - at;
    }
    const lineAt = (x: number) => start + slope * (x - x1);
    const edge = (y: number, inner: number) => y - (up ? 0 : BEAM_THICKNESS) - side * inner;
    beams.push({ x1, y1: edge(lineAt(x1), 0), x2, y2: edge(lineAt(x2), 0) });
    group.forEach((heads, index) => {
      stemOn(heads, up, lineAt(stemX(heads))).flags = [];
      // The second beam spans each run of sixteenths; a lone one gets a stub toward its neighbour.
      const value = (at: number) => group[at]?.[0].value;
      if (value(index) !== 1 || value(index - 1) === 1) return;
      let end = index;
      while (value(end + 1) === 1) end++;
      const from = end > index ? stemX(heads) : index < group.length - 1 ? stemX(heads) : stemX(heads) - BEAM_STUB;
      const to = end > index ? stemX(group[end]) : from + BEAM_STUB;
      beams.push({ x1: from, y1: edge(lineAt(from), BEAM_SPACE), x2: to, y2: edge(lineAt(to), BEAM_SPACE) });
    });
  }
  return { notes: copies, beams };
}

// Rests fill the silence before and between notes.
export function scoreRests(notes: HarmonyNote[], firstBar: number): ScoreRest[] {
  const rests: ScoreRest[] = [];
  let at = 0;
  for (const note of notes) {
    if (note.unit > at) {
      for (const part of splitValues(at, note.unit - at, firstBar, REST_VALUES)) {
        rests.push({ x: part.unit * UNIT_WIDTH, units: part.value });
      }
    }
    at = Math.max(at, note.unit + note.length);
  }
  return rests;
}

// The last item whose position has been reached, or -1 before the first.
export function reachedIndex(positions: number[], position: number): number {
  let low = 0, high = positions.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (positions[middle] <= position) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

// Standard drum notation: kick in the bottom space, snare in the third, tom in the fourth, crossed cymbals on top.
const DRUM_PLACES: Record<DrumName, { y: number; cross?: boolean }> = {
  kick: { y: 84 }, snare: { y: 68 }, tom: { y: 60 }, hihat: { y: 52, cross: true }, cymbal: { y: 48, cross: true },
};
export const CYMBAL_LEDGER = 48;
const BEAM_UP = 30;
const BEAM_DOWN = 116;
export const BEAM_HEIGHT = 3;
const BEAM_GAP = 5;
const STUB = 6;

export interface DrumStroke {
  unit: number; x: number; length: number;
  heads: { y: number; cross: boolean }[];
  ledger: boolean;
  stems: { x: number; from: number; to: number }[];
  flags: string[];
  dots: { x: number; y: number }[];
}
export interface DrumScore { strokes: DrumStroke[]; beams: { x: number; y: number; width: number }[]; rests: ScoreRest[] }

// Hands and feet are separate voices, stems up and down. Notes last until the next in their voice or the
// end of the beat, and those sharing a beat are beamed. Rests show only where the hands are silent.
export function drumScore(hits: DrumHit[], firstBar: number): DrumScore {
  const strokes = new Map<number, DrumStroke>();
  const stroke = (unit: number) => {
    let found = strokes.get(unit);
    if (!found) strokes.set(unit, found = { unit, x: unit * UNIT_WIDTH, length: 1, heads: [], ledger: false, stems: [], flags: [], dots: [] });
    return found;
  };
  const beams: DrumScore['beams'] = [];
  for (const hit of hits) {
    const { y, cross } = DRUM_PLACES[hit.drum];
    const target = stroke(hit.unit);
    target.heads.push({ y, cross: !!cross });
    target.ledger ||= y === CYMBAL_LEDGER;
  }
  const drawVoice = (voice: DrumHit[], up: boolean) => {
    const beats = new Map<number, number[]>();
    for (const unit of new Set(voice.map(hit => hit.unit))) {
      const beat = Math.floor(unit / 4);
      beats.set(beat, [...(beats.get(beat) ?? []), unit]);
    }
    const beamY = up ? BEAM_UP : BEAM_DOWN;
    const stemX = (unit: number) => unit * UNIT_WIDTH + (up ? HEAD_OFFSET : -HEAD_OFFSET);
    for (const [beat, units] of beats) {
      const values = units.map((unit, index) => (units[index + 1] ?? (beat + 1) * 4) - unit);
      units.forEach((unit, index) => {
        const target = stroke(unit);
        const ys = voice.filter(hit => hit.unit === unit).map(hit => DRUM_PLACES[hit.drum].y);
        target.stems.push({ x: stemX(unit), from: up ? Math.max(...ys) : Math.min(...ys), to: beamY });
        if (values[index] === 3) target.dots.push({ x: target.x + 9, y: Math.max(...ys) });
        if (units.length === 1) {
          const count = values[index] === 1 ? 2 : values[index] < 4 ? 1 : 0;
          for (let flag = 0; flag < count; flag++) {
            const from = beamY + (up ? flag : -flag) * 6;
            target.flags.push(`M${stemX(unit)} ${from} q7 ${up ? 6 : -6} 6 ${up ? 14 : -14}`);
          }
        }
      });
      if (units.length < 2) continue;
      const top = up ? beamY : beamY - BEAM_HEIGHT;
      beams.push({ x: stemX(units[0]), y: top, width: stemX(units[units.length - 1]) - stemX(units[0]) });
      const inner = top + (up ? BEAM_GAP : -BEAM_GAP);
      units.forEach((unit, index) => {
        if (values[index] !== 1) return;
        const next = index + 1 < units.length && values[index + 1] === 1;
        if (next) beams.push({ x: stemX(unit), y: inner, width: stemX(units[index + 1]) - stemX(unit) });
        else if (!(index && values[index - 1] === 1)) {
          const left = index === units.length - 1;
          beams.push({ x: left ? stemX(unit) - STUB : stemX(unit), y: inner, width: STUB });
        }
      });
    }
  };
  drawVoice(hits.filter(hit => hit.drum !== 'kick'), true);
  drawVoice(hits.filter(hit => hit.drum === 'kick'), false);
  const list = [...strokes.values()].sort((a, b) => a.unit - b.unit);
  list.forEach((item, index) => { item.length = Math.min((list[index + 1]?.unit ?? item.unit + 4) - item.unit, 4); });
  return { strokes: list, beams, rests: drumRests(hits, firstBar) };
}

export function drumRests(hits: DrumHit[], firstBar: number): ScoreRest[] {
  if (!hits.length) return [];
  const barStart = firstBar * 4;
  const barOf = (unit: number) => Math.floor((unit - barStart) / UNITS_PER_BAR);
  const heardBars = new Set(hits.map(hit => barOf(hit.unit)));
  const hands = hits.filter(hit => hit.drum !== 'kick');
  const beats = new Map<number, number>();
  for (const { unit } of hands) {
    const beat = Math.floor(unit / 4);
    beats.set(beat, Math.min(beats.get(beat) ?? 4, unit - beat * 4));
  }
  const rests: ScoreRest[] = [];
  const last = Math.max(...hits.map(hit => hit.unit));
  for (let bar = Math.min(0, barOf(0)); bar <= barOf(last); bar++) {
    const start = barStart + bar * UNITS_PER_BAR;
    if (!heardBars.has(bar)) {
      if (start >= 0) rests.push({ x: start * UNIT_WIDTH, units: UNITS_PER_BAR });
      continue;
    }
    for (let unit = start; unit < start + UNITS_PER_BAR; unit += 4) {
      if (unit < 0) continue;
      const first = beats.get(unit / 4) ?? 4;
      for (const part of splitValues(unit, first, firstBar, REST_VALUES)) rests.push({ x: part.unit * UNIT_WIDTH, units: part.value });
    }
  }
  return rests;
}

// Key change: chord names, notes and the key move by semitones, spelled with flats in flat keys.
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// F♯ is written with sharps rather than G♭, as guitar music usually is.
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);
const NOTE_INDEX: Record<string, number> = Object.fromEntries([
  ...SHARP_NAMES.map((name, index) => [name, index]), ...FLAT_NAMES.map((name, index) => [name, index]),
]);
const rootOf = (name: string) => (name[1] === '#' || name[1] === 'b' ? name.slice(0, 2) : name.slice(0, 1));

function moveNote(note: string, semitones: number, flats: boolean) {
  const index = NOTE_INDEX[note];
  if (index === undefined) return note;
  return (flats ? FLAT_NAMES : SHARP_NAMES)[((index + semitones) % 12 + 12) % 12];
}

export function transposeKey(key: string, semitones: number) {
  const root = rootOf(key);
  const moved = moveNote(root, semitones, false) + key.slice(root.length);
  // Spell the new key the way it is usually written (Bb, not A#).
  const flat = moveNote(root, semitones, true) + key.slice(root.length);
  return FLAT_KEYS.has(flat) ? flat : moved;
}

export function transposeChord(name: string, semitones: number, flats: boolean) {
  const [chord, bass] = name.split('/');
  const root = rootOf(chord);
  const moved = moveNote(root, semitones, flats) + chord.slice(root.length);
  return bass ? `${moved}/${moveNote(bass, semitones, flats)}` : moved;
}

// `songKey` (before the change) spells parts without a key of their own, such as the bass, like the song.
export function transposePart(part: HarmonyPart, semitones: number, songKey?: string): HarmonyPart {
  if (!semitones) return part;
  const key = part.key ? transposeKey(part.key, semitones) : undefined;
  const heard = key ?? (songKey ? transposeKey(songKey, semitones) : undefined);
  const flats = heard ? FLAT_KEYS.has(heard) : semitones < 0;
  const move = (notes: HarmonyNote[]) => notes.map(note => ({ ...note, pitch: note.pitch + semitones }));
  return {
    ...part, key,
    chords: part.chords.map(chord => ({ ...chord, name: transposeChord(chord.name, semitones, flats) })),
    notes: move(part.notes), second: part.second && move(part.second),
  };
}
