import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, input, viewChild,
} from '@angular/core';
import { DrumHit, DrumName, HarmonyGrid, HarmonyNote, HarmonyPart } from './services';

const UNIT_WIDTH = 16; // Pixels per sixteenth note.
const UNITS_PER_BAR = 16;
const LINE_GAP = 8;
const BOTTOM_LINE_Y = 88;
const MIDDLE_LINE_Y = BOTTOM_LINE_Y - 2 * LINE_GAP;
const STEM_LENGTH = 26;
const HEAD_OFFSET = 4.8;
const NOTE_VALUES = [16, 12, 8, 6, 4, 3, 2, 1];
const REST_VALUES = [16, 8, 4, 2, 1];
// Letter name offset from C, and accidental, for each pitch class.
const SPELLING: [number, string][] = [
  [0, ''], [0, '♯'], [1, ''], [2, '♭'], [2, ''], [3, ''], [3, '♯'], [4, ''], [5, '♭'], [5, ''], [6, '♭'], [6, ''],
];
// Steps count letter names from C0; bottom is E4 or G2. Guitar and bass are written an octave above their sound.
const CLEFS: Record<string, { clef: 'treble' | 'bass'; bottomStep: number; lift: number; low: number; high: number }> = {
  guitar: { clef: 'treble', bottomStep: 30, lift: 12, low: 52, high: 84 },
  piano: { clef: 'treble', bottomStep: 30, lift: 0, low: 52, high: 84 },
  other: { clef: 'treble', bottomStep: 30, lift: 0, low: 52, high: 84 },
  bass: { clef: 'bass', bottomStep: 18, lift: 12, low: 36, high: 64 },
};

export interface NotePiece {
  x: number; y: number; hollow: boolean; stem?: { x: number; end: number };
  flags: string[]; dot?: { x: number; y: number }; tie?: string; ledgers: number[]; accidental: string;
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
const CYMBAL_LEDGER = 48;
const BEAM_UP = 30;
const BEAM_DOWN = 116;
const BEAM_HEIGHT = 3;
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

@Component({
  selector: 'app-harmony-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="harmony-strip" [class.chords-only]="!written()" #strip role="img" [attr.aria-label]="label()">
      @if (written()) {
        <svg class="staff-lines" aria-hidden="true">
          @for (y of staffLines; track y) { <line x1="0" x2="100%" [attr.y1]="y" [attr.y2]="y"></line> }
        </svg>
      }
      <div class="harmony-window">
        <svg class="harmony-flow" #flow aria-hidden="true" [attr.width]="width()" height="128">
          @for (x of barLines(); track x) {
            <line class="score-bar" [attr.x1]="x" [attr.x2]="x" [attr.y1]="staffLines[4]" [attr.y2]="staffLines[0]"></line>
          }
          @for (chord of chords(); track $index) {
            <text class="score-chord" text-anchor="middle" y="18" [attr.x]="chord.x">{{ chord.name }}</text>
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
          @for (pieces of notes(); track $index) {
            <g class="score-note">
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
        </svg>
      </div>
      @if (isDrums()) {
        <span class="drum-clef" aria-hidden="true"></span>
      } @else if (written()) {
        <span class="staff-clef" [class]="'staff-clef ' + clef()" aria-hidden="true">{{ clef() === 'bass' ? '𝄢' : '𝄞' }}</span>
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
  readonly middleLineY = MIDDLE_LINE_Y;
  readonly staffLines = [0, 1, 2, 3, 4].map(line => BOTTOM_LINE_Y - line * LINE_GAP);
  readonly isDrums = computed(() => this.stem() === 'drums');
  readonly written = computed(() => this.part().notes.length > 0 || !!this.part().hits?.length);
  readonly clef = computed(() => CLEFS[this.stem()]?.clef);
  readonly notes = computed(() => this.part().notes.map(note => notePieces(this.stem(), note, this.grid().firstBar)));
  readonly drums = computed<DrumScore>(() => drumScore(this.part().hits ?? [], this.grid().firstBar));
  readonly rests = computed(() => this.isDrums() ? this.drums().rests : scoreRests(this.part().notes, this.grid().firstBar));
  // A drum score's bars carry the letter of their repeating pattern where others carry chords.
  readonly chords = computed(() => this.isDrums() ? (this.part().patterns ?? []).map(pattern => ({
    name: pattern.label, unit: pattern.unit, x: pattern.unit * UNIT_WIDTH + UNIT_WIDTH / 2,
  })) : this.part().chords.map(chord => ({
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
    : `Chords and melody: ${this.part().chords.map(chord => chord.name).slice(0, 40).join(', ')}`);
  private readonly strip = viewChild.required<ElementRef<HTMLElement>>('strip');
  private readonly flow = viewChild.required<ElementRef<SVGSVGElement>>('flow');
  private highlighted: Element[] = [];

  crossPath(x: number, y: number): string {
    return `M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x - 4} ${y + 4} L${x + 4} ${y - 4}`;
  }

  constructor() {
    // Written directly, because this runs on every playback tick over every note.
    afterRenderEffect(() => this.place(this.spans(), this.chords(), this.grid(), this.time()));
  }

  private readonly spans = computed<{ unit: number; length: number }[]>(() => this.isDrums() ? this.drums().strokes : this.part().notes);

  private place(spans: { unit: number; length: number }[], chordUnits: { unit: number }[], grid: HarmonyGrid, time: number): void {
    const flow = this.flow().nativeElement;
    const position = positionAt(grid.beats, time);
    const middle = this.strip().nativeElement.clientWidth / 2;
    flow.style.transform = `translateX(${middle - position * UNIT_WIDTH}px)`;
    const chords = flow.getElementsByClassName('score-chord');
    const notes = flow.getElementsByClassName('score-note');
    if (chords.length !== chordUnits.length || notes.length !== spans.length) return;
    // Sorting only matters for chords, whose snapped positions can tie.
    const chord = reachedIndex(chordUnits.map(item => item.unit), position);
    const note = reachedIndex(spans.map(item => item.unit), position);
    const active = [
      chord >= 0 ? chords[chord] : null,
      note >= 0 && position < spans[note].unit + spans[note].length ? notes[note] : null,
    ].filter((element): element is Element => !!element);
    if (active.length !== this.highlighted.length || active.some((element, index) => element !== this.highlighted[index])) {
      for (const element of this.highlighted) element.classList.remove('active');
      for (const element of active) element.classList.add('active');
      this.highlighted = active;
    }
  }
}
