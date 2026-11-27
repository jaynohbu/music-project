// A page for looking closely at the Harmonic (other) stem: its waveform over the whole song, and its waveform,
// spectrogram and the energy that stands out in it (spectrogram.ts meaningful) flowing as it plays, on one time
// scale with the moment playing at the middle. It plays the stem as it is, only what the meaningful view keeps (the
// stem's own sound in those cells, the rest silenced: spectrogram.ts maskedSignal), or only what it leaves out. The song's beats (from its
// chord analysis, when there is one) are drawn on both, bar lines brighter.
//
// A score of a passage (the intro, say) can be given: a PDF, read into MusicXML by the local score reader
// (tools/omr, Audiveris; only while running locally), or MusicXML itself. It is aligned with the song through all
// the stems (score-align.ts), its measures drawn on both views, and the Harmonic stem restored from it: the score's
// notes the stem plays, when and as loud as it plays them, drawn over the spectrogram and heard alone or with the stem.
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { StemsService, errorMessage, type HarmonyGrid, type Job } from './services';
import { type Score, parseMusicXml, unzipMusicXml } from './musicxml';
import { type AlignStem, type Alignment, alignScore, restoredScore } from './score-align';
import { harmonyMidi } from './score-export';
import { renderNotes } from './accompaniment-player';
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
// The other stems the score is compared with, besides the Harmonic stem itself.
const COMPARED: AlignStem[] = ['vocals', 'bass', 'drums'];
type Listen = 'all' | 'meaningful' | 'rest' | 'restored' | 'both';

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
        <div class="spectrum-listen" role="group" aria-label="What to hear">
          @for (choice of listenChoices; track choice.kind) {
            <button type="button" [class.secondary]="listen() !== choice.kind" [attr.aria-pressed]="listen() === choice.kind"
              (click)="hear(choice.kind)" [disabled]="!ready()">{{ choice.label }}</button>
          }
          @if (masking()) { <span class="hint" role="status">Preparing the filtered sound… the full sound plays until it is ready.</span> }
          @else if (maskedReady()) { <span class="hint">Filtered keeps {{ keptShare() }}% of the stem's energy.</span> }
        </div>
        @if (grid()) { <span class="hint">Beats from the chord analysis; bar lines brighter.</span> }
      </div>
      <div class="spectrum-score">
        <div class="spectrum-heading">
          <h2 class="spectrum-label">Score</h2>
          <label class="button-link secondary spectrum-file">{{ score() ? 'Another score…' : 'Upload a score…' }}
            <input type="file" accept=".pdf,.png,.jpg,.jpeg,.musicxml,.xml,.mxl,application/pdf" (change)="chooseScore($event)" [disabled]="!ready() || aligning()">
          </label>
          <label>The score is
            <select (change)="setIntro($any($event.target).value === 'intro')" [disabled]="aligning()">
              <option value="intro" [selected]="intro()">the song's beginning (intro)</option>
              <option value="anywhere" [selected]="!intro()">a passage anywhere in the song</option>
            </select>
          </label>
          @if (alignment()) {
            <label><input type="checkbox" [checked]="showNotes()" (change)="setShowNotes($any($event.target).checked)"> Show the score's notes</label>
            <button type="button" class="secondary" (click)="download('midi')">Restored MIDI</button>
            <button type="button" class="secondary" (click)="download('json')">Restored JSON</button>
          }
        </div>
        <p class="hint">A passage of the song (the intro, say) as a PDF or MusicXML (.musicxml, .mxl). It is found in the song by
          comparing it with every stem; the Harmonic stem is then restored from it: the score's notes the stem plays, as it plays them.</p>
        @if (scoreError()) { <p class="error" role="alert">{{ scoreError() }}</p> }
        @if (scoreStatus()) { <p class="hint" role="status">{{ scoreStatus() }}</p> }
        @if (alignment(); as found) {
          <p><strong>{{ score()?.title || scoreName() }}</strong>: {{ found.measures.length }} measures, {{ clock(found.measures[0].start) }} to
            {{ clock(found.measures[found.measures.length - 1].end) }}, about {{ tempoOf(found) }} quarters a minute{{ shiftText(found) }};
            the score and the song alike {{ percent(found.likeness) }}%.</p>
          <p>Parts:
            @for (part of found.parts; track part.name; let last = $last) {
              {{ part.name }} → {{ part.stem ?? 'no single stem' }}{{ part.stem ? ' (' + percent(part.likeness[part.stem] ?? 0) + '%)' : '' }}{{ last ? '' : '; ' }}
            }
          </p>
          <p>Restored {{ found.notes.length }} notes on the Harmonic stem; {{ found.missing.length }} score notes it does not play{{ missingText(found) }}.
            @if (rendering()) { <span class="hint">Preparing the restored sound…</span> }</p>
          <div class="spectrum-measures" role="group" aria-label="Measures">
            @for (measure of found.measures; track measure.index) {
              <button type="button" class="secondary" [class.off-beat]="!measure.onBeat" (click)="seekTo(measure.start)"
                [attr.aria-label]="'Measure ' + measure.number + ' at ' + clock(measure.start)">{{ measure.number }}</button>
            }
          </div>
        }
      </div>
      <canvas #overview class="spectrum-overview" [style.height.px]="overviewHeight" (pointerdown)="seekOverview($event)"
        role="slider" aria-label="Song position" [attr.aria-valuenow]="position()" aria-valuemin="0" [attr.aria-valuemax]="duration()"></canvas>
      <h2 class="spectrum-label">Waveform</h2>
      <canvas #wave class="spectrum-canvas" [style.height.px]="waveHeight" role="img" aria-label="Harmonic stem waveform around the moment playing"></canvas>
      <div class="spectrum-heading">
        <h2 class="spectrum-label">Spectrogram</h2>
        <button type="button" [class.secondary]="listen() !== 'all'" [attr.aria-pressed]="listen() === 'all'"
          (click)="hear('all')" [disabled]="!ready()">Listen to the full spectrum</button>
      </div>
      <canvas #spectrum class="spectrum-canvas" [class.listening]="listen() === 'all'" [style.height.px]="spectrumHeight" role="img" aria-label="Harmonic stem spectrogram around the moment playing"></canvas>
      <div class="spectrum-heading">
        <h2 class="spectrum-label">Meaningful energy</h2>
        <button type="button" [class.secondary]="listen() !== 'meaningful'" [attr.aria-pressed]="listen() === 'meaningful'"
          (click)="hear('meaningful')" [disabled]="!ready()">Listen to the filtered spectrum</button>
        <label>Above the noise floor {{ aboveFloor() }} dB
          <input type="range" min="3" max="30" step="1" [value]="aboveFloor()" (input)="setAboveFloor(+$any($event.target).value)" [disabled]="!ready()">
        </label>
        <label>Within {{ withinLoudest() }} dB of the loudest
          <input type="range" min="10" max="50" step="1" [value]="withinLoudest()" (input)="setWithinLoudest(+$any($event.target).value)" [disabled]="!ready()">
        </label>
      </div>
      <p class="hint">Only peaks along the pitch axis that stand above that pitch's usual level, are not far below the loudest
        sound at that moment, and last at least about 90 ms. Brighter is further above the floor.</p>
      <canvas #energy class="spectrum-canvas" [class.listening]="listen() !== 'all'" [style.height.px]="spectrumHeight" role="img" aria-label="The energy that stands out in the Harmonic stem around the moment playing"></canvas>
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
  readonly listen = signal<Listen>('all');
  readonly keptShare = signal(0);
  readonly masking = signal(false);
  readonly maskedReady = signal(false);
  readonly aboveFloor = signal(12);
  readonly withinLoudest = signal(30);
  readonly score = signal<Score | null>(null);
  readonly scoreName = signal('');
  readonly scoreStatus = signal('');
  readonly scoreError = signal('');
  readonly aligning = signal(false);
  readonly alignment = signal<Alignment | null>(null);
  readonly rendering = signal(false);
  readonly showNotes = signal(true);
  readonly intro = signal(true);
  private restored?: AudioBuffer;
  private both?: AudioBuffer;
  private compared = new Map<AlignStem, Promise<Spectrogram>>();
  private spectrumReady?: Promise<Spectrogram>;
  private readonly overview = viewChild.required<ElementRef<HTMLCanvasElement>>('overview');
  private readonly wave = viewChild.required<ElementRef<HTMLCanvasElement>>('wave');
  private readonly spectrum = viewChild.required<ElementRef<HTMLCanvasElement>>('spectrum');
  private readonly energy = viewChild.required<ElementRef<HTMLCanvasElement>>('energy');
  private kept?: Uint8Array;
  private mono?: Float32Array;
  private masked?: AudioBuffer;
  private rest?: AudioBuffer;
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
      this.spectrumReady = spectrogramOf(mono, rate, share => {
        if (!this.destroyed) this.status.set(`Drawing the spectrogram… ${(share * 100).toFixed(0)}%`);
      });
      this.spectrogram = await this.spectrumReady;
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
    const chosen = { all: undefined, meaningful: this.masked, rest: this.rest, restored: this.restored, both: this.both }[this.listen()];
    source.buffer = chosen ?? this.buffer;
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
    const mono = this.mono, rest = new Float32Array(signal.length);
    let kept = 0, total = 0;
    for (let index = 0; index < signal.length; index++) {
      rest[index] = mono[index] - signal[index];
      kept += signal[index] * signal[index];
      total += mono[index] * mono[index];
    }
    this.masked = this.context.createBuffer(1, signal.length, this.rate);
    this.masked.copyToChannel(signal, 0);
    this.rest = this.context.createBuffer(1, rest.length, this.rate);
    this.rest.copyToChannel(rest, 0);
    this.keptShare.set(Math.round(100 * kept / Math.max(total, 1e-12)));
    this.masking.set(false);
    this.maskedReady.set(true);
    if (this.playing() && this.listen() !== 'all') this.seekTo(this.now());
  }

  private readonly plainChoices: { kind: Listen; label: string }[] = [
    { kind: 'all', label: 'Full spectrum' }, { kind: 'meaningful', label: 'Filtered' }, { kind: 'rest', label: 'Left out' },
  ];
  private readonly scoreChoices: { kind: Listen; label: string }[] = [
    { kind: 'restored', label: 'Restored notes' }, { kind: 'both', label: 'Stem + restored' },
  ];
  get listenChoices(): { kind: Listen; label: string }[] {
    return this.alignment() ? [...this.plainChoices, ...this.scoreChoices] : this.plainChoices;
  }

  // Switches what is heard at the same moment, and plays if stopped. Until the filtered sound is ready the full one
  // plays; it switches by itself when ready.
  hear(kind: Listen): void {
    const changed = kind !== this.listen();
    this.listen.set(kind);
    if (!this.playing()) this.play();
    else if (changed) this.seekTo(this.now());
  }

  // A score file chosen: read (a PDF by the local score reader), aligned with the song, the Harmonic stem restored.
  async chooseScore(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    input.value = '';
    if (!file || this.aligning()) return;
    this.aligning.set(true);
    this.scoreError.set('');
    this.scoreName.set(file.name);
    try {
      this.scoreStatus.set(/\.(pdf|png|jpe?g)$/i.test(file.name) ? 'Reading the score (this can take a minute)…' : 'Reading the score…');
      const score = parseMusicXml(await this.scoreText(file));
      if (!score.notes.length) throw new Error('No notes were found in the score.');
      this.score.set(score);
      await this.align(score);
    } catch (error) {
      this.scoreError.set(`Could not use the score: ${errorMessage(error)}`);
    } finally {
      this.scoreStatus.set('');
      this.aligning.set(false);
    }
  }

  private async scoreText(file: File): Promise<string> {
    if (/\.mxl$/i.test(file.name)) return unzipMusicXml(new Uint8Array(await file.arrayBuffer()));
    if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) return file.text();
    let response: Response;
    try {
      response = await fetch('/omr', { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } });
    } catch {
      throw new Error('the score reader could not be reached.');
    }
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.includes('musicxml')) {
      const message = type.includes('json') ? (await response.json() as { message?: string }).message : undefined;
      throw new Error(message ?? 'PDFs are read by the score reader, which runs only locally for now (npm run omr in web/). Upload MusicXML (.musicxml or .mxl) instead.');
    }
    const parts = Number(response.headers.get('x-omr-scores') ?? 1);
    if (parts > 1) this.scoreError.set(`The score was read as ${parts} separate pieces; the first is used.`);
    return unzipMusicXml(new Uint8Array(await response.arrayBuffer()));
  }

  // How much of the song to search: two and a half times the score at the song's tempo, at least two minutes.
  private searchSeconds(score: Score): number {
    const last = score.measures[score.measures.length - 1];
    const beats = this.grid()?.beats;
    const beat = beats && beats.length > 2 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : score.tempo ? 60 / score.tempo : 0.6;
    return Math.min(this.duration(), Math.max(120, (last.start + last.length) * beat * 2.5 + 20));
  }

  private comparedSpectrogram(stem: AlignStem, seconds: number, progress: (share: number) => void): Promise<Spectrogram> {
    let found = this.compared.get(stem);
    if (!found) {
      found = (async () => {
        const url = this.job()?.stems?.[stem]?.playUrl;
        if (!url) throw new Error(`this song has no ${stem} stem.`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`the ${stem} stem request failed (HTTP ${response.status}).`);
        const decoded = await this.context!.decodeAudioData(await response.arrayBuffer());
        // The whole stem, so a later, longer search needs no second pass.
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
        const { signal } = monoSignal(channels.map(channel => channel.subarray(0, Math.ceil(Math.max(seconds, 180) * decoded.sampleRate))), decoded.sampleRate);
        return spectrogramOf(signal, this.rate, progress);
      })();
      found.catch(() => this.compared.delete(stem));
      this.compared.set(stem, found);
    }
    return found;
  }

  private async align(score: Score): Promise<void> {
    const seconds = this.searchSeconds(score);
    const other = this.spectrogram ?? await this.spectrumReady;
    if (!other) throw new Error('the Harmonic stem is not ready.');
    const spectrograms: Partial<Record<AlignStem, Spectrogram>> = { other };
    for (const [index, stem] of COMPARED.entries()) {
      try {
        spectrograms[stem] = await this.comparedSpectrogram(stem, seconds, share =>
          this.scoreStatus.set(`Looking at the ${stem} stem (${index + 1} of ${COMPARED.length})… ${(share * 100).toFixed(0)}%`));
      } catch (error) {
        // Alignment works with fewer stems.
        console.warn(`Score alignment without the ${stem} stem: ${errorMessage(error)}`);
      }
      if (this.destroyed) return;
    }
    // Usable stems only: covering the stretch searched.
    for (const stem of COMPARED) {
      const found = spectrograms[stem];
      if (found && found.frames * HOP / found.rate < Math.min(seconds, 180) - 1) delete spectrograms[stem];
    }
    this.scoreStatus.set('Finding the score in the song…');
    await new Promise(resolve => setTimeout(resolve, 30));
    const found = alignScore({ score, spectrograms, seconds: Math.min(seconds, ...Object.values(spectrograms).map(one => one!.frames * HOP / one!.rate)), beats: this.grid()?.beats, intro: this.intro() });
    this.alignment.set(found);
    this.restored = this.both = undefined;
    this.seekTo(Math.max(0, found.measures[0].start - 1));
    void this.renderRestored(found);
  }

  // The restored notes as a sound (a piano), alone and over the stem.
  private async renderRestored(found: Alignment): Promise<void> {
    if (!this.mono || !this.context) return;
    this.rendering.set(true);
    try {
      const events = found.notes.map(note => ({ time: note.start, duration: note.end - note.start, pitch: note.pitch, velocity: note.velocity }));
      const restored = await renderNotes(events, this.mono.length / this.rate, this.rate);
      if (this.alignment() !== found || this.destroyed) return;
      const alone = restored.getChannelData(0), mixed = new Float32Array(alone.length);
      for (let index = 0; index < mixed.length; index++) mixed[index] = 0.7 * (this.mono[index] ?? 0) + alone[index];
      this.restored = restored;
      this.both = this.context.createBuffer(1, mixed.length, this.rate);
      this.both.copyToChannel(mixed, 0);
      if (this.playing() && (this.listen() === 'restored' || this.listen() === 'both')) this.seekTo(this.now());
    } catch (error) {
      this.scoreError.set(`Could not prepare the restored sound: ${errorMessage(error)}`);
    } finally {
      this.rendering.set(false);
    }
  }

  download(kind: 'midi' | 'json'): void {
    const found = this.alignment(), score = this.score();
    if (!found || !score) return;
    const { notes, grid } = restoredScore(found, score);
    const blob = kind === 'midi' ? new Blob([harmonyMidi({ chords: [], notes }, grid)], { type: 'audio/midi' })
      : new Blob([JSON.stringify({
        score: score.title || this.scoreName(), shift: found.shift, secondsPerQuarter: found.secondsPerQuarter, likeness: found.likeness,
        measures: found.measures, parts: found.parts, notes: found.notes, missing: found.missing,
      }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${(this.job()?.title || 'song').replace(/[\\/:*?"<>|]+/g, ' ').trim()} - restored from score.${kind === 'midi' ? 'mid' : 'json'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // Aligned again with the score already given.
  setIntro(value: boolean): void {
    this.intro.set(value);
    const score = this.score();
    if (!score || this.aligning()) return;
    this.aligning.set(true);
    this.scoreError.set('');
    void this.align(score).catch(error => this.scoreError.set(`Could not use the score: ${errorMessage(error)}`))
      .finally(() => { this.scoreStatus.set(''); this.aligning.set(false); });
  }

  setShowNotes(value: boolean): void {
    this.showNotes.set(value);
    this.draw();
  }

  percent(value: number): number {
    return Math.round(value * 100);
  }

  tempoOf(found: Alignment): number {
    return Math.round(60 / found.secondsPerQuarter);
  }

  shiftText(found: Alignment): string {
    if (!found.shift) return '';
    const size = Math.abs(found.shift);
    return `, the song ${size} semitone${size > 1 ? 's' : ''} ${found.shift > 0 ? 'above' : 'below'} the score`;
  }

  missingText(found: Alignment): string {
    const counts = new Map<string, number>();
    for (const note of found.missing) for (const stem of note.stems) counts.set(stem, (counts.get(stem) ?? 0) + 1);
    const heard = [...counts].map(([stem, count]) => `${count} heard in ${stem}`);
    return heard.length ? ` (${heard.join(', ')})` : '';
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
    this.drawScore(context, width, time);
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
  // The aligned score: its measure lines, numbered at the top, and (when shown) the restored notes outlined at their
  // pitch, the score notes the Harmonic stem does not play dotted.
  private drawScore(context: CanvasRenderingContext2D, width: number, time: number): void {
    const found = this.alignment();
    if (!found) return;
    const x = (seconds: number) => (seconds - time) * this.pixelsPerSecond() + width / 2;
    const y = (pitch: number) => SPECTRUM_HEIGHT - ((pitch - LOWEST_PITCH) * ROWS_PER_SEMITONE + 0.5) / ROWS * SPECTRUM_HEIGHT;
    const tall = Math.max(3, ROWS_PER_SEMITONE / ROWS * SPECTRUM_HEIGHT);
    if (this.showNotes()) {
      context.lineWidth = 1;
      context.setLineDash([2, 2]);
      context.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      for (const note of found.missing) {
        if (x(note.end) < 0 || x(note.start) > width) continue;
        context.strokeRect(Math.round(x(note.start)) + 0.5, Math.round(y(note.pitch) - tall / 2) + 0.5, Math.max(2, x(note.end) - x(note.start)), tall);
      }
      context.setLineDash([]);
      context.strokeStyle = '#3df2ff';
      for (const note of found.notes) {
        if (x(note.end) < 0 || x(note.start) > width) continue;
        context.strokeRect(Math.round(x(note.start)) + 0.5, Math.round(y(note.pitch) - tall / 2) + 0.5, Math.max(2, x(note.end) - x(note.start)), tall);
      }
    }
    context.font = '12px system-ui, sans-serif';
    for (const measure of found.measures) {
      const at = Math.round(x(measure.start));
      if (at < -40 || at > width) continue;
      context.fillStyle = 'rgba(255, 214, 10, 0.9)';
      context.fillRect(at, 0, 2, SPECTRUM_HEIGHT);
      context.fillText(measure.number, at + 4, 14);
    }
    const last = found.measures[found.measures.length - 1];
    if (x(last.end) >= 0 && x(last.end) <= width) {
      context.fillStyle = 'rgba(255, 214, 10, 0.9)';
      context.fillRect(Math.round(x(last.end)), 0, 2, SPECTRUM_HEIGHT);
    }
  }
}
