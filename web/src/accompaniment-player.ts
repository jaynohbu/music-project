// Plays live accompaniment parts on the mixer's AudioContext, in step with the stems. Each sound is one sampled
// note every three semitones (public/accompaniment/sounds/<program>.flac); notes are scheduled a little ahead,
// a quarter second at a time, from the song position the mixer is playing.
import { type NoteEvent, type StyleLibrary, sampleFor, samplesOf } from './accompaniment';

const AHEAD = 0.25;      // Seconds scheduled ahead of the clock.
const TICK_MS = 60;
const ATTACK = 0.004, RELEASE = 0.12;
// Notes starting within this many seconds of each other are one chord: their level is shared, so a full chord is
// no louder than a few notes and does not clip.
const TOGETHER = 0.05;

const sounds = new Map<string, Promise<AudioBuffer>>();

// How long each sample takes to be heard: seconds from its start until its level (a 10 ms running mean) first reaches
// half its peak in its first LOOK_ATTACK seconds. A note is started that much earlier (at the speed it is played, at
// most MOST_LEAD), so a sound that swells in (strings, pads, organ) is heard on its beat.
const LOOK_ATTACK = 1, MOST_LEAD = 0.25;
const attacks = new WeakMap<AudioBuffer, number[]>();
export function sampleAttacks(buffer: { sampleRate: number; length: number; getChannelData(channel: number): Float32Array },
  samples: StyleLibrary['samples']): number[] {
  const data = buffer.getChannelData(0), rate = buffer.sampleRate, smooth = Math.max(1, Math.round(0.01 * rate));
  return samples.pitches.map((_, index) => {
    const from = Math.round(index * samples.slot * rate), to = Math.min(data.length, from + Math.round(LOOK_ATTACK * rate));
    const level = new Float32Array(Math.max(0, to - from));
    let sum = 0, peak = 0;
    for (let at = from; at < to; at++) {
      sum += Math.abs(data[at]) - (at - smooth >= from ? Math.abs(data[at - smooth]) : 0);
      level[at - from] = sum / smooth;
      peak = Math.max(peak, level[at - from]);
    }
    const heard = level.findIndex(value => value >= peak / 2);
    return peak > 0 && heard > 0 ? heard / rate : 0;
  });
}
function leadOf(buffer: AudioBuffer, samples: StyleLibrary['samples'], index: number, speed: number): number {
  let found = attacks.get(buffer);
  if (!found) attacks.set(buffer, found = sampleAttacks(buffer, samples));
  return Math.min(MOST_LEAD, (found[index] ?? 0) / speed);
}
let library: Promise<StyleLibrary> | undefined;

export function loadLibrary(): Promise<StyleLibrary> {
  library ??= fetch('accompaniment/styles.json').then(response => {
    if (!response.ok) throw new Error(`Accompaniment styles request failed (HTTP ${response.status}).`);
    return response.json() as Promise<StyleLibrary>;
  });
  library.catch(() => { library = undefined; });
  return library;
}

export function loadSound(context: BaseAudioContext, program: number): Promise<AudioBuffer> {
  const key = String(program);
  let found = sounds.get(key);
  if (!found) {
    found = fetch(`accompaniment/sounds/${program}.flac`).then(async response => {
      if (!response.ok) throw new Error(`Sound request failed (HTTP ${response.status}).`);
      return context.decodeAudioData(await response.arrayBuffer());
    });
    found.catch(() => sounds.delete(key));
    sounds.set(key, found);
  }
  return found;
}

// Where the song is playing: the context time it started at, from which song second, and the loop it repeats.
export interface PlayClock { startedAt: number; startOffset: number; start: number; end: number; loop: boolean }

export class AccompanimentVoice {
  readonly output: GainNode;
  private events: NoteEvent[] = [];
  private shares: number[] = [];
  private buffer?: AudioBuffer;
  private samples?: StyleLibrary['samples'];
  private active = new Set<AudioBufferSourceNode>();
  private timer?: ReturnType<typeof setInterval>;
  // How far the song has been scheduled, in song seconds and the matching context time.
  private cursor?: { song: number; context: number; index: number };

  constructor(private readonly context: AudioContext, destination: AudioNode) {
    this.output = context.createGain();
    this.output.connect(destination);
  }

  setNotes(events: NoteEvent[], buffer: AudioBuffer, samples: StyleLibrary['samples'], clock?: PlayClock): void {
    this.events = events;
    // Events come sorted by time.
    let from = 0, to = 0;
    this.shares = events.map(event => {
      while (events[from].time < event.time - TOGETHER) from++;
      while (to < events.length && events[to].time <= event.time + TOGETHER) to++;
      return 1 / Math.sqrt(Math.max(1, (to - from) / 2));
    });
    this.buffer = buffer;
    this.samples = samples;
    // A change while playing takes over from the next scheduled moment.
    if (clock) this.start(clock);
  }

  start(clock: PlayClock): void {
    this.stop();
    const now = this.context.currentTime;
    const song = clock.startOffset + Math.max(0, now - clock.startedAt);
    const position = clock.loop && song >= clock.end ? clock.start + (song - clock.end) % (clock.end - clock.start) : song;
    this.cursor = { song: position, context: Math.max(now, clock.startedAt), index: this.firstAfter(position) };
    this.schedule(clock);
    this.timer = setInterval(() => this.schedule(clock), TICK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.cursor = undefined;
    const now = this.context.currentTime;
    for (const source of this.active) {
      try { source.stop(now + 0.02); } catch { /* Already stopped. */ }
    }
    this.active.clear();
  }

  dispose(): void {
    this.stop();
    this.output.disconnect();
  }

  private firstAfter(time: number): number {
    let low = 0, high = this.events.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.events[middle].time < time) low = middle + 1; else high = middle;
    }
    return low;
  }

  private schedule(clock: PlayClock): void {
    const cursor = this.cursor;
    if (!cursor || !this.buffer || !this.samples) return;
    const horizon = this.context.currentTime + AHEAD;
    while (cursor.context < horizon) {
      const until = Math.min(clock.end, cursor.song + (horizon - cursor.context));
      while (cursor.index < this.events.length && this.events[cursor.index].time < until) {
        const share = this.shares[cursor.index], event = this.events[cursor.index++];
        // Notes are cut at the end of the section, so a loop starts clean.
        const duration = Math.min(event.duration, clock.end - event.time);
        if (duration > 0) this.play(event, cursor.context + (event.time - cursor.song), duration, share);
      }
      cursor.context += until - cursor.song;
      cursor.song = until;
      if (cursor.song < clock.end) break;
      if (!clock.loop) { clearInterval(this.timer); return; }
      cursor.song = clock.start;
      cursor.index = this.firstAfter(clock.start);
    }
  }

  private play(event: NoteEvent, when: number, duration: number, share: number): void {
    const samples = this.samples!, buffer = this.buffer!;
    const { index, rate } = sampleFor(samples.pitches, event.pitch);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const envelope = this.context.createGain();
    const level = (event.velocity / 127) ** 1.5 * 0.5 * share;
    // Started early by the sound's attack, so it is heard on time (and held as much longer).
    const lead = leadOf(buffer, samples, index, rate);
    const at = Math.max(when - lead, this.context.currentTime);
    // The sample lasts samples.length seconds at its own pitch; held notes end with it.
    const held = Math.min(duration + lead, samples.length / rate - RELEASE);
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + ATTACK);
    envelope.gain.setValueAtTime(level, at + Math.max(ATTACK, held));
    envelope.gain.linearRampToValueAtTime(0, at + Math.max(ATTACK, held) + RELEASE);
    source.connect(envelope);
    envelope.connect(this.output);
    source.start(at, index * samples.slot, samples.length);
    source.stop(at + Math.max(ATTACK, held) + RELEASE + 0.01);
    this.active.add(source);
    source.onended = () => { this.active.delete(source); envelope.disconnect(); };
  }
}

// Notes rendered offline into one buffer `seconds` long at `rate`, in a sound of the library (a piano by default),
// as a voice would play them: for listening to notes against the song without scheduling them live.
export async function renderNotes(events: NoteEvent[], seconds: number, rate: number, program = 0): Promise<AudioBuffer> {
  const samples = samplesOf(await loadLibrary(), program);
  const context = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * rate)), rate);
  const buffer = await loadSound(context, program);
  const sorted = [...events].sort((a, b) => a.time - b.time);
  let from = 0, to = 0;
  sorted.forEach(event => {
    while (sorted[from].time < event.time - TOGETHER) from++;
    while (to < sorted.length && sorted[to].time <= event.time + TOGETHER) to++;
    const share = 1 / Math.sqrt(Math.max(1, (to - from) / 2));
    const { index, rate: speed } = sampleFor(samples.pitches, event.pitch);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;
    const envelope = context.createGain();
    const lead = leadOf(buffer, samples, index, speed);
    const level = (event.velocity / 127) ** 1.5 * 0.5 * share, at = Math.max(0, event.time - lead);
    const held = Math.max(ATTACK, Math.min(event.duration + lead, samples.length / speed - RELEASE));
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + ATTACK);
    envelope.gain.setValueAtTime(level, at + held);
    envelope.gain.linearRampToValueAtTime(0, at + held + RELEASE);
    source.connect(envelope);
    envelope.connect(context.destination);
    source.start(at, index * samples.slot, samples.length);
    source.stop(at + held + RELEASE + 0.01);
  });
  return context.startRendering();
}

// Note levels set so a part follows a recording's loudness through the song: `measured` (the notes the recording
// has) is rendered in the sound, its loudness and the recording's are taken every WINDOW seconds, and each note's
// velocity is moved by how much louder or softer the recording is there than the part (smoothed over SMOOTH windows
// either side, at most MOST_CHANGE either way) against their typical ratio, which comes back as `gain`: the part's
// level at which it is as loud as the recording.
const WINDOW = 0.25, SMOOTH = 2, MOST_CHANGE = 4, RENDER_RATE = 11025;
export async function matchLoudness(events: NoteEvent[], measured: NoteEvent[], reference: AudioBuffer, program: number): Promise<{ events: NoteEvent[]; gain: number }> {
  const seconds = reference.duration;
  const rendered = (await renderNotes(measured, seconds, RENDER_RATE, program)).getChannelData(0);
  const windows = Math.ceil(seconds / WINDOW);
  const loudness = (read: (index: number) => number, rate: number, length: number) => Array.from({ length: windows }, (_, w) => {
    const from = Math.floor(w * WINDOW * rate), to = Math.min(length, Math.floor((w + 1) * WINDOW * rate));
    let sum = 0;
    for (let index = from; index < to; index++) sum += read(index) ** 2;
    return to > from ? Math.sqrt(sum / (to - from)) : 0;
  });
  const channels = Array.from({ length: reference.numberOfChannels }, (_, index) => reference.getChannelData(index));
  const heard = loudness(index => channels.reduce((sum, channel) => sum + channel[index], 0) / channels.length, reference.sampleRate, reference.length);
  const played = loudness(index => rendered[index], RENDER_RATE, rendered.length);
  const { change, typical } = levelChanges(heard, played);
  const changeAt = (time: number) => change[Math.max(0, Math.min(windows - 1, Math.floor(time / WINDOW)))];
  // A note's level goes as velocity to the power 1.5 (AccompanimentVoice), so dB move velocity by a third of their power.
  const moved = events.map(event => ({ ...event, velocity: Math.max(1, Math.min(127, Math.round(event.velocity * 10 ** (changeAt(event.time) / 30)))) }));
  return { events: moved, gain: 10 ** (typical / 20) };
}

// How many dB a part must move in each window to be as loud as a recording, against their typical ratio (the
// median, in dB, of the windows where both sound): smoothed over SMOOTH windows either side, at most MOST_CHANGE
// either way, and where only one sounds, as the nearest window that has both (within two seconds).
export function levelChanges(heard: number[], played: number[]): { change: number[]; typical: number } {
  const ratio = heard.map((value, w) => value > 1e-4 && played[w] > 1e-4 ? 20 * Math.log10(value / played[w]) : NaN);
  const valid = ratio.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return { change: heard.map(() => 0), typical: 0 };
  const typical = valid[valid.length >> 1];
  const limit = 20 * Math.log10(MOST_CHANGE);
  const smooth = ratio.map((_, w) => {
    const near = ratio.slice(Math.max(0, w - SMOOTH), w + SMOOTH + 1).filter(Number.isFinite).sort((a, b) => a - b);
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
