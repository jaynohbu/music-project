import { Component, ElementRef, EventEmitter, Injector, Input, OnChanges, OnDestroy, OnInit, Output, afterNextRender, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { HARMONY_STEMS, HarmonyGrid, HarmonyPart, Job, LyricLine, SceneEntry, SceneSettings, STEM_NAMES, StemName, StemsService, errorMessage } from './services';
import { ConfirmationService } from './confirmation';
import { captureSceneSettings, restoredSceneInterval } from './scene-settings';
import { HarmonyStrip } from './harmony-strip';
import { LyricsStrip } from './lyrics-strip';
import { LyricsEditor, firstChange } from './lyrics-editor';
import {
  EffectControl, EffectSettings, FaderControl, FADER_CONTROLS,
  StemEffects, applyStemEffects, createStemEffects, defaultEffects,
} from './stem-effects';

const MAX_UPLOAD_BYTES = 30_000_000;
const MAX_AUDIO_SECONDS = 720;
const STEM_POLL_MS = 4000;
const STEM_DOWNLOAD_POOL = 4;

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <section class="card narrow">
      <span class="eyebrow">SIX-STEM SEPARATION</span>
      <h1>Upload audio to split</h1>
      <button type="button" class="secondary" (click)="back()">Back to Music</button>
      <p>Separate an audio file into drums, bass, vocals, guitar, piano and other.</p>
      <form (ngSubmit)="submit()">
        <label for="audio-file">Audio file</label>
        <input id="audio-file" name="audio-file" type="file" accept="audio/*"
          (change)="selectFile($event)" [disabled]="busy()">
        <label for="audio-title">Title</label>
        <input id="audio-title" name="audio-title" type="text" maxlength="160"
          [(ngModel)]="title" [disabled]="busy()">
        <p class="hint">Maximum 30 MB (30,000,000 bytes) and 12 minutes. Your browser checks duration before upload;
          the service also validates the actual media.</p>
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
        @if (notice()) { <p class="success" role="status">{{ notice() }}</p> }
        @if (retryJobId()) {
          <p role="alert" class="error">Audio was uploaded, but separation was not queued.
            Retry queueing this uploaded job; the file will not be uploaded again.</p>
          <button type="button" class="secondary" (click)="retryStart()" [disabled]="busy()">
            Retry queueing
          </button>
        }
        @if (busy() && uploading()) {
          <label for="upload-progress">Upload progress: {{ progress() }}%</label>
          <progress id="upload-progress" max="100" [value]="progress()">{{ progress() }}%</progress>
          <button type="button" class="secondary" (click)="cancelUpload()">Cancel upload</button>
        }
        <button type="submit" [disabled]="busy() || !file() || !!retryJobId()">
          {{ busy() ? (uploading() ? 'Uploading...' : 'Preparing upload...') : 'Split audio' }}
        </button>
      </form>
      @if (jobId()) {
        <p><a routerLink="/list">View your audio jobs</a></p>
      }
    </section>
  `,
})
export class SplitPage implements OnDestroy {
  private readonly stems = inject(StemsService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmationService);
  private returning = false;
  private controller?: AbortController;
  private destroyed = false;
  readonly file = signal<File | null>(null);
  titleValue = '';
  readonly busy = signal(false);
  readonly uploading = signal(false);
  readonly progress = signal(0);
  readonly error = signal('');
  readonly notice = signal('');
  readonly jobId = signal('');
  readonly retryJobId = signal('');

  selectFile(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    this.file.set(input.files?.[0] ?? null);
    this.titleValue = this.file()?.name.replace(/\.[^.]+$/, '') ?? '';
    this.error.set('');
    this.notice.set('');
  }

  get title(): string {
    return this.titleValue;
  }

  set title(value: string) {
    this.titleValue = value;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.controller?.abort();
  }

  async cancelUpload(): Promise<void> {
    if (await this.confirm.confirm('Cancel upload?', 'Cancel this upload? It will not be submitted for separation.', 'Cancel upload')) {
      this.controller?.abort();
    }
  }

  async canLeave(): Promise<boolean> {
    if (!this.busy() || this.returning) return true;
    if (!await this.confirm.confirm('Leave upload?', 'The upload is still active. Leaving cancels it; separation that was already queued continues.', 'Leave upload')) return false;
    this.controller?.abort();
    return true;
  }

  async back(): Promise<void> {
    await this.router.navigateByUrl('/list');
  }

  async submit(): Promise<void> {
    const file = this.file();
    if (!file || this.busy()) return;
    this.error.set('');
    this.notice.set('');
    if (this.retryJobId()) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      this.error.set('The file is larger than the 30 MB (30,000,000 bytes) upload limit.');
      return;
    }

    this.busy.set(true);
    this.uploading.set(false);
    this.progress.set(0);
    this.controller = new AbortController();
    let uploaded = false;
    try {
      const duration = await readAudioDuration(file);
      if (duration > MAX_AUDIO_SECONDS) {
        throw new Error('Audio must be 12 minutes or shorter.');
      }
      if (this.destroyed || this.controller.signal.aborted) return;

      const request = await this.stems.createUpload(
        file.name, file.size, this.titleValue.trim() || file.name,
      );
      if (typeof request.job?.jobId !== 'string' || !request.job.jobId ||
          typeof request.upload?.url !== 'string' || !request.upload.url ||
          !isStringRecord(request.upload.fields) || !Object.keys(request.upload.fields).length) {
        throw new Error('The service returned an invalid upload response.');
      }
      this.jobId.set(request.job.jobId);
      this.uploading.set(true);
      await uploadToPresignedPost(
        request.upload.url,
        request.upload.fields,
        file,
        percent => this.progress.set(percent),
        this.controller.signal,
      );
      if (this.destroyed || this.controller.signal.aborted) return;
      this.uploading.set(false);
      uploaded = true;
      await this.stems.complete(request.job.jobId);
      if (!this.destroyed) {
        this.notice.set('Upload complete. Stem separation is queued; follow its progress in your jobs.');
        this.retryJobId.set('');
        this.file.set(null);
        this.returning = true;
        await this.router.navigateByUrl('/list');
      }
    } catch (error) {
      if (!this.destroyed) {
        if (uploaded && this.jobId()) this.retryJobId.set(this.jobId());
        this.error.set(this.controller?.signal.aborted
          ? 'Upload cancelled. The job was not submitted for processing.'
          : uploaded
            ? `Audio uploaded, but the job could not be queued: ${errorMessage(error)}`
            : errorMessage(error));
      }
    } finally {
      this.uploading.set(false);
      this.busy.set(false);
      this.controller = undefined;
    }
  }

  async retryStart(): Promise<void> {
    const jobId = this.retryJobId();
    if (!jobId || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.stems.complete(jobId);
      if (!this.destroyed) {
        this.retryJobId.set('');
        this.notice.set('Separation queued. Follow its progress in your jobs.');
        this.file.set(null);
        this.returning = true;
        await this.router.navigateByUrl('/list');
      }
    } catch (error) {
      if (!this.destroyed) this.error.set(`Could not queue the uploaded job: ${errorMessage(error)}`);
    } finally {
      this.busy.set(false);
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every(item => typeof item === 'string');
}

function readAudioDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      audio.removeEventListener('loadedmetadata', loaded);
      audio.removeEventListener('error', failed);
      clearTimeout(timeout);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
    const loaded = (): void => {
      const duration = audio.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('Could not determine the audio duration. Choose a supported audio file.'));
      } else {
        resolve(duration);
      }
    };
    const failed = (): void => {
      cleanup();
      reject(new Error('Could not read this audio file. Choose a supported audio file.'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Reading the audio duration took too long. Try another audio file.'));
    }, 15000);
    audio.addEventListener('loadedmetadata', loaded, { once: true });
    audio.addEventListener('error', failed, { once: true });
    audio.preload = 'metadata';
    audio.src = url;
  });
}

function uploadToPresignedPost(
  url: string,
  fields: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', file, file.name);
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const abort = (): void => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      cleanup();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    xhr.open('POST', url);
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });
    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Direct upload failed (HTTP ${xhr.status}).`));
    }, { once: true });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new Error('Direct upload failed because of a network or storage error.'));
    }, { once: true });
    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
    }, { once: true });
    xhr.send(form);
  });
}

interface StemTrack extends EffectSettings {
  name: string;
  label: string;
  downloadUrl?: string;
  cleanedDownloadUrl?: string;
  hasCleaned: boolean;
  useCleaned: boolean;
  cleanedPeaks: number[];
  cleanError?: string;
  status: 'waiting' | 'loading' | 'ready' | 'error';
  error?: string;
  muted: boolean;
  solo: boolean;
  bypassed: boolean;
  peaks: number[];
  duration: number;
}

interface StemRuntime extends StemEffects {
  buffer: AudioBuffer;
  cleanedBuffer?: AudioBuffer;
  originalLevel: GainNode;
  cleanedLevel: GainNode;
}

function newTrack(name: string): StemTrack {
  return {
    ...defaultEffects(), name, label: name, status: 'waiting', muted: false, solo: false,
    bypassed: false, peaks: [], duration: 0, hasCleaned: false, useCleaned: false, cleanedPeaks: [],
  };
}

const LYRICS_REPLAY_LEAD = 1; // Seconds of run-up before an edited line.

@Component({
  selector: 'app-stem-mixer',
  standalone: true,
  imports: [RouterLink, FormsModule, LyricsStrip, LyricsEditor, HarmonyStrip],
  template: `
    <section class="card">
      <div class="section-heading">
        <div>
          <span class="eyebrow">SIX-STEM MIXER</span>
          <h1>{{ sceneTitle || job()?.title || 'Stem mixer' }}</h1>
          @if (job()?.author) { <p class="music-byline">By {{ job()!.author }}</p> }
        </div>
        @if (!sceneEntry) { <a routerLink="/list">Back to music</a> }
      </div>
      @if (error()) { <p role="alert" class="error">{{ error() }}</p> }
      @if (job() && job()!.status !== 'completed' && job()!.status !== 'failed') {
        <p role="status" class="hint">Separation {{ job()!.status }}. This page checks for updates automatically.</p>
      }
      @if (job()?.status === 'failed') {
        <p role="alert" class="error">{{ job()?.error || 'Stem separation failed.' }}</p>
      }
      @if (job()?.status === 'completed') {
        @if (sceneEntry) {
          <button type="button" class="secondary" (click)="resetSong()" [disabled]="!canPlay()">Reset song settings</button>
        }
        @if (editingMetadata()) {
          <form class="metadata-form" (ngSubmit)="saveMetadata()">
            <label for="music-title">Music title</label>
            <input id="music-title" name="musicTitle" [(ngModel)]="musicTitle" required maxlength="200"
              [disabled]="savingMetadata()">
            @if (!sceneEntry) {
              <label for="music-author">Author</label>
              <input id="music-author" name="musicAuthor" [(ngModel)]="musicAuthor" maxlength="200"
                placeholder="Artist or composer (optional)" [disabled]="savingMetadata()">
            }
            @if (metadataError()) { <p class="error" role="alert">{{ metadataError() }}</p> }
            <div class="metadata-buttons">
              <button type="submit" [disabled]="savingMetadata() || !musicTitle.trim()">
                {{ savingMetadata() ? 'Saving...' : sceneEntry ? 'Save scene song title' : 'Save title and author' }}
              </button>
              <button type="button" class="secondary" (click)="editingMetadata.set(false)"
                [disabled]="savingMetadata()">Cancel</button>
            </div>
          </form>
        } @else {
          <button type="button" class="secondary" (click)="editMetadata()">{{ sceneEntry ? 'Edit scene song title' : 'Edit title and author' }}</button>
        }
        @if (metadataSaved()) { <p class="success" role="status">Title and author saved.</p> }
        <div class="section-heading mixer-actions">
          <p class="hint">Refreshes signed playback and download links automatically every 45 minutes.</p>
          <button type="button" class="secondary" (click)="retryLoadAndRenew()"
            [disabled]="renewingLinks()">
            {{ renewingLinks() ? 'Refreshing links...' : 'Retry load / refresh links' }}
          </button>
        </div>
        <p class="hint">Drag the S/E arrows to set the shared interval; drag a waveform or red playhead to scrub.
          Transport, Loop and Master in any mixer control all stems together.</p>
        <div class="stem-tracks">
          @for (track of tracks(); track track.name) {
            <article class="stem-track" [attr.data-stem]="track.name">
              <section class="mixing-console" [attr.aria-label]="track.label + ' mixer'">
              <div class="console-stem-view">
              <div class="stem-heading">
                <h2>{{ track.label }}</h2>
                @if (track.status === 'loading') { <span class="hint">Loading audio...</span> }
                <div class="stem-actions">
                  @if (track.name === 'vocals' && !lyricLines()) {
                    @if (findingLyrics()) {
                      <button type="button" class="secondary" disabled>Finding lyrics...</button>
                    } @else {
                      <button type="button" class="secondary" (click)="findLyrics()" [disabled]="!canPlay()">Lyrics</button>
                    }
                  }
                  @if (track.name === 'vocals' && lyricLines()) {
                    <button type="button" class="secondary" (click)="editLyrics()">Edit lyrics</button>
                  }
                  @if (isHarmonic(track.name) && !harmonyParts()) {
                    @if (findingChords()) {
                      <button type="button" class="secondary" disabled>Finding notes...</button>
                    } @else {
                      <button type="button" class="secondary" (click)="findChords()" [disabled]="!canPlay()"
                        aria-label="Find chords and melody for guitar, piano, other and bass, and the drum score">{{ track.name === 'drums' ? 'Drum score' : 'Chords & melody' }}</button>
                    }
                  }
                  @if (isHarmonic(track.name) && harmonyParts()) {
                    @if (regenerating(track.name)) {
                      <button type="button" class="secondary" disabled>Regenerating...</button>
                    } @else {
                      <button type="button" class="secondary" (click)="regenerate(track)" [disabled]="!canPlay()"
                        [attr.aria-label]="regenerateLabel(track.name) + ' for ' + track.label + ' only'">{{ regenerateLabel(track.name) }}</button>
                    }
                  }
                  @if (track.hasCleaned) {
                    <div class="version-switch" role="group" [attr.aria-label]="track.label + ' version'">
                      <button type="button" [class.active]="!track.useCleaned" [attr.aria-pressed]="!track.useCleaned"
                        (click)="showVersion(track.name, false)">Original</button>
                      <button type="button" [class.active]="track.useCleaned" [attr.aria-pressed]="track.useCleaned"
                        (click)="showVersion(track.name, true)">Cleaned</button>
                    </div>
                  } @else if (cleaning(track.name)) {
                    <button type="button" class="secondary" disabled>Cleaning...</button>
                  } @else {
                    <button type="button" class="secondary" (click)="clean(track.name)" [disabled]="!canPlay()"
                      [attr.aria-label]="'Clean ' + track.label">Clean</button>
                  }
                  @if (track.status === 'ready') {
                    <a [href]="track.useCleaned ? track.cleanedDownloadUrl : track.downloadUrl"
                      [download]="job()!.title + '-' + track.label + (track.useCleaned ? '-cleaned' : '')">
                      Download
                    </a>
                  }
                </div>
                @if (track.status === 'error') { <span class="error">{{ track.error }}</span> }
                @if (cleanFailure(track)) { <span class="error">{{ cleanFailure(track) }}</span> }
                @if (track.name === 'vocals' && lyricsFailure()) { <span class="error">{{ lyricsFailure() }}</span> }
                @if (isHarmonic(track.name) && chordsFailure()) { <span class="error">{{ chordsFailure() }}</span> }
                @if (isHarmonic(track.name) && partFailure(track.name)) { <span class="error">{{ partFailure(track.name) }}</span> }
              </div>
              @if (track.name === 'vocals' && !lyricLines() && findingLyrics()) {
                <div class="task-note" role="status"><span>{{ lyricsNote }}</span></div>
              }
              @if (isHarmonic(track.name) && (harmonyParts() ? regenerating(track.name) : findingChords())) {
                <div class="task-note" role="status"><span>{{ chordsNote }}</span></div>
              }
              @if (isHarmonic(track.name) && harmonyParts(); as parts) {
                @if (track.name === 'drums' && !parts['drums'] && !regenerating('drums')) {
                  <p class="hint">Press Regenerate drum score to write this song's drums.</p>
                } @else if (hasMusic(parts[track.name])) {
                  <app-harmony-strip [part]="parts[track.name]" [stem]="track.name" [grid]="harmonyGrid()!" [time]="position()"></app-harmony-strip>
                } @else if (parts[track.name]) {
                  <p class="hint">No clear chords or notes were found in this stem.</p>
                }
              }
              @if (track.name === 'vocals' && lyricLines(); as lines) {
                @if (lines.length) {
                  <app-lyrics-strip [lines]="lines" [time]="position()"></app-lyrics-strip>
                } @else {
                  <p class="hint">No lyrics were found in this stem.</p>
                }
              }
              <div class="waveform-editor">
                <div class="marker-rail">
                  <button type="button" role="slider" class="boundary-arrow start-arrow"
                    [style.left.%]="waveformPercent(sectionStart())"
                    [attr.aria-label]="track.label + ' start marker'" aria-valuemin="0"
                    [attr.aria-valuemax]="sectionEndTime() - minimumInterval()"
                    [attr.aria-valuenow]="sectionStart()" [attr.aria-valuetext]="sectionStart().toFixed(2) + ' seconds'"
                    [attr.title]="'Start: ' + sectionStart().toFixed(2) + 's'"
                    [disabled]="!canPlay()" (pointerdown)="beginDrag('start', $event)"
                    (pointermove)="moveDrag($event)" (pointerup)="endDrag($event)"
                    (pointercancel)="finishDrag()" (lostpointercapture)="finishDrag()"
                    (keydown)="moveMarkerByKey('start', $event)">
                    <span class="marker-letter">S</span><span class="down-arrow"></span>
                  </button>
                  <button type="button" role="slider" class="boundary-arrow end-arrow"
                    [style.left.%]="waveformPercent(sectionEndTime())"
                    [attr.aria-label]="track.label + ' end marker'"
                    [attr.aria-valuemin]="sectionStart() + minimumInterval()" [attr.aria-valuemax]="duration()"
                    [attr.aria-valuenow]="sectionEndTime()" [attr.aria-valuetext]="sectionEndTime().toFixed(2) + ' seconds'"
                    [attr.title]="'End: ' + sectionEndTime().toFixed(2) + 's'"
                    [disabled]="!canPlay()" (pointerdown)="beginDrag('end', $event)"
                    (pointermove)="moveDrag($event)" (pointerup)="endDrag($event)"
                    (pointercancel)="finishDrag()" (lostpointercapture)="finishDrag()"
                    (keydown)="moveMarkerByKey('end', $event)">
                    <span class="marker-letter">E</span><span class="down-arrow"></span>
                  </button>
                </div>
              <svg class="waveform selectable-waveform" viewBox="0 0 600 64" preserveAspectRatio="none"
                role="img" [attr.aria-label]="track.label + ' waveform; drag to scrub all stems'"
                (pointerdown)="beginDrag('playhead', $event)" (pointermove)="moveDrag($event)"
                (pointerup)="endDrag($event)" (pointercancel)="finishDrag()"
                (lostpointercapture)="finishDrag()">
                @for (peak of track.useCleaned ? track.cleanedPeaks : track.peaks; track $index) {
                  <rect [attr.x]="$index * 6 + 1" [attr.y]="32 - peak * 29"
                    width="4" [attr.height]="Math.max(2, peak * 58)" rx="1"></rect>
                }
                  <rect class="section-highlight" [attr.x]="waveformX(sectionStart())" y="0"
                    [attr.width]="waveformX(sectionEndTime() - sectionStart())" height="64"></rect>
                  <line class="section-marker" [attr.x1]="waveformX(sectionStart())"
                    [attr.x2]="waveformX(sectionStart())" y1="0" y2="64"></line>
                  <line class="section-marker" [attr.x1]="waveformX(sectionEndTime())"
                    [attr.x2]="waveformX(sectionEndTime())" y1="0" y2="64"></line>
                <line class="playhead" [attr.x1]="waveformX(position())"
                  [attr.x2]="waveformX(position())" y1="0" y2="64"></line>
              </svg>
                <button type="button" role="slider" class="playhead-handle"
                  [style.left.%]="waveformPercent(position())"
                  [attr.aria-label]="track.label + ' playhead'" [attr.aria-valuemin]="sectionStart()"
                  [attr.aria-valuemax]="sectionEndTime()" [attr.aria-valuenow]="position()"
                  [attr.title]="'Playback: ' + position().toFixed(2) + 's'"
                  [disabled]="!canPlay()" (pointerdown)="beginDrag('playhead', $event)"
                  (pointermove)="moveDrag($event)" (pointerup)="endDrag($event)"
                  (pointercancel)="finishDrag()" (lostpointercapture)="finishDrag()"
                  (keydown)="moveMarkerByKey('playhead', $event)">
                  <span class="playhead-grip"></span>
                </button>
              </div>
              <div class="waveform-times">
                <span class="section-start">
                  <button type="button" class="secondary" (click)="resetSection()" [disabled]="!sectionChanged()"
                    [attr.aria-label]="track.label + ' reset loop interval to the whole song'">Reset</button>
                  Start {{ sectionStart().toFixed(2) }}s
                </span>
                <span>Playing {{ position().toFixed(2) }}s</span>
                <span>End {{ sectionEndTime().toFixed(2) }}s</span>
              </div>
              </div>
              <div class="stem-transport">
                <div class="seek-row">
                  <span>{{ formatTime(position()) }}</span>
                  <input [attr.aria-label]="track.label + ' seek all stems'" type="range" [min]="sectionStart()"
                    [max]="sectionEndTime() || 0" step="0.01"
                    [value]="position()" (input)="seek($event)" [disabled]="!canPlay()">
                  <span>{{ formatTime(duration()) }}</span>
                </div>
              </div>
                <button type="button" class="console-heading" [id]="'mixer-toggle-' + track.name"
                  [attr.aria-label]="track.label + ' mixer controls'"
                  [attr.aria-expanded]="expandedStem() === track.name"
                  [attr.aria-controls]="'mixer-panel-' + track.name"
                  (click)="toggleMixer(track.name)">
                  <span class="console-title"><span class="console-chevron" aria-hidden="true"></span>
                    Mixer <span class="console-action">{{ expandedStem() === track.name ? 'Hide controls' : 'Show controls' }}</span>
                  </span>
                  <span class="console-status">
                    <span class="console-volume">{{ track.volume }}%</span>
                    @if (track.muted) { <span class="console-state">Muted</span> }
                    @if (track.solo) { <span class="console-state">Solo</span> }
                    <span class="console-led" aria-hidden="true"
                    [class.on]="playing() && !track.muted && !suppressedBySolo(track)"></span>
                    {{ track.bypassed ? 'FX bypassed' : 'FX active' }}</span>
                </button>
                <div class="console-panel" [id]="'mixer-panel-' + track.name" role="region"
                  [attr.aria-labelledby]="'mixer-toggle-' + track.name"
                  [hidden]="expandedStem() !== track.name">
                <div class="console-transport" role="group" [attr.aria-label]="track.label + ' transport, mute and solo'">
                <div class="transport-buttons">
                  @if (sceneEntry) {
                    <button type="button" class="secondary" (click)="previousSong.emit()" [disabled]="!hasPrevious">Previous song</button>
                    <button type="button" class="secondary" (click)="nextSong.emit()" [disabled]="!hasNext">Next song</button>
                  }
                  <button type="button" (click)="play()" [disabled]="!canPlay() || playing()"
                    [attr.aria-label]="track.label + ' play all stems'">
                    {{ position() > sectionStart() && position() < sectionEndTime() ? 'Resume' : 'Play' }}
                  </button>
                  <button type="button" class="secondary" (click)="pause()" [disabled]="!playing()"
                    [attr.aria-label]="track.label + ' pause all stems'">Pause</button>
                  <button type="button" class="secondary" (click)="stop()"
                    [disabled]="!playing() && position() === sectionStart()"
                    [attr.aria-label]="track.label + ' stop all stems'">Stop</button>
                  <button type="button" class="console-switch" [class.lit]="track.muted"
                    [attr.aria-label]="track.label + ' mute'" [attr.aria-pressed]="track.muted"
                    (click)="toggleMute(track.name)" [disabled]="track.status !== 'ready'">
                    <span class="switch-lamp"></span><span>MUTE</span>
                  </button>
                  <button type="button" class="console-switch" [class.lit]="allMuted()"
                    aria-label="Mute all stems" [attr.aria-pressed]="allMuted()"
                    (click)="toggleMuteAll()" [disabled]="!canPlay()">
                    <span class="switch-lamp"></span><span>ALL MUTE</span>
                  </button>
                  <button type="button" class="console-switch" [class.lit]="track.solo"
                    [attr.aria-label]="track.label + ' solo'" [attr.aria-pressed]="track.solo"
                    (click)="toggleSolo(track.name)" [disabled]="track.status !== 'ready'">
                    <span class="switch-lamp"></span><span>SOLO</span>
                  </button>
                  <button type="button" class="console-switch loop-switch" [class.lit]="loopSection()"
                    [attr.aria-label]="track.label + ' loop all stems'"
                    [attr.aria-pressed]="loopSection()" [disabled]="!canPlay()" (click)="toggleLoop()">
                    <span class="switch-lamp" aria-hidden="true"></span><span>LOOP</span>
                  </button>
                  <div class="master-control">
                    <label [for]="'master-volume-' + track.name">Master {{ masterVolume() }}%</label>
                    <input class="master-fader" [id]="'master-volume-' + track.name" type="range" min="0" max="100" step="1"
                      [attr.aria-label]="track.label + ' master volume for all stems'"
                      [attr.aria-valuetext]="masterVolume() + ' percent'" aria-orientation="horizontal"
                      [value]="masterVolume()" (input)="setMasterVolume($event)" [disabled]="!canPlay()">
                  </div>
                </div>
                </div>
                <div class="console-scroll" tabindex="0"
                  [attr.aria-label]="track.label + ' faders; scroll horizontally on small screens'">
                  <div class="console-channels">
                    @for (control of controls; track control.key) {
                      <div class="channel-strip" [class.control-inactive]="controlDisabled(track, control)">
                        <label class="channel-name" [for]="control.key + '-' + track.name">{{ control.label }}</label>
                        <output class="channel-level" [for]="control.key + '-' + track.name">
                          {{ controlValue(track, control) }}
                        </output>
                        <div class="fader-well">
                          <div class="fader-scale" aria-hidden="true">
                            @for (fraction of scaleFractions; track fraction) {
                              <span [style.top.%]="100 - fraction * 100">
                                {{ scaleValue(control, fraction) }}<i></i>
                              </span>
                            }
                          </div>
                          <input class="console-fader" [id]="control.key + '-' + track.name" type="range"
                            [min]="control.min" [max]="control.max" [step]="control.step"
                            [attr.aria-label]="track.label + ' ' + control.label"
                            [attr.aria-valuetext]="controlValue(track, control)"
                            [attr.title]="controlDisabledReason(track, control) || control.label"
                            [value]="track[control.key]" (input)="setControl(track.name, control.key, $event)"
                            [disabled]="controlDisabled(track, control)">
                        </div>
                        <span class="control-note">{{ controlDisabledReason(track, control) || control.unit || 'L / R' }}</span>
                      </div>
                    }
                  </div>
                </div>
                <div class="console-buttons">
                  <button type="button" class="console-switch" [class.lit]="track.bypassed"
                    [attr.aria-label]="track.label + ' effects bypass'" [attr.aria-pressed]="track.bypassed"
                    (click)="toggleBypass(track.name)" [disabled]="track.status !== 'ready'">
                    <span class="switch-lamp"></span><span>EFFECTS BYPASS</span>
                  </button>
                  <button type="button" class="console-switch"
                    [attr.aria-label]="track.label + ' reset'" (click)="resetTrack(track.name)"
                    [disabled]="track.status !== 'ready'">
                    <span class="switch-lamp"></span><span>RESET</span>
                  </button>
                </div>
                <p class="console-note">
                  @if (track.bypassed) { Effects bypassed. Volume, mute and solo still apply. }
                  @else if (suppressedBySolo(track)) { Silent while another stem is soloed. }
                  @else { All effects apply to this stem. Reset restores its faders and buttons only. }
                </p>
                </div>
              </section>
            </article>
          }
        </div>
      }
      @if (editingLyrics() && lyricLines(); as lines) {
        <app-lyrics-editor [lines]="lines" [duration]="duration()" [saving]="savingLyrics()" [error]="lyricsSaveError()"
          (saved)="saveLyrics($event)" (cancelled)="editingLyrics.set(false)"></app-lyrics-editor>
      }
    </section>
  `,
})
export class MixerPage implements OnInit, OnChanges, OnDestroy {
  @Input() sceneEntry?: SceneEntry;
  @Input() sceneTitle = '';
  @Input() hasPrevious = false;
  @Input() hasNext = false;
  @Output() settingsChanged = new EventEmitter<SceneSettings>();
  @Output() sceneTitleChanged = new EventEmitter<string>();
  @Output() songEnded = new EventEmitter<void>();
  @Output() audioReady = new EventEmitter<void>();
  @Output() audioFailed = new EventEmitter<string>();
  @Output() previousSong = new EventEmitter<void>();
  @Output() nextSong = new EventEmitter<void>();
  private readonly confirm = inject(ConfirmationService);
  private readonly hydrated = signal(false);
  private initialized = false;
  private entryId = '';
  private lastSettings = '';
  private readonly route = inject(ActivatedRoute);
  private readonly stems = inject(StemsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private centered: string | null = null;
  private scrollFrame = 0;
  private readonly followScroll = () => {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.openCentered();
    });
  };
  private jobId = '';
  private generation = 0;
  private routeSubscription?: Subscription;
  private pollTimer?: ReturnType<typeof setInterval>;
  private linkRenewTimer?: ReturnType<typeof setInterval>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private mediaController?: AbortController;
  private context?: AudioContext;
  private master?: GainNode;
  private readonly runtimes = new Map<string, StemRuntime>();
  private readonly sources = new Map<string, AudioBufferSourceNode>();
  private destroyed = false;
  private polling = false;
  private loadingStems = false;
  private starting = false;
  private playbackToken = 0;
  private linksRenewing = false;
  private startedAt = 0;
  private startOffset = 0;
  private drag?: { pointerId: number; kind: 'start' | 'end' | 'playhead'; resume: boolean };
  private readonly scrubSources = new Set<AudioBufferSourceNode>();
  private scrubReady = false;
  private lastScrubAt = -Infinity;
  private readonly startingClean = signal<string[]>([]);
  private readonly startingLyrics = signal(false);
  private readonly lyricsLoadError = signal('');
  private lyricsLoading = false;
  private readonly startingChords = signal(false);
  private readonly chordsLoadError = signal('');
  private chordsLoading = false;
  private readonly startingParts = signal<string[]>([]);
  private readonly partLoadErrors = signal<Record<string, string>>({});
  private readonly loadedParts = new Map<string, string>();

  readonly lyricsNote = 'Converting voice to text takes time. The timing may not match well at first but improves when reloaded. You can edit the text later.';
  readonly chordsNote = 'Converting to chords and melody takes time, and the result is not the same as the original.';
  readonly lyricLines = signal<LyricLine[] | null>(null);
  readonly editingLyrics = signal(false);
  readonly savingLyrics = signal(false);
  readonly lyricsSaveError = signal('');
  readonly harmonyParts = signal<Record<string, HarmonyPart> | null>(null);
  readonly harmonyGrid = signal<HarmonyGrid | null>(null);
  readonly Math = Math;
  readonly controls = FADER_CONTROLS;
  readonly scaleFractions = [1, 0.75, 0.5, 0.25, 0];
  readonly job = signal<Job | null>(null);
  readonly tracks = signal<StemTrack[]>(STEM_NAMES.map(newTrack));
  readonly error = signal('');
  readonly position = signal(0);
  readonly duration = signal(0);
  readonly playing = signal(false);
  readonly renewingLinks = signal(false);
  readonly masterVolume = signal(80);
  readonly sectionStart = signal(0);
  readonly sectionEnd = signal<number | null>(null);
  readonly loopSection = signal(false);
  readonly expandedStem = signal<string | null>(STEM_NAMES[0]);
  readonly editingMetadata = signal(false);
  readonly savingMetadata = signal(false);
  readonly metadataError = signal('');
  readonly metadataSaved = signal(false);
  musicTitle = '';
  musicAuthor = '';

  constructor() {
    effect(() => {
      if (!this.hydrated()) return;
      const settings = this.snapshotSettings();
      const serialized = JSON.stringify(settings);
      if (this.sceneEntry && serialized !== this.lastSettings) {
        this.lastSettings = serialized;
        untracked(() => this.settingsChanged.emit(settings));
      }
    });
  }

  private snapshotSettings(): SceneSettings {
    return captureSceneSettings(this.masterVolume(), this.sectionStart(), this.sectionEndTime(),
      this.loopSection(), this.tracks(), this.job()?.duration);
  }

  async resetSong(): Promise<void> {
    if (!await this.confirm.confirm('Reset song settings?', 'Restore every stem, master volume, original audio, full-song interval and Loop off for this scene entry? Its title and position in the scene will not change.', 'Reset song')) return;
    this.stop();
    for (const track of this.tracks()) {
      this.resetTrack(track.name);
      this.showVersion(track.name, false);
    }
    this.masterVolume.set(80);
    if (this.master && this.context) this.master.gain.setTargetAtTime(0.8, this.context.currentTime, 0.015);
    this.sectionStart.set(0); this.sectionEnd.set(null); this.loopSection.set(false); this.position.set(0);
  }

  editMetadata(): void {
    this.musicTitle = this.sceneEntry?.title || this.job()?.title || '';
    this.musicAuthor = this.job()?.author ?? '';
    this.metadataError.set('');
    this.metadataSaved.set(false);
    this.editingMetadata.set(true);
  }

  async saveMetadata(): Promise<void> {
    if (this.savingMetadata()) return;
    const generation = this.generation;
    this.savingMetadata.set(true);
    this.metadataError.set('');
    try {
      if (this.sceneEntry) {
        if (!this.musicTitle.trim() || this.musicTitle.trim().length > 200) throw new Error('Enter a title of 1–200 characters.');
        this.sceneTitleChanged.emit(this.musicTitle.trim());
        this.editingMetadata.set(false);
        return;
      }
      const { metadata } = await this.stems.updateMetadata(this.jobId, this.musicTitle, this.musicAuthor);
      if (this.destroyed || generation !== this.generation) return;
      this.job.update(job => job ? { ...job, ...metadata } : job);
      this.editingMetadata.set(false);
      this.metadataSaved.set(true);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) this.metadataError.set(errorMessage(error));
    } finally {
      if (!this.destroyed && generation === this.generation) this.savingMetadata.set(false);
    }
  }

  toggleMixer(name: string): void {
    this.showMixer(this.expandedStem() === name ? null : name, name);
  }

  // Changes which mixer is open, keeping the anchor stem in place on screen while the others resize.
  private showMixer(name: string | null, anchorName: string): void {
    const top = () => this.host.nativeElement.querySelector(`[data-stem="${anchorName}"]`)?.getBoundingClientRect().top ?? 0;
    const before = top();
    this.expandedStem.set(name);
    afterNextRender(() => {
      const moved = top() - before;
      if (Math.abs(moved) > 0.5) window.scrollBy(0, moved);
      // A mixer closed by hand stays closed only while it is the one in the middle.
      this.centered = name === null ? anchorName : this.centeredStem();
    }, { injector: this.injector });
  }

  private centeredStem(): string | null {
    const tracks = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-stem]'));
    // On a tall screen the first stem cannot reach the middle.
    if (window.scrollY <= 0) return tracks[0]?.dataset['stem'] ?? null;
    const middle = window.innerHeight / 2;
    let nearest: string | null = null, shortest = Infinity;
    for (const track of tracks) {
      const { top, bottom } = track.getBoundingClientRect();
      const distance = Math.max(top - middle, middle - bottom, 0);
      if (distance < shortest) {
        shortest = distance;
        nearest = track.dataset['stem'] ?? null;
      }
    }
    return nearest;
  }

  // Acts only when the middle reaches another stem, so a mixer closed by hand stays closed until then.
  private openCentered(): void {
    const focused = document.activeElement;
    // Closing the panel holding keyboard focus would lose the user's place.
    if (focused?.closest('.console-panel') && focused.matches(':focus-visible')) return;
    const name = this.centeredStem();
    if (!name || name === this.centered) return;
    this.centered = name;
    if (name !== this.expandedStem()) this.showMixer(name, name);
  }

  cleaning(name: string): boolean {
    return this.startingClean().includes(name) || !!this.job()?.restorations?.some(item =>
      item.stem === name && item.status !== 'failed');
  }

  cleanFailure(track: StemTrack): string | undefined {
    if (track.hasCleaned || this.cleaning(track.name)) return track.cleanError;
    return this.job()?.restorations?.find(item => item.stem === track.name && item.status === 'failed')?.error;
  }

  async clean(name: string): Promise<void> {
    if (!STEM_NAMES.some(stem => stem === name) || this.cleaning(name)) return;
    const generation = this.generation;
    this.startingClean.update(names => [...names, name]);
    this.error.set('');
    try {
      await this.stems.createRestoration(this.jobId, name as StemName);
      if (this.destroyed || generation !== this.generation) return;
      await this.refreshJob(generation);
      this.watchRestorations(generation);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.error.set(`Could not start cleaning ${name}: ${errorMessage(error)}`);
      }
    } finally {
      this.startingClean.update(names => names.filter(item => item !== name));
    }
  }

  findingLyrics(): boolean {
    const lyrics = this.job()?.lyrics;
    return this.startingLyrics() || (!!lyrics && lyrics.status !== 'failed' && !this.lyricsLoadError());
  }

  lyricsFailure(): string | undefined {
    if (this.findingLyrics() || this.lyricLines()) return undefined;
    return this.lyricsLoadError() || this.job()?.lyrics?.error;
  }

  async findLyrics(): Promise<void> {
    if (this.findingLyrics()) return;
    const generation = this.generation;
    this.startingLyrics.set(true);
    this.lyricsLoadError.set('');
    this.error.set('');
    try {
      await this.stems.createLyrics(this.jobId);
      if (this.destroyed || generation !== this.generation) return;
      await this.refreshJob(generation);
      this.watchRestorations(generation);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.error.set(`Could not start finding lyrics: ${errorMessage(error)}`);
      }
    } finally {
      this.startingLyrics.set(false);
    }
  }

  editLyrics(): void {
    this.pause();
    this.lyricsSaveError.set('');
    this.editingLyrics.set(true);
  }

  // Leaves the cursor just before the first change, ready to replay it.
  async saveLyrics(lines: LyricLine[]): Promise<void> {
    const generation = this.generation;
    const changed = firstChange(this.lyricLines() ?? [], lines);
    if (changed === null) {
      this.editingLyrics.set(false);
      return;
    }
    this.savingLyrics.set(true);
    this.lyricsSaveError.set('');
    try {
      await this.stems.saveLyrics(this.jobId, lines);
      if (this.destroyed || generation !== this.generation) return;
      this.lyricLines.set(lines);
      this.editingLyrics.set(false);
      this.moveTo(changed - LYRICS_REPLAY_LEAD);
      await this.refreshJob(generation);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.lyricsSaveError.set(`Could not save the lyrics: ${errorMessage(error)}`);
      }
    } finally {
      this.savingLyrics.set(false);
    }
  }

  private async loadLyrics(job: Job, generation: number): Promise<void> {
    const url = job.lyrics?.url;
    if (!url || this.lyricLines() || this.lyricsLoading || this.lyricsLoadError()) return;
    this.lyricsLoading = true;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Lyrics request failed (HTTP ${response.status}).`);
      const { lines } = await response.json() as { lines: LyricLine[] };
      if (!this.destroyed && generation === this.generation) this.lyricLines.set(lines);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.lyricsLoadError.set(`Could not load the lyrics: ${errorMessage(error)}`);
      }
    } finally {
      this.lyricsLoading = false;
    }
  }

  isHarmonic(name: string): boolean { return HARMONY_STEMS.includes(name); }

  hasMusic(part?: HarmonyPart): boolean { return !!part && (part.chords.length > 0 || part.notes.length > 0 || !!part.hits?.length); }

  findingChords(): boolean {
    const harmony = this.job()?.harmony;
    return this.startingChords() || (!!harmony && harmony.status !== 'failed' && !this.chordsLoadError());
  }

  chordsFailure(): string | undefined {
    if (this.findingChords() || this.harmonyParts()) return undefined;
    return this.chordsLoadError() || this.job()?.harmony?.error;
  }

  async findChords(): Promise<void> {
    if (this.findingChords()) return;
    const generation = this.generation;
    this.startingChords.set(true);
    this.chordsLoadError.set('');
    this.error.set('');
    try {
      await this.stems.createHarmony(this.jobId);
      if (this.destroyed || generation !== this.generation) return;
      await this.refreshJob(generation);
      this.watchRestorations(generation);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.error.set(`Could not start finding chords: ${errorMessage(error)}`);
      }
    } finally {
      this.startingChords.set(false);
    }
  }

  private async loadChords(job: Job, generation: number): Promise<void> {
    const url = job.harmony?.url;
    if (!url || this.harmonyParts() || this.chordsLoading || this.chordsLoadError()) return;
    this.chordsLoading = true;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Chords request failed (HTTP ${response.status}).`);
      const { stems, ...grid } = await response.json() as HarmonyGrid & { stems: Record<string, HarmonyPart> };
      if (!this.destroyed && generation === this.generation) {
        this.harmonyGrid.set(grid);
        this.harmonyParts.set(stems);
        void this.loadParts(generation);
      }
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.chordsLoadError.set(`Could not load the chords: ${errorMessage(error)}`);
      }
    } finally {
      this.chordsLoading = false;
    }
  }

  regenerateLabel(name: string): string {
    return name === 'other' ? 'Regenerate chords' : name === 'drums' ? 'Regenerate drum score' : 'Regenerate chords & melody';
  }

  regenerating(name: string): boolean {
    const status = this.job()?.harmony?.stems?.[name]?.status;
    return this.startingParts().includes(name) || status === 'queued' || status === 'processing';
  }

  partFailure(name: string): string | undefined {
    if (this.regenerating(name)) return undefined;
    const part = this.job()?.harmony?.stems?.[name];
    return this.partLoadErrors()[name] || (part?.status === 'failed' ? part.error : undefined);
  }

  // Uses the version being heard, since the same audio would give the same notes.
  async regenerate(track: StemTrack): Promise<void> {
    const name = track.name;
    if (this.regenerating(name)) return;
    const generation = this.generation;
    this.startingParts.update(names => [...names, name]);
    this.partLoadErrors.update(({ [name]: _, ...others }) => others);
    this.error.set('');
    try {
      await this.stems.createHarmony(this.jobId, { stem: name, cleaned: track.useCleaned });
      if (this.destroyed || generation !== this.generation) return;
      await this.refreshJob(generation);
      this.watchRestorations(generation);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.error.set(`Could not start regenerating ${name}: ${errorMessage(error)}`);
      }
    } finally {
      this.startingParts.update(names => names.filter(item => item !== name));
    }
  }

  private async loadParts(generation: number): Promise<void> {
    const parts = this.job()?.harmony?.stems ?? {};
    if (!this.harmonyParts()) return;
    await Promise.all(Object.entries(parts).map(async ([name, part]) => {
      if (!part?.url || !part.resultId || this.loadedParts.get(name) === part.resultId || this.partLoadErrors()[name]) return;
      this.loadedParts.set(name, part.resultId);
      try {
        const response = await fetch(part.url);
        if (!response.ok) throw new Error(`Chords request failed (HTTP ${response.status}).`);
        const { stems } = await response.json() as { stems: Record<string, HarmonyPart> };
        if (!this.destroyed && generation === this.generation) {
          this.harmonyParts.update(current => current && { ...current, [name]: stems[name] });
        }
      } catch (error) {
        this.loadedParts.delete(name);
        if (!this.destroyed && generation === this.generation) {
          this.partLoadErrors.update(errors => ({ ...errors, [name]: `Could not load the regenerated notes: ${errorMessage(error)}` }));
        }
      }
    }));
  }

  private restoring(job: Job | null): boolean {
    const running = (status?: string) => status === 'queued' || status === 'processing';
    return !!job?.restorations?.some(item => running(item.status)) ||
      running(job?.lyrics?.status) || running(job?.harmony?.status) ||
      Object.values(job?.harmony?.stems ?? {}).some(part => running(part?.status));
  }

  private watchRestorations(generation: number): void {
    clearInterval(this.pollTimer);
    if (!this.restoring(this.job())) return;
    this.pollTimer = setInterval(() => { void this.refreshJob(generation); }, STEM_POLL_MS);
  }

  // Both versions play in sync, so switching compares them without restarting.
  showVersion(name: string, cleaned: boolean): void {
    this.updateTrack(name, { useCleaned: cleaned });
    const runtime = this.runtimes.get(name);
    if (runtime && this.context) this.applyVersion(runtime, cleaned, this.context.currentTime);
  }

  private applyVersion(runtime: StemRuntime, cleaned: boolean, time: number): void {
    const available = cleaned && !!runtime.cleanedBuffer;
    runtime.originalLevel.gain.setTargetAtTime(available ? 0 : 1, time, 0.005);
    runtime.cleanedLevel.gain.setTargetAtTime(available ? 1 : 0, time, 0.005);
  }

  sectionEndTime(): number { return this.sectionEnd() ?? this.duration(); }
  waveformPercent(time: number): number { return this.duration() > 0 ? time / this.duration() * 100 : 0; }
  waveformX(time: number): number { return this.duration() > 0 ? time / this.duration() * 600 : 0; }
  minimumInterval(): number { return Math.min(0.05, this.duration()); }

  private playbackBounds(): { start: number; end: number } {
    return { start: this.sectionStart(), end: this.sectionEndTime() };
  }

  sectionChanged(): boolean {
    return this.sectionStart() > 0 || this.sectionEndTime() < this.duration();
  }

  resetSection(): void {
    if (!this.sectionChanged()) return;
    const resume = this.playing();
    this.pause();
    this.sectionStart.set(0);
    this.sectionEnd.set(null);
    if (resume) void this.play();
    else this.position.set(0);
  }

  toggleLoop(): void {
    if (!this.canPlay()) return;
    const resume = this.playing();
    this.pause();
    this.loopSection.update(current => !current);
    if (resume) void this.play();
  }

  private moveMarker(kind: 'start' | 'end' | 'playhead', time: number): void {
    if (kind === 'start') {
      this.sectionStart.set(Math.max(0, Math.min(time, this.sectionEndTime() - this.minimumInterval())));
      this.position.set(this.sectionStart());
    } else if (kind === 'end') {
      this.sectionEnd.set(Math.max(this.sectionStart() + this.minimumInterval(), Math.min(time, this.duration())));
      this.position.set(this.sectionEndTime());
    } else {
      this.position.set(Math.max(this.sectionStart(), Math.min(time, this.sectionEndTime())));
    }
  }

  private pointerTime(event: PointerEvent): number | undefined {
    if (!(event.currentTarget instanceof Element)) return undefined;
    const rect = event.currentTarget.closest('.waveform-editor')?.getBoundingClientRect();
    if (!rect?.width) return undefined;
    return Math.max(0, Math.min(this.duration(),
      Math.round((event.clientX - rect.left) / rect.width * this.duration() * 100) / 100));
  }

  beginDrag(kind: 'start' | 'end' | 'playhead', event: PointerEvent): void {
    if (!this.canPlay() || event.button !== 0 || this.drag ||
        !(event.currentTarget instanceof Element)) return;
    const resume = this.playing();
    this.pause();
    this.drag = { pointerId: event.pointerId, kind, resume };
    if (kind === 'start') this.position.set(this.sectionStart());
    else if (kind === 'end') this.position.set(this.sectionEndTime());
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
    // Resume inside the pointer gesture; later moves preview the latest position.
    const token = this.playbackToken;
    const context = this.context;
    if (!context) return;
    void context.resume().then(() => {
      if (token !== this.playbackToken || !this.drag || context !== this.context) return;
      this.scrubReady = true;
      this.previewScrub();
    }).catch(error => {
      if (token === this.playbackToken) {
        this.error.set(`Could not preview audio while dragging: ${errorMessage(error)}`);
      }
    });
    if (kind === 'playhead') this.moveDrag(event);
  }

  moveDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const time = this.pointerTime(event);
    if (time === undefined) return;
    this.moveMarker(this.drag.kind, time);
    this.previewScrub();
  }

  endDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.moveDrag(event);
    this.finishDrag();
  }

  finishDrag(): void {
    if (!this.drag) return;
    const resume = this.drag.resume;
    this.stopScrub();
    ++this.playbackToken;
    if (resume) {
      const { start, end } = this.playbackBounds();
      this.position.set(Math.max(start, Math.min(this.position(), end - 1 / (this.context?.sampleRate ?? 44100))));
      void this.play();
    }
  }

  moveMarkerByKey(kind: 'start' | 'end' | 'playhead', event: KeyboardEvent): void {
    if (!this.canPlay() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const resume = this.playing();
    this.pause();
    const value = kind === 'start' ? this.sectionStart() : kind === 'end' ? this.sectionEndTime() : this.position();
    const delta = event.shiftKey ? 1 : 0.1;
    const time = event.key === 'Home' ? 0 : event.key === 'End' ? this.duration()
      : value + (event.key === 'ArrowLeft' ? -delta : delta);
    this.moveMarker(kind, time);
    if (resume) void this.play();
  }

  private previewScrub(): void {
    const context = this.context;
    if (!this.scrubReady || !context || context.state !== 'running' ||
        context.currentTime - this.lastScrubAt < 0.06) return;
    this.lastScrubAt = context.currentTime;
    const startAt = context.currentTime + 0.005;
    try {
      for (const [name, runtime] of this.runtimes) {
        const useCleaned = this.tracks().find(track => track.name === name)?.useCleaned;
        // Overlapping, faded grains audition successive positions in either drag direction.
        const length = Math.min(0.1, runtime.buffer.duration);
        const fade = Math.min(0.008, length / 3);
        const offset = Math.min(this.position(), runtime.buffer.duration - length);
        const source = context.createBufferSource();
        const envelope = context.createGain();
        source.buffer = useCleaned && runtime.cleanedBuffer || runtime.buffer;
        source.connect(envelope);
        envelope.connect(runtime.input);
        runtime.transport.gain.setTargetAtTime(1, context.currentTime, 0.003);
        envelope.gain.setValueAtTime(0, startAt);
        envelope.gain.linearRampToValueAtTime(0.7, startAt + fade);
        envelope.gain.setValueAtTime(0.7, startAt + length - fade);
        envelope.gain.linearRampToValueAtTime(0, startAt + length);
        source.onended = () => {
          this.scrubSources.delete(source);
          source.disconnect();
          envelope.disconnect();
          if (!this.scrubSources.size && !this.playing()) this.setTransport(false);
        };
        this.scrubSources.add(source);
        source.start(startAt, offset, length);
      }
    } catch (error) {
      this.stopScrub();
      this.error.set(`Could not preview audio while dragging: ${errorMessage(error)}`);
    }
  }

  private stopScrub(): void {
    this.drag = undefined;
    this.scrubReady = false;
    this.lastScrubAt = -Infinity;
    for (const source of this.scrubSources) source.stop();
    this.scrubSources.clear();
    if (!this.playing()) this.setTransport(false);
  }

  ngOnInit(): void {
    this.initialized = true;
    window.addEventListener('scroll', this.followScroll, { passive: true });
    if (this.sceneEntry) { this.loadJob(this.sceneEntry.jobId); return; }
    this.routeSubscription = this.route.paramMap.subscribe(params => {
      const jobId = params.get('jobId');
      if (!jobId) {
        this.error.set('The mixer job ID is missing.');
        return;
      }
      this.loadJob(jobId);
    });
  }

  ngOnChanges(): void {
    if (!this.initialized || !this.sceneEntry || this.sceneEntry.id === this.entryId) return;
    this.loadJob(this.sceneEntry.jobId);
  }

  private loadJob(jobId: string): void {
      if (jobId === this.jobId && (!this.sceneEntry || this.entryId === this.sceneEntry.id)) return;
      this.entryId = this.sceneEntry?.id ?? '';
      this.hydrated.set(false);
      this.resetMixer();
      this.jobId = jobId;
      const generation = ++this.generation;
      this.job.set(null);
      this.tracks.set(STEM_NAMES.map(newTrack));
      this.error.set('');
      this.position.set(0);
      this.duration.set(0);
      this.sectionStart.set(0);
      this.sectionEnd.set(null);
      this.loopSection.set(false);
      this.masterVolume.set(80);
      this.playing.set(false);
      this.renewingLinks.set(false);
      this.loadingStems = false;
      void this.refreshJob(generation);
      this.pollTimer = setInterval(() => { void this.refreshJob(generation); }, STEM_POLL_MS);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.hydrated.set(false);
    window.removeEventListener('scroll', this.followScroll);
    cancelAnimationFrame(this.scrollFrame);
    this.routeSubscription?.unsubscribe();
    this.resetMixer();
  }

  private resetMixer(): void {
    this.editingMetadata.set(false);
    this.savingMetadata.set(false);
    this.metadataError.set('');
    this.metadataSaved.set(false);
    this.expandedStem.set(STEM_NAMES[0]);
    this.centered = null;
    this.stopScrub();
    ++this.playbackToken;
    this.starting = false;
    clearInterval(this.pollTimer);
    clearInterval(this.linkRenewTimer);
    clearInterval(this.clockTimer);
    this.mediaController?.abort();
    this.mediaController = undefined;
    this.stopSources();
    if (this.context && this.context.state !== 'closed') void this.context.close();
    this.context = undefined;
    this.master = undefined;
    this.runtimes.clear();
    this.startingClean.set([]);
    this.startingLyrics.set(false);
    this.lyricsLoadError.set('');
    this.lyricLines.set(null);
    this.editingLyrics.set(false);
    this.savingLyrics.set(false);
    this.lyricsSaveError.set('');
    this.lyricsLoading = false;
    this.startingChords.set(false);
    this.chordsLoadError.set('');
    this.harmonyParts.set(null);
    this.harmonyGrid.set(null);
    this.chordsLoading = false;
    this.startingParts.set([]);
    this.partLoadErrors.set({});
    this.loadedParts.clear();
    this.polling = false;
  }

  canPlay(): boolean {
    return STEM_NAMES.every(name => this.tracks().some(track => track.name === name && track.status === 'ready'));
  }

  private async refreshJob(generation: number): Promise<void> {
    if (this.polling || this.destroyed || generation !== this.generation) return;
    this.polling = true;
    try {
      const response = await this.stems.getJob(this.jobId);
      if (this.destroyed || generation !== this.generation) return;
      const job = response.job;
      this.job.set(job);
      this.error.set('');
      if (job.status === 'completed') {
        // Keep polling through a load, so a stem that finished during it still gets loaded.
        if (!this.restoring(job) && !this.loadingStems) clearInterval(this.pollTimer);
        this.scheduleLinkRenewal(generation);
        if (!this.loadingStems) await this.loadStems(job, generation);
      } else if (job.status === 'failed') {
        clearInterval(this.pollTimer);
        this.audioFailed.emit(job.error || 'This song could not be separated.');
      } else if (job.status === 'deleting') {
        this.audioFailed.emit('This song is being deleted and is unavailable for playback.');
      }
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.error.set(errorMessage(error));
        this.audioFailed.emit(this.error());
      }
    } finally {
      if (generation === this.generation) this.polling = false;
    }
  }

  private scheduleLinkRenewal(generation: number): void {
    clearInterval(this.linkRenewTimer);
    this.linkRenewTimer = setInterval(() => {
      if (generation === this.generation) void this.retryLoadAndRenew();
    }, 45 * 60 * 1000);
  }

  async retryLoadAndRenew(): Promise<void> {
    if (!this.jobId || this.linksRenewing || this.destroyed) return;
    this.linksRenewing = true;
    this.renewingLinks.set(true);
    const generation = this.generation;
    try {
      const response = await this.stems.getJob(this.jobId);
      if (this.destroyed || generation !== this.generation) return;
      if (response.job.status !== 'completed') {
        this.job.set(response.job);
        throw new Error(`Stem job is ${response.job.status}; links are not ready to renew.`);
      }
      this.job.set(response.job);
      this.error.set('');
      this.lyricsLoadError.set('');
      this.chordsLoadError.set('');
      this.partLoadErrors.set({});
      this.scheduleLinkRenewal(generation);
      await this.loadStems(response.job, generation);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.error.set(`Could not refresh stem links or load missing stems: ${errorMessage(error)}`);
      }
    } finally {
      if (generation === this.generation) {
        this.linksRenewing = false;
        this.renewingLinks.set(false);
      }
    }
  }

  private async loadStems(job: Job, generation: number): Promise<void> {
    void this.loadLyrics(job, generation);
    void this.loadChords(job, generation);
    void this.loadParts(generation);
    if (this.loadingStems) return;
    this.loadingStems = true;
    const controller = new AbortController();
    this.mediaController?.abort();
    this.mediaController = controller;
    const files = STEM_NAMES.map(name => ({ name, file: job.stems?.[name] }));
    for (const { name, file } of files) this.updateTrack(name, { downloadUrl: file?.downloadUrl });
    const cleaned = (job.restorations ?? []).filter(item => item.status === 'completed' && item.playUrl);
    for (const item of cleaned) this.updateTrack(item.stem, { cleanedDownloadUrl: item.downloadUrl });
    const failedNames = STEM_NAMES.filter(name =>
      !this.runtimes.has(name) && !job.stems?.[name]?.playUrl,
    );
    for (const name of failedNames) {
      this.updateTrack(name, { status: 'error', error: 'The service did not provide this stem.' });
    }
    try {
      if (!this.context || this.context.state === 'closed') {
        const context = new AudioContext();
        this.context = context;
        const master = context.createGain();
        this.master = master;
        master.gain.value = this.masterVolume() / 100;
        master.connect(context.destination);
      }
    } catch (error) {
      this.error.set(`Audio playback is unavailable: ${errorMessage(error)}`);
      this.audioFailed.emit(this.error());
      for (const name of STEM_NAMES.filter(name => !failedNames.includes(name))) {
        this.updateTrack(name, { status: 'error', error: 'Audio playback is unavailable.' });
      }
      this.loadingStems = false;
      return;
    }
    const context = this.context;
    const master = this.master;
    if (!context || !master) {
      this.error.set('Audio playback is unavailable: the audio engine did not initialize.');
      this.audioFailed.emit(this.error());
      this.loadingStems = false;
      return;
    }

    const missing = [
      ...files.flatMap(({ name, file }) =>
        !this.runtimes.has(name) && file?.playUrl ? [{ name, url: file.playUrl, isCleaned: false }] : []),
      ...cleaned.flatMap(item =>
        !this.runtimes.get(item.stem)?.cleanedBuffer && item.playUrl
          ? [{ name: item.stem as string, url: item.playUrl, isCleaned: true }] : []),
    ];
    const decoding = inPool(missing, STEM_DOWNLOAD_POOL, async ({ name, url, isCleaned }) => {
      if (!isCleaned) this.updateTrack(name, { status: 'loading', error: undefined });
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Audio request failed (HTTP ${response.status}).`);
      return context.decodeAudioData(await response.arrayBuffer());
    });
    // Handled below in order; this only covers results left behind by an early return.
    for (const pending of decoding) pending.catch(() => undefined);

    // Stems download together but become ready in order, so the alignment reference stays stable.
    for (const [index, { name, isCleaned }] of missing.entries()) {
      try {
        const buffer = await decoding[index];
        if (this.destroyed || generation !== this.generation) return;
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
          throw new Error('This stem contains no playable audio.');
        }
        const reference = this.runtimes.values().next().value;
        if (reference) {
          const sampleTolerance = 1 / Math.min(reference.buffer.sampleRate, buffer.sampleRate);
          if (Math.abs(buffer.duration - reference.buffer.duration) > sampleTolerance) {
            throw new Error('This stem is not time-aligned with the other stems (maximum difference is one sample).');
          }
        }
        if (isCleaned) {
          const original = this.runtimes.get(name);
          if (!original) continue;
          original.cleanedBuffer = buffer;
          const useCleaned = this.sceneEntry
            ? this.sceneEntry.settings?.tracks[name]?.useCleaned ?? false : true;
          this.applyVersion(original, useCleaned, context.currentTime);
          this.updateTrack(name, {
            hasCleaned: true, useCleaned, cleanedPeaks: waveformPeaks(buffer), cleanError: undefined,
          });
          continue;
        }
        const track = this.tracks().find(item => item.name === name)!;
        const originalLevel = context.createGain(), cleanedLevel = context.createGain();
        cleanedLevel.gain.value = 0;
        const runtime = { buffer, originalLevel, cleanedLevel, ...createStemEffects(context, master) };
        originalLevel.connect(runtime.input);
        cleanedLevel.connect(runtime.input);
        this.runtimes.set(name, runtime);
        this.applyTrackSettings(track, runtime);
        this.updateTrack(name, {
          status: 'ready',
          duration: buffer.duration,
          peaks: waveformPeaks(buffer),
        });
        this.duration.set(Math.max(this.duration(), buffer.duration));
      } catch (error) {
        if (this.destroyed || generation !== this.generation || controller.signal.aborted) return;
        // A cleaned version that fails to load leaves the original playing.
        this.updateTrack(name, isCleaned
          ? { cleanError: `Could not load the cleaned version: ${errorMessage(error)}` }
          : { status: 'error', error: errorMessage(error) });
      }
    }
    if (this.destroyed || generation !== this.generation) return;
    this.loadingStems = false;
    // A version that arrives during playback needs a restart to join in sync.
    if (missing.length && this.playing()) {
      this.pause();
      void this.play();
    }
    if (!this.canPlay()) {
      this.error.set('One or more stems could not be loaded or are not time-aligned. Failed stems are identified above.');
      this.audioFailed.emit(this.error());
    } else if (!this.hydrated()) {
      const saved = this.sceneEntry?.settings;
      if (saved && this.context) {
        this.masterVolume.set(saved.masterVolume);
        if (this.master) this.master.gain.value = saved.masterVolume / 100;
        const { start, end } = restoredSceneInterval(saved, this.duration());
        this.sectionStart.set(start);
        this.sectionEnd.set(end);
        this.loopSection.set(saved.loop);
        this.position.set(start);
        for (const [name, settings] of Object.entries(saved.tracks)) {
          this.updateTrack(name, settings);
          const runtime = this.runtimes.get(name);
          const track = this.tracks().find(item => item.name === name);
          if (runtime && track) {
            this.applyTrackSettings(track, runtime);
            if (settings.useCleaned && !runtime.cleanedBuffer) {
              this.updateTrack(name, { cleanError: 'Saved Cleaned audio is unavailable. Original audio is playing; retry loading stems to restore the saved version.' });
            }
            this.applyVersion(runtime, settings.useCleaned, this.context.currentTime);
          }
        }
      }
      this.lastSettings = JSON.stringify(this.snapshotSettings());
      this.hydrated.set(true);
      this.audioReady.emit();
    }
  }

  private updateTrack(name: string, patch: Partial<StemTrack>): void {
    this.tracks.update(tracks => tracks.map(track =>
      track.name === name ? { ...track, ...patch } : track,
    ));
  }

  controlDisabled(track: StemTrack, control: FaderControl): boolean {
    return track.status !== 'ready' || (track.bypassed && control.key !== 'volume');
  }

  controlDisabledReason(track: StemTrack, control: FaderControl): string {
    if (track.status !== 'ready') return 'Audio not ready';
    return track.bypassed && control.key !== 'volume' ? 'Bypassed' : '';
  }

  controlValue(track: StemTrack, control: FaderControl): string {
    const value = track[control.key];
    if (control.key === 'pan') return value === 0 ? 'Center' : `${Math.abs(value)}${value < 0 ? 'L' : 'R'}`;
    return `${value}${control.unit === 'dB' ? ' dB' : control.unit}`;
  }

  scaleValue(control: FaderControl, fraction: number): number {
    return control.min + (control.max - control.min) * fraction;
  }

  setControl(name: string, control: EffectControl, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const value = Number(target.value);
    const definition = this.controls.find(item => item.key === control);
    const current = this.tracks().find(item => item.name === name);
    if (!definition || !current || this.controlDisabled(current, definition)) return;
    if (!Number.isFinite(value) || value < definition.min || value > definition.max) {
      this.error.set(`Choose a ${definition.label} value between ${definition.min} and ${definition.max}.`);
      return;
    }
    this.updateTrack(name, { [control]: value });
    const track = this.tracks().find(item => item.name === name);
    const runtime = this.runtimes.get(name);
    if (track && runtime && this.context) this.applyTrackSettings(track, runtime);
  }

  toggleMute(name: string): void {
    const track = this.tracks().find(item => item.name === name);
    if (!track || track.status !== 'ready') return;
    this.updateTrack(name, { muted: !track.muted });
    this.updateMixGains();
  }

  suppressedBySolo(track: StemTrack): boolean {
    return !track.solo && this.tracks().some(item => item.solo);
  }

  allMuted(): boolean { return this.tracks().every(track => track.muted); }

  toggleMuteAll(): void {
    if (!this.canPlay()) return;
    const muted = !this.allMuted();
    this.tracks.update(tracks => tracks.map(track => ({ ...track, muted })));
    this.updateMixGains();
  }

  toggleSolo(name: string): void {
    const track = this.tracks().find(item => item.name === name);
    if (!track || track.status !== 'ready') return;
    this.updateTrack(name, { solo: !track.solo });
    this.updateMixGains();
  }

  toggleBypass(name: string): void {
    const track = this.tracks().find(item => item.name === name);
    const runtime = this.runtimes.get(name);
    if (!track || !runtime || !this.context) return;
    this.updateTrack(name, { bypassed: !track.bypassed });
    this.applyTrackSettings({ ...track, bypassed: !track.bypassed }, runtime);
  }

  resetTrack(name: string): void {
    const track = this.tracks().find(item => item.name === name);
    const runtime = this.runtimes.get(name);
    if (!track || !runtime || !this.context) return;
    const restored = { ...track, ...defaultEffects(), muted: false, solo: false, bypassed: false };
    this.updateTrack(name, restored);
    this.applyTrackSettings(restored, runtime);
    this.updateMixGains();
  }

  private updateMixGains(): void {
    if (!this.context) return;
    for (const track of this.tracks()) {
      const runtime = this.runtimes.get(track.name);
      if (runtime) runtime.gain.gain.setTargetAtTime(
        track.muted || this.suppressedBySolo(track) ? 0 : track.volume / 100,
        this.context.currentTime, 0.015,
      );
    }
  }

  private setTransport(active: boolean): void {
    if (!this.context) return;
    for (const runtime of this.runtimes.values()) {
      runtime.transport.gain.setTargetAtTime(active ? 1 : 0, this.context.currentTime, 0.003);
    }
  }

  private applyTrackSettings(track: StemTrack, runtime: StemRuntime): void {
    if (!this.context) return;
    applyStemEffects(this.context, runtime, track, track.bypassed);
    this.updateMixGains();
  }

  setMasterVolume(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const value = Number(target.value);
    if (!Number.isFinite(value) || !this.context || !this.master) return;
    this.masterVolume.set(value);
    this.master.gain.setTargetAtTime(value / 100, this.context.currentTime, 0.015);
  }

  async play(): Promise<void> {
    if (!this.canPlay() || this.playing() || this.starting || this.drag) return;
    const context = this.context;
    if (!context) return;
    const token = ++this.playbackToken;
    this.starting = true;
    try {
      await context.resume();
      if (this.destroyed || token !== this.playbackToken || context !== this.context) return;
      const { start, end } = this.playbackBounds();
      const offset = this.position();
      const startOffset = offset < start || offset >= end ? start : offset;
      const startAt = context.currentTime + 0.05;
      this.stopSources();
      for (const [name, runtime] of this.runtimes) {
        if (startOffset >= runtime.buffer.duration) continue;
        const source = context.createBufferSource();
        source.buffer = runtime.buffer;
        source.loop = this.loopSection();
        source.loopStart = start;
        source.loopEnd = end;
        source.onended = () => {
          if (token !== this.playbackToken || source.loop || !this.playing()) return;
          this.position.set(end);
          this.playing.set(false);
          clearInterval(this.clockTimer);
          this.stopSources();
          this.songEnded.emit();
        };
        source.connect(runtime.originalLevel);
        this.sources.set(name, source);
        source.start(startAt, startOffset);
        if (!source.loop) source.stop(startAt + end - startOffset);
        if (runtime.cleanedBuffer) {
          const cleaned = context.createBufferSource();
          cleaned.buffer = runtime.cleanedBuffer;
          cleaned.loop = source.loop;
          cleaned.loopStart = start;
          cleaned.loopEnd = end;
          cleaned.connect(runtime.cleanedLevel);
          this.sources.set(`${name}:cleaned`, cleaned);
          cleaned.start(startAt, startOffset);
          if (!cleaned.loop) cleaned.stop(startAt + end - startOffset);
        }
      }
      this.startedAt = startAt;
      this.startOffset = startOffset;
      this.position.set(startOffset);
      this.playing.set(true);
      this.setTransport(true);
      this.clockTimer = setInterval(() => this.updatePlaybackClock(), 40);
    } catch (error) {
      if (!this.destroyed && token === this.playbackToken && context === this.context) {
        this.stopSources();
        this.playing.set(false);
        clearInterval(this.clockTimer);
        this.error.set(`Could not start playback: ${errorMessage(error)}`);
        this.audioFailed.emit(this.error());
      }
    } finally {
      if (token === this.playbackToken) this.starting = false;
    }
  }

  pause(): void {
    this.stopScrub();
    ++this.playbackToken;
    this.starting = false;
    if (!this.playing() || !this.context) return;
    this.updatePlaybackClock();
    this.stopSources();
    this.playing.set(false);
    clearInterval(this.clockTimer);
  }

  stop(): void {
    this.stopScrub();
    ++this.playbackToken;
    this.starting = false;
    this.stopSources();
    this.playing.set(false);
    this.position.set(this.playbackBounds().start);
    clearInterval(this.clockTimer);
  }

  seek(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    this.moveTo(value);
  }

  private moveTo(value: number): void {
    const wasPlaying = this.playing();
    ++this.playbackToken;
    this.starting = false;
    this.stopSources();
    this.playing.set(false);
    clearInterval(this.clockTimer);
    const { start, end } = this.playbackBounds();
    this.position.set(Math.max(start, Math.min(value, end)));
    if (wasPlaying) void this.play();
  }

  private updatePlaybackClock(): void {
    if (!this.context || !this.playing()) return;
    const elapsed = Math.max(0, this.context.currentTime - this.startedAt);
    const { start, end } = this.playbackBounds();
    const rawPosition = this.startOffset + elapsed;
    const looping = this.loopSection();
    const position = looping && rawPosition >= end
      ? start + (rawPosition - end) % (end - start) : Math.min(end, rawPosition);
    this.position.set(position);
    if (!looping && position >= end) {
      this.stopSources();
      this.playing.set(false);
      this.position.set(end);
      clearInterval(this.clockTimer);
      this.songEnded.emit();
    }
  }

  private stopSources(): void {
    this.setTransport(false);
    for (const source of this.sources.values()) {
      source.onended = null;
      try {
        source.stop();
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') {
          console.error('Unable to stop stem source', error);
          this.error.set('Unable to stop an audio source. Leave the mixer to release playback.');
        }
      }
      source.disconnect();
    }
    this.sources.clear();
  }

  formatTime(value: number): string {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
}

function inPool<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<R>[] {
  const waiting: (() => void)[] = [];
  let free = size;
  return items.map(async item => {
    if (free > 0) free--;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await task(item);
    } finally {
      const next = waiting.shift();
      if (next) next(); else free++;
    }
  });
}

function waveformPeaks(buffer: AudioBuffer): number[] {
  const channel = buffer.getChannelData(0);
  const count = 100;
  const peaks: number[] = [];
  const samplesPerPeak = Math.max(1, Math.floor(channel.length / count));
  for (let index = 0; index < count; index++) {
    let peak = 0;
    const start = index * samplesPerPeak;
    const end = Math.min(channel.length, start + samplesPerPeak);
    for (let sample = start; sample < end; sample++) {
      peak = Math.max(peak, Math.abs(channel[sample]));
    }
    peaks.push(peak);
  }
  const maximum = Math.max(...peaks);
  return maximum > 0 ? peaks.map(peak => peak / maximum) : peaks;
}
