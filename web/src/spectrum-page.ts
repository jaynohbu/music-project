// A page for looking closely at the Harmonic (other) stem: its waveform over the whole song, and its waveform,
// spectrogram and the energy that stands out in it (spectrogram.ts meaningful) flowing as it plays, on one time
// scale with the moment playing at the middle. It plays either the stem as it is or only what the meaningful view
// keeps (the stem's own sound in those cells, the rest silenced: spectrogram.ts maskedSignal). The song's beats (from its
// chord analysis, when there is one) are drawn on both, bar lines brighter.
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { StemsService, errorMessage, type HarmonyGrid, type Job } from './services';
import {
  HOP, LOWEST_PITCH, RANGE_DB, ROWS, ROWS_PER_SEMITONE, type Spectrogram, heatColors, maskedSignal, meaningful, monoSignal, spectrogramOf,
} from './spectrogram';

const STEM = 'other';
const WAVE_HEIGHT = 140;
const SPECTRUM_HEIGHT = 360;
const OVERVIEW_HEIGHT = 64;
// Zoom: pixels per second.
const ZOOMS = [40, 80, 160, 320, 640];
const COLORS = heatColors();

// The loudest sample (absolute) in each block of a signal.
function blockPeaks(signal: Float32Array, block: number) {
  const peaks = new Float32Array(Math.ceil(signal.length / block));
  for (let index = 0; index < signal.length; index++) {
    const value = Math.abs(signal[index]), at = (index / block) | 0;
    if (value > peaks[at]) peaks[at] = value;
  }
  return peaks;
}

@Component({
  selector: 'app-spectrum-page',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card spectrum-page">
      <div class="section-heading">
        <div>
          <h1>{{ job()?.title || 'Song' }}</h1>
          <p class="hint">Harmonic stem (guitars, keys and the other instruments): waveform and spectrogram, A0 to C8.
            The middle line is the moment playing.</p>
        </div>
        <a class="button-link" [routerLink]="['/mixer', jobId]">Back to the mixer</a>
      </div>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (status()) { <p class="hint" role="status">{{ status() }}</p> }
      <div class="spectrum-transport">
        <button type="button" (click)="toggle()" [disabled]="!ready()">{{ playing() ? 'Pause' : 'Play' }}</button>
        <span class="spectrum-time">{{ clock(position()) }} / {{ clock(duration()) }}</span>
        <label>Zoom
          <select (change)="setZoom(+$any($event.target).value)" [disabled]="!ready()">
            @for (zoom of zooms; track zoom) { <option [value]="zoom" [selected]="zoom === pixelsPerSecond()">{{ zoom }} px/s</option> }
          </select>
        </label>
        <div class="spectrum-listen" role="radiogroup" aria-label="What to hear">
          <label><input type="radio" name="listen" value="all" [checked]="listen() === 'all'" (change)="setListen('all')"
            [disabled]="!ready()"> Everything (full spectrum)</label>
          <label><input type="radio" name="listen" value="meaningful" [checked]="listen() === 'meaningful'"
            (change)="setListen('meaningful')" [disabled]="!maskedReady()"> Meaningful energy only{{ masking() ? ' (preparing…)' : '' }}</label>
        </div>
        @if (grid()) { <span class="hint">Beats from the chord analysis; bar lines brighter.</span> }
      </div>
      <canvas #overview class="spectrum-overview" [style.height.px]="overviewHeight" (pointerdown)="seekOverview($event)"
        role="slider" aria-label="Song position" [attr.aria-valuenow]="position()" aria-valuemin="0" [attr.aria-valuemax]="duration()"></canvas>
      <h2 class="spectrum-label">Waveform</h2>
      <canvas #wave class="spectrum-canvas" [style.height.px]="waveHeight" role="img" aria-label="Harmonic stem waveform around the moment playing"></canvas>
      <h2 class="spectrum-label">Spectrogram</h2>
      <canvas #spectrum class="spectrum-canvas" [class.listening]="listen() === 'all'" [style.height.px]="spectrumHeight" role="img" aria-label="Harmonic stem spectrogram around the moment playing"></canvas>
      <div class="spectrum-heading">
        <h2 class="spectrum-label">Meaningful energy</h2>
        <label>Above the noise floor {{ aboveFloor() }} dB
          <input type="range" min="3" max="30" step="1" [value]="aboveFloor()" (input)="setAboveFloor(+$any($event.target).value)" [disabled]="!ready()">
        </label>
        <label>Within {{ withinLoudest() }} dB of the loudest
          <input type="range" min="10" max="50" step="1" [value]="withinLoudest()" (input)="setWithinLoudest(+$any($event.target).value)" [disabled]="!ready()">
        </label>
      </div>
      <p class="hint">Only peaks along the pitch axis that stand above that pitch's usual level, are not far below the loudest
        sound at that moment, and last at least about 90 ms. Brighter is further above the floor.</p>
      <canvas #energy class="spectrum-canvas" [class.listening]="listen() === 'meaningful'" [style.height.px]="spectrumHeight" role="img" aria-label="The energy that stands out in the Harmonic stem around the moment playing"></canvas>
    </section>
  `,
})
export class SpectrumPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly stems = inject(StemsService);
  readonly zooms = ZOOMS;
  readonly waveHeight = WAVE_HEIGHT;
  readonly spectrumHeight = SPECTRUM_HEIGHT;
  readonly overviewHeight = OVERVIEW_HEIGHT;
  readonly jobId = this.route.snapshot.paramMap.get('jobId') ?? '';
  readonly job = signal<Job | null>(null);
  readonly error = signal('');
  readonly status = signal('Loading the Harmonic stem…');
  readonly ready = signal(false);
  readonly playing = signal(false);
  readonly position = signal(0);
  readonly duration = signal(0);
  readonly pixelsPerSecond = signal(160);
  readonly grid = signal<HarmonyGrid | null>(null);
  readonly listen = signal<'all' | 'meaningful'>('all');
  readonly masking = signal(false);
  readonly maskedReady = signal(false);
  readonly aboveFloor = signal(12);
  readonly withinLoudest = signal(30);
  private readonly overview = viewChild.required<ElementRef<HTMLCanvasElement>>('overview');
  private readonly wave = viewChild.required<ElementRef<HTMLCanvasElement>>('wave');
  private readonly spectrum = viewChild.required<ElementRef<HTMLCanvasElement>>('spectrum');
  private readonly energy = viewChild.required<ElementRef<HTMLCanvasElement>>('energy');
  private kept?: Uint8Array;
  private mono?: Float32Array;
  private masked?: AudioBuffer;
  private maskToken = 0;
  private keptTimer?: ReturnType<typeof setTimeout>;
  private context?: AudioContext;
  private buffer?: AudioBuffer;
  private source?: AudioBufferSourceNode;
  private startedAt = 0;
  private startOffset = 0;
  private frame = 0;
  private destroyed = false;
  private rate = 1;
  private peaks = new Float32Array(0);       // Per PEAK_BLOCK samples of the mono signal.
  private overviewPeaks = new Float32Array(0);
  private spectrogram?: Spectrogram;
  private image?: ImageData;
  private scratch?: HTMLCanvasElement;
  private readonly peakBlock = 64;
  private readonly resize = () => this.draw();

  ngOnInit(): void {
    window.addEventListener('resize', this.resize);
    void this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    window.removeEventListener('resize', this.resize);
    cancelAnimationFrame(this.frame);
    clearTimeout(this.keptTimer);
    this.stopSource();
    void this.context?.close();
  }

  private async load(): Promise<void> {
    try {
      const { job } = await this.stems.getJob(this.jobId);
      this.job.set(job);
      const url = job.stems?.[STEM]?.playUrl;
      if (!url) throw new Error('This song has no Harmonic stem yet.');
      void this.loadGrid(job);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Audio request failed (HTTP ${response.status}).`);
      this.context = new AudioContext();
      this.buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (this.destroyed) return;
      this.duration.set(this.buffer.duration);
      const channels = Array.from({ length: this.buffer.numberOfChannels }, (_, index) => this.buffer!.getChannelData(index));
      const { signal: mono, rate } = monoSignal(channels, this.buffer.sampleRate);
      this.rate = rate;
      this.mono = mono;
      this.peaks = blockPeaks(mono, this.peakBlock);
      this.overviewPeaks = blockPeaks(mono, Math.max(1, Math.ceil(mono.length / 2000)));
      this.ready.set(true);
      this.status.set('Drawing the spectrogram… 0%');
      this.draw();
      this.spectrogram = await spectrogramOf(mono, rate, share => {
        if (!this.destroyed) this.status.set(`Drawing the spectrogram… ${(share * 100).toFixed(0)}%`);
      });
      if (this.destroyed) return;
      this.kept = meaningful(this.spectrogram, this.aboveFloor(), this.withinLoudest());
      this.status.set('');
      this.draw();
      void this.rebuildMasked();
    } catch (error) {
      this.status.set('');
      this.error.set(`Could not load the Harmonic stem: ${errorMessage(error)}`);
    }
  }

  // The beats of the song's chord analysis, when it has one.
  private async loadGrid(job: Job): Promise<void> {
    const shown = job.harmony?.status === 'completed' ? job.harmony : job.harmony?.previous;
    if (!shown?.url) return;
    try {
      const response = await fetch(shown.url);
      if (!response.ok) return;
      const { beats, firstBar } = await response.json() as HarmonyGrid;
      if (!this.destroyed && beats?.length > 1) {
        this.grid.set({ beats, firstBar });
        this.draw();
      }
    } catch { /* The page works without beats. */ }
  }

  toggle(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  private play(): void {
    if (!this.context || !this.buffer) return;
    void this.context.resume();
    if (this.position() >= this.buffer.duration - 0.01) this.position.set(0);
    const source = this.context.createBufferSource();
    source.buffer = this.listen() === 'meaningful' && this.masked ? this.masked : this.buffer;
    source.connect(this.context.destination);
    this.startedAt = this.context.currentTime + 0.02;
    this.startOffset = this.position();
    source.start(this.startedAt, this.startOffset);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = undefined;
      this.playing.set(false);
      this.position.set(this.buffer?.duration ?? 0);
      this.draw();
    };
    this.source = source;
    this.playing.set(true);
    this.tick();
  }

  private pause(): void {
    this.position.set(this.now());
    this.stopSource();
    this.playing.set(false);
    this.draw();
  }

  private stopSource(): void {
    const source = this.source;
    this.source = undefined;
    try { source?.stop(); } catch { /* Already stopped. */ }
  }

  private now(): number {
    if (!this.playing() || !this.context) return this.position();
    return Math.min(this.duration(), this.startOffset + Math.max(0, this.context.currentTime - this.startedAt));
  }

  private tick(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.keptTimer);
    const step = () => {
      if (!this.playing() || this.destroyed) return;
      this.position.set(this.now());
      this.draw();
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  seekTo(seconds: number): void {
    const time = Math.max(0, Math.min(this.duration(), seconds));
    const wasPlaying = this.playing();
    if (wasPlaying) { this.stopSource(); this.playing.set(false); }
    this.position.set(time);
    if (wasPlaying) this.play();
    else this.draw();
  }

  seekOverview(event: PointerEvent): void {
    const canvas = event.currentTarget as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    this.seekTo((event.clientX - rect.left) / rect.width * this.duration());
  }

  setAboveFloor(value: number): void {
    this.aboveFloor.set(value);
    this.refindEnergy();
  }

  setWithinLoudest(value: number): void {
    this.withinLoudest.set(value);
    this.refindEnergy();
  }

  // Found again once the slider rests a moment.
  private refindEnergy(): void {
    clearTimeout(this.keptTimer);
    this.keptTimer = setTimeout(() => {
      if (!this.spectrogram || this.destroyed) return;
      this.kept = meaningful(this.spectrogram, this.aboveFloor(), this.withinLoudest());
      this.draw();
      void this.rebuildMasked();
    }, 120);
  }

  // The stem with only the meaningful cells, rebuilt as the sliders change; heard at once when it is being heard.
  private async rebuildMasked(): Promise<void> {
    if (!this.spectrogram || !this.kept || !this.mono || !this.context) return;
    const token = ++this.maskToken;
    this.masking.set(true);
    const signal = await maskedSignal(this.mono, this.rate, this.kept, this.spectrogram.frames);
    if (token !== this.maskToken || this.destroyed || !this.context) return;
    const buffer = this.context.createBuffer(1, signal.length, this.rate);
    buffer.copyToChannel(signal, 0);
    this.masked = buffer;
    this.masking.set(false);
    this.maskedReady.set(true);
    if (this.playing() && this.listen() === 'meaningful') this.seekTo(this.now());
  }

  setListen(kind: 'all' | 'meaningful'): void {
    if (kind === this.listen()) return;
    this.listen.set(kind);
    // Carries on from the same moment in the other sound.
    if (this.playing()) this.seekTo(this.now());
  }

  setZoom(value: number): void {
    this.pixelsPerSecond.set(value);
    this.draw();
  }

  clock(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, '0')}`;
  }

  // A canvas sized to its CSS box at the screen's pixel ratio; drawing is in CSS pixels.
  private prepare(canvas: HTMLCanvasElement, height: number): { context: CanvasRenderingContext2D; width: number } | null {
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width };
  }

  private draw(): void {
    if (this.destroyed) return;
    const time = this.position();
    this.drawOverview(time);
    this.drawWave(time);
    this.drawSpectrum(this.spectrum().nativeElement, time, (frame, row) => {
      const level = this.spectrogram!.levels[frame * ROWS + row];
      return Math.round((level + RANGE_DB) / RANGE_DB * 255);
    });
    this.drawSpectrum(this.energy().nativeElement, time, (frame, row) => {
      const above = this.kept?.[frame * ROWS + row] ?? 0;
      return above ? Math.min(255, 80 + above * 6) : 0;
    });
  }

  // Seconds at each pixel column of a flowing view, the moment playing at the middle.
  private secondsAt(x: number, width: number, time: number): number {
    return time + (x - width / 2) / this.pixelsPerSecond();
  }

  private drawBeats(context: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    const grid = this.grid();
    if (!grid) return;
    const from = this.secondsAt(0, width, time), to = this.secondsAt(width, width, time);
    grid.beats.forEach((beat, index) => {
      if (beat < from || beat > to) return;
      const bar = (index - grid.firstBar) % 4 === 0;
      context.fillStyle = bar ? 'rgba(120, 200, 255, 0.55)' : 'rgba(120, 200, 255, 0.2)';
      context.fillRect(Math.round((beat - time) * this.pixelsPerSecond() + width / 2), 0, 1, height);
    });
  }

  private drawPlayhead(context: CanvasRenderingContext2D, width: number, height: number): void {
    context.fillStyle = '#ff4d4d';
    context.fillRect(Math.round(width / 2), 0, 1, height);
  }

  private drawOverview(time: number): void {
    const prepared = this.prepare(this.overview().nativeElement, OVERVIEW_HEIGHT);
    if (!prepared) return;
    const { context, width } = prepared, middle = OVERVIEW_HEIGHT / 2;
    context.fillStyle = '#0d1117';
    context.fillRect(0, 0, width, OVERVIEW_HEIGHT);
    const peaks = this.overviewPeaks, duration = this.duration();
    if (!peaks.length || !duration) return;
    context.fillStyle = '#5b8def';
    for (let x = 0; x < width; x++) {
      const low = Math.floor(x / width * peaks.length), high = Math.max(low + 1, Math.floor((x + 1) / width * peaks.length));
      let peak = 0;
      for (let index = low; index < high && index < peaks.length; index++) peak = Math.max(peak, peaks[index]);
      const size = peak * (middle - 2);
      context.fillRect(x, middle - size, 1, Math.max(1, 2 * size));
    }
    // The stretch the flowing views show, and the moment playing.
    const shown = width / this.pixelsPerSecond() / duration * width;
    context.fillStyle = 'rgba(255, 255, 255, 0.12)';
    context.fillRect(time / duration * width - shown / 2, 0, shown, OVERVIEW_HEIGHT);
    context.fillStyle = '#ff4d4d';
    context.fillRect(Math.round(time / duration * width), 0, 1, OVERVIEW_HEIGHT);
  }

  private drawWave(time: number): void {
    const prepared = this.prepare(this.wave().nativeElement, WAVE_HEIGHT);
    if (!prepared) return;
    const { context, width } = prepared, middle = WAVE_HEIGHT / 2;
    context.fillStyle = '#0d1117';
    context.fillRect(0, 0, width, WAVE_HEIGHT);
    context.fillStyle = 'rgba(255, 255, 255, 0.12)';
    context.fillRect(0, Math.round(middle), width, 1);
    this.drawBeats(context, width, WAVE_HEIGHT, time);
    const peaks = this.peaks, perSecond = this.rate / this.peakBlock;
    if (peaks.length) {
      context.fillStyle = '#7fd1ae';
      for (let x = 0; x < width; x++) {
        const low = Math.floor(this.secondsAt(x, width, time) * perSecond);
        const high = Math.max(low + 1, Math.floor(this.secondsAt(x + 1, width, time) * perSecond));
        let peak = 0;
        for (let index = Math.max(0, low); index < high && index < peaks.length; index++) peak = Math.max(peak, peaks[index]);
        const size = peak * (middle - 4);
        if (size > 0) context.fillRect(x, middle - size, 1, Math.max(1, 2 * size));
      }
    }
    this.drawPlayhead(context, width, WAVE_HEIGHT);
  }

  // Each column is read from the frame playing at its moment: one image column per CSS pixel and one row per
  // spectrogram row, scaled to the canvas; low notes at the bottom. step(frame, row): the colour, 0 to 255.
  private drawSpectrum(canvas: HTMLCanvasElement, time: number, step: (frame: number, row: number) => number): void {
    const prepared = this.prepare(canvas, SPECTRUM_HEIGHT);
    if (!prepared) return;
    const { context, width } = prepared;
    context.fillStyle = '#000004';
    context.fillRect(0, 0, width, SPECTRUM_HEIGHT);
    const spectrogram = this.spectrogram;
    if (spectrogram) {
      if (!this.image || this.image.width !== width) {
        this.image = new ImageData(width, ROWS);
        this.scratch = document.createElement('canvas');
        this.scratch.width = width;
        this.scratch.height = ROWS;
      }
      const pixels = this.image.data;
      for (let x = 0; x < width; x++) {
        const frame = Math.round(this.secondsAt(x, width, time) * spectrogram.rate / HOP);
        const inside = frame >= 0 && frame < spectrogram.frames;
        for (let row = 0; row < ROWS; row++) {
          const pixel = ((ROWS - 1 - row) * width + x) * 4;
          const color = (inside ? step(frame, row) : 0) * 3;
          pixels[pixel] = COLORS[color]; pixels[pixel + 1] = COLORS[color + 1]; pixels[pixel + 2] = COLORS[color + 2]; pixels[pixel + 3] = 255;
        }
      }
      this.scratch!.getContext('2d')!.putImageData(this.image, 0, 0);
      context.imageSmoothingEnabled = false;
      context.drawImage(this.scratch!, 0, 0, width, SPECTRUM_HEIGHT);
    }
    this.drawBeats(context, width, SPECTRUM_HEIGHT, time);
    // Every C, named.
    context.font = '11px system-ui, sans-serif';
    for (let pitch = 24; pitch <= 108; pitch += 12) {
      const y = SPECTRUM_HEIGHT - ((pitch - LOWEST_PITCH) * ROWS_PER_SEMITONE + 0.5) / ROWS * SPECTRUM_HEIGHT;
      context.fillStyle = 'rgba(255, 255, 255, 0.18)';
      context.fillRect(0, Math.round(y), width, 1);
      context.fillStyle = 'rgba(255, 255, 255, 0.85)';
      context.fillText(`C${pitch / 12 - 1}`, 4, y - 2);
    }
    this.drawPlayhead(context, width, SPECTRUM_HEIGHT);
  }
}
