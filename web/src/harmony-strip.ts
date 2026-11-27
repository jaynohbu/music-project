import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, input, viewChild,
} from '@angular/core';
import { DrumHit, DrumName, HarmonyGrid, HarmonyNote, HarmonyPart } from './services';

export const UNIT_WIDTH = 16; // Pixels per sixteenth note.
export const UNITS_PER_BAR = 16;
export const LINE_GAP = 8;
export const BOTTOM_LINE_Y = 88;
export const MIDDLE_LINE_Y = BOTTOM_LINE_Y - 2 * LINE_GAP;
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

// `unit` and `value` are the written note's start and length in sixteenths.
export interface NotePiece {
  unit: number; value: number; x: number; y: number; hollow: boolean; stem?: { x: number; end: number };
  flags: string[]; dot?: { x: number; y: number }; tie?: string; ledgers: number[]; accidental: string;
  // Filled in by the vote among repeated passages: drawn lighter.
  voted?: boolean;
}
export interface ScoreRest { x: number; units: number }

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
      accidental: index === 0 ? accidental : '', voted: note.voted,
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

function drumRests(hits: DrumHit[], firstBar: number): ScoreRest[] {
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

@Component({
  selector: 'app-harmony-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="harmony-strip" [class.chords-only]="!written()" [style.height.px]="frame().height" #strip role="img" [attr.aria-label]="label()">
      @if (written()) {
        <svg class="staff-lines" aria-hidden="true">
          @for (y of staffLines; track y) { <line x1="0" x2="100%" [attr.y1]="y - frame().top" [attr.y2]="y - frame().top"></line> }
        </svg>
      }
      <div class="harmony-window" [style.left.px]="start()">
        <svg class="harmony-flow" #flow aria-hidden="true" [attr.width]="width()" [attr.height]="frame().height"
          [style.margin-left.px]="-start()">
          <g [attr.transform]="'translate(0 ' + -frame().top + ')'">
          @for (x of barLines(); track x) {
            <line class="score-bar" [attr.x1]="x" [attr.x2]="x" [attr.y1]="staffLines[4]" [attr.y2]="staffLines[0]"></line>
          }
          @for (chord of chords(); track $index) {
            <text class="score-chord" text-anchor="middle" [attr.y]="frame().chordY" [attr.x]="chord.x">{{ chord.name }}</text>
          }
          @for (rest of rests(); track $index) {
            <g class="score-rest">
              @switch (rest.units) {
                @case (16) { <rect [attr.x]="rest.x + 6" [attr.y]="middleLineY - 8" width="12" height="4"></rect> }
                @case (8) { <rect [attr.x]="rest.x + 6" [attr.y]="middleLineY - 4" width="12" height="4"></rect> }
                @case (4) {
                  <path [attr.d]="'M' + (rest.x - 2) + ' ' + (middleLineY - 11) + ' l5 6 l-4 5 l5 6 c-4 -2 -6 0 -3 4'"></path>
                }
                @default {
                  <path [attr.d]="'M' + (rest.x + 4) + ' ' + (middleLineY - 6) + ' l-4 ' + (rest.units === 1 ? 17 : 12)"></path>
                  <path [attr.d]="'M' + (rest.x - 3) + ' ' + (middleLineY - 5) + ' q4 2 7 -1'"></path>
                  <circle r="1.9" [attr.cx]="rest.x - 3" [attr.cy]="middleLineY - 5"></circle>
                  @if (rest.units === 1) {
                    <path [attr.d]="'M' + (rest.x - 4) + ' ' + (middleLineY + 1) + ' q4 2 7 -1'"></path>
                    <circle r="1.9" [attr.cx]="rest.x - 4" [attr.cy]="middleLineY + 1"></circle>
                  }
                }
              }
            </g>
          }
          @for (beam of drums().beams; track $index) {
            <rect class="score-beam" [attr.x]="beam.x" [attr.y]="beam.y" [attr.width]="beam.width" height="3"></rect>
          }
          @for (item of drums().strokes; track item.unit) {
            <g class="score-note">
              @if (item.ledger) { <line [attr.x1]="item.x - 8" [attr.x2]="item.x + 8" y1="48" y2="48"></line> }
              @for (head of item.heads; track head.y) {
                @if (head.cross) {
                  <path class="score-cross" [attr.d]="crossPath(item.x, head.y)"></path>
                } @else {
                  <ellipse rx="5.2" ry="3.8" [attr.cx]="item.x" [attr.cy]="head.y"
                    [attr.transform]="'rotate(-20 ' + item.x + ' ' + head.y + ')'"></ellipse>
                }
              }
              @for (stem of item.stems; track $index) {
                <line [attr.x1]="stem.x" [attr.x2]="stem.x" [attr.y1]="stem.from" [attr.y2]="stem.to"></line>
              }
              @for (flag of item.flags; track $index) { <path [attr.d]="flag"></path> }
              @for (dot of item.dots; track $index) { <circle r="1.6" [attr.cx]="dot.x" [attr.cy]="dot.y"></circle> }
            </g>
          }
          @for (beam of noteBeams(); track $index) {
            <path class="score-beam" [class.second]="beam.second" [attr.d]="beam.d"></path>
          }
          @for (pieces of second(); track $index) {
            <g class="score-note second">
              @for (piece of pieces; track $index) {
                @for (y of piece.ledgers; track y) {
                  <line [attr.x1]="piece.x - 8" [attr.x2]="piece.x + 8" [attr.y1]="y" [attr.y2]="y"></line>
                }
                <ellipse rx="5.2" ry="3.8" [class.hollow]="piece.hollow" [attr.cx]="piece.x" [attr.cy]="piece.y"
                  [attr.transform]="'rotate(-20 ' + piece.x + ' ' + piece.y + ')'"></ellipse>
                @if (piece.stem; as stem) { <line [attr.x1]="stem.x" [attr.x2]="stem.x" [attr.y1]="piece.y" [attr.y2]="stem.end"></line> }
                @for (flag of piece.flags; track $index) { <path [attr.d]="flag"></path> }
                @if (piece.dot; as dot) { <circle r="1.6" [attr.cx]="dot.x" [attr.cy]="dot.y"></circle> }
                @if (piece.tie; as tie) { <path [attr.d]="tie"></path> }
                @if (piece.accidental) { <text text-anchor="end" [attr.x]="piece.x - 7" [attr.y]="piece.y + 4">{{ piece.accidental }}</text> }
              }
            </g>
          }
          @for (pieces of notes(); track $index) {
            <g class="score-note">
              @for (piece of pieces; track $index) {
                @for (y of piece.ledgers; track y) {
                  <line [attr.x1]="piece.x - 8" [attr.x2]="piece.x + 8" [attr.y1]="y" [attr.y2]="y"></line>
                }
                <ellipse rx="5.2" ry="3.8" [class.hollow]="piece.hollow" [class.voted]="piece.voted" [attr.cx]="piece.x" [attr.cy]="piece.y"
                  [attr.transform]="'rotate(-20 ' + piece.x + ' ' + piece.y + ')'"></ellipse>
                @if (piece.stem; as stem) { <line [attr.x1]="stem.x" [attr.x2]="stem.x" [attr.y1]="piece.y" [attr.y2]="stem.end"></line> }
                @for (flag of piece.flags; track $index) { <path [attr.d]="flag"></path> }
                @if (piece.dot; as dot) { <circle r="1.6" [attr.cx]="dot.x" [attr.cy]="dot.y"></circle> }
                @if (piece.tie; as tie) { <path [attr.d]="tie"></path> }
                @if (piece.accidental) { <text text-anchor="end" [attr.x]="piece.x - 7" [attr.y]="piece.y + 4">{{ piece.accidental }}</text> }
              }
            </g>
          }
          </g>
        </svg>
      </div>
      @if (isDrums()) {
        <span class="drum-clef" [style.top.px]="staffLines[4] - frame().top + 8" aria-hidden="true"></span>
      } @else if (written()) {
        <span class="staff-clef" [class]="'staff-clef ' + clef()" [style.top.px]="staffLines[4] - frame().top - (clef() === 'bass' ? 16 : 10)"
          aria-hidden="true">{{ clef() === 'bass' ? '𝄢' : '𝄞' }}</span>
        @for (mark of marks(); track $index) {
          <span class="key-mark" aria-hidden="true" [style.left.px]="36 + $index * 8" [style.top.px]="mark.y - frame().top - 11">{{ mark.symbol }}</span>
        }
      }
      <span class="staff-now" aria-hidden="true"></span>
    </div>
  `,
})
export class HarmonyStrip {
  readonly part = input.required<HarmonyPart>();
  readonly stem = input.required<string>();
  readonly grid = input.required<HarmonyGrid>();
  readonly time = input.required<number>();
  // The song's key after any key change, for the bass part, which has no key of its own.
  readonly songKey = input<string>();
  readonly signature = computed(() => keySignature(this.isDrums() ? undefined : this.part().key ?? this.songKey()));
  // The key signature sits after the clef and pushes the moving score right by its width, as in the app.
  readonly marks = computed(() => {
    const clef = this.clef();
    return clef && this.written() && !this.isDrums() ? signatureMarks(this.signature(), clef, CLEFS[this.stem()].bottomStep) : [];
  });
  readonly start = computed(() => 44 + (this.marks().length ? this.marks().length * 8 + 4 : 0));
  readonly middleLineY = MIDDLE_LINE_Y;
  readonly staffLines = [0, 1, 2, 3, 4].map(line => BOTTOM_LINE_Y - line * LINE_GAP);
  // The strip shows only rows the song uses: from just above its chord names to just below its lowest mark,
  // as in the app (mobile/src/score-view.tsx).
  readonly frame = computed(() => {
    if (!this.written()) return { top: 0, height: 30, chordY: 18 };
    let low = this.staffLines[4], high = this.staffLines[0];
    const reach = (...ys: number[]) => { for (const y of ys) { low = Math.min(low, y); high = Math.max(high, y); } };
    for (const piece of [...this.notes(), ...this.second()].flat()) {
      reach(piece.y - 5, piece.y + 5, ...piece.ledgers);
      if (piece.stem) reach(piece.stem.end);
      if (piece.tie) reach(piece.y - 15, piece.y + 15);
    }
    for (const stroke of this.drums().strokes) {
      reach(...stroke.heads.flatMap(head => [head.y - 5, head.y + 5]), ...stroke.stems.flatMap(stem => [stem.from, stem.to]));
      if (stroke.ledger) reach(CYMBAL_LEDGER);
    }
    for (const beam of this.drums().beams) reach(beam.y, beam.y + BEAM_HEIGHT);
    for (const beam of this.noteBeams()) reach(beam.y1, beam.y2, beam.y1 + BEAM_HEIGHT, beam.y2 + BEAM_HEIGHT);
    const chordY = low - 6, top = (this.chords().length ? chordY - 15 : low) - 6;
    return { top, height: high + 6 - top, chordY };
  });
  readonly isDrums = computed(() => this.stem() === 'drums');
  readonly written = computed(() => this.part().notes.length > 0 || !!this.part().second?.length || !!this.part().hits?.length);
  readonly clef = computed(() => CLEFS[this.stem()]?.clef);
  readonly voices = computed(() => !this.isDrums() && !!this.part().second?.length);
  readonly melody = computed(() => beamNotes(this.isDrums() ? [] : this.part().notes.map(note =>
    notePieces(this.stem(), note, this.grid().firstBar, this.voices() ? 'up' : undefined, this.signature())), this.voices() ? 'up' : undefined));
  readonly notes = computed(() => this.melody().notes);
  // The line under the melody, drawn lighter with its stems down.
  readonly lower = computed(() => beamNotes(this.voices()
    ? this.part().second!.map(note => notePieces(this.stem(), note, this.grid().firstBar, 'down', this.signature())) : [], 'down'));
  readonly second = computed(() => this.lower().notes);
  // Beams over short notes, as slanted bars; the second line's drawn lighter.
  readonly noteBeams = computed(() => [
    ...this.lower().beams.map(beam => ({ ...beam, second: true })), ...this.melody().beams.map(beam => ({ ...beam, second: false })),
  ].map(beam => ({ second: beam.second, y1: beam.y1, y2: beam.y2,
    d: `M${beam.x1} ${beam.y1} L${beam.x2} ${beam.y2} L${beam.x2} ${beam.y2 + BEAM_HEIGHT} L${beam.x1} ${beam.y1 + BEAM_HEIGHT} Z` })));
  readonly drums = computed<DrumScore>(() => drumScore(this.part().hits ?? [], this.grid().firstBar));
  readonly rests = computed(() => this.isDrums() ? this.drums().rests : scoreRests(this.part().notes, this.grid().firstBar));
  // Drums have no chords; the score is written from the hits alone.
  readonly chords = computed(() => this.isDrums() ? [] : this.part().chords.map(chord => ({
    name: chord.name,
    // Chords land on the nearest eighth note, so they line up with the notes below.
    unit: Math.round(positionAt(this.grid().beats, chord.start) / 2) * 2,
  })).map(chord => ({ ...chord, x: chord.unit * UNIT_WIDTH })));
  readonly width = computed(() => (this.grid().beats.length * 4 + 8) * UNIT_WIDTH);
  readonly barLines = computed(() => {
    if (!this.written()) return [];
    const lines: number[] = [];
    for (let unit = this.grid().firstBar * 4; unit < this.grid().beats.length * 4; unit += UNITS_PER_BAR) {
      lines.push(unit * UNIT_WIDTH - UNIT_WIDTH / 2);
    }
    return lines;
  });
  readonly label = computed(() => this.isDrums()
    ? `Drum score with ${this.drums().strokes.length} strokes`
    : `Chords and notes: ${this.part().chords.map(chord => chord.name).slice(0, 40).join(', ')}`);
  private readonly strip = viewChild.required<ElementRef<HTMLElement>>('strip');
  private readonly flow = viewChild.required<ElementRef<SVGSVGElement>>('flow');
  private highlighted: Element[] = [];

  crossPath(x: number, y: number): string {
    return `M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x - 4} ${y + 4} L${x + 4} ${y - 4}`;
  }

  constructor() {
    // Written directly, because this runs on every playback tick over every note.
    afterRenderEffect(() => this.place(this.chords(), this.grid(), this.time()));
  }

  // The notes sounding at a moment, by when they are played (start to end, in song seconds): every one of a chord.
  // Each list is sorted by start; `longest` bounds how far back a note can still be sounding.
  private readonly sounding = computed(() => {
    const prepare = (notes: { start: number; end: number }[]) => {
      const order = notes.map((_, index) => index).sort((a, b) => notes[a].start - notes[b].start);
      return {
        count: notes.length, order, starts: order.map(index => notes[index].start), ends: order.map(index => notes[index].end),
        longest: notes.reduce((most, note) => Math.max(most, note.end - note.start), 0),
      };
    };
    return { main: prepare(this.part().notes), second: prepare(this.part().second ?? []) };
  });

  private place(chordUnits: { unit: number }[], grid: HarmonyGrid, time: number): void {
    const flow = this.flow().nativeElement;
    const position = positionAt(grid.beats, time);
    const middle = this.strip().nativeElement.clientWidth / 2;
    flow.style.transform = `translateX(${middle - position * UNIT_WIDTH}px)`;
    const chords = flow.getElementsByClassName('score-chord');
    const active: Element[] = [];
    if (chords.length === chordUnits.length) {
      const chord = reachedIndex(chordUnits.map(item => item.unit), position);
      if (chord >= 0) active.push(chords[chord]);
    }
    if (this.isDrums()) {
      // Drum strokes have no length: the one just struck.
      const strokes = this.drums().strokes, elements = flow.querySelectorAll('g.score-note');
      const stroke = reachedIndex(strokes.map(item => item.unit), position);
      if (elements.length === strokes.length && stroke >= 0 && position < strokes[stroke].unit + strokes[stroke].length) active.push(elements[stroke]);
    } else {
      const { main, second } = this.sounding();
      const light = (list: ReturnType<typeof this.sounding>['main'], elements: NodeListOf<Element>) => {
        if (elements.length !== list.count) return;
        // From the last note started back to the earliest that could still be sounding.
        for (let at = reachedIndex(list.starts, time); at >= 0 && list.starts[at] >= time - list.longest; at--) {
          if (time < list.ends[at]) active.push(elements[list.order[at]]);
        }
      };
      light(main, flow.querySelectorAll('g.score-note:not(.second)'));
      light(second, flow.querySelectorAll('g.score-note.second'));
    }
    if (active.length !== this.highlighted.length || active.some(element => !this.highlighted.includes(element))) {
      for (const element of this.highlighted) element.classList.remove('active');
      for (const element of active) element.classList.add('active');
      this.highlighted = active;
    }
  }
}
