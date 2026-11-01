import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild, signal } from '@angular/core';
import { HarmonySource } from './accompaniment-audio';
import { MINIMUM_REGION, Region, StemAnalysis, largestGap, normalizeRegions, regionHasChord, waveformPath } from './accompaniment-regions';

// Matches the mixer's default channel and master volume, so the balance heard here carries over.
export const LISTENING_GAIN = 0.64;
const EDGE_FADE = 0.005;
type DragKind = 'start' | 'end' | 'move' | 'create';

@Component({
  selector: 'region-editor',
  standalone: true,
  template: `
    <div class="region-toolbar">
      <button type="button" (click)="playAll()" [disabled]="disabled || !regions.length">Play selection</button>
      <button type="button" class="secondary" (click)="stop()" [disabled]="playing() === null">Stop</button>
      <label class="wizard-choice"><input type="checkbox" [checked]="looping()"
        (change)="looping.set(!looping())"> Loop</label>
      <button type="button" class="secondary" (click)="add()" [disabled]="disabled || !canAdd()">Add region</button>
      <button type="button" class="secondary" (click)="commit(detected)" [disabled]="disabled">Reset to detected</button>
      <button type="button" class="secondary" (click)="commit([])" [disabled]="disabled || !regions.length">Clear all</button>
      <label class="wizard-choice">Zoom
        <select [value]="zoom()" (change)="setZoom($event)" aria-label="Waveform zoom">
          @for (level of zoomLevels; track level) { <option [value]="level">{{ level }}×</option> }
        </select>
      </label>
    </div>
    <p class="hint">Drag an edge to resize, drag a region to move it, or drag empty space to add one.
      Regions can go anywhere in the song. On a focused edge, use arrow keys (Shift for 1 second) and Delete.</p>
    <div class="region-scroll">
      <div #timeline class="region-timeline" [style.width.%]="zoom() * 100" (pointerdown)="beginDrag('create', -1, $event)"
        (pointermove)="moveDrag($event)" (pointerup)="endDrag($event)" (pointercancel)="endDrag($event)">
        @for (lane of lanes; track lane.name) {
          <div class="region-lane">
            <span class="region-lane-name">{{ lane.name }}</span>
            <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path [attr.d]="lane.path"></path></svg>
          </div>
        }
        @for (region of shown(); track $index) {
          <div class="region-block" [class.silent]="!hasChord(region)" [style.left.%]="percent(region.start)"
            [style.width.%]="percent(region.end - region.start)" (pointerdown)="beginDrag('move', $index, $event)">
            <button type="button" class="region-edge start" role="slider" [disabled]="disabled"
              [attr.aria-label]="'Region ' + ($index + 1) + ' start'" [attr.aria-valuemin]="0"
              [attr.aria-valuemax]="duration" [attr.aria-valuenow]="region.start" [attr.aria-valuetext]="clock(region.start)"
              (pointerdown)="beginDrag('start', $index, $event)" (keydown)="edgeKey('start', $index, $event)"></button>
            <button type="button" class="region-remove" [disabled]="disabled" [attr.aria-label]="'Remove region ' + ($index + 1)"
              (pointerdown)="$event.stopPropagation()" (click)="remove($index)">×</button>
            <button type="button" class="region-edge end" role="slider" [disabled]="disabled"
              [attr.aria-label]="'Region ' + ($index + 1) + ' end'" [attr.aria-valuemin]="0"
              [attr.aria-valuemax]="duration" [attr.aria-valuenow]="region.end" [attr.aria-valuetext]="clock(region.end)"
              (pointerdown)="beginDrag('end', $index, $event)" (keydown)="edgeKey('end', $index, $event)"></button>
          </div>
        }
        @if (playing() !== null) { <div class="region-playhead" [style.left.%]="percent(position())"></div> }
      </div>
    </div>
    @if (!regions.length) {
      <p class="hint" role="status">No regions selected. Add one to generate.</p>
    }
    <div class="region-list">
      @for (region of regions; track $index) {
        <div class="region-row">
          <span>Region {{ $index + 1 }}</span>
          <label>Start <input type="number" min="0" [max]="duration" step="0.01" [value]="region.start" [disabled]="disabled"
            (change)="setTime($index, 'start', $event)"></label>
          <label>End <input type="number" min="0" [max]="duration" step="0.01" [value]="region.end" [disabled]="disabled"
            (change)="setTime($index, 'end', $event)"></label>
          <small>{{ clock(region.start) }}–{{ clock(region.end) }}</small>
          <button type="button" class="secondary" (click)="playOne($index)" [disabled]="disabled">Play</button>
          <button type="button" class="secondary" (click)="remove($index)" [disabled]="disabled">Remove</button>
          @if (!hasChord(region)) { <small class="error">Only “N” chords here, so this region will stay silent.</small> }
        </div>
      }
    </div>
  `,
})
export class RegionEditor implements OnChanges, OnDestroy {
  @Input({ required: true }) stems: StemAnalysis[] = [];
  @Input({ required: true }) sources: HarmonySource[] = [];
  @Input({ required: true }) regions: Region[] = [];
  @Input({ required: true }) detected: Region[] = [];
  @Input({ required: true }) chords: readonly { start: number; end: number; chord: string }[] = [];
  @Input({ required: true }) duration = 0;
  @Input({ required: true }) audio!: () => AudioContext;
  @Input() disabled = false;
  @Output() regionsChange = new EventEmitter<Region[]>();
  @Output() listening = new EventEmitter<void>();
  @ViewChild('timeline') private timeline?: ElementRef<HTMLElement>;
  readonly zoomLevels = [1, 2, 4, 8, 16];
  readonly zoom = signal(1);
  readonly looping = signal(false);
  readonly playing = signal<number[] | null>(null);
  readonly position = signal(0);
  readonly draft = signal<Region[] | null>(null);
  lanes: { name: string; path: string }[] = [];
  private drag?: { pointerId: number; kind: DragKind; index: number; anchor: number; original: Region; working: Region[] };
  private nodes: AudioBufferSourceNode[] = [];
  private gains: GainNode[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private playToken = 0;

  ngOnChanges(): void {
    // One scale for all lanes keeps loudness differences between stems visible.
    let scale = 0;
    for (const stem of this.stems) for (const peak of stem.peaks) if (peak > scale) scale = peak;
    this.lanes = this.stems.map(stem => ({ name: stem.name, path: waveformPath(stem.peaks, scale) }));
  }

  shown(): Region[] { return this.draft() ?? this.regions; }
  percent(time: number): number { return this.duration > 0 ? time / this.duration * 100 : 0; }
  hasChord(region: Region): boolean { return regionHasChord(region, this.chords); }
  canAdd(): boolean { return !!largestGap(this.regions, this.duration); }
  clock(value: number): string {
    return `${Math.floor(value / 60)}:${(value % 60).toFixed(2).padStart(5, '0')}`;
  }
  setZoom(event: Event): void {
    if (event.target instanceof HTMLSelectElement) this.zoom.set(Number(event.target.value));
  }

  commit(regions: Region[]): void {
    this.stop();
    this.regionsChange.emit(normalizeRegions(regions, this.duration));
  }
  remove(index: number): void { this.commit(this.regions.filter((_, item) => item !== index)); }
  add(): void {
    const gap = largestGap(this.regions, this.duration);
    if (!gap) return;
    const middle = (gap.start + gap.end) / 2, half = Math.min(2, (gap.end - gap.start) / 2);
    this.commit([...this.regions, { start: middle - half, end: middle + half }]);
  }
  setTime(index: number, edge: 'start' | 'end', event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const value = Number(event.target.value);
    if (event.target.value === '' || !Number.isFinite(value)) { event.target.value = String(this.regions[index][edge]); return; }
    this.moveEdge(index, edge, value);
    // The model may clamp to its existing value, which would not rewrite the input.
    event.target.value = String(this.regions[index]?.[edge] ?? value);
  }
  edgeKey(edge: 'start' | 'end', index: number, event: KeyboardEvent): void {
    const region = this.regions[index], step = event.shiftKey ? 1 : 0.1;
    if (['Delete', 'Backspace'].includes(event.key)) this.remove(index);
    else if (event.key === 'ArrowLeft') this.moveEdge(index, edge, region[edge] - step);
    else if (event.key === 'ArrowRight') this.moveEdge(index, edge, region[edge] + step);
    else if (event.key === 'Home') this.moveEdge(index, edge, edge === 'start' ? 0 : region.start + MINIMUM_REGION);
    else if (event.key === 'End') this.moveEdge(index, edge, edge === 'end' ? this.duration : region.end - MINIMUM_REGION);
    else return;
    event.preventDefault();
  }
  private moveEdge(index: number, edge: 'start' | 'end', time: number): void {
    this.commit(this.regions.map((region, item) => item === index ? this.withEdge(region, edge, time) : region));
  }
  private withEdge(region: Region, edge: 'start' | 'end', time: number): Region {
    return edge === 'start'
      ? { ...region, start: Math.max(0, Math.min(time, region.end - MINIMUM_REGION)) }
      : { ...region, end: Math.min(this.duration, Math.max(time, region.start + MINIMUM_REGION)) };
  }

  private pointerTime(event: PointerEvent): number | undefined {
    const rect = this.timeline?.nativeElement.getBoundingClientRect();
    if (!rect?.width) return undefined;
    return Math.max(0, Math.min(this.duration, (event.clientX - rect.left) / rect.width * this.duration));
  }

  beginDrag(kind: DragKind, index: number, event: PointerEvent): void {
    const time = this.pointerTime(event);
    if (this.disabled || this.drag || event.button !== 0 || time === undefined) return;
    this.stop();
    const working = this.regions.map(region => ({ ...region }));
    const original = kind === 'create' ? { start: time, end: time } : { ...working[index] };
    if (kind === 'create') { working.push(original); index = working.length - 1; }
    this.drag = { pointerId: event.pointerId, kind, index, anchor: time, original, working };
    this.timeline?.nativeElement.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  moveDrag(event: PointerEvent): void {
    const drag = this.drag, time = this.pointerTime(event);
    if (!drag || drag.pointerId !== event.pointerId || time === undefined) return;
    let next: Region;
    if (drag.kind === 'create') {
      next = { start: Math.min(drag.anchor, time), end: Math.max(drag.anchor, time) };
    } else if (drag.kind === 'move') {
      const length = drag.original.end - drag.original.start;
      const start = Math.max(0, Math.min(this.duration - length, drag.original.start + time - drag.anchor));
      next = { start, end: start + length };
    } else {
      next = this.withEdge(drag.original, drag.kind, time);
    }
    drag.working[drag.index] = next;
    this.draft.set([...drag.working]);
  }

  endDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = undefined;
    if (this.timeline?.nativeElement.hasPointerCapture(event.pointerId)) {
      this.timeline.nativeElement.releasePointerCapture(event.pointerId);
    }
    const changed = this.draft();
    this.draft.set(null);
    if (changed && event.type !== 'pointercancel') this.commit(changed);
  }

  playAll(): void { this.play(this.regions.map((_, index) => index)); }
  playOne(index: number): void { this.play([index]); }

  private async play(indexes: number[]): Promise<void> {
    this.stop();
    const token = this.playToken;
    this.listening.emit();
    const context = this.audio();
    await context.resume();
    if (token !== this.playToken) return;
    const list = indexes.map(index => this.regions[index]).filter(Boolean);
    if (!list.length) return;
    const first = context.currentTime + 0.05;
    let cursor = first;
    const schedule = list.map(region => {
      const when = cursor, length = region.end - region.start;
      const gain = context.createGain();
      const fade = Math.min(EDGE_FADE, length / 2);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(LISTENING_GAIN, when + fade);
      gain.gain.setValueAtTime(LISTENING_GAIN, when + length - fade);
      gain.gain.linearRampToValueAtTime(0, when + length);
      gain.connect(context.destination);
      this.gains.push(gain);
      for (const { buffer } of this.sources) {
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(gain);
        node.start(when, region.start, length);
        this.nodes.push(node);
      }
      cursor += length;
      return { when, region };
    });
    const finish = cursor;
    this.playing.set(indexes);
    this.position.set(list[0].start);
    this.timer = setInterval(() => {
      const now = context.currentTime;
      if (now >= finish) {
        if (this.looping()) void this.play(indexes); else this.stop();
        return;
      }
      for (let item = schedule.length - 1; item >= 0; item--) {
        if (now >= schedule[item].when) {
          this.position.set(schedule[item].region.start + now - schedule[item].when);
          return;
        }
      }
    }, 40);
  }

  stop(): void {
    this.playToken++;
    clearInterval(this.timer);
    for (const node of this.nodes) { try { node.stop(); } catch { /* Already ended. */ } node.disconnect(); }
    for (const gain of this.gains) gain.disconnect();
    this.nodes = [];
    this.gains = [];
    this.playing.set(null);
  }

  ngOnDestroy(): void { this.stop(); }
}
