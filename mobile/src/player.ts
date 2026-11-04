// The mixer's audio engine: six stems read from disk and decoded as they play, all
// driven by one audio context so they stay sample-aligned (design doc, Audio engine).
import {
  AudioContext, AudioManager, MediaElementAudioSourceNode, PlaybackNotificationManager,
  type AudioParam, type GainNode,
} from 'react-native-audio-api';
// @ts-expect-error Not part of the public API, so the library is pinned (design doc).
// It is the only way to start every stem at one shared time.
import { AudioFileSourceNode } from 'react-native-audio-api/lib/module/Audio/AudioFileSourceNode';
import type { AudioFileSourceNode as FileSource } from 'react-native-audio-api/lib/typescript/Audio/AudioFileSourceNode';
import { STEM_NAMES, type StemName } from './api';
import { applyEffects, createEffects, defaults, stereoGain, type EffectNodes, type Effects } from './effects';

export interface Channel extends Omit<Effects, 'volume'> {
  volume: number; // 0 to 1
  muted: boolean;
  solo: boolean;
  // EQ gains in dB, -12 to +12, as on the website (web/src/stem-effects.ts).
  bass: number;
  mid: number;
  treble: number;
  bypassed: boolean;
  useCleaned: boolean;
}

export type Band = 'bass' | 'mid' | 'treble';
export const EQ_RANGE = 12;

export const defaultChannel = (): Channel => ({ ...defaults(), volume: .8, muted: false, solo: false, bypassed: false, useCleaned: false });

// Changes ramp over this long, so they never click.
const RAMP_SECONDS = 0.03;
// Start a little ahead, so every stem is scheduled before the time comes.
const START_DELAY = 0.2;
// Seeking is asynchronous in the decoder; the trial waited this long before starting again.
const SEEK_SETTLE_MS = 500;
// A stem that reaches the end of its file stops its decoder for good in the pinned
// library, so playback ends this far before the shortest stem runs out.
const END_MARGIN = .5;
const SKIP_SECONDS = 15;

interface Stem {
  source: FileSource;
  cleaned?: FileSource;
  originalGain: GainNode;
  cleanedGain?: GainNode;
  gain: GainNode;
  effects: EffectNodes;
}

// The native media-control registry is an unsynchronised dictionary that every
// call mutates on a concurrent queue, so overlapping calls crash the app.
let notificationQueue: Promise<unknown> = Promise.resolve();
function notification<T>(call: () => Promise<T>): Promise<T> {
  const next = notificationQueue.then(call);
  notificationQueue = next.catch(() => undefined);
  return next;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function ramp(param: AudioParam, value: number, now: number) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + RAMP_SECONDS);
}

export class Mixer {
  private static active: Mixer | null = null;
  private readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly stems: Record<StemName, Stem>;
  private readonly subscriptions: { remove(): void }[] = [];
  private channels: Record<StemName, Channel>;
  private masterVolume = 0.8;
  private playing = false;
  private closed = false;
  // While playing, the position is startPosition plus the context time since startClock.
  private startClock = 0;
  private startPosition = 0;
  // Serialises play, pause and seek, which each touch every stem.
  private queue: Promise<void> = Promise.resolve();
  readonly duration: number;
  private readonly listeners = new Set<() => void>();
  private readonly endedListeners = new Set<() => void>();
  private readonly sources: FileSource[] = [];
  private closing: Promise<void> | null = null;
  private endPending = false;
  // Stall check: positions at the last check. Empty after a restart, so the next
  // check only takes a baseline once the stems have really started again.
  private lastProgress: number[] = [];
  private lastProgressAt = 0;
  // True while startAt has the stems paused for a seek.
  private restarting = false;
  private playingBeforeInterruption = false;
  private playableEnd = 0;
  private notificationShown = false;
  error = '';
  loop = false;
  sectionStart = 0;
  sectionEnd: number;

  static async create(paths: Record<StemName, string>, title: string, artist = '', cleaned: Partial<Record<StemName, string>> = {},
    durationLimit?: number) {
    if (Mixer.active) await Mixer.active.close();
    AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default' });
    const context = new AudioContext({ sampleRate: 44100 });
    try {
      await context.resume();
      if (context.state !== 'running') throw new Error(`The audio engine is ${context.state}. Reload the song and try again.`);
      const mixer = new Mixer(context, paths, title, artist, cleaned, durationLimit);
      Mixer.active = mixer;
      return mixer;
    } catch (failure) {
      await context.close().catch(error => console.warn('Failed audio initialization cleanup', error));
      throw failure;
    }
  }

  private constructor(context: AudioContext, paths: Record<StemName, string>, private title: string,
    private readonly artist: string, cleaned: Partial<Record<StemName, string>>, durationLimit?: number) {
    this.context = context;
    this.master = stereoGain(this.context);
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.context.destination);
    this.channels = Object.fromEntries(STEM_NAMES.map(name => [name, defaultChannel()])) as Record<StemName, Channel>;
    try {
      this.stems = Object.fromEntries(STEM_NAMES.map(name => [name, this.createStem(paths[name], cleaned[name])])) as Record<StemName, Stem>;
      const durations = this.sources.map(source => source.getDuration());
      const decodedDuration = Math.min(...durations);
      this.duration = durationLimit && durationLimit > 0 ? Math.min(decodedDuration, durationLimit) : decodedDuration;
      this.sectionEnd = this.duration;
      this.playableEnd = decodedDuration - END_MARGIN;
      if (!Number.isFinite(this.duration) || !(this.duration > 0)) throw new Error('These stems could not be read. Remove the song from this phone and try again.');
      if (Math.max(...durations) - decodedDuration > .05) throw new Error(`The decoded stems are not aligned (${durations.map(d => d.toFixed(2)).join(', ')}s). Reload this song.`);
      this.applyGains();
      this.listen();
    } catch (failure) {
      for (const subscription of this.subscriptions) subscription.remove();
      for (const source of this.sources) source.dispose();
      throw failure;
    }
  }

  private createSource(path: string, target: GainNode, watchEnd: boolean): FileSource {
    const native = this.context.context.createFileSource({
      source: path, loop: false, volume: 1, playbackRate: 1, preservesPitch: false,
    });
    if (!native) throw new Error('The audio engine is unavailable.');
    const source: FileSource = new AudioFileSourceNode(this.context, native);
    this.sources.push(source);
    // attach()/dispose() in pinned 0.13.6 leave JS listeners registered. Own and
    // remove the native event subscriptions so changing Scene tabs releases audio.
    if (watchEnd) {
      const events = globalThis.AudioEventEmitter;
      const ended = events.addAudioEventListener('ended', () => {
        if (this.playing && this.position >= this.stopAt - .1) this.finish();
      });
      const position = events.addAudioEventListener('positionChanged', () => this.tick());
      native.onEnded = ended; native.onPositionChanged = position;
      this.subscriptions.push({ remove: () => {
        native.onEnded = '0'; native.onPositionChanged = '0';
        events.removeAudioEventListener('ended', ended);
        events.removeAudioEventListener('positionChanged', position);
      } });
    }
    // Without this routing, start() also connects the source straight to the speakers.
    let volume = 1, muted = false;
    const mediaElement = {
      getFileSourceNode: () => native,
      play: () => source.play(), pause: () => source.pause(),
      seekToTime: (seconds: number) => source.seekToTime(seconds),
      setVolume: (value: number) => { volume = value; source.setVolume(muted ? 0 : volume); },
      setMuted: (value: boolean) => { muted = value; source.setVolume(muted ? 0 : volume); },
      setPlaybackRate: (value: number) => source.setPlaybackRate(value),
    };
    const routed = new MediaElementAudioSourceNode(this.context, { mediaElement });
    routed.connect(target);
    return source;
  }

  private createStem(path: string, cleanedPath?: string): Stem {
    const effects = createEffects(this.context);
    const gain = stereoGain(this.context);
    const originalGain = stereoGain(this.context), cleanedGain = cleanedPath ? stereoGain(this.context, 0) : undefined;
    originalGain.connect(effects.input);
    cleanedGain?.connect(effects.input);
    const source = this.createSource(path, originalGain, this.sources.length === 0);
    const cleaned = cleanedPath && cleanedGain ? this.createSource(cleanedPath, cleanedGain, false) : undefined;
    effects.output.connect(gain);
    gain.connect(this.master);
    return { source, cleaned, originalGain, cleanedGain, gain, effects };
  }

  private system(operation: Promise<void>) {
    void operation.catch(error => console.warn('System audio control failed', error));
  }
  private listen() {
    AudioManager.observeAudioInterruptions(true);
    const subscriptions = [
      AudioManager.addSystemEventListener('interruption', event => {
        if (event.type === 'began') {
          this.playingBeforeInterruption = this.playing;
          this.system(this.pause());
        } else if (event.shouldResume && this.playingBeforeInterruption) {
          this.system(this.play());
        }
      }),
      // Headphones were unplugged: stop rather than play out of the speaker.
      AudioManager.addSystemEventListener('routeChange', event => {
        if (event.reason === 'OldDeviceUnavailable') this.system(this.pause());
      }),
      PlaybackNotificationManager.addEventListener('playbackNotificationPlay', () => this.system(this.play())),
      PlaybackNotificationManager.addEventListener('playbackNotificationPause', () => this.system(this.pause())),
      PlaybackNotificationManager.addEventListener('playbackNotificationSkipForward',
        () => this.system(this.seek(this.position + SKIP_SECONDS))),
      PlaybackNotificationManager.addEventListener('playbackNotificationSkipBackward',
        () => this.system(this.seek(this.position - SKIP_SECONDS))),
      PlaybackNotificationManager.addEventListener('playbackNotificationSeekTo', event => this.system(this.seek(event.value))),
    ];
    // The system listeners return undefined where the platform has no such event.
    this.subscriptions.push(...subscriptions.filter(subscription => subscription !== undefined));
    for (const control of ['play', 'pause', 'skipForward', 'skipBackward', 'seekTo'] as const) {
      notification(() => PlaybackNotificationManager.enableControl(control, true)).catch(error => console.warn('Could not enable media control', control, error));
    }
  }

  private run(step: () => Promise<void>) {
    const operation = this.queue.then(async () => {
      if (this.closed) return;
      this.error = '';
      try { await step(); }
      catch (failure) {
        this.playing = false;
        this.error = failure instanceof Error ? failure.message : 'Playback failed. Please reload this song.';
        for (const source of this.sources) source.pause();
        this.changed();
        throw failure;
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  // Calls the listener after any change the screen shows, except the moving position.
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onEnded(listener: () => void) { this.endedListeners.add(listener); return () => { this.endedListeners.delete(listener); }; }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  get isPlaying() { return this.playing; }

  get position() {
    if (!this.playing || this.restarting) return this.startPosition;
    return Math.min(this.startPosition + Math.max(this.context.currentTime - this.startClock, 0), this.sectionEnd);
  }

  // Where playback ends: the section end, but never past the playable end of the stems.
  private get stopAt() { return Math.min(this.sectionEnd, this.playableEnd); }

  channel(name: StemName) { return this.channels[name]; }

  get volume() { return this.masterVolume; }

  private async startAt(position: number) {
    const sources = this.sources;
    this.startPosition = position;
    this.restarting = true;
    try {
      for (const source of sources) source.pause();
      for (const source of sources) source.seekToTime(position);
      await wait(SEEK_SETTLE_MS);
      if (this.closed) return;
      await this.context.resume();
      if (this.context.state !== 'running') throw new Error(`The audio engine is ${this.context.state}. Try Play again.`);
      const when = this.context.currentTime + START_DELAY;
      for (const source of sources) source.getFileSourceNode().start(when);
      this.startClock = when;
    } finally {
      this.restarting = false;
      // The native position updates only once the seeked audio renders, so take the baseline later.
      this.lastProgress = [];
      this.lastProgressAt = Date.now();
    }
  }

  play() {
    return this.run(async () => {
      if (this.playing) return;
      if (this.startPosition < this.sectionStart || this.startPosition >= this.stopAt - .05) this.startPosition = this.sectionStart;
      await this.startAt(this.startPosition);
      this.playing = true;
      this.notify();
    });
  }

  pause() {
    return this.run(async () => {
      if (!this.playing) return;
      const position = this.position;
      for (const source of this.sources) source.pause();
      this.playing = false;
      this.startPosition = position;
      this.notify();
    });
  }

  seek(target: number) {
    return this.run(async () => {
      const position = Math.min(Math.max(target, this.sectionStart), this.stopAt);
      if (this.playing) {
        await this.startAt(position);
      } else {
        this.startPosition = position;
      }
      this.notify();
    });
  }

  // Call regularly while the screen shows the mixer; stops at the end of the song.
  tick() {
    if (!this.playing || this.restarting) return;
    if (this.position >= this.stopAt && !this.endPending) {
      this.finish();
    } else if (Date.now() - this.lastProgressAt > 2000) {
      const progress = this.sources.map(source => source.getCurrentTime());
      if (this.lastProgress.length && progress.some((position, index) => Math.abs(position - this.lastProgress[index]) < .01)) {
        this.system(this.run(async () => { throw new Error('Audio did not advance. Reload the song and try again.'); }));
      }
      this.lastProgress = progress;
      this.lastProgressAt = Date.now();
    }
  }

  private finish() {
    if (this.endPending || !this.playing) return;
    this.endPending = true;
    void this.run(async () => {
      if (!this.playing) return;
      for (const source of this.sources) source.pause();
      this.playing = false;
      this.startPosition = this.sectionStart;
      const looping = this.loop;
      if (looping) { await this.startAt(this.sectionStart); this.playing = true; }
      this.notify();
      if (!looping) for (const listener of this.endedListeners) listener();
    }).catch(error => console.warn('Song completion failed', error)).finally(() => { this.endPending = false; });
  }

  hasCleaned(name: StemName) { return !!this.stems[name].cleaned; }

  // Adds a stem's cleaned version while the mixer is open; playing stems are realigned so it starts in step.
  addCleaned(name: StemName, path: string) {
    return this.run(async () => {
      if (this.closed || this.hasCleaned(name)) return;
      const cleanedGain = stereoGain(this.context, 0);
      cleanedGain.connect(this.stems[name].effects.input);
      const cleaned = this.createSource(path, cleanedGain, false);
      this.stems[name] = { ...this.stems[name], cleaned, cleanedGain };
      if (this.playing) await this.startAt(this.position);
      else cleaned.seekToTime(this.startPosition);
      this.changed();
    });
  }

  setChannel(name: StemName, change: Partial<Channel>) {
    const next = { ...this.channels[name], ...change };
    if (next.useCleaned && !this.hasCleaned(name)) {
      this.error = `The saved cleaned ${name} stem is no longer available. Playing the original instead.`;
      next.useCleaned = false;
    }
    this.channels = { ...this.channels, [name]: next };
    ramp(this.stems[name].originalGain.gain, next.useCleaned ? 0 : 1, this.context.currentTime);
    const cleanedGain = this.stems[name].cleanedGain;
    if (cleanedGain) ramp(cleanedGain.gain, next.useCleaned ? 1 : 0, this.context.currentTime);
    applyEffects(this.context, this.stems[name].effects, { ...next, volume: next.volume * 100 }, next.bypassed);
    this.applyGains();
    this.changed();
  }

  reset() {
    for (const name of STEM_NAMES) this.setChannel(name, defaultChannel());
    this.setVolume(.8); this.sectionStart = 0; this.sectionEnd = this.duration; this.loop = false;
    this.changed();
  }
  stop() {
    return this.run(async () => {
      for (const source of this.sources) source.pause();
      this.playing = false; this.startPosition = this.sectionStart;
      this.notify();
    });
  }
  setLoop(value: boolean) { this.loop = value; this.changed(); }
  setSection(start: number, end: number) {
    this.sectionStart = Math.max(0, Math.min(start, this.duration - .05));
    this.sectionEnd = Math.min(this.duration, Math.max(end, this.sectionStart + .05));
    this.changed();
  }

  setVolume(volume: number) {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    ramp(this.master.gain, this.masterVolume, this.context.currentTime);
    this.changed();
  }

  // Muted, or silent because another stem is soloed; otherwise the stem's volume.
  private applyGains() {
    const soloing = STEM_NAMES.some(name => this.channels[name].solo);
    for (const name of STEM_NAMES) {
      const { volume, muted, solo } = this.channels[name];
      ramp(this.stems[name].gain.gain, muted || (soloing && !solo) ? 0 : volume, this.context.currentTime);
    }
  }

  private notify() {
    this.notificationShown = true;
    this.changed();
    notification(async () => {
      if (this.closed) return;
      await PlaybackNotificationManager.show({
        title: this.title,
        artist: this.artist,
        duration: this.duration,
        elapsedTime: this.position,
        state: this.playing ? 'playing' : 'paused',
      });
    }).catch(failure => console.warn('Lock screen controls not shown', failure));
  }
  setTitle(title: string) {
    if (this.title === title) return;
    this.title = title;
    if (this.notificationShown) this.notify();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const source of this.sources) source.pause();
      await this.queue;
      this.playing = false;
      for (const subscription of this.subscriptions) subscription.remove();
      for (const source of this.sources) source.dispose();
      for (const name of STEM_NAMES) clearTimeout(this.stems[name].effects.links.reverbOff);
      this.listeners.clear(); this.endedListeners.clear();
      await notification(() => PlaybackNotificationManager.hide()).catch(error => console.warn('Could not hide media controls', error));
      await this.context.close();
      if (Mixer.active === this) Mixer.active = null;
    })();
    return this.closing;
  }
}
