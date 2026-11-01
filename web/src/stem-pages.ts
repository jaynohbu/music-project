import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Job, STEM_NAMES, StemName, StemsService, errorMessage } from './services';
import {
  EffectControl, EffectSettings, FaderControl, FADER_CONTROLS,
  StemEffects, applyStemEffects, createStemEffects, defaultEffects,
} from './stem-effects';

const MAX_UPLOAD_BYTES = 30_000_000;
const MAX_AUDIO_SECONDS = 420;
const STEM_POLL_MS = 4000;
const STEM_DOWNLOAD_POOL = 4;

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <section class="card narrow">
      <span class="eyebrow">SIX-STEM SEPARATION</span>
      <h1>Upload audio to split</h1>
      <p>Separate an audio file into drums, bass, vocals, guitar, piano and other.</p>
      <form (ngSubmit)="submit()">
        <label for="audio-file">Audio file</label>
        <input id="audio-file" name="audio-file" type="file" accept="audio/*"
          (change)="selectFile($event)" [disabled]="busy()">
        <label for="audio-title">Title</label>
        <input id="audio-title" name="audio-title" type="text" maxlength="160"
          [(ngModel)]="title" [disabled]="busy()">
        <p class="hint">Maximum 30 MB (30,000,000 bytes) and 7 minutes. Your browser checks duration before upload;
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

  cancelUpload(): void {
    this.controller?.abort();
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
        throw new Error('Audio must be 7 minutes or shorter.');
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

@Component({
  standalone: true,
  imports: [RouterLink, FormsModule],
  template: `
    <section class="card">
      <div class="section-heading">
        <div>
          <span class="eyebrow">SIX-STEM MIXER</span>
          <h1>{{ job()?.title || 'Stem mixer' }}</h1>
        </div>
        <a routerLink="/list">Back to jobs</a>
      </div>
      @if (error()) { <p role="alert" class="error">{{ error() }}</p> }
      @if (job() && job()!.status !== 'completed' && job()!.status !== 'failed') {
        <p role="status" class="hint">Separation {{ job()!.status }}. This page checks for updates automatically.</p>
      }
      @if (job()?.status === 'failed') {
        <p role="alert" class="error">{{ job()?.error || 'Stem separation failed.' }}</p>
      }
      @if (job()?.status === 'completed') {
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
            <article class="stem-track">
              <section class="mixing-console" [attr.aria-label]="track.label + ' mixer'">
              <div class="console-stem-view">
              <div class="stem-heading">
                <h2>{{ track.label }}</h2>
                @if (track.status === 'loading') { <span class="hint">Loading audio...</span> }
                <div class="stem-actions">
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
              </div>
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
                <span>Start {{ sectionStart().toFixed(2) }}s</span>
                <span>Playing {{ position().toFixed(2) }}s</span>
                <span>End {{ sectionEndTime().toFixed(2) }}s</span>
              </div>
              </div>
              <div class="stem-transport" role="group" [attr.aria-label]="track.label + ' transport, mute and solo'">
                <div class="transport-buttons">
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
    </section>
  `,
})
export class MixerPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly stems = inject(StemsService);
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

  toggleMixer(name: string): void {
    this.expandedStem.update(current => current === name ? null : name);
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

  private restoring(job: Job | null): boolean {
    return !!job?.restorations?.some(item => item.status === 'queued' || item.status === 'processing');
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
    runtime.originalLevel.gain.setTargetAtTime(cleaned ? 0 : 1, time, 0.005);
    runtime.cleanedLevel.gain.setTargetAtTime(cleaned ? 1 : 0, time, 0.005);
  }

  sectionEndTime(): number { return this.sectionEnd() ?? this.duration(); }
  waveformPercent(time: number): number { return this.duration() > 0 ? time / this.duration() * 100 : 0; }
  waveformX(time: number): number { return this.duration() > 0 ? time / this.duration() * 600 : 0; }
  minimumInterval(): number { return Math.min(0.05, this.duration()); }

  private playbackBounds(): { start: number; end: number } {
    return { start: this.sectionStart(), end: this.sectionEndTime() };
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
    this.routeSubscription = this.route.paramMap.subscribe(params => {
      const jobId = params.get('jobId');
      if (!jobId) {
        this.error.set('The mixer job ID is missing.');
        return;
      }
      if (jobId === this.jobId) return;
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
      this.playing.set(false);
      this.renewingLinks.set(false);
      this.loadingStems = false;
      void this.refreshJob(generation);
      this.pollTimer = setInterval(() => { void this.refreshJob(generation); }, STEM_POLL_MS);
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.routeSubscription?.unsubscribe();
    this.resetMixer();
  }

  private resetMixer(): void {
    this.expandedStem.set(STEM_NAMES[0]);
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
      }
    } catch (error) {
      if (!this.destroyed && generation === this.generation) this.error.set(errorMessage(error));
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
          this.applyVersion(original, true, context.currentTime);
          this.updateTrack(name, {
            hasCleaned: true, useCleaned: true, cleanedPeaks: waveformPeaks(buffer), cleanError: undefined,
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
