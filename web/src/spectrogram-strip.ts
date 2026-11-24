import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, effect, input, signal, untracked, viewChild,
} from '@angular/core';
import { UNIT_WIDTH, positionAt } from './harmony-strip';
import type { HarmonyGrid } from './services';
import {
  HOP, LOWEST_PITCH, RANGE_DB, ROWS, ROWS_PER_SEMITONE, type Spectrogram, heatColors, monoSignal, spectrogramOf, timeAtPosition,
} from './spectrogram';

// Without the song's beats, this many pixels per second.
const PIXELS_PER_SECOND = 120;
const HEIGHT = 240;
const COLORS = heatColors();

// A stem's spectrogram flowing with playback, the moment playing at the middle. With the song's beat grid it is
// drawn on the score's scale (UNIT_WIDTH per sixteenth), so it lines up with the score strip above it.
@Component({
  selector: 'app-spectrogram-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="spectrogram-strip" #strip role="img" [attr.aria-label]="label() + ' spectrogram, A0 to C8'">
      <canvas #canvas [style.height.px]="height"></canvas>
      @if (progress() < 1) {
        <span class="spectrogram-note" role="status">Drawing the spectrogram… {{ (progress() * 100).toFixed(0) }}%</span>
      }
    </div>
  `,
})
export class SpectrogramStrip {
  readonly buffer = input.required<AudioBuffer>();
  readonly time = input.required<number>();
  readonly grid = input<HarmonyGrid | null>(null);
  readonly label = input('Stem');
  readonly height = HEIGHT;
  readonly progress = signal(0);
  private readonly spectrogram = signal<Spectrogram | null>(null);
  private readonly strip = viewChild.required<ElementRef<HTMLElement>>('strip');
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private image?: ImageData;
  private scratch?: HTMLCanvasElement;
  private token = 0;

  constructor() {
    effect(() => {
      const buffer = this.buffer();
      untracked(() => void this.compute(buffer));
    });
    afterRenderEffect(() => this.draw(this.spectrogram(), this.grid(), this.time()));
  }

  private async compute(buffer: AudioBuffer): Promise<void> {
    const token = ++this.token;
    this.spectrogram.set(null);
    this.progress.set(0);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const { signal: mono, rate } = monoSignal(channels, buffer.sampleRate);
    const found = await spectrogramOf(mono, rate, share => { if (token === this.token) this.progress.set(share); });
    if (token === this.token) this.spectrogram.set(found);
  }

  // Each column of the strip is read from the frame playing at its moment; the image is one column per CSS pixel and
  // one row per spectrogram row, scaled to the canvas.
  private draw(spectrogram: Spectrogram | null, grid: HarmonyGrid | null, time: number): void {
    const canvas = this.canvas().nativeElement;
    const width = Math.max(1, Math.round(this.strip().nativeElement.clientWidth));
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(HEIGHT * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(HEIGHT * ratio);
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#000004';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!spectrogram) return;
    if (!this.image || this.image.width !== width) {
      this.image = new ImageData(width, ROWS);
      this.scratch = document.createElement('canvas');
      this.scratch.width = width;
      this.scratch.height = ROWS;
    }
    const pixels = this.image.data, middle = width / 2;
    const beats = grid && grid.beats.length > 1 ? grid.beats : null;
    const now = beats ? positionAt(beats, time) : time;
    const scale = beats ? UNIT_WIDTH : PIXELS_PER_SECOND;
    for (let x = 0; x < width; x++) {
      const at = now + (x - middle) / scale;
      const seconds = beats ? timeAtPosition(beats, at) : at;
      const frame = Math.round(seconds * spectrogram.rate / HOP);
      const inside = frame >= 0 && frame < spectrogram.frames;
      for (let row = 0; row < ROWS; row++) {
        // Low notes at the bottom.
        const pixel = ((ROWS - 1 - row) * width + x) * 4;
        const level = inside ? spectrogram.levels[frame * ROWS + row] : -RANGE_DB;
        const step = Math.round((level + RANGE_DB) / RANGE_DB * 255) * 3;
        pixels[pixel] = COLORS[step]; pixels[pixel + 1] = COLORS[step + 1]; pixels[pixel + 2] = COLORS[step + 2]; pixels[pixel + 3] = 255;
      }
    }
    this.scratch!.getContext('2d')!.putImageData(this.image, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(this.scratch!, 0, 0, canvas.width, canvas.height);
    // Every C, named, and the playhead.
    context.scale(ratio, ratio);
    context.font = '11px system-ui, sans-serif';
    for (let pitch = 24; pitch <= 108; pitch += 12) {
      const y = HEIGHT - ((pitch - LOWEST_PITCH) * ROWS_PER_SEMITONE + 0.5) / ROWS * HEIGHT;
      context.fillStyle = 'rgba(255, 255, 255, 0.18)';
      context.fillRect(0, Math.round(y), width, 1);
      context.fillStyle = 'rgba(255, 255, 255, 0.85)';
      context.fillText(`C${pitch / 12 - 1}`, 4, y - 2);
    }
    context.fillStyle = 'rgba(255, 255, 255, 0.9)';
    context.fillRect(Math.round(middle), 0, 1, HEIGHT);
  }
}
