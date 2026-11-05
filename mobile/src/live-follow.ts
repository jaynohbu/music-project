// Live follow: hears the player's notes, compares them with the song's beat map and
// works out how fast the backing stems should play so they stay with the player.
// Pure functions and classes only, so it runs in tests without audio.
import type { StemName } from './api';

// How the backing was stretched during a take, on the take's own clock (seconds into the
// recording). From each point on, the song advanced at `rate` song seconds per second.
export interface TempoPoint { at: number; pos: number; rate: number }

export const MIN_RATE = 0.7;
export const MAX_RATE = 1.3;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function segmentAt(points: TempoPoint[], at: number) {
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (points[middle].at <= at) low = middle; else high = middle - 1;
  }
  return points[low];
}

// Song position heard at take time `at`; before the first point the song runs at normal speed.
export function songPositionAt(points: TempoPoint[], at: number) {
  if (!points.length) return at;
  if (at < points[0].at) return points[0].pos - (points[0].at - at);
  const point = segmentAt(points, at);
  return point.pos + (at - point.at) * point.rate;
}

export function rateAt(points: TempoPoint[], at: number) {
  return points.length && at >= points[0].at ? segmentAt(points, at).rate : 1;
}

// The take time at which the song reached `pos`; the inverse of songPositionAt.
export function takeTimeAt(points: TempoPoint[], pos: number) {
  if (!points.length) return pos;
  if (pos < points[0].pos) return points[0].at - (points[0].pos - pos);
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (points[middle].pos <= pos) low = middle; else high = middle - 1;
  }
  const point = points[low];
  return point.at + (pos - point.pos) / point.rate;
}

// Fractional beat index of a song position, continuing the edge tempo outside the map.
export function beatAt(beats: number[], pos: number) {
  const last = beats.length - 1;
  if (last < 1) return 0;
  if (pos <= beats[0]) return (pos - beats[0]) / (beats[1] - beats[0]);
  if (pos >= beats[last]) return last + (pos - beats[last]) / (beats[last] - beats[last - 1]);
  let low = 0, high = last - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (beats[middle] <= pos) low = middle; else high = middle - 1;
  }
  return low + (pos - beats[low]) / (beats[low + 1] - beats[low]);
}

// Song seconds per beat around a fractional beat index.
function beatLength(beats: number[], beat: number) {
  const index = clamp(Math.floor(beat), 0, beats.length - 2);
  return beats[index + 1] - beats[index];
}

// Finds the moments new notes start with spectral flux: how much new sound appears across the
// spectrum since the last frame. A ringing note fades and adds nothing; a new strum, pluck, key
// or sung syllable adds energy at its own frequencies even when it is not louder overall.
// `size` is the analysis frame (longer resolves low notes), `hop` the step between frames,
// `sensitivity` how far above the recent average flux a note must rise, `low` the lowest
// frequency listened to, `spread` how many neighbouring bins a held note may wander (vibrato,
// bends) without counting as new, and `gap` the shortest time between two notes.
export interface OnsetOptions { size: number; hop: number; sensitivity: number; floor: number; spread: number; low: number; gap: number; silence: number }
export const DEFAULT_ONSETS: OnsetOptions = { size: 1024, hop: 256, sensitivity: 1.6, floor: 3, spread: 1, low: 70, gap: 0.08, silence: -60 };

export type InstrumentId = 'guitar' | 'bass' | 'keyboard' | 'piano' | 'drums' | 'vocals' | 'other';
// `stem` is the band part the instrument stands in for, silenced while the player's take is heard.
export const INSTRUMENTS: { id: InstrumentId; label: string; stem: StemName | null; onsets: OnsetOptions }[] = [
  { id: 'guitar', label: 'Guitar', stem: 'guitar', onsets: DEFAULT_ONSETS },
  { id: 'bass', label: 'Bass', stem: 'bass', onsets: { ...DEFAULT_ONSETS, size: 2048, low: 30, gap: 0.1 } },
  { id: 'keyboard', label: 'Keyboard', stem: 'piano', onsets: { ...DEFAULT_ONSETS, low: 40 } },
  { id: 'piano', label: 'Piano', stem: 'piano', onsets: { ...DEFAULT_ONSETS, low: 40 } },
  { id: 'drums', label: 'Drums', stem: 'drums', onsets: { ...DEFAULT_ONSETS, low: 40, gap: 0.06 } },
  { id: 'vocals', label: 'Vocals', stem: 'vocals', onsets: { ...DEFAULT_ONSETS, low: 80, sensitivity: 1.4, gap: 0.15 } },
  { id: 'other', label: 'Other', stem: null, onsets: { ...DEFAULT_ONSETS, low: 40 } },
];
export const instrument = (id: string | undefined) => INSTRUMENTS.find(item => item.id === id) ?? INSTRUMENTS[0];

// In-place radix-2 FFT; `real` and `imag` have a power-of-two length.
function fft(real: Float64Array, imag: Float64Array) {
  const n = real.length;
  for (let index = 1, swap = 0; index < n; index++) {
    let bit = n >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [real[index], real[swap]] = [real[swap], real[index]];
      [imag[index], imag[swap]] = [imag[swap], imag[index]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length, stepReal = Math.cos(angle), stepImag = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let turnReal = 1, turnImag = 0;
      for (let offset = 0; offset < length / 2; offset++) {
        const a = start + offset, b = a + length / 2;
        const productReal = real[b] * turnReal - imag[b] * turnImag, productImag = real[b] * turnImag + imag[b] * turnReal;
        real[b] = real[a] - productReal; imag[b] = imag[a] - productImag;
        real[a] += productReal; imag[a] += productImag;
        [turnReal, turnImag] = [turnReal * stepReal - turnImag * stepImag, turnReal * stepImag + turnImag * stepReal];
      }
    }
  }
}

export class OnsetDetector {
  private readonly ring: Float32Array;
  private readonly window: Float64Array;
  private readonly real: Float64Array;
  private readonly imag: Float64Array;
  private previous: Float64Array | null = null;
  private readonly first: number;
  private readonly last: number;
  private written = 0;
  private sinceFrame = 0;
  private readonly fluxes: number[] = [];
  // The newest frame is held back one hop so it is only reported when it is a peak.
  private candidate: { at: number; flux: number } | null = null;
  private lastOnset = -Infinity;
  constructor(private readonly sampleRate: number, private readonly options: OnsetOptions = DEFAULT_ONSETS) {
    const { size } = options;
    this.ring = new Float32Array(size);
    this.window = Float64Array.from({ length: size }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / size));
    this.real = new Float64Array(size);
    this.imag = new Float64Array(size);
    this.first = Math.max(1, Math.floor(options.low * size / sampleRate));
    this.last = Math.min(size / 2, Math.ceil(5000 * size / sampleRate));
  }

  // `when` is the take time of the first sample. Returns the take times of new onsets.
  push(samples: Float32Array, when: number): number[] {
    const found: number[] = [];
    const { size, hop } = this.options;
    for (let index = 0; index < samples.length; index++) {
      this.ring[this.written % size] = samples[index];
      this.written++;
      if (++this.sinceFrame < hop || this.written < size) continue;
      this.sinceFrame = 0;
      const end = when + (index + 1) / this.sampleRate;
      const onset = this.frame(end);
      if (onset !== null) found.push(onset);
    }
    return found;
  }

  private frame(end: number): number | null {
    const { size, sensitivity, gap, silence } = this.options;
    const { real, imag, window, ring } = this;
    let energy = 0;
    for (let index = 0; index < size; index++) {
      const sample = ring[(this.written + index) % size];
      energy += sample * sample;
      real[index] = sample * window[index];
      imag[index] = 0;
    }
    fft(real, imag);
    const magnitudes = new Float64Array(this.last - this.first);
    for (let bin = this.first; bin < this.last; bin++) {
      // Scaled to the sine amplitude, then log compressed so quiet and loud notes count alike
      // while the window's faint side lobes (which move with vibrato) stay near zero.
      magnitudes[bin - this.first] = Math.log1p(1000 * Math.hypot(real[bin], imag[bin]) * 4 / size);
    }
    let flux = 0;
    const { spread, floor } = this.options, previous = this.previous;
    if (previous) for (let bin = 0; bin < magnitudes.length; bin++) {
      let before = previous[bin];
      for (let near = Math.max(0, bin - spread); near <= Math.min(magnitudes.length - 1, bin + spread); near++) before = Math.max(before, previous[near]);
      flux += Math.max(0, magnitudes[bin] - before);
    }
    this.previous = magnitudes;
    const loud = 10 * Math.log10(energy / size + 1e-12) > silence;
    // A new note fills the newest part of the frame first; this places it where it began.
    const at = end - 0.25 * size / this.sampleRate;
    const recent = this.fluxes.length ? this.fluxes.reduce((sum, value) => sum + value, 0) / this.fluxes.length : flux;
    this.fluxes.push(flux);
    if (this.fluxes.length > 24) this.fluxes.shift();

    let onset: number | null = null;
    const held = this.candidate;
    this.candidate = null;
    if (held && flux < held.flux) { onset = held.at; this.lastOnset = held.at; }
    if (loud && flux > sensitivity * recent + floor && at - this.lastOnset >= gap && (!held || flux >= held.flux)) {
      this.candidate = { at, flux };
    }
    return onset;
  }
}

export interface FollowStatus { rate: number; tempo: number; beat: number; locked: boolean }

// Strength 0 follows only lasting tempo changes; 1 reacts within about a beat.
export class Follower {
  rate = 1;
  tempo = 1;
  beat = 0;
  private history: { at: number; beat: number }[] = [];
  private misses = 0;
  private settleAt = Infinity;
  private lastMatch = -Infinity;
  constructor(private readonly beats: number[], private readonly strength = 0.5) {}

  get status(): FollowStatus {
    return { rate: this.rate, tempo: this.tempo, beat: this.beat, locked: this.history.length >= 3 };
  }

  // `at` is when the note was played (take seconds); `pos` is the song position the player heard then.
  // Returns the new stem speed, or null when this note is not used.
  onset(at: number, pos: number): number | null {
    if (this.beats.length < 2) return null;
    const heard = beatAt(this.beats, pos);
    // Where the player should be by their own recent timing; the band is only a fallback.
    const lost = this.misses >= 3;
    const model = lost ? null : this.playerLine();
    const expected = model ? model.beat + (at - model.at) * model.speed : heard;
    const whole = Math.round(expected), half = Math.round(expected * 2) / 2;
    let target: number;
    if (Math.abs(whole - expected) <= (lost ? 0.45 : 0.3)) target = whole;
    else if (!lost && Math.abs(half - expected) <= 0.15) target = half;
    else { this.misses++; return null; }
    // A note that would put the player back in time is a stray, not a beat.
    if (this.history.length && target <= this.history[this.history.length - 1].beat) { this.misses++; return null; }
    this.misses = 0;
    if (lost) this.history = [];
    this.beat = target;
    this.lastMatch = at;
    this.history.push({ at, beat: target });
    this.history = this.history.filter(point => target - point.beat <= 6);
    const length = beatLength(this.beats, target);
    const line = this.playerLine();
    if (line) {
      const played = clamp(line.speed * length, MIN_RATE, MAX_RATE);
      this.tempo += (played - this.tempo) * (0.4 + 0.6 * this.strength);
    }
    // Close the gap to the player over a few beats: positive when the player is ahead.
    const ahead = target - heard, over = 1 + 3 * (1 - this.strength);
    this.rate = clamp(this.tempo * (1 + ahead / over), Math.max(MIN_RATE, this.tempo * 0.85), Math.min(MAX_RATE, this.tempo * 1.15));
    this.settleAt = at + over * length / this.tempo;
    return this.rate;
  }

  // A straight line through the player's recent notes: their beat at a time and beats per second.
  // Recent notes weigh more so a tempo change shows up within a couple of beats.
  private playerLine() {
    const points = this.history;
    if (points.length < 3 || points[points.length - 1].beat - points[0].beat < 1.5) return null;
    const last = points[points.length - 1];
    let total = 0, meanAt = 0, meanBeat = 0;
    const weights = points.map(point => 0.6 ** (last.beat - point.beat));
    points.forEach((point, index) => { total += weights[index]; meanAt += weights[index] * point.at; meanBeat += weights[index] * point.beat; });
    meanAt /= total; meanBeat /= total;
    let top = 0, bottom = 0;
    points.forEach((point, index) => { top += weights[index] * (point.at - meanAt) * (point.beat - meanBeat); bottom += weights[index] * (point.at - meanAt) ** 2; });
    if (bottom <= 0 || top <= 0) return null;
    const speed = top / bottom;
    return { at: last.at, beat: meanBeat + (last.at - meanAt) * speed, speed };
  }

  // Call regularly: once the catch-up has had its time, play at the player's tempo.
  idle(at: number): number | null {
    if (at < this.settleAt || this.rate === this.tempo) return null;
    this.settleAt = Infinity;
    this.rate = this.tempo;
    return this.rate;
  }

  get lastNote() { return this.lastMatch; }
}
