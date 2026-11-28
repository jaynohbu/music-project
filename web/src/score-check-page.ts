// A page for checking a song's uploaded score against its stem, a part at a time (Harmonic, bass or drums): the PDF's
// transcript as it is (the score as printed, at its own tempo, in its written key) and the transcript made from it
// for the song (what the mixer plays: the score unfolded as played, every measure as written, laid on the song from
// its anchor, score-align.ts layFromAnchor), each drawn and played. Each bar is marked over both transcripts with how
// like the stem the PDF's measure is where it was laid, "est." for a measure outside the anchor (its time from the
// beats around, not synced with the stem). Choosing a bar plays the PDF's measure, the stem there, the made bar, or
// the made bar with the stem.
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { StemsService, errorMessage, type HarmonyGrid, type HarmonyPart, type Job, type ScorePartName } from './services';
import type { NoteEvent, StyleLibrary } from './accompaniment';
import { beatTime, offered } from './accompaniment';
import { loadLibrary, matchLoudness, renderNotes } from './accompaniment-player';
import { type BarMark, levelColor, sheetLines, tempo } from './score-sheet';
import { SCORE_ENGINE } from './score-blast';
import { barAtTime, barFollower, laidEvents, percent, writtenKey, writtenPart } from './score-written';
import type { Score } from './musicxml';

interface LaidBar { number: string; start: number; end: number; corrected?: true; similarity?: number; estimated?: true }
interface Laid { title?: string; measures?: number; notes?: number; heard?: number; correctedBars?: number; similarity?: number; bars?: LaidBar[] }
interface Drawn { lines: { svg: SafeHtml; firstBar: number }[]; barAt: (line: number, share: number) => number }
// A bar of the song as laid: its number on the made transcript, and the PDF measure laid there.
interface SongBar extends LaidBar { bar: number; index: number; measure?: number }
type Playing = 'pdf' | 'made' | 'together' | 'stem';
const PART_LABELS: Record<ScorePartName, string> = { other: 'Harmonic', bass: 'Bass', drums: 'Drums' };
const FAMILY: Record<ScorePartName, 'keys' | 'bass' | 'drums'> = { other: 'keys', bass: 'bass', drums: 'drums' };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

@Component({
  selector: 'app-score-check-page',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card score-check-page">
      <div class="section-heading">
        <div>
          <h1>{{ job()?.title || 'Song' }}</h1>
          <p class="hint">The uploaded score beside the transcript made from it for the song, bar by bar: each bar shows how
            like the stem the PDF's measure is where it was laid (red unlike, green alike).</p>
        </div>
        <a class="button-link" [routerLink]="['/mixer', jobId]">Back to the mixer</a>
      </div>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (status()) { <p class="hint" role="status">{{ status() }}</p> }
      @if (parts().length > 1) {
        <div class="score-check-tabs" role="group" aria-label="Part">
          @for (name of parts(); track name) {
            <button type="button" [class.secondary]="name !== part()" [attr.aria-pressed]="name === part()" (click)="choose(name)">{{ labels[name] }}</button>
          }
        </div>
      }
      <p class="hint">
        @if (outdated()) { This score was laid by an earlier version, so it is being laid again. }
        <button type="button" class="secondary" (click)="layAgain()" [disabled]="laying()">{{ laying() ? 'Regenerating score… about 4 min' : 'Regenerate score' }}</button></p>

      <div class="score-check-controls">
      <div class="score-check-player" role="status">
        @if (playing()) { <span>Playing {{ playingLabel() }} · {{ position() }}</span> <button type="button" (click)="stop()">Stop</button> }
        @else if (preparing()) { <span class="busy">Preparing the sound… (the first time takes a few seconds)</span> }
        @else if (warming()) { <span class="busy">Getting the sound ready…</span> }
      </div>

      @if (selected(); as bar) {
        <div class="score-check-bar-panel" aria-live="polite">
          <strong>Song bar {{ bar.bar }}</strong>
          <span>{{ bar.measure !== undefined ? 'PDF measure ' + bar.number : 'Not in the PDF' }} · {{ clockOf(bar.start) }}–{{ clockOf(bar.end) }}</span>
          <span class="score-check-like" [style.color]="colorOf(bar.similarity)">Similarity {{ percentOf(bar.similarity) }}</span>
          @if (bar.estimated) { <span class="hint">Estimated: outside the passage synced with the stem</span> }
          @if (bar.corrected) { <span class="hint">drum bar corrected</span> }
          <div class="score-check-buttons">
            @if (bar.measure !== undefined) {
              <button type="button" (click)="playMeasure(bar)" [disabled]="!pdf()" [class.busy]="preparingKey() === 'measure:' + bar.index">{{ buttonLabel('measure:' + bar.index, 'PDF measure') }}</button>
            }
            <button type="button" (click)="playBar('stem', bar)" [disabled]="!stem" [class.busy]="preparingKey() === 'stem:' + bar.index">{{ buttonLabel('stem:' + bar.index, 'Stem') }}</button>
            <button type="button" (click)="playBar('made', bar)" [class.busy]="preparingKey() === 'made:' + bar.index">{{ buttonLabel('made:' + bar.index, 'Made bar') }}</button>
            <button type="button" (click)="playBar('together', bar)" [disabled]="!stem" [class.busy]="preparingKey() === 'together:' + bar.index">{{ buttonLabel('together:' + bar.index, 'Made bar + stem') }}</button>
          </div>
          @if (placements().length > 1) {
            <span class="hint">PDF measure {{ bar.number }} is laid {{ placements().length }} times:
              @for (other of placements(); track other.index) {
                <button type="button" class="link-button" [class.current]="other.index === bar.index" (click)="select(other)">bar {{ other.bar }} ({{ percentOf(other.similarity) }})</button>
              }
            </span>
          }
        </div>
      }
      </div>

      <section class="score-check-transcript" aria-labelledby="score-check-pdf">
        <div class="score-check-heading">
          <h2 id="score-check-pdf">From the PDF</h2>
          <button type="button" (click)="toggle('pdf')" [disabled]="!pdf()" [class.busy]="preparingKey() === 'pdf'">{{ buttonLabel('pdf', 'Play') }}</button>
        </div>
        <p class="hint">{{ pdfNote() }}</p>
        <div class="score-check-lines" #pdfLines>
          @if (floating()?.view === 'pdf') {
            <button type="button" class="score-check-float" [style.left.px]="floating()!.left" [style.top.px]="floating()!.top"
              (click)="floatPress()" [attr.aria-label]="playing() ? 'Stop' : 'Resume from here'">{{ playing() ? '■ Stop' : '▶ Resume' }}</button>
          }
          @for (line of pdf()?.lines ?? []; track $index) {
            <div class="score-check-line" [innerHTML]="line.svg" (click)="pickPdf($index, $event)"></div>
          }
        </div>
      </section>

      <section class="score-check-transcript" aria-labelledby="score-check-made">
        <div class="score-check-heading">
          <h2 id="score-check-made">Made for the song (as the mixer plays it)</h2>
          <button type="button" (click)="toggle('made')" [disabled]="!made()" [class.busy]="preparingKey() === 'made'">{{ buttonLabel('made', 'Play') }}</button>
          <button type="button" class="secondary" (click)="toggle('together')" [disabled]="!made() || !stem" [class.busy]="preparingKey() === 'together'">{{ buttonLabel('together', 'Play with the stem') }}</button>
        </div>
        <p class="hint">{{ madeNote() }}</p>
        <div class="score-check-lines" #madeLines>
          @if (floating()?.view === 'made') {
            <button type="button" class="score-check-float" [style.left.px]="floating()!.left" [style.top.px]="floating()!.top"
              (click)="floatPress()" [attr.aria-label]="playing() ? 'Stop' : 'Resume from here'">{{ playing() ? '■ Stop' : '▶ Resume' }}</button>
          }
          @for (line of made()?.lines ?? []; track $index) {
            <div class="score-check-line" [innerHTML]="line.svg" (click)="pickMade($index, $event)"></div>
          }
        </div>
      </section>
    </section>
  `,
  host: { '(document:keydown.escape)': 'stop()' },
})
export class ScoreCheckPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly stems = inject(StemsService);
  private readonly sanitizer = inject(DomSanitizer);
  readonly jobId = this.route.snapshot.paramMap.get('jobId') ?? '';
  readonly labels = PART_LABELS;
  readonly percentOf = percent;
  readonly clockOf = clock;
  readonly job = signal<Job | null>(null);
  readonly error = signal('');
  readonly status = signal('Loading…');
  readonly parts = signal<ScorePartName[]>([]);
  readonly part = signal<ScorePartName>('other');
  readonly pdf = signal<Drawn | null>(null);
  readonly made = signal<Drawn | null>(null);
  readonly pdfNote = signal('');
  readonly madeNote = signal('');
  readonly bars = signal<SongBar[]>([]);
  readonly selected = signal<SongBar | null>(null);
  readonly placements = computed(() => { const bar = this.selected(); return bar?.measure === undefined ? [] : this.bars().filter(other => other.number === bar.number && other.measure !== undefined); });
  // The result shown was laid by an earlier version of the laying (score-blast.ts SCORE_ENGINE); laid again once.
  readonly outdated = signal(false);
  private relaid = false;
  readonly laying = signal(false);
  readonly playing = signal<Playing | null>(null);
  // What is playing: a whole transcript ('pdf', 'made', 'together') or a bar's ('made:<bar index>', 'measure:<bar index>'…).
  readonly playingKey = signal('');
  private readonly pdfLines = viewChild<ElementRef<HTMLElement>>('pdfLines');
  private readonly madeLines = viewChild<ElementRef<HTMLElement>>('madeLines');
  // When each transcript's notes sound and where its bars are, for lighting them as they play.
  private timing: Partial<Record<'pdf' | 'made', { notes: { start: number; end: number }[]; hits: { unit: number; time: number }[]; barAt: (time: number) => number }>> = {};
  private frame = 0;
  private litBar?: Element;
  private litNotes: Element[] = [];
  private litKey = '';
  // A Stop (or, once stopped, Play from there) button over the bar playing, following it.
  readonly floating = signal<{ view: 'pdf' | 'made'; left: number; top: number } | null>(null);
  private floatBar?: Element;
  private resume?: { kind: Playing; time: number };
  private readonly placeFloat = () => this.moveFloat();
  readonly preparing = signal(false);
  private play = 0;
  // The button whose sound is being prepared, and whether the sounds are being made ahead of a Play.
  readonly preparingKey = signal('');
  readonly warming = signal(false);
  buttonLabel(key: string, idle: string): string {
    return this.preparingKey() === key ? 'Preparing…' : idle;
  }
  readonly position = signal('');
  readonly playingLabel = computed(() => ({ pdf: 'the PDF', made: 'the made transcript', together: 'the made transcript with the stem', stem: 'the stem' })[this.playing() ?? 'pdf']);
  stem?: AudioBuffer;
  private document?: Record<string, unknown> & { beats: number[]; firstBar: number };
  private library?: StyleLibrary;
  private score?: Score;
  private written?: { events: NoteEvent[]; seconds: number; quarter: number; grid: HarmonyGrid };
  private laidPart?: HarmonyPart;
  private context?: AudioContext;
  private sources: AudioBufferSourceNode[] = [];
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private token = 0;
  private destroyed = false;

  ngOnInit(): void {
    window.addEventListener('resize', this.placeFloat);
    void this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    window.removeEventListener('resize', this.placeFloat);
    this.stop();
    void this.context?.close();
  }

  private laidOf(name: ScorePartName): Laid | undefined {
    const fromScore = this.document?.['fromScore'] as (Laid & { parts?: Partial<Record<ScorePartName, Laid>> }) | undefined;
    return fromScore?.parts ? fromScore.parts[name] : name === 'other' ? fromScore : undefined;
  }
  private scoreUrl(name: ScorePartName): string | undefined {
    const job = this.job();
    return job?.scores?.[name]?.url ?? (name === 'other' ? job?.score?.url : undefined);
  }

  private async load(): Promise<void> {
    try {
      const { job } = await this.stems.getJob(this.jobId);
      if (this.destroyed) return;
      this.job.set(job);
      const shown = job.harmony?.status === 'completed' ? job.harmony : job.harmony?.previous;
      if (!shown?.url) throw new Error('This song has no chords & notes yet.');
      const response = await fetch(shown.url);
      if (!response.ok) throw new Error(`Score request failed (HTTP ${response.status}).`);
      this.document = await response.json();
      const parts = (['other', 'bass', 'drums'] as ScorePartName[]).filter(name => this.laidOf(name) && this.scoreUrl(name));
      if (!parts.length) throw new Error('No uploaded score is laid on this song yet.');
      this.parts.set(parts);
      this.library = await loadLibrary();
      const asked = this.route.snapshot.queryParamMap.get('part') as ScorePartName | null;
      await this.show(asked && parts.includes(asked) ? asked : parts[0]);
      // A result from an earlier laying is laid again with the current one (once a visit; it is shown meanwhile).
      const engine = (this.document?.['fromScore'] as { engine?: number } | undefined)?.engine;
      if (engine !== SCORE_ENGINE && shown === job.harmony && !this.relaid && !this.laying()) {
        this.relaid = true; this.outdated.set(true);
        void this.layAgain();
      } else this.outdated.set(false);
    } catch (error) {
      this.status.set('');
      this.error.set(`Could not load the score: ${errorMessage(error)}`);
    }
  }

  async choose(name: ScorePartName): Promise<void> {
    if (name === this.part()) return;
    void this.router.navigate([], { queryParams: { part: name }, replaceUrl: true });
    await this.show(name);
  }

  private async show(name: ScorePartName): Promise<void> {
    this.stop();
    this.buffers.clear();
    const token = ++this.token, document = this.document!, job = this.job()!;
    this.floating.set(null); this.floatBar = undefined; this.resume = undefined;
    // The stem heard is the part's own.
    if (name !== this.part()) this.stem = undefined;
    this.part.set(name); this.pdf.set(null); this.made.set(null); this.selected.set(null); this.error.set('');
    this.status.set('Reading the score…');
    const grid = { beats: document.beats, firstBar: document.firstBar };
    const ensemble = document['ensemble'] as HarmonyPart | undefined, stems = document['stems'] as Record<string, HarmonyPart | undefined> | undefined;
    const laid = (name === 'other' ? ensemble : stems?.[name]) ?? { chords: [], notes: [] };
    this.laidPart = laid;
    const summary = this.laidOf(name)!;
    const key = (ensemble as { key?: string } | undefined)?.key;
    const barOf = (time: number) => barAtTime(grid, time + 0.001);
    const songBars: SongBar[] = (summary.bars ?? []).map((bar, index) => ({ ...bar, bar: barOf(bar.start), index, ...(bar.number !== '–' ? { measure: index } : {}) }));
    this.bars.set(songBars);
    // The made transcript: each song bar marked with the PDF measure laid there and how like the stem it is.
    const madeMarks = new Map<number, BarMark>(songBars.map(bar => [bar.bar, bar.measure === undefined
      ? { text: 'not in PDF' }
      : { text: `m.${bar.number} ${percent(bar.similarity)}${bar.estimated ? ' est.' : ''}`, ...(bar.similarity !== undefined ? { level: bar.similarity } : {}) }]));
    const madeLines = sheetLines(laid, name, grid, key, madeMarks);
    const madeHits = (laid.hits ?? []).map(hit => ({ unit: hit.unit, time: beatTime(grid.beats, hit.unit / 4) }));
    this.timing = { made: { notes: laid.notes, hits: madeHits,
      barAt: barFollower(grid, [...laid.notes, ...madeHits.map(hit => ({ start: hit.time, unit: hit.unit }))]) } };
    this.made.set({ lines: madeLines.lines.map(line => ({ ...line, svg: this.sanitizer.bypassSecurityTrustHtml(line.svg) })), barAt: madeLines.barAt });
    const counted = name === 'drums' ? 'hits' : 'notes';
    const estimated = songBars.filter(bar => bar.estimated).length;
    this.madeNote.set(`The PDF's ${songBars.length} measures as played (repeats unfolded), every one as written; ${songBars.length - estimated} synced with the stem`
      + (estimated ? `, ${estimated} before or after them estimated` : '') + `; ${summary.heard ?? '–'} of ${summary.notes ?? '–'} ${counted} heard in the stem`
      + (summary.correctedBars ? `; ${summary.correctedBars} drum bars corrected` : '') + '. Choose a bar to compare it.');
    try {
      const [{ parseMusicXml }, { chordName }] = await Promise.all([import('./musicxml'), import('./score-align')]);
      const response = await fetch(this.scoreUrl(name)!);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const musicxml = await response.text();
      if (token !== this.token) return;
      const score = this.score = parseMusicXml(musicxml), written = name === 'drums' ? undefined : writtenKey(musicxml);
      const qpm = score.tempo ?? tempo(grid.beats) ?? 90;
      const pdf = writtenPart(score, name, qpm, written, chordName);
      this.written = { events: pdf.events, seconds: pdf.seconds, quarter: 60 / qpm, grid: pdf.grid };
      const pdfHits = (pdf.part.hits ?? []).map(hit => ({ unit: hit.unit, time: hit.unit / 4 * (60 / qpm) }));
      this.timing.pdf = { notes: pdf.part.notes, hits: pdfHits,
        barAt: barFollower(pdf.grid, [...pdf.part.notes, ...pdfHits.map(hit => ({ start: hit.time, unit: hit.unit }))]) };
      // The PDF: each measure marked with how like the stem it is where it was laid (each time, when laid more than once).
      const byNumber = new Map<string, SongBar[]>();
      for (const bar of songBars) if (bar.measure !== undefined) byNumber.set(bar.number, [...byNumber.get(bar.number) ?? [], bar]);
      const pdfMarks = new Map<number, BarMark>();
      for (const measure of score.measures) {
        const bar = Math.floor((Math.round(measure.start * 4) - pdf.grid.firstBar * 4) / 16) + 1, placed = byNumber.get(measure.number) ?? [];
        const levels = placed.map(item => item.similarity).filter((value): value is number => value !== undefined);
        const mean = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : undefined;
        pdfMarks.set(bar, !placed.length ? { text: `m.${measure.number} not laid` }
          : { text: `m.${measure.number} ${placed.length > 1 ? levels.map(percent).join(' ') : percent(mean)}`, ...(mean !== undefined ? { level: mean } : {}) });
      }
      const pdfLines = sheetLines(pdf.part, name, pdf.grid, written, pdfMarks);
      this.pdf.set({ lines: pdfLines.lines.map(line => ({ ...line, svg: this.sanitizer.bypassSecurityTrustHtml(line.svg) })), barAt: pdfLines.barAt });
      const count = name === 'drums' ? `${pdf.part.hits?.length ?? 0} hits` : `${pdf.part.notes.length} notes`;
      this.pdfNote.set(`${score.measures.length} measures, ${count}, as printed (repeats not taken)${written ? `, in ${written}` : ''}, `
        + `at ♩ = ${Math.round(qpm)}${score.tempo ? ' as marked' : ' (the song\'s tempo; the score marks none)'}. Choose a measure to compare it.`);
      this.status.set('Loading the stem…');
      const url = job.stems?.[name]?.playUrl;
      if (url && !this.stem) {
        const audio = await fetch(url);
        if (!audio.ok) throw new Error(`Audio request failed (HTTP ${audio.status}).`);
        this.context ??= new AudioContext();
        const decoded = await this.context.decodeAudioData(await audio.arrayBuffer());
        if (token !== this.token) return;
        this.stem = decoded;
      }
      this.status.set('');
      void this.warm(token);
    } catch (error) {
      if (token === this.token) { this.status.set(''); this.error.set(`Could not read the uploaded score: ${errorMessage(error)}`); }
    }
  }

  // Both transcripts' sounds made while the page is read, so Play starts at once.
  private async warm(token: number): Promise<void> {
    this.context ??= new AudioContext();
    this.warming.set(true);
    try {
      await this.sound('made');
      if (token === this.token && this.written) await this.sound('pdf');
    } catch { /* Made again when played; the error is shown then. */ }
    if (token === this.token) this.warming.set(false);
  }

  colorOf(level?: number): string { return level === undefined ? '' : levelColor(level); }

  select(bar: SongBar): void { this.selected.set(bar); }

  pickMade(line: number, event: MouseEvent): void {
    const bar = this.made()?.barAt(line, this.share(event));
    const found = this.bars().find(item => item.bar === bar);
    if (found) this.selected.set(found);
  }

  pickPdf(line: number, event: MouseEvent): void {
    const bar = this.pdf()?.barAt(line, this.share(event)), score = this.score, grid = this.written?.grid;
    if (bar === undefined || !score || !grid) return;
    const measure = score.measures.find(item => Math.floor((Math.round(item.start * 4) - grid.firstBar * 4) / 16) + 1 === bar);
    if (!measure) return;
    const laid = this.bars().filter(item => item.measure !== undefined && item.number === measure.number);
    // A measure never laid can still be heard on its own.
    if (laid.length) this.selected.set(laid.sort((a, b) => (a.similarity ?? 1) - (b.similarity ?? 1))[0]);
    else void this.playRange('pdf', measure.start * this.written!.quarter, measure.length * this.written!.quarter);
  }

  private share(event: MouseEvent): number {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return (event.clientX - box.left) / box.width;
  }

  async layAgain(): Promise<void> {
    this.laying.set(true);
    try {
      const { harmony } = await this.stems.useSongScore(this.jobId, true);
      for (let tries = 0; tries < 60 && !this.destroyed; tries++) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        const { job } = await this.stems.getJob(this.jobId);
        if (job.harmony?.id === harmony.id && job.harmony.status === 'completed') { this.document = undefined; this.stem = undefined; this.laying.set(false); await this.load(); return; }
        if (job.harmony?.id === harmony.id && job.harmony.status === 'failed') throw new Error(job.harmony.error ?? 'Laying the score failed.');
      }
    } catch (error) {
      this.error.set(`Could not lay the score again: ${errorMessage(error)}`);
    }
    this.laying.set(false);
  }

  // The sounds, made once a part: the PDF at its tempo, the made transcript as loud through the song as the stem.
  private async sound(kind: 'pdf' | 'made'): Promise<AudioBuffer> {
    const known = this.buffers.get(kind);
    if (known) return known;
    const made = this.render(kind);
    made.catch(() => { if (this.buffers.get(kind) === made) this.buffers.delete(kind); });
    this.buffers.set(kind, made);
    return made;
  }
  private async render(kind: 'pdf' | 'made'): Promise<AudioBuffer> {
    const name = this.part(), context = this.context!;
    const sound = offered(this.library!, this.document?.['accompaniment'] as never, FAMILY[name]).sounds[0] ?? 0;
    let buffer: AudioBuffer;
    if (kind === 'pdf') buffer = await renderNotes(this.written!.events, this.written!.seconds, context.sampleRate, sound);
    else {
      let events = laidEvents({ part: name, laid: this.laidPart!, grid: { beats: this.document!.beats, firstBar: this.document!.firstBar } }), gain = 1;
      if (this.stem) ({ events, gain } = await matchLoudness(events, events, this.stem, sound));
      buffer = await renderNotes(events, this.stem?.duration ?? (this.document!.beats.at(-1) ?? 0) + 2, context.sampleRate, sound);
      if (gain !== 1) { const data = buffer.getChannelData(0); for (let index = 0; index < data.length; index++) data[index] *= gain; }
    }
    return buffer;
  }

  // A Play button always plays its transcript from the start, stopping whatever plays; the button over the bar playing
  // stops it, and then resumes from where it stopped.
  toggle(kind: Playing): void { void this.playRange(kind, 0, undefined, kind); }

  playMeasure(bar: SongBar): void {
    const key = `measure:${bar.index}`;
    const measure = this.score?.measures.find(item => item.number === bar.number);
    if (measure && this.written) void this.playRange('pdf', measure.start * this.written.quarter, measure.length * this.written.quarter, key);
  }

  playBar(kind: Playing, bar: SongBar): void {
    const key = `${kind}:${bar.index}`;
    void this.playRange(kind, bar.start, bar.end - bar.start, key);
  }

  private async playRange(kind: Playing, from: number, length?: number, key: string = kind): Promise<void> {
    this.stop();
    this.context ??= new AudioContext();
    // Only the Play pressed last is heard: one still being prepared when another is pressed is dropped.
    const context = this.context, token = this.token, play = this.play;
    this.preparing.set(true); this.preparingKey.set(key);
    await context.resume();
    try {
      const buffers = kind === 'stem' ? [this.stem!] : kind === 'pdf' ? [await this.sound('pdf')]
        : kind === 'made' ? [await this.sound('made')] : [await this.sound('made'), this.stem!];
      if (token !== this.token || play !== this.play || !buffers.every(Boolean)) return;
      const at = context.currentTime + 0.05, end = Math.max(...buffers.map(buffer => buffer.duration));
      this.sources = buffers.map(buffer => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(at, Math.min(from, buffer.duration), length);
        return source;
      });
      this.sources[0].onended = () => { if (this.playing() === kind) this.stop(); };
      this.playing.set(kind);
      this.playingKey.set(key);
      const view = kind === 'pdf' ? 'pdf' : 'made', until = length ? from + length : end;
      // What is heard now: the context's clock less the time its sound takes to reach the speakers.
      const delay = (context.baseLatency || 0) + (context.outputLatency || 0);
      const tick = () => {
        const time = from + Math.max(0, context.currentTime - delay - at);
        this.resume = { kind, time };
        this.position.set(`${clock(time)} / ${clock(until)}`);
        this.light(view, time);
        this.frame = requestAnimationFrame(tick);
      };
      tick();
    } catch (error) {
      this.error.set(`Could not play: ${errorMessage(error)}`);
    } finally {
      if (play === this.play) { this.preparing.set(false); this.preparingKey.set(''); }
    }
  }

  stop(): void {
    this.play++;
    this.preparing.set(false); this.preparingKey.set('');
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* not started */ } source.disconnect(); }
    this.sources = [];
    cancelAnimationFrame(this.frame);
    this.unlight();
    this.playing.set(null);
    this.playingKey.set('');
  }

  // The bar playing lit, and the notes sounding in it drawn bigger (styles.css), on the transcript heard; the
  // bar's line kept in view.
  private light(view: 'pdf' | 'made', time: number): void {
    const timing = this.timing[view], container = (view === 'pdf' ? this.pdfLines() : this.madeLines())?.nativeElement;
    if (!timing || !container) return;
    const bar = timing.barAt(time);
    const barElement = container.querySelector(`rect.bar-now[data-bar="${bar}"]`) ?? undefined;
    if (barElement !== this.litBar) {
      this.litBar?.classList.remove('on');
      barElement?.classList.add('on');
      this.litBar = barElement;
      barElement?.closest('.score-check-line')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (barElement) { this.floatBar = barElement; this.moveFloat(view); }
    }
    const selectors: string[] = [];
    timing.notes.forEach((note, index) => { if (note.start <= time && time < Math.max(note.end, note.start + 0.12)) selectors.push(`g.note[data-i="${index}"]`); });
    for (const unit of new Set(timing.hits.filter(hit => hit.time <= time && time < hit.time + 0.15).map(hit => hit.unit))) selectors.push(`g.note[data-u="${unit}"]`);
    const key = selectors.join(',');
    if (key === this.litKey) return;
    for (const element of this.litNotes) element.classList.remove('on');
    this.litNotes = key ? Array.from(container.querySelectorAll(key)) : [];
    for (const element of this.litNotes) element.classList.add('on');
    this.litKey = key;
  }

  private moveFloat(view = this.floating()?.view): void {
    const bar = this.floatBar, container = bar?.closest('.score-check-lines');
    if (!bar || !container || !view) return;
    const box = bar.getBoundingClientRect(), around = container.getBoundingClientRect();
    this.floating.set({ view, left: box.left - around.left + box.width / 2, top: box.top - around.top });
  }

  // Stops what plays, or plays on from where it stopped.
  floatPress(): void {
    if (this.playing()) { this.stop(); return; }
    if (this.resume) void this.playRange(this.resume.kind, this.resume.time, undefined, this.resume.kind);
  }

  private unlight(): void {
    this.litBar?.classList.remove('on');
    for (const element of this.litNotes) element.classList.remove('on');
    this.litBar = undefined; this.litNotes = []; this.litKey = '';
  }
}
