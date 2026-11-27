// The Harmonic score played on guitar and on keys, as the website's mixer plays it (web/src/accompaniment-player.ts):
// every note of the score (its sung line among them) in a sampled sound from the website's library — one note every
// three semitones, read faster or slower for the notes between — started early by the sound's own attack, and as
// loud through the song as the Harmonic stem (whose loudness comes with a result made from a score). Each part is
// rendered whole and played as one source with the stems (player.ts).
import { Directory, File, Paths } from 'expo-file-system';
import type { AudioBuffer, AudioContext } from 'react-native-audio-api';
import type { HarmonyNote, HarmonyPart } from './api';

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

const ATTACK = 0.004, RELEASE = 0.12, TOGETHER = 0.05;
export const RENDER_RATE = 22050;
// A part rendered whole, as one signal at RENDER_RATE from the song's start: each note its sample read faster or
// slower for its pitch, started early by the sample's attack (at most MOST_LEAD) and held as much longer, faded in
// and out, as loud as its velocity and shared with the notes starting with it (a chord is no louder than a few
// notes). Played as one source next to the stems, so nothing is made or removed on the audio graph per note.
// `sound`: the sound's samples (its first channel) at `soundRate`.
export function renderPart(events: NoteEvent[], sound: Float32Array, soundRate: number, samples: Samples, attacks: number[],
  seconds: number, rate = RENDER_RATE): Float32Array<ArrayBuffer> {
  const steps = renderSteps(events, sound, soundRate, samples, attacks, seconds, rate);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
// The same, a few notes at a time, so the phone stays responsive while a song's part is made; undefined if `cancelled`.
export async function renderPartAsync(events: NoteEvent[], sound: Float32Array, soundRate: number, samples: Samples, attacks: number[],
  seconds: number, cancelled: () => boolean, rate = RENDER_RATE): Promise<Float32Array<ArrayBuffer> | undefined> {
  const steps = renderSteps(events, sound, soundRate, samples, attacks, seconds, rate);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await new Promise(resolve => setTimeout(resolve, 0));
    if (cancelled()) return undefined;
  }
}
const NOTES_PER_STEP = 40;
function* renderSteps(events: NoteEvent[], sound: Float32Array, soundRate: number, samples: Samples, attacks: number[],
  seconds: number, rate: number): Generator<void, Float32Array<ArrayBuffer>> {
  const out = new Float32Array(Math.ceil(seconds * rate));
  const sorted = [...events].sort((a, b) => a.time - b.time);
  let from = 0, to = 0;
  for (const [number, event] of sorted.entries()) {
    if (number && number % NOTES_PER_STEP === 0) yield;
    while (sorted[from].time < event.time - TOGETHER) from++;
    while (to < sorted.length && sorted[to].time <= event.time + TOGETHER) to++;
    const share = 1 / Math.sqrt(Math.max(1, (to - from) / 2));
    const { index, rate: speed } = sampleFor(samples.pitches, event.pitch);
    const lead = Math.min(MOST_LEAD, (attacks[index] ?? 0) / speed);
    const held = Math.max(ATTACK, Math.min(event.duration + lead, samples.length / speed - RELEASE));
    const level = (event.velocity / 127) ** 1.5 * LEVEL * share;
    const begin = Math.round((event.time - lead) * rate), length = Math.round((held + RELEASE) * rate);
    const offset = index * samples.slot * soundRate, step = speed * soundRate / rate, last = offset + samples.length * soundRate - 1;
    const attackEnd = ATTACK * rate, releaseStart = held * rate;
    for (let k = Math.max(0, -begin); k < length && begin + k < out.length; k++) {
      const position = offset + k * step;
      if (position >= last) break;
      const whole = Math.floor(position), fraction = position - whole;
      const value = sound[whole] + (sound[whole + 1] - sound[whole]) * fraction;
      const envelope = k < attackEnd ? k / attackEnd : k < releaseStart ? 1 : Math.max(0, 1 - (k - releaseStart) / (RELEASE * rate));
      out[begin + k] += value * level * envelope;
    }
  }
  return out;
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
