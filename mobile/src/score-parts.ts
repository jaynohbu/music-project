// The Harmonic score played on guitar and on keys, as the website's mixer plays it (web/src/accompaniment-player.ts):
// every note of the score (its sung line among them) in a sampled sound from the website's library — one note every
// three semitones, read faster or slower for the notes between — started early by the sound's own attack, and as
// loud through the song as the Harmonic stem (whose loudness comes with a result made from a score). The notes are
// scheduled a little ahead on the mixer's clock, at whatever speed the song plays.
import { Directory, File, Paths } from 'expo-file-system';
import type { AudioBuffer, AudioContext, AudioNode } from 'react-native-audio-api';
import type { HarmonyNote, HarmonyPart } from './api';
import { stereoGain } from './effects';

export type Family = 'guitar' | 'keys';
export const SCORE_FAMILIES: readonly Family[] = ['guitar', 'keys'];
const LIBRARY_URL = 'https://tunesbasis.com/accompaniment';

export interface Samples { rate: number; pitches: number[]; slot: number; length: number }
export interface SoundLibrary {
  groups: Record<string, { styles: string[]; guitar: number[]; keys: number[] }>;
  sounds: Record<string, { name: string; family: Family }>;
  samples: Samples;
}
// The song's analysis's choice of sounds for it, closest first (backend/accompaniment.py).
export interface SoundChoices { genre: string; closest?: Family; guitar?: { sounds: number[] }; keys?: { sounds: number[] } }
export interface NoteEvent { time: number; duration: number; pitch: number; velocity: number }
export interface Loudness { window: number; other: number[] }

let library: Promise<SoundLibrary> | undefined;
export function loadLibrary(): Promise<SoundLibrary> {
  library ??= fetch(`${LIBRARY_URL}/styles.json`).then(async response => {
    if (!response.ok) throw new Error(`Sounds request failed (HTTP ${response.status}).`);
    return await response.json() as SoundLibrary;
  });
  library.catch(() => { library = undefined; });
  return library;
}

// A sound's samples, kept on the phone after the first time.
export async function soundFile(sound: number): Promise<string> {
  const folder = new Directory(Paths.cache, 'sounds');
  folder.create({ idempotent: true, intermediates: true });
  const file = new File(folder, `${sound}.flac`);
  if (!file.exists) await File.downloadFileAsync(`${LIBRARY_URL}/sounds/${sound}.flac`, file, { idempotent: true });
  return file.uri;
}

// The sounds offered for a family: the song's ranked ones first, then the genre group's, then every other.
export function offered(sounds: SoundLibrary, choices: SoundChoices | undefined, family: Family): number[] {
  const group = sounds.groups[choices?.genre ?? 'pop'] ?? sounds.groups.pop;
  const ranked = (choices?.[family]?.sounds?.length ? choices[family]!.sounds : group?.[family] ?? []).filter(sound => sounds.sounds[String(sound)]);
  const rest = Object.entries(sounds.sounds).filter(([id, sound]) => sound.family === family && !ranked.includes(Number(id))).map(([id]) => Number(id));
  return [...ranked, ...rest];
}

export function sampleFor(pitches: number[], pitch: number): { index: number; rate: number } {
  let index = 0;
  for (let i = 1; i < pitches.length; i++) if (Math.abs(pitches[i] - pitch) < Math.abs(pitches[index] - pitch)) index = i;
  return { index, rate: 2 ** ((pitch - pitches[index]) / 12) };
}

const velocityOf = (note: HarmonyNote) => note.velocity ?? 90;
// Every note of the part, and its sung line, as played; moved by the key change.
export function scoreEvents(part: HarmonyPart, semitones: number, melody = true): NoteEvent[] {
  return [...part.notes, ...(melody ? part.melody ?? [] : [])].map(note => ({
    time: note.start, duration: Math.max(0.05, note.end - note.start), pitch: note.pitch + semitones, velocity: velocityOf(note),
  })).sort((a, b) => a.time - b.time);
}

// Per sample: seconds until it is heard (its level, a 10 ms running mean, first reaches half its peak in its first
// second), and its level every `window` seconds over its length; from the sound's samples at `rate`.
export function sampleShape(data: Float32Array, rate: number, samples: Samples, window: number): { attacks: number[]; levels: number[][] } {
  const smooth = Math.max(1, Math.round(0.01 * rate)), attacks: number[] = [], levels: number[][] = [];
  samples.pitches.forEach((_, index) => {
    const from = Math.round(index * samples.slot * rate), to = Math.min(data.length, from + Math.round(samples.length * rate));
    let sum = 0, peak = 0, heard = -1;
    const look = Math.min(to, from + rate);
    const running = new Float32Array(Math.max(0, look - from));
    for (let at = from; at < look; at++) {
      sum += Math.abs(data[at]) - (at - smooth >= from ? Math.abs(data[at - smooth]) : 0);
      running[at - from] = sum / smooth;
      peak = Math.max(peak, running[at - from]);
    }
    heard = running.findIndex(value => value >= peak / 2);
    attacks.push(peak > 0 && heard > 0 ? heard / rate : 0);
    const steps: number[] = [], size = Math.round(window * rate);
    for (let start = from; start < to; start += size) {
      let energy = 0;
      const end = Math.min(to, start + size);
      for (let at = start; at < end; at++) energy += data[at] * data[at];
      steps.push(Math.sqrt(energy / Math.max(1, end - start)));
    }
    levels.push(steps);
  });
  return { attacks, levels };
}

// How many dB a part must move in each window to be as loud as a recording, against their typical ratio (as the
// website's levelChanges): smoothed over two windows either side, at most four times either way.
export function levelChanges(heard: number[], played: number[]): { change: number[]; typical: number } {
  const ratio = heard.map((value, w) => value > 1e-4 && played[w] > 1e-4 ? 20 * Math.log10(value / played[w]) : NaN);
  const valid = ratio.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return { change: heard.map(() => 0), typical: 0 };
  const typical = valid[valid.length >> 1], limit = 20 * Math.log10(4);
  const smooth = ratio.map((_, w) => {
    const near = ratio.slice(Math.max(0, w - 2), w + 3).filter(Number.isFinite).sort((a, b) => a - b);
    return near.length ? Math.max(-limit, Math.min(limit, near[near.length >> 1] - typical)) : NaN;
  });
  const change = smooth.map((_, w) => {
    for (let reach = 0; reach <= 8; reach++) {
      for (const at of [w - reach, w + reach]) if (at >= 0 && at < smooth.length && Number.isFinite(smooth[at])) return smooth[at];
    }
    return 0;
  });
  return { change, typical };
}

const LEVEL = 0.5, MOST_LEAD = 0.25;
// The part's level at which it is as loud as the Harmonic stem, and its notes' velocities moved to follow the
// stem's loudness: the part's loudness is reckoned from its samples' levels (the notes the stem has, not the sung
// line), each note sounding its sample's level curve from its start for its length.
export function matchLoudness(events: NoteEvent[], measured: NoteEvent[], loudness: Loudness, samples: Samples, levels: number[][]):
  { events: NoteEvent[]; gain: number } {
  const window = loudness.window, energy = new Array(loudness.other.length).fill(0);
  for (const event of measured) {
    const { index } = sampleFor(samples.pitches, event.pitch);
    const amplitude = (event.velocity / 127) ** 1.5 * LEVEL;
    const first = Math.floor(event.time / window), steps = Math.ceil(event.duration / window);
    for (let k = 0; k < steps && first + k < energy.length && k < levels[index].length; k++) {
      energy[first + k] += (amplitude * levels[index][k]) ** 2;
    }
  }
  const { change, typical } = levelChanges(loudness.other, energy.map(Math.sqrt));
  const at = (time: number) => change[Math.max(0, Math.min(change.length - 1, Math.floor(time / window)))] ?? 0;
  return {
    events: events.map(event => ({ ...event, velocity: Math.max(1, Math.min(127, Math.round(event.velocity * 10 ** (at(event.time) / 30)))) })),
    gain: 10 ** (typical / 20),
  };
}

const AHEAD = 0.3, TICK_MS = 60, ATTACK = 0.004, RELEASE = 0.12, TOGETHER = 0.05;
// Where the song is: its position now, and the audio-clock time of a song time (at the speed it plays now).
export interface SongClock { position(): number; contextTime(song: number): number; playing(): boolean; end(): number }

// One part's notes in one sound, played into `destination` while the song plays.
export class ScoreVoice {
  readonly output;
  private events: NoteEvent[] = [];
  private shares: number[] = [];
  private buffer?: AudioBuffer;
  private samples?: Samples;
  private attacks: number[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private next = 0;
  private scheduledUntil = 0;
  private active = new Set<{ stop(when?: number): void }>();

  constructor(private readonly context: AudioContext, destination: AudioNode, private readonly clock: SongClock) {
    this.output = stereoGain(context);
    this.output.connect(destination);
  }

  setNotes(events: NoteEvent[], buffer: AudioBuffer, samples: Samples, attacks: number[]) {
    this.events = events;
    let from = 0, to = 0;
    this.shares = events.map(event => {
      while (events[from].time < event.time - TOGETHER) from++;
      while (to < events.length && events[to].time <= event.time + TOGETHER) to++;
      return 1 / Math.sqrt(Math.max(1, (to - from) / 2));
    });
    this.buffer = buffer;
    this.samples = samples;
    this.attacks = attacks;
    if (this.timer) this.start();
  }

  // From the song's position now; called whenever the song starts playing (play, seek, loop).
  start() {
    this.stop();
    const position = this.clock.position();
    this.next = this.firstAfter(position);
    this.scheduledUntil = position;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    const now = this.context.currentTime;
    for (const source of this.active) { try { source.stop(now + 0.02); } catch { /* Already ended. */ } }
    this.active.clear();
  }

  dispose() { this.stop(); this.output.disconnect(); }

  private firstAfter(time: number) {
    let low = 0, high = this.events.length;
    while (low < high) { const middle = (low + high) >> 1; if (this.events[middle].time < time) low = middle + 1; else high = middle; }
    return low;
  }

  private schedule() {
    if (!this.buffer || !this.samples || !this.clock.playing()) return;
    const position = this.clock.position(), until = Math.min(this.clock.end(), position + AHEAD);
    while (this.next < this.events.length && this.events[this.next].time < until) {
      const index = this.next++, event = this.events[index];
      if (event.time >= this.scheduledUntil - 0.01) this.play(event, this.shares[index]);
    }
    this.scheduledUntil = until;
  }

  private play(event: NoteEvent, share: number) {
    const samples = this.samples!, { index, rate } = sampleFor(samples.pitches, event.pitch);
    const lead = Math.min(MOST_LEAD, (this.attacks[index] ?? 0) / rate);
    const start = this.clock.contextTime(event.time), at = Math.max(start - lead, this.context.currentTime);
    const end = this.clock.contextTime(event.time + event.duration);
    const held = Math.max(ATTACK, Math.min(end - start + lead, samples.length / rate - RELEASE));
    const source = this.context.createBufferSource();
    source.buffer = this.buffer!;
    source.playbackRate.value = rate;
    const envelope = stereoGain(this.context, 0);
    const level = (event.velocity / 127) ** 1.5 * LEVEL * share;
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + ATTACK);
    envelope.gain.setValueAtTime(level, at + held);
    envelope.gain.linearRampToValueAtTime(0, at + held + RELEASE);
    source.connect(envelope);
    envelope.connect(this.output);
    source.start(at, index * samples.slot, samples.length);
    source.stop(at + held + RELEASE + 0.01);
    this.active.add(source);
    source.onEnded = () => { this.active.delete(source); envelope.disconnect(); };
  }
}

// A sound's samples decoded on the mixer's context, and their shape, once per context and sound.
const decoded = new WeakMap<AudioContext, Map<number, Promise<{ buffer: AudioBuffer; attacks: number[]; levels: number[][] }>>>();
export function loadSound(context: AudioContext, sound: number, samples: Samples, window = 0.25) {
  let sounds = decoded.get(context);
  if (!sounds) decoded.set(context, sounds = new Map());
  let found = sounds.get(sound);
  if (!found) {
    found = (async () => {
      const buffer = await context.decodeAudioData(await soundFile(sound));
      return { buffer, ...sampleShape(buffer.getChannelData(0), buffer.sampleRate, samples, window) };
    })();
    found.catch(() => sounds!.delete(sound));
    sounds.set(sound, found);
  }
  return found;
}
