import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, input, viewChild,
} from '@angular/core';
import { LyricLine, LyricWord } from './services';

const HELD_AFTER_WORD = 0.25;

// The last word started by this time, or -1 before the first.
export function lyricIndex(words: LyricWord[], time: number): number {
  let low = 0, high = words.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (words[middle].start <= time) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

@Component({
  selector: 'app-lyrics-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lyrics-strip" #strip role="group" aria-label="Lyrics">
      <div class="lyrics-flow" #flow>
        @for (line of lines(); track $index) {
          <span class="lyrics-line">
            @for (word of line.words; track $index) { <span class="lyrics-word">{{ word.text }}</span> }
          </span>
        }
      </div>
    </div>
  `,
})
export class LyricsStrip {
  readonly lines = input.required<LyricLine[]>();
  readonly time = input.required<number>();
  private readonly strip = viewChild.required<ElementRef<HTMLElement>>('strip');
  private readonly flow = viewChild.required<ElementRef<HTMLElement>>('flow');
  private readonly words = computed(() => this.lines().flatMap(line => line.words));
  private highlighted = -1;

  constructor() {
    // Written directly, because this runs on every playback tick over every word.
    afterRenderEffect(() => this.place(this.words(), this.time()));
  }

  private place(words: LyricWord[], time: number): void {
    const elements = this.flow().nativeElement.getElementsByClassName('lyrics-word') as HTMLCollectionOf<HTMLElement>;
    if (!words.length || elements.length !== words.length) return;
    const center = (element: HTMLElement) => element.offsetLeft + element.offsetWidth / 2;
    const index = lyricIndex(words, time);
    const middle = this.strip().nativeElement.clientWidth / 2;
    // Words differ in length, so glide between them; the current word reaches the middle as it is sung.
    const fromTime = index < 0 ? 0 : words[index].start;
    const from = index < 0 ? center(elements[0]) - middle : center(elements[index]);
    const next = Math.min(index + 1, words.length - 1);
    const span = words[next].start - fromTime;
    const progress = span > 0 ? Math.min(1, (time - fromTime) / span) : 0;
    const position = from + (center(elements[next]) - from) * progress;
    this.flow().nativeElement.style.transform = `translateX(${middle - position}px)`;

    // Word timings are sometimes a word early or late, so the words either side are lit too, more faintly.
    const active = index >= 0 && time < words[index].end + HELD_AFTER_WORD ? index : -1;
    if (active !== this.highlighted) {
      this.light(elements, this.highlighted, false);
      this.light(elements, active, true);
      this.highlighted = active;
    }
  }

  private light(elements: HTMLCollectionOf<HTMLElement>, index: number, on: boolean): void {
    if (index < 0) return;
    elements[index].classList.toggle('active', on);
    elements[index - 1]?.classList.toggle('near', on);
    elements[index + 1]?.classList.toggle('near', on);
  }
}
