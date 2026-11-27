// Plays live accompaniment parts on the mixer's AudioContext, in step with the stems. Each sound is one sampled
// note every three semitones (public/accompaniment/sounds/<program>.flac); notes are scheduled a little ahead,
// a quarter second at a time, from the song position the mixer is playing.
import { type NoteEvent, type StyleLibrary, sampleFor } from './accompaniment';

const AHEAD = 0.25;      // Seconds scheduled ahead of the clock.
const TICK_MS = 60;
const ATTACK = 0.004, RELEASE = 0.12;
// Notes starting within this many seconds of each other are one chord: their level is shared, so a full chord is
// no louder than a few notes and does not clip.
const TOGETHER = 0.05;

const sounds = new Map<string, Promise<AudioBuffer>>();
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
    const at = Math.max(when, this.context.currentTime);
    // The sample lasts samples.length seconds at its own pitch; held notes end with it.
    const held = Math.min(duration, samples.length / rate - RELEASE);
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
  const { samples } = await loadLibrary();
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
    const level = (event.velocity / 127) ** 1.5 * 0.5 * share, at = Math.max(0, event.time);
    const held = Math.max(ATTACK, Math.min(event.duration, samples.length / speed - RELEASE));
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
