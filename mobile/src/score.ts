// Lyrics timing and staff layout, ported from the website (web/src/lyrics-strip.ts, lyrics-editor.ts and
// harmony-strip.ts) so both draw the same score. Pure functions only, so they can be unit-tested.
import type { DrumHit, DrumName, HarmonyNote, LyricLine, LyricWord } from './api';

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
// Letter name offset from C, and accidental, for each pitch class.
const SPELLING: [number, string][] = [
  [0, ''], [0, '♯'], [1, ''], [2, '♭'], [2, ''], [3, ''], [3, '♯'], [4, ''], [5, '♭'], [5, ''], [6, '♭'], [6, ''],
];
// Steps count letter names from C0; bottom is E4 or G2. Guitar and bass are written an octave above their sound.
export const CLEFS: Record<string, { clef: 'treble' | 'bass'; bottomStep: number; lift: number; low: number; high: number }> = {
  guitar: { clef: 'treble', bottomStep: 30, lift: 12, low: 52, high: 84 },
  piano: { clef: 'treble', bottomStep: 30, lift: 0, low: 52, high: 84 },
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

export interface NotePiece {
  x: number; y: number; hollow: boolean; stem?: { x: number; end: number };
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

export function notePieces(stem: string, note: HarmonyNote, firstBar: number): NotePiece[] {
  const { bottomStep, lift, low, high } = CLEFS[stem];
  let written = note.pitch + lift;
  while (written < low) written += 12;
  while (written > high) written -= 12;
  const [letter, accidental] = SPELLING[written % 12];
  const step = (Math.floor(written / 12) - 1) * 7 + letter;
  const yOf = (value: number) => BOTTOM_LINE_Y - (value - bottomStep) * LINE_GAP / 2;
  const y = yOf(step);
  const ledgers: number[] = [];
  for (let value = bottomStep - 2; value >= step; value -= 2) ledgers.push(yOf(value));
  for (let value = bottomStep + 10; value <= step; value += 2) ledgers.push(yOf(value));
  const up = y >= MIDDLE_LINE_Y;
  const parts = splitValues(note.unit, note.length, firstBar, NOTE_VALUES);
  return parts.map((part, index) => {
    const x = part.unit * UNIT_WIDTH;
    const stemX = x + (up ? HEAD_OFFSET : -HEAD_OFFSET);
    const end = y + (up ? -STEM_LENGTH : STEM_LENGTH);
    const count = part.value === 1 ? 2 : part.value === 2 || part.value === 3 ? 1 : 0;
    const flags = Array.from({ length: count }, (_, flag) => {
      const from = end + (up ? flag * 6 : -flag * 6);
      return `M${stemX} ${from} q7 ${up ? 6 : -6} 6 ${up ? 14 : -14}`;
    });
    const next = parts[index + 1];
    const bow = up ? 7 : -7;
    return {
      x, y, ledgers, flags,
      hollow: part.value >= 8,
      stem: part.value === 16 ? undefined : { x: stemX, end },
      dot: [3, 6, 12].includes(part.value) ? { x: x + 9, y: Math.round(y / LINE_GAP) * LINE_GAP === y ? y - 4 : y } : undefined,
      tie: next ? `M${x + 5} ${y + bow} Q${(x + next.unit * UNIT_WIDTH) / 2} ${y + bow * 2} ${next.unit * UNIT_WIDTH - 5} ${y + bow}` : undefined,
      accidental: index === 0 ? accidental : '',
    };
  });
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
