// Recording a live take: the player's input is saved as-is while the stems follow their tempo.
import { AudioManager, AudioRecorder, FileDirectory, FileFormat, type GainNode } from 'react-native-audio-api';
import { Follower, OnsetDetector, type FollowStatus, type TempoPoint } from './live-follow';
import { discardRecording, saveTake, takePath, takeSubDirectory, type LiveTake } from './live-take';
import type { Mixer } from './player';

export type FollowStrength = 'loose' | 'normal' | 'tight';
export const STRENGTHS: { id: FollowStrength; label: string; value: number }[] = [
  { id: 'loose', label: 'Loose', value: 0.2 },
  { id: 'normal', label: 'Normal', value: 0.5 },
  { id: 'tight', label: 'Tight', value: 0.85 },
];

// Output plus input delay of a wired interface; the take's Sync control adjusts it per song.
export const DEFAULT_LATENCY = 0.03;
const SAMPLE_RATE = 44100;
const BUFFER = 512;
const IDLE_MS = 50;

export interface LiveStatus extends FollowStatus { seconds: number; level: number; notes: number }

const recordingError = (message: string) => new Error(`Recording failed: ${message}`);

export async function microphoneAllowed() {
  let status = await AudioManager.checkRecordingPermissions();
  if (status === 'Undetermined') status = await AudioManager.requestRecordingPermissions();
  return status === 'Granted';
}

export function playbackSession() {
  AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default' });
}

export class LiveSession {
  private readonly listeners = new Set<() => void>();
  private readonly points: TempoPoint[] = [];
  private readonly follower: Follower;
  private detector: OnsetDetector | null = null;
  private recorder = new AudioRecorder();
  private monitor: GainNode | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private recordStart = 0;
  private finishing: Promise<LiveTake | null> | null = null;
  private level = -90;
  private notes = 0;
  // Called when playback stops by itself (end of song or section), with the saved take.
  onFinished: ((take: LiveTake | null, error?: string) => void) | null = null;

  private constructor(private readonly mixer: Mixer, private readonly jobId: string, beats: number[], strength: number,
    private readonly previous: LiveTake | null) {
    this.follower = new Follower(beats, strength);
  }

  static async start(options: { mixer: Mixer; jobId: string; beats: number[]; strength: FollowStrength; monitor: boolean; previous: LiveTake | null }) {
    if (!await microphoneAllowed()) throw new Error('Sorituh needs the microphone to hear your instrument. Allow it in Settings > Sorituh > Microphone.');
    const strength = STRENGTHS.find(item => item.id === options.strength)?.value ?? 0.5;
    const session = new LiveSession(options.mixer, options.jobId, options.beats, strength, options.previous);
    try { await session.begin(options.monitor); }
    catch (failure) { await session.cleanUp(); throw failure; }
    return session;
  }

  private async begin(monitor: boolean) {
    const { mixer } = this;
    await mixer.pause();
    await mixer.suspendTake(true);
    mixer.setLoop(false);
    AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'default', iosOptions: ['defaultToSpeaker', 'allowBluetoothA2DP'] });
    await AudioManager.setAudioSessionActivity(true);
    const output = this.recorder.enableFileOutput({
      format: FileFormat.M4A, channelCount: 1, directory: FileDirectory.Document,
      subDirectory: takeSubDirectory(this.jobId), fileNamePrefix: 'take',
    });
    if (output.status === 'error') throw recordingError(output.message);
    const ready = this.recorder.onAudioReady({ sampleRate: SAMPLE_RATE, bufferLength: BUFFER, channelCount: 1 }, event => {
      const samples = event.buffer.getChannelData(0).subarray(0, event.numFrames);
      // The device may deliver a different rate than asked for.
      this.detector ??= new OnsetDetector(event.buffer.sampleRate);
      let peak = 0;
      for (let index = 0; index < samples.length; index++) peak = Math.max(peak, Math.abs(samples[index]));
      this.level = Math.max(20 * Math.log10(peak + 1e-9), this.level - 3);
      for (const at of this.detector.push(samples, event.when)) this.hear(at);
    });
    if (ready.status === 'error') throw recordingError(ready.message);
    if (monitor) {
      const route = mixer.createInputMonitor(1);
      this.recorder.connect(route.input);
      this.monitor = route.gain;
    }
    const started = await this.recorder.start();
    if (started.status === 'error') throw recordingError(started.message);
    this.recordStart = mixer.contextTime;
    await mixer.play();
    if (!mixer.isPlaying) throw new Error(mixer.error || 'The song did not start.');
    this.points.push({ at: mixer.startTime - this.recordStart, pos: mixer.positionAt(mixer.startTime), rate: mixer.rate });
    this.idleTimer = setInterval(() => {
      const changed = this.follower.idle(this.mixer.contextTime - this.recordStart);
      if (changed !== null) this.apply(changed);
      this.changed();
    }, IDLE_MS);
    // The take ends with the song or section, or if anything else stops playback.
    this.unsubscribe = mixer.subscribe(() => {
      if (!mixer.isPlaying && !this.finishing) {
        void this.stop(true).then(take => this.onFinished?.(take), failure => this.onFinished?.(null, failure instanceof Error ? failure.message : String(failure)));
      }
    });
  }

  // A note at take time `at`: what the player heard then is where the band was, less the delay.
  private hear(at: number) {
    const { mixer } = this;
    const time = this.recordStart + at - DEFAULT_LATENCY;
    if (!mixer.isPlaying || time < mixer.startTime) return;
    this.notes++;
    const rate = this.follower.onset(at, mixer.positionAt(time));
    if (rate !== null) this.apply(rate);
  }

  private apply(rate: number) {
    const now = this.mixer.contextTime;
    const pos = this.mixer.positionAt(now);
    this.mixer.setRate(rate);
    this.points.push({ at: now - this.recordStart, pos, rate: this.mixer.rate });
  }

  get status(): LiveStatus {
    return { ...this.follower.status, rate: this.mixer.rate, seconds: Math.max(0, this.mixer.contextTime - this.recordStart), level: this.level, notes: this.notes };
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }

  // Ends the take. When kept, it becomes the song's user stem and replaces any earlier one.
  stop(keep: boolean): Promise<LiveTake | null> {
    if (!this.finishing) this.finishing = this.finish(keep);
    return this.finishing;
  }

  private async finish(keep: boolean): Promise<LiveTake | null> {
    const result = await this.cleanUp();
    const path = result?.status === 'success' ? result.paths[0] : undefined;
    const file = path?.split('/').at(-1);
    if (!keep || !file || !result || result.status !== 'success' || result.duration < 1) {
      if (file) discardRecording(this.jobId, file, this.previous);
      await this.mixer.suspendTake(false);
      if (keep && result?.status === 'error') throw recordingError(result.message);
      return null;
    }
    const take: LiveTake = {
      version: 1, file, recordedAt: Date.now(), duration: result.duration, latency: DEFAULT_LATENCY,
      points: this.points, volume: this.previous?.volume ?? 0.9, muted: false,
    };
    saveTake(this.jobId, take);
    await this.mixer.suspendTake(false);
    await this.mixer.attachTake({ path: takePath(this.jobId, take), duration: take.duration, latency: take.latency,
      points: take.points, volume: take.volume, muted: take.muted });
    return take;
  }

  private async cleanUp() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.recorder.clearOnAudioReady();
    const result = this.recorder.isRecording() ? await this.recorder.stop() : null;
    this.recorder.disconnect();
    this.monitor?.disconnect(); this.monitor = null;
    await this.mixer.pause().catch(() => undefined);
    this.mixer.setRate(1);
    playbackSession();
    this.changed();
    return result;
  }
}
