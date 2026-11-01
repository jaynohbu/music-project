import { Component, EventEmitter, HostListener, Input, OnDestroy, Output, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccompanimentSettings, GeneratedStem, StemName, StemsService, errorMessage } from './services';
import {
  CHORD_NAMES, ChordEvent, HarmonySource, INSTRUMENTS, Instrument, PlayingStyle, STYLE_LABELS,
  downsampleSources, encodeWav, loadInstrument, planNotes, renderAccompaniment, stylesFor,
} from './accompaniment-audio';
import {
  Region, StemAnalysis, analyzeStem, detectRegions, loudnessProfile, regionHasChord, shapeRender,
} from './accompaniment-regions';
import { LISTENING_GAIN, RegionEditor } from './region-editor';

@Component({
  selector: 'accompaniment-wizard',
  standalone: true,
  imports: [FormsModule, RegionEditor],
  template: `
    <section class="generation-wizard" aria-label="Generate accompaniment wizard">
      <div class="section-heading">
        <div><span class="eyebrow">NEW ACCOMPANIMENT</span><h2>Step {{ step() }} of 4 · {{ headings[step() - 1] }}</h2></div>
        <button type="button" class="secondary" (click)="close()" [disabled]="busy()">Close</button>
      </div>
      <p class="hint">Runs locally in this browser. Keep this page open until saving finishes.
        Original stems are never changed. Chords are estimates, not exact transcription.</p>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (busy()) { <p role="status">{{ status() }}</p><progress [value]="progress()" max="1"></progress> }
      @if (step() === 1) {
        <fieldset [disabled]="busy()">
          <legend>Use these harmonic stems</legend>
          @for (source of harmonicNames; track source) {
            <label class="wizard-choice"><input type="checkbox" [checked]="selected.includes(source)"
              (change)="selectSource(source, $event)" [disabled]="!hasSource(source)"> {{ source }}</label>
          }
          <p class="hint">Vocals are optional. Include them if the singing should shape chords, regions and loudness.</p>
          <label for="generation-tempo">Tempo (BPM)</label>
          <input id="generation-tempo" type="number" min="40" max="240" step="1" [(ngModel)]="tempo">
          <p class="hint">Set the song's tempo for the chord grid and rhythm. Beat alignment starts at time zero.</p>
        </fieldset>
        <button type="button" (click)="analyze()" [disabled]="busy() || !selected.length">Analyze harmony</button>
      }
      @if (step() === 2) {
        <p>Review the estimated major/minor chords. “N” is silence/no chord. Correct uncertain sections before continuing.</p>
        <div class="chord-review">
          @for (chord of chords; track $index) {
            <label class="chord-row">
              <span>{{ formatTime(chord.start) }}–{{ formatTime(chord.end) }}</span>
              <select [(ngModel)]="chord.chord" [disabled]="busy()" [attr.aria-label]="'Chord at ' + formatTime(chord.start)">
                @for (name of chordNames; track name) { <option [value]="name">{{ name === 'N' ? 'N (silence)' : name }}</option> }
              </select>
              <small>{{ (chord.confidence ?? 0) < 0.5 ? 'Review suggested' : 'Estimated' }}</small>
            </label>
          }
        </div>
        <div class="wizard-navigation">
          <button type="button" class="secondary" (click)="step.set(1)">Back</button>
          <button type="button" (click)="step.set(3)" [disabled]="!hasChords()">Choose instrument</button>
        </div>
      }
      @if (step() === 3) {
        <fieldset [disabled]="busy()">
          <legend>Instrument and playing style</legend>
          <label for="generation-instrument">Instrument</label>
          <select id="generation-instrument" [ngModel]="instrument" (ngModelChange)="chooseInstrument($event)">
            @for (item of instruments; track item.id) { <option [value]="item.id">{{ item.label }}</option> }
          </select>
          <label for="generation-style">Style</label>
          <select id="generation-style" [(ngModel)]="style">
            @for (item of styles(); track item) { <option [value]="item">{{ styleLabels[item] }}</option> }
          </select>
          <p class="hint">Piano and guitars use bundled instrument samples, not exact recreations of the recorded instruments.</p>
        </fieldset>
        <div class="wizard-navigation">
          <button type="button" class="secondary" (click)="back(2)" [disabled]="busy()">Back</button>
          <button type="button" (click)="enterFinalStep()" [disabled]="busy()">Select regions</button>
        </div>
      }
      @if (step() === 4) {
        <p>{{ instrumentLabel() }} · {{ styleLabels[style] }} · {{ tempo }} BPM · {{ formatTime(duration) }}</p>
        <p class="hint">Regions were found where the selected stems contain audible music. Use Play selection
          to hear those stems inside the regions. Accompaniment is generated only there and is silent elsewhere,
          so the saved WAV stays aligned with the song. Its level follows the average and the rises and falls of these stems.</p>
        @if (analysisReady()) {
          <region-editor [stems]="stems" [sources]="regionSources" [regions]="regions" [detected]="detected"
            [chords]="chords" [duration]="duration" [audio]="audio" [disabled]="busy()"
            (regionsChange)="onRegions($event)" (listening)="stopPreview()"></region-editor>
        }
        <p class="hint">Preview with sources plays up to 12 seconds from the first region that has chords.
          The full generated WAV will be saved privately and appear as a new channel on future visits.</p>
        @if (pending && error()) {
          <p class="hint">Retry save keeps your rendered audio. If the save expired, use Back, then generate and save again.</p>
        }
        <div class="wizard-navigation">
          <button type="button" class="secondary" (click)="back(3)" [disabled]="busy()">Back</button>
          <button type="button" class="secondary" (click)="preview()" [disabled]="busy() || previewing() || !canGenerate()">
            Preview with sources
          </button>
          <button type="button" class="secondary" (click)="stopPreview()" [disabled]="!previewing()">Stop preview</button>
          <button type="button" (click)="save()" [disabled]="busy() || !canGenerate()">
            {{ pending ? 'Retry save' : 'Generate full stem and save' }}
          </button>
        </div>
      }
      <p class="hint instrument-credit">Instrument samples: FluidR3 by Frank Wen, via midi-js-soundfonts.
        <a href="/instruments/LICENSE.txt" target="_blank" rel="noopener">CC BY 3.0 attribution</a>.
        Generated WAVs using those samples should retain this attribution when shared.</p>
    </section>
  `,
})
export class AccompanimentWizard implements OnDestroy {
  @Input({ required: true }) jobId = '';
  @Input({ required: true }) sources: HarmonySource[] = [];
  @Input({ required: true }) duration = 0;
  @Output() saved = new EventEmitter<GeneratedStem>();
  @Output() closed = new EventEmitter<void>();
  private readonly service = inject(StemsService);
  readonly headings = ['Choose sources', 'Review chords', 'Choose sound', 'Select regions and save'];
  readonly instruments = INSTRUMENTS;
  readonly chordNames = CHORD_NAMES;
  readonly styleLabels = STYLE_LABELS;
  readonly harmonicNames: StemName[] = ['piano', 'guitar', 'bass', 'other', 'vocals'];
  readonly step = signal(1);
  readonly busy = signal(false);
  readonly status = signal('');
  readonly progress = signal(0);
  readonly error = signal('');
  readonly previewing = signal(false);
  readonly analysisReady = signal(false);
  selected: StemName[] = ['piano', 'guitar', 'bass'];
  tempo = 120;
  instrument: Instrument = 'synth';
  style: PlayingStyle = 'pad';
  chords: ChordEvent[] = [];
  pending?: { settings: AccompanimentSettings; wav: Blob; id?: string };
  stems: StemAnalysis[] = [];
  regionSources: HarmonySource[] = [];
  regions: Region[] = [];
  detected: Region[] = [];
  readonly audio = (): AudioContext => { this.context ??= new AudioContext(); return this.context; };
  @ViewChild(RegionEditor) private editor?: RegionEditor;
  private analysisKey = '';
  private readonly analyses = new Map<string, StemAnalysis>();
  private seed = 0;
  private context?: AudioContext;
  private controller = new AbortController();
  private worker?: Worker;
  private rejectAnalysis?: (error: Error) => void;
  private previewSources: AudioBufferSourceNode[] = [];
  private sampleCache?: { instrument: Instrument; samples: Map<number, AudioBuffer> };
  private destroyed = false;

  @HostListener('window:beforeunload', ['$event'])
  warnBeforeLeaving(event: BeforeUnloadEvent): void {
    if (this.busy()) { event.preventDefault(); event.returnValue = ''; }
  }

  hasSource(name: string): boolean { return this.sources.some(source => source.name === name); }
  hasChords(): boolean { return this.chords.some(chord => chord.chord !== 'N'); }
  styles(): PlayingStyle[] { return stylesFor(this.instrument); }
  instrumentLabel(): string { return INSTRUMENTS.find(item => item.id === this.instrument)!.label; }
  formatTime(value: number): string {
    return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  }
  selectSource(name: StemName, event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.selected = event.target.checked ? [...this.selected, name] : this.selected.filter(item => item !== name);
  }
  chooseInstrument(value: Instrument): void {
    this.stopPreview();
    this.instrument = value;
    if (!this.styles().includes(this.style)) this.style = this.styles()[0];
    this.sampleCache = undefined;
  }
  back(step: number): void { this.stopPreview(); this.editor?.stop(); this.pending = undefined; this.step.set(step); }
  canGenerate(): boolean { return this.regions.some(region => regionHasChord(region, this.chords)); }
  onRegions(regions: Region[]): void {
    this.stopPreview();
    // Rendered audio no longer matches the selection, so a retry must not upload it.
    this.pending = undefined;
    this.regions = regions;
    this.error.set('');
  }

  async enterFinalStep(): Promise<void> {
    if (this.busy()) return;
    this.step.set(4);
    const key = [...this.selected].sort().join();
    if (key === this.analysisKey) return;
    this.analysisReady.set(false);
    this.busy.set(true); this.error.set(''); this.status.set('Finding music in the selected stems...'); this.progress.set(0);
    try {
      const sources = this.sources.filter(source => this.selected.some(name => name === source.name));
      for (const [index, { name, buffer }] of sources.entries()) {
        if (!this.analyses.has(name)) {
          // Yield so progress paints between stems.
          await new Promise(resolve => setTimeout(resolve));
          if (this.destroyed) return;
          const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
          this.analyses.set(name, analyzeStem(name, channels, buffer.sampleRate));
        }
        this.progress.set((index + 1) / sources.length);
      }
      this.regionSources = sources;
      this.stems = sources.map(source => this.analyses.get(source.name)!);
      this.detected = detectRegions(this.stems, this.duration);
      this.regions = this.detected;
      this.seed = crypto.getRandomValues(new Uint32Array(1))[0];
      this.analysisKey = key;
      this.analysisReady.set(true);
      if (!this.regions.length) this.error.set('No audible music was found in these stems. Add a region by hand or choose other sources.');
    } catch (error) {
      if (!this.destroyed) this.error.set(`Could not analyze the selected stems: ${errorMessage(error)}`);
    } finally { if (!this.destroyed) this.busy.set(false); }
  }

  private shaped(offset: number, exact: boolean): (channels: Float32Array[], sampleRate: number) => void {
    const profile = loudnessProfile(this.stems, this.regions), regions = this.regions;
    return (channels, sampleRate) => shapeRender(channels, sampleRate, offset, profile, regions, exact);
  }
  private notes() {
    return planNotes(this.chords, this.instrument, this.style, this.tempo, this.regions, this.seed);
  }
  close(): void { if (!this.busy()) { this.stopPreview(); this.closed.emit(); } }

  async analyze(): Promise<void> {
    if (this.busy()) return;
    this.error.set('');
    if (!Number.isFinite(this.tempo) || this.tempo < 40 || this.tempo > 240 ||
        !this.selected.length || this.selected.some(name => !this.hasSource(name))) {
      this.error.set('Select available harmonic stems and a tempo from 40 to 240 BPM.');
      return;
    }
    this.busy.set(true); this.status.set('Analyzing harmony locally...'); this.progress.set(0);
    try {
      const samples = downsampleSources(this.sources.filter(source => this.selected.some(name => name === source.name)), this.duration);
      this.worker = new Worker('/harmony-worker.mjs?v=1', { type: 'module' });
      const chords = await new Promise<ChordEvent[]>((resolve, reject) => {
        this.rejectAnalysis = reject;
        this.worker!.onerror = event => reject(new Error(event.message || 'Harmony worker failed.'));
        this.worker!.onmessage = (event: MessageEvent<{ progress?: number; chords?: ChordEvent[]; error?: string }>) => {
          if (event.data.error) reject(new Error(event.data.error));
          else if (event.data.chords) resolve(event.data.chords);
          else if (event.data.progress !== undefined) this.progress.set(event.data.progress);
        };
        this.worker!.postMessage({ samples, sampleRate: 11025, duration: this.duration, tempo: this.tempo }, [samples.buffer]);
      });
      if (this.destroyed) return;
      this.chords = chords;
      this.step.set(2);
      if (!this.hasChords()) this.error.set('No reliable harmony detected. Choose different sources or enter chords manually.');
    } catch (error) {
      if (!this.destroyed) this.error.set(`Analysis failed: ${errorMessage(error)}`);
    } finally {
      this.worker?.terminate(); this.worker = undefined; this.rejectAnalysis = undefined;
      if (!this.destroyed) this.busy.set(false);
    }
  }

  private async engine(): Promise<{ context: AudioContext; samples: Map<number, AudioBuffer> }> {
    const context = this.audio();
    await context.resume();
    if (this.sampleCache?.instrument !== this.instrument) {
      this.status.set('Loading bundled instrument samples...');
      const samples = await loadInstrument(this.instrument, context, this.controller.signal);
      this.sampleCache = { instrument: this.instrument, samples };
    }
    this.controller.signal.throwIfAborted();
    return { context, samples: this.sampleCache.samples };
  }

  async preview(): Promise<void> {
    if (this.busy()) return;
    this.editor?.stop();
    this.busy.set(true); this.error.set(''); this.progress.set(0);
    try {
      const { context, samples } = await this.engine();
      const region = this.regions.find(item => regionHasChord(item, this.chords))!;
      const chord = this.chords.find(item => item.chord !== 'N' && item.start < region.end && item.end > region.start)!;
      const offset = Math.max(region.start, chord.start);
      const duration = Math.min(12, this.duration - offset);
      this.status.set('Rendering preview...');
      const buffer = await renderAccompaniment(this.notes(), this.instrument, samples, duration, offset, this.shaped(offset, false));
      this.controller.signal.throwIfAborted();
      const start = context.currentTime + 0.05;
      this.stopPreview();
      // Equal gains, so the balance heard here is the balance saved to the mixer.
      const previewBuffers = [
        { buffer, offset: 0 },
        ...this.regionSources.map(source => ({ buffer: source.buffer, offset })),
      ];
      for (const item of previewBuffers) {
        const source = context.createBufferSource(), gain = context.createGain();
        source.buffer = item.buffer; gain.gain.value = LISTENING_GAIN;
        source.connect(gain); gain.connect(context.destination);
        source.onended = () => {
          source.disconnect(); gain.disconnect();
          this.previewSources = this.previewSources.filter(value => value !== source);
          if (!this.previewSources.length) this.previewing.set(false);
        };
        this.previewSources.push(source);
        source.start(start, item.offset, duration);
      }
      this.previewing.set(true);
    } catch (error) {
      this.stopPreview();
      if (!this.destroyed) this.error.set(`Preview failed: ${errorMessage(error)}`);
    } finally { if (!this.destroyed) this.busy.set(false); }
  }

  stopPreview(): void {
    for (const source of this.previewSources) source.stop();
    this.previewSources = [];
    this.previewing.set(false);
  }

  async save(): Promise<void> {
    if (this.busy()) return;
    this.stopPreview(); this.editor?.stop(); this.busy.set(true); this.error.set(''); this.progress.set(0);
    try {
      if (!this.pending) {
        const { samples } = await this.engine();
        this.status.set('Rendering full-length accompaniment locally...');
        const buffer = await renderAccompaniment(this.notes(), this.instrument, samples, this.duration, 0, this.shaped(0, true));
        this.controller.signal.throwIfAborted();
        this.pending = {
          settings: { requestId: crypto.randomUUID(), instrument: this.instrument, style: this.style,
            tempo: this.tempo, sources: [...this.selected],
            chords: this.chords.map(({ start, end, chord }) => ({ start, end, chord })),
            regions: this.regions, seed: this.seed },
          wav: encodeWav(buffer),
        };
      }
      this.progress.set(0.5); this.status.set('Preparing private storage...');
      if (!this.pending.id) {
        const response = await this.service.createAccompaniment(this.jobId, this.pending.settings);
        this.controller.signal.throwIfAborted();
        if (!response.upload) {
          if (!('playUrl' in response.accompaniment)) throw new Error('The service did not provide an upload or saved stem.');
          this.pending = undefined;
          this.saved.emit(response.accompaniment);
          return;
        }
        const form = new FormData();
        for (const [key, value] of Object.entries(response.upload.fields)) form.append(key, value);
        form.append('file', this.pending.wav, 'accompaniment.wav');
        this.status.set('Uploading generated WAV...');
        const upload = await fetch(response.upload.url, { method: 'POST', body: form, signal: this.controller.signal });
        if (!upload.ok) throw new Error(`Upload failed (HTTP ${upload.status}).`);
        this.pending.id = response.accompaniment.id;
      }
      this.status.set('Verifying and saving the new stem...'); this.progress.set(0.9);
      const result = await this.service.completeAccompaniment(this.jobId, this.pending.id);
      this.controller.signal.throwIfAborted();
      this.pending = undefined; this.progress.set(1);
      this.saved.emit(result.accompaniment);
    } catch (error) {
      if (!this.destroyed) this.error.set(`Could not save accompaniment: ${errorMessage(error)} Your original stems are unchanged.`);
    } finally { if (!this.destroyed) this.busy.set(false); }
  }

  ngOnDestroy(): void {
    this.destroyed = true; this.controller.abort(); this.worker?.terminate();
    this.rejectAnalysis?.(new Error('Wizard closed.'));
    this.stopPreview(); this.sampleCache = undefined; this.pending = undefined;
    if (this.context && this.context.state !== 'closed') void this.context.close();
  }
}
