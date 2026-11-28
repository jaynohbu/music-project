// A song's uploaded score checked against its stem: the score as it was uploaded (drawn and played at its own
// tempo, in its written key), and under it what was laid on the stem (the song's part made from it, drawn on the
// song's bars) with the similarity measured while laying it (score-align.ts, one less how unlike each measure is
// where it was laid), played alone or with the stem, from the start or from any bar.
import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import type { HarmonyGrid, HarmonyPart, ScorePartName } from './services';
import type { NoteEvent } from './accompaniment';
import { matchLoudness, renderNotes } from './accompaniment-player';
import { sheetPages, tempo } from './score-sheet';
import { laidEvents, percent, writtenKey, writtenPart } from './score-written';

export interface ScoreCheckBar { number: string; start: number; end: number; corrected?: true; similarity?: number }
export interface ScoreCheckSummary { title?: string; measures?: number; notes?: number; heard?: number; correctedBars?: number; similarity?: number; bars?: ScoreCheckBar[] }
export interface ScoreCheck {
  part: ScorePartName; label: string; title: string;
  url: string;                            // The uploaded score's MusicXML.
  laid: HarmonyPart; grid: HarmonyGrid; songKey?: string;
  summary?: ScoreCheckSummary;
  stem?: AudioBuffer;                     // The stem, as recorded.
  sound: number;                          // The sound both are played in.
}

const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
type Playing = 'written' | 'laid' | 'together';

@Component({
  selector: 'app-score-check',
  standalone: true,
  template: `
    <dialog #dialog class="score-check" aria-labelledby="score-check-title" (close)="closed.emit()">
      <header><h2 id="score-check-title">{{ check?.title }} · {{ check?.label }} score check</h2></header>
      <div class="score-check-body">
        @if (error()) { <p role="alert" class="error">{{ error() }}</p> }
        <section aria-labelledby="score-check-written">
          <div class="score-check-heading">
            <h3 id="score-check-written">As uploaded</h3>
            <button type="button" (click)="toggle('written')" [disabled]="!written() || (preparing() && preparing() !== 'written')">
              {{ playing() === 'written' ? 'Stop' : preparing() === 'written' ? 'Preparing…' : 'Play' }}</button>
          </div>
          <p class="hint">{{ writtenNote() }}</p>
          @if (playing() === 'written') { <p class="hint" role="status">{{ clock() }}</p> }
          <div class="score-check-pages">
            @for (page of writtenPages(); track $index) { <div class="score-check-page" [innerHTML]="page"></div> }
            @empty { <p class="hint">{{ error() ? '' : 'Reading the score…' }}</p> }
          </div>
        </section>
        <section aria-labelledby="score-check-laid">
          <div class="score-check-heading">
            <h3 id="score-check-laid">Matched with the stem</h3>
            <button type="button" (click)="toggle('laid')" [disabled]="!!preparing() && preparing() !== 'laid'">
              {{ playing() === 'laid' ? 'Stop' : preparing() === 'laid' ? 'Preparing…' : 'Play' }}</button>
            @if (check?.stem) {
              <button type="button" class="secondary" (click)="toggle('together')" [disabled]="!!preparing() && preparing() !== 'together'">
                {{ playing() === 'together' ? 'Stop' : preparing() === 'together' ? 'Preparing…' : 'Play with the stem' }}</button>
            }
          </div>
          <p class="score-check-similarity"><strong>Similarity {{ similarity() }}</strong> · {{ laidNote() }}</p>
          @if (check && check.summary?.similarity === undefined) {
            <button type="button" class="secondary" (click)="relay.emit(); close()">Lay the score again</button>
          }
          @if (playing() === 'laid' || playing() === 'together') { <p class="hint" role="status">{{ clock() }}</p> }
          @if (bars().length) {
            <p class="hint">Each bar as laid on the song: the score's measure number and how like the stem it is there.
              Choose one to play the notes with the stem from it.</p>
            <div class="score-check-bars" role="list">
              @for (bar of bars(); track $index) {
                <button type="button" role="listitem" class="score-check-bar" [class.free]="bar.similarity === undefined"
                  [style.--like]="bar.similarity ?? 0" (click)="playFrom(bar.start)"
                  [attr.aria-label]="'Bar ' + ($index + 1) + ', measure ' + bar.number + ', similarity ' + percentOf(bar.similarity) + ', at ' + timeOf(bar.start)"
                  [title]="timeOf(bar.start) + (bar.corrected ? ' · drum bar corrected' : '')">
                  <span>{{ bar.number }}</span><small>{{ percentOf(bar.similarity) }}</small>
                </button>
              }
            </div>
          }
          <div class="score-check-pages">
            @for (page of laidPages(); track $index) { <div class="score-check-page" [innerHTML]="page"></div> }
          </div>
        </section>
      </div>
      <footer><button type="button" class="secondary" (click)="close()">Close</button></footer>
    </dialog>
  `,
})
export class ScoreCheckDialog implements OnChanges, OnDestroy {
  @Input() check: ScoreCheck | null = null;
  @Output() closed = new EventEmitter<void>();
  // Sent before playing, so the mixer stops.
  @Output() started = new EventEmitter<void>();
  // Asks for the score to be laid on the song again (a result from before similarity was measured).
  @Output() relay = new EventEmitter<void>();
  @ViewChild('dialog', { static: true }) private dialog?: ElementRef<HTMLDialogElement>;
  private readonly sanitizer = inject(DomSanitizer);
  readonly writtenPages = signal<SafeHtml[]>([]);
  readonly laidPages = signal<SafeHtml[]>([]);
  readonly written = signal<{ events: NoteEvent[]; seconds: number } | null>(null);
  readonly writtenNote = signal('');
  readonly laidNote = signal('');
  readonly similarity = signal('–');
  readonly bars = signal<ScoreCheckBar[]>([]);
  readonly error = signal('');
  readonly playing = signal<Playing | null>(null);
  readonly preparing = signal<Playing | null>(null);
  readonly clock = signal('');
  readonly percentOf = percent;
  readonly timeOf = minutes;
  private context?: AudioContext;
  private sources: AudioBufferSourceNode[] = [];
  private buffers = new Map<Playing, AudioBuffer[]>();
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;

  ngOnChanges(): void {
    this.stop();
    this.buffers.clear();
    const check = this.check, generation = ++this.generation;
    this.writtenPages.set([]); this.laidPages.set([]); this.written.set(null); this.error.set('');
    if (!check) { if (this.dialog?.nativeElement.open) this.dialog.nativeElement.close(); return; }
    this.dialog?.nativeElement.showModal();
    const summary = check.summary;
    this.similarity.set(percent(summary?.similarity));
    this.bars.set(summary?.bars ?? []);
    const counted = check.part === 'drums' ? 'hits' : 'notes';
    this.laidNote.set(summary?.similarity === undefined ? 'This score was laid before its similarity was measured; lay it again (about 4 min) to measure it.' : summary
      ? `${summary.measures ?? '–'} measures laid on ${summary.bars?.length ?? '–'} bars of the song; ${summary.heard ?? '–'} of ${summary.notes ?? '–'} ${counted} heard in the stem`
        + (summary.correctedBars ? `; ${summary.correctedBars} drum bars corrected` : '') + '.'
      : 'This score was laid before its similarity was measured.');
    const text = (subtitle: string) => ({ title: check.title, subtitle, page: (page: number, pages: number) => `${page} / ${pages}` });
    this.laidPages.set(sheetPages(check.laid, check.part, check.grid, text(`${check.label} · matched with the stem`), check.songKey).pages
      .map(page => this.sanitizer.bypassSecurityTrustHtml(page)));
    void this.readWritten(check, generation, text);
  }

  private async readWritten(check: ScoreCheck, generation: number, text: (subtitle: string) => { title: string; subtitle: string; page: (page: number, pages: number) => string }) {
    try {
      const [{ parseMusicXml }, { chordName }] = await Promise.all([import('./musicxml'), import('./score-align')]);
      const response = await fetch(check.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const musicxml = await response.text();
      if (generation !== this.generation) return;
      const score = parseMusicXml(musicxml), key = check.part === 'drums' ? undefined : writtenKey(musicxml);
      const qpm = score.tempo ?? tempo(check.grid.beats) ?? 90;
      const made = writtenPart(score, check.part, qpm, key, chordName);
      const count = check.part === 'drums' ? `${made.part.hits?.length ?? 0} hits` : `${made.part.notes.length} notes`;
      this.writtenNote.set(`${score.measures.length} measures, ${count}, as printed (repeats not taken)`
        + `${key ? `, in ${key}` : ''}, played at ${Math.round(qpm)} a quarter note a minute${score.tempo ? ' as marked' : ', the song\'s tempo (the score marks none)'}.`);
      this.writtenPages.set(sheetPages(made.part, check.part, made.grid, text(`${check.label} · as uploaded`), key).pages
        .map(page => this.sanitizer.bypassSecurityTrustHtml(page)));
      this.written.set({ events: made.events, seconds: made.seconds });
    } catch (error) {
      if (generation === this.generation) this.error.set(`Could not read the uploaded score: ${error instanceof Error ? error.message : error}`);
    }
  }

  // The sounds to play together for each way of listening, made once.
  private async prepare(kind: Playing, context: AudioContext): Promise<AudioBuffer[]> {
    const known = this.buffers.get(kind);
    if (known) return known;
    const check = this.check!;
    let made: AudioBuffer[];
    if (kind === 'written') {
      const written = this.written()!;
      made = [await renderNotes(written.events, written.seconds, context.sampleRate, check.sound)];
    } else {
      const seconds = check.stem?.duration ?? (check.grid.beats.at(-1) ?? 0) + 2;
      let events = laidEvents(check), gain = 1;
      // With the stem, the notes follow its loudness and are as loud as it is.
      if (kind === 'together' && check.stem) ({ events, gain } = await matchLoudness(events, events, check.stem, check.sound));
      const notes = await renderNotes(events, seconds, context.sampleRate, check.sound);
      if (gain !== 1) { const data = notes.getChannelData(0); for (let index = 0; index < data.length; index++) data[index] *= gain; }
      made = kind === 'together' && check.stem ? [notes, check.stem] : [notes];
    }
    this.buffers.set(kind, made);
    return made;
  }

  async toggle(kind: Playing, from = 0): Promise<void> {
    if (this.playing() === kind && !from) { this.stop(); return; }
    this.stop();
    if (!this.check || this.preparing()) return;
    this.started.emit();
    this.context ??= new AudioContext();
    const context = this.context, generation = this.generation;
    await context.resume();
    this.preparing.set(kind);
    try {
      const buffers = await this.prepare(kind, context);
      if (generation !== this.generation) return;
      const at = context.currentTime + 0.05, length = Math.max(...buffers.map(buffer => buffer.duration));
      this.sources = buffers.map(buffer => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(at, Math.min(from, buffer.duration));
        return source;
      });
      this.sources[0].onended = () => { if (this.playing() === kind) this.stop(); };
      this.playing.set(kind);
      const tick = () => this.clock.set(`${minutes(from + Math.max(0, context.currentTime - at))} / ${minutes(length)}`);
      tick();
      this.timer = setInterval(tick, 250);
    } catch (error) {
      this.error.set(`Could not play: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.preparing.set(null);
    }
  }

  playFrom(start: number): void { void this.toggle(this.check?.stem ? 'together' : 'laid', Math.max(0.001, start)); }

  stop(): void {
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* not started */ } source.disconnect(); }
    this.sources = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.playing.set(null);
  }

  close(): void { this.stop(); this.dialog?.nativeElement.close(); }

  ngOnDestroy(): void { this.stop(); void this.context?.close(); }
}
