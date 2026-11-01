import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, input, viewChild,
} from '@angular/core';
import { HarmonyPart } from './services';

const NOTE_GAP = 26;
const CHORD_GAP = 46;
const CHORD_JOINS_NOTE = 0.2;
const LINE_GAP = 8;
const BOTTOM_LINE_Y = 66;
const BOTTOM_LINE_STEP = 30; // E4, counting letter names from C0.
const TOP_LINE_STEP = 38; // F5.
const LOWEST_WRITTEN = 57; // A3, the second ledger line below the staff.
const HIGHEST_WRITTEN = 84; // C6, the second ledger line above it.
// Letter name offset from C, and accidental, for each pitch class.
const SPELLING: [number, string][] = [
  [0, ''], [0, '♯'], [1, ''], [2, '♭'], [2, ''], [3, ''], [3, '♯'], [4, ''], [5, '♭'], [5, ''], [6, '♭'], [6, ''],
];

export interface ScoreNote { y: number; accidental: string; ledgers: number[] }
export interface ScoreColumn { start: number; x: number; chord?: string; note?: ScoreNote }

// Notes are drawn without length, and folded by octaves onto the treble staff, so the staff stays readable.
export function scoreNote(pitch: number): ScoreNote {
  let written = pitch;
  while (written < LOWEST_WRITTEN) written += 12;
  while (written > HIGHEST_WRITTEN) written -= 12;
  const [letter, accidental] = SPELLING[written % 12];
  const step = (Math.floor(written / 12) - 1) * 7 + letter;
  const yOf = (value: number) => BOTTOM_LINE_Y - (value - BOTTOM_LINE_STEP) * LINE_GAP / 2;
  const ledgers: number[] = [];
  for (let value = BOTTOM_LINE_STEP - 2; value >= step; value -= 2) ledgers.push(yOf(value));
  for (let value = TOP_LINE_STEP + 2; value <= step; value += 2) ledgers.push(yOf(value));
  return { y: yOf(step), accidental, ledgers };
}

// One row of evenly spaced columns: a chord shares a column with the note it starts on.
export function scoreColumns(part: HarmonyPart): ScoreColumn[] {
  const columns: { start: number; chord?: string; pitch?: number }[] = [
    ...part.notes.map(note => ({ start: note.start, pitch: note.pitch })),
  ].sort((a, b) => a.start - b.start);
  for (const chord of part.chords) {
    const joined = columns.find(column => column.pitch !== undefined && column.chord === undefined &&
      column.start >= chord.start && column.start - chord.start <= CHORD_JOINS_NOTE);
    if (joined) joined.chord = chord.name;
    else columns.push({ start: chord.start, chord: chord.name });
  }
  columns.sort((a, b) => a.start - b.start);
  let x = 0;
  let lastChordX = -Infinity;
  return columns.map(column => {
    if (column.chord) x = Math.max(x, lastChordX + CHORD_GAP);
    const placed: ScoreColumn = {
      start: column.start, x, chord: column.chord,
      note: column.pitch === undefined ? undefined : scoreNote(column.pitch),
    };
    if (column.chord) lastChordX = x;
    x += NOTE_GAP;
    return placed;
  });
}

// The last column started by this time, or -1 before the first.
export function columnIndex(columns: { start: number }[], time: number): number {
  let low = 0, high = columns.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (columns[middle].start <= time) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

@Component({
  selector: 'app-harmony-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="harmony-strip" #strip role="img" [attr.aria-label]="label()">
      <svg class="staff-lines" aria-hidden="true">
        @for (y of staffLines; track y) { <line x1="0" x2="100%" [attr.y1]="y" [attr.y2]="y"></line> }
      </svg>
      <div class="harmony-window">
        <svg class="harmony-flow" #flow aria-hidden="true" [attr.width]="width()" height="92">
          @for (column of columns(); track $index) {
            <g class="score-column" [attr.transform]="'translate(' + column.x + ')'">
              @if (column.chord) { <text class="score-chord" text-anchor="middle" y="16">{{ column.chord }}</text> }
              @if (column.note; as note) {
                <g class="score-note">
                  @for (y of note.ledgers; track y) { <line x1="-9" x2="9" [attr.y1]="y" [attr.y2]="y"></line> }
                  <ellipse rx="5.2" ry="3.8" [attr.cy]="note.y" [attr.transform]="'rotate(-20 0 ' + note.y + ')'"></ellipse>
                  @if (note.accidental) { <text text-anchor="end" x="-7" [attr.y]="note.y + 4">{{ note.accidental }}</text> }
                </g>
              }
            </g>
          }
        </svg>
      </div>
      <span class="staff-clef" aria-hidden="true">𝄞</span>
      <span class="staff-now" aria-hidden="true"></span>
    </div>
  `,
})
export class HarmonyStrip {
  readonly part = input.required<HarmonyPart>();
  readonly time = input.required<number>();
  readonly staffLines = [0, 1, 2, 3, 4].map(line => BOTTOM_LINE_Y - line * LINE_GAP);
  readonly columns = computed(() => scoreColumns(this.part()));
  readonly width = computed(() => (this.columns().at(-1)?.x ?? 0) + NOTE_GAP);
  readonly label = computed(() => `Chords and notes: ${this.part().chords.map(chord => chord.name).slice(0, 40).join(', ')}`);
  private readonly strip = viewChild.required<ElementRef<HTMLElement>>('strip');
  private readonly flow = viewChild.required<ElementRef<SVGSVGElement>>('flow');
  private highlighted: Element[] = [];

  constructor() {
    // Written directly, because this runs on every playback tick over every column.
    afterRenderEffect(() => this.place(this.columns(), this.time()));
  }

  private place(columns: ScoreColumn[], time: number): void {
    const elements = this.flow().nativeElement.getElementsByClassName('score-column');
    if (!columns.length || elements.length !== columns.length) return;
    const index = columnIndex(columns, time);
    const middle = this.strip().nativeElement.clientWidth / 2;
    const fromTime = index < 0 ? 0 : columns[index].start;
    const from = index < 0 ? columns[0].x - middle : columns[index].x;
    const next = Math.min(index + 1, columns.length - 1);
    const span = columns[next].start - fromTime;
    const progress = span > 0 ? Math.min(1, (time - fromTime) / span) : 0;
    const position = from + (columns[next].x - from) * progress;
    this.flow().nativeElement.style.transform = `translateX(${middle - position}px)`;

    let chord = index;
    while (chord >= 0 && !columns[chord].chord) chord--;
    let note = index;
    while (note >= 0 && !columns[note].note) note--;
    const active = [
      chord >= 0 ? elements[chord].querySelector('.score-chord') : null,
      note >= 0 ? elements[note].querySelector('.score-note') : null,
    ].filter((element): element is Element => !!element);
    if (active[0] !== this.highlighted[0] || active[1] !== this.highlighted[1]) {
      for (const element of this.highlighted) element.classList.remove('active');
      for (const element of active) element.classList.add('active');
      this.highlighted = active;
    }
  }
}
