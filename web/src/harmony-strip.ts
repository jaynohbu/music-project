import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, input, viewChild,
} from '@angular/core';
import { HarmonyPart } from './services';

const PIXELS_PER_SECOND = 60;
const LINE_GAP = 8;
const BOTTOM_LINE_Y = 88;
const SHORTEST_BAR = 8;
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

export interface ScoreNote { x: number; width: number; y: number; accidental: string; ledgers: number[] }

export function scoreNote(stem: string, note: { start: number; end: number; pitch: number }): ScoreNote {
  const { bottomStep, lift, low, high } = CLEFS[stem];
  let written = note.pitch + lift;
  while (written < low) written += 12;
  while (written > high) written -= 12;
  const [letter, accidental] = SPELLING[written % 12];
  const step = (Math.floor(written / 12) - 1) * 7 + letter;
  const yOf = (value: number) => BOTTOM_LINE_Y - (value - bottomStep) * LINE_GAP / 2;
  const ledgers: number[] = [];
  for (let value = bottomStep - 2; value >= step; value -= 2) ledgers.push(yOf(value));
  for (let value = bottomStep + 10; value <= step; value += 2) ledgers.push(yOf(value));
  return {
    x: note.start * PIXELS_PER_SECOND, width: Math.max(SHORTEST_BAR, (note.end - note.start) * PIXELS_PER_SECOND),
    y: yOf(step), accidental, ledgers,
  };
}

// The last item started by this time, or -1 before the first.
export function startedIndex(items: { start: number }[], time: number): number {
  let low = 0, high = items.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle].start <= time) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

@Component({
  selector: 'app-harmony-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="harmony-strip" [class.chords-only]="!part().notes.length" #strip role="img" [attr.aria-label]="label()">
      @if (part().notes.length) {
        <svg class="staff-lines" aria-hidden="true">
          @for (y of staffLines; track y) { <line x1="0" x2="100%" [attr.y1]="y" [attr.y2]="y"></line> }
        </svg>
      }
      <div class="harmony-window">
        <svg class="harmony-flow" #flow aria-hidden="true" [attr.width]="width()" height="128">
          @for (chord of part().chords; track $index) {
            <text class="score-chord" text-anchor="middle" y="18" [attr.x]="chord.start * pixelsPerSecond">{{ chord.name }}</text>
          }
          @for (note of notes(); track $index) {
            <g class="score-note">
              @for (y of note.ledgers; track y) {
                <line [attr.x1]="note.x - 4" [attr.x2]="note.x + note.width + 4" [attr.y1]="y" [attr.y2]="y"></line>
              }
              <rect [attr.x]="note.x" [attr.y]="note.y - 3.5" [attr.width]="note.width" height="7" rx="3.5"></rect>
              @if (note.accidental) { <text text-anchor="end" [attr.x]="note.x - 3" [attr.y]="note.y + 4">{{ note.accidental }}</text> }
            </g>
          }
        </svg>
      </div>
      @if (part().notes.length) {
        <span class="staff-clef" [class]="'staff-clef ' + clef()" aria-hidden="true">{{ clef() === 'bass' ? '𝄢' : '𝄞' }}</span>
      }
      <span class="staff-now" aria-hidden="true"></span>
    </div>
  `,
})
export class HarmonyStrip {
  readonly part = input.required<HarmonyPart>();
  readonly stem = input.required<string>();
  readonly time = input.required<number>();
  readonly pixelsPerSecond = PIXELS_PER_SECOND;
  readonly staffLines = [0, 1, 2, 3, 4].map(line => BOTTOM_LINE_Y - line * LINE_GAP);
  readonly clef = computed(() => CLEFS[this.stem()].clef);
  readonly notes = computed(() => this.part().notes.map(note => scoreNote(this.stem(), note)));
  readonly width = computed(() => {
    const { chords, notes } = this.part();
    return (Math.max(chords.at(-1)?.start ?? 0, notes.at(-1)?.end ?? 0) + 2) * PIXELS_PER_SECOND;
  });
  readonly label = computed(() => `Chords and melody: ${this.part().chords.map(chord => chord.name).slice(0, 40).join(', ')}`);
  private readonly strip = viewChild.required<ElementRef<HTMLElement>>('strip');
  private readonly flow = viewChild.required<ElementRef<SVGSVGElement>>('flow');
  private highlighted: Element[] = [];

  constructor() {
    // Written directly, because this runs on every playback tick over every note.
    afterRenderEffect(() => this.place(this.part(), this.time()));
  }

  private place(part: HarmonyPart, time: number): void {
    const flow = this.flow().nativeElement;
    const middle = this.strip().nativeElement.clientWidth / 2;
    flow.style.transform = `translateX(${middle - time * PIXELS_PER_SECOND}px)`;
    const chords = flow.getElementsByClassName('score-chord');
    const notes = flow.getElementsByClassName('score-note');
    if (chords.length !== part.chords.length || notes.length !== part.notes.length) return;
    const chord = startedIndex(part.chords, time);
    const note = startedIndex(part.notes, time);
    const active = [
      chord >= 0 ? chords[chord] : null,
      note >= 0 && time < part.notes[note].end ? notes[note] : null,
    ].filter((element): element is Element => !!element);
    if (active.length !== this.highlighted.length || active.some((element, index) => element !== this.highlighted[index])) {
      for (const element of this.highlighted) element.classList.remove('active');
      for (const element of active) element.classList.add('active');
      this.highlighted = active;
    }
  }
}
