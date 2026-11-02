import {
  ChangeDetectionStrategy, Component, ElementRef, afterNextRender, inject, input, output, signal, viewChild,
} from '@angular/core';
import { LyricLine, LyricWord } from './services';
import { ConfirmationService } from './confirmation';

const NEW_LINE_SECONDS = 3;
const SHORTEST_NEW_LINE = 0.3;

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

@Component({
  selector: 'app-lyrics-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog class="lyrics-editor" #dialog aria-labelledby="lyrics-editor-title" (cancel)="escape($event)">
      <header>
        <h2 id="lyrics-editor-title">Edit lyrics</h2>
        <p class="hint">Timing stays with each line. Clear a line to remove it.</p>
      </header>
      <div class="lyrics-editor-lines">
        <button type="button" class="secondary lyrics-add" (click)="add(-1)" [disabled]="!canAdd(-1) || saving()"
          aria-label="Add a line at the beginning">+ Add line</button>
        @for (row of rows(); track row.id; let index = $index) {
          <div class="lyrics-editor-row">
            <span class="lyrics-time">{{ clock(row.start) }}</span>
            <input type="text" [value]="row.text" [disabled]="saving()" maxlength="2000"
              [attr.aria-label]="'Line at ' + clock(row.start)" (input)="change(row.id, $event)">
            <button type="button" class="secondary" (click)="add(index)" [disabled]="!canAdd(index) || saving()"
              [attr.aria-label]="'Add a line after ' + clock(row.start)">+</button>
          </div>
        }
      </div>
      @if (error()) { <p role="alert" class="error">{{ error() }}</p> }
      <footer>
        <button type="button" class="secondary" (click)="cancel()" [disabled]="saving()">Cancel</button>
        <button type="button" (click)="save()" [disabled]="saving()">{{ saving() ? 'Saving...' : 'Save lyrics' }}</button>
      </footer>
    </dialog>
  `,
})
export class LyricsEditor {
  private readonly confirm = inject(ConfirmationService);
  readonly lines = input.required<LyricLine[]>();
  readonly duration = input.required<number>();
  readonly saving = input(false);
  readonly error = input('');
  readonly saved = output<LyricLine[]>();
  readonly cancelled = output<void>();
  readonly rows = signal<LyricRow[]>([]);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private nextId = 0;

  constructor() {
    afterNextRender(() => {
      this.rows.set(this.lines().map(line => ({
        id: this.nextId++, start: line.start, end: line.end, text: lineText(line), words: line.words,
      })));
      this.dialog().nativeElement.showModal();
    });
  }

  clock(seconds: number): string {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  change(id: number, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.rows.update(rows => rows.map(row => row.id === id ? { ...row, text } : row));
  }

  canAdd(index: number): boolean { return !!gapAfter(this.rows(), index, this.duration()); }

  add(index: number): void {
    const gap = gapAfter(this.rows(), index, this.duration());
    if (!gap) return;
    this.rows.update(rows => [...rows.slice(0, index + 1), { id: this.nextId++, ...gap, text: '' }, ...rows.slice(index + 1)]);
  }

  save(): void { this.saved.emit(editedLines(this.rows())); }

  async cancel(): Promise<void> {
    const changed = firstChange(this.lines(), editedLines(this.rows())) !== null;
    if (!changed || await this.confirm.confirm('Discard lyric changes?', 'Discard your changes to the lyrics?', 'Discard')) {
      this.cancelled.emit();
    }
  }

  escape(event: Event): void {
    event.preventDefault();
    if (!this.saving()) this.cancel();
  }
}
