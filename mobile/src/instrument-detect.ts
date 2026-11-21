// Works out which instrument is coming in on the live input. The strongest clue is the song itself:
// a player usually plays along with one part, so the input's spectrum is compared with what each
// stem is playing at that moment. Pitch, how noisy the sound is and where its energy sits break ties.
// Pure functions and classes only, so it runs in tests without audio.
import type { StemName } from './api';
import { fft, type InstrumentId } from './live-follow';

const SIZE = 2048;
const HOP = 1024;
// Log-spaced bands from 40 Hz to 11 kHz: fine enough to tell a bass from a guitar, coarse enough that
// the mic and a stem compare by shape rather than exact pitch.
export const BAND_COUNT = 24;
const LOWEST = 40, HIGHEST = 11000;
export const BAND_EDGES = Array.from({ length: BAND_COUNT + 1 }, (_, index) => LOWEST * (HIGHEST / LOWEST) ** (index / BAND_COUNT));
// Quieter frames are between notes or room noise.
const GATE_DB = -50;
// Enough sound to decide on: about three seconds of playing.
const DECIDE_FRAMES = 120;
// A stem must match this much better than the next one to be trusted.
const STEM_MARGIN = 0.04;
const SILENT_STEM_DB = -75;
const STEM_INSTRUMENT: Record<StemName, InstrumentId> = {
  vocals: 'vocals', guitar: 'guitar', bass: 'bass', piano: 'piano', drums: 'drums', other: 'other',
};

// Average power per band, in dB, from linear magnitudes or from dB values (an AnalyserNode's output).
export function bandLevels(spectrum: ArrayLike<number>, binHz: number, decibels: boolean): Float64Array {
  const levels = new Float64Array(BAND_COUNT);
  for (let band = 0; band < BAND_COUNT; band++) {
    const first = Math.max(1, Math.floor(BAND_EDGES[band] / binHz));
    const last = Math.min(spectrum.length - 1, Math.max(first, Math.ceil(BAND_EDGES[band + 1] / binHz) - 1));
    let power = 0;
    for (let bin = first; bin <= last; bin++) {
      const value = spectrum[bin];
      power += decibels ? 10 ** (value / 10) : value * value;
    }
    levels[band] = 10 * Math.log10(power / (last - first + 1) + 1e-12);
  }
  return levels;
}

// Cosine similarity of two band profiles after removing their average level, so a quiet mic and a
// loud stem compare by the shape of their spectra.
export function shapeSimilarity(a: Float64Array, b: Float64Array) {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let dot = 0, normA = 0, normB = 0;
  for (let index = 0; index < a.length; index++) {
    const x = a[index] - meanA, y = b[index] - meanB;
    dot += x * y; normA += x * x; normB += y * y;
  }
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

// Pitch by normalised autocorrelation; clarity near 1 means one clear note.
export function pitch(frame: Float32Array, sampleRate: number) {
  const minLag = Math.floor(sampleRate / 1200), maxLag = Math.min(frame.length >> 1, Math.ceil(sampleRate / 35));
  let energy = 0;
  for (let index = 0; index < frame.length - maxLag; index++) energy += frame[index] * frame[index];
  if (energy <= 0) return { frequency: 0, clarity: 0 };
  let bestLag = 0, best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, shifted = 0;
    for (let index = 0; index < frame.length - maxLag; index++) {
      sum += frame[index] * frame[index + lag];
      shifted += frame[index + lag] * frame[index + lag];
    }
    const value = sum / Math.sqrt(energy * shifted + 1e-12);
    if (value > best) { best = value; bestLag = lag; }
  }
  return { frequency: bestLag ? sampleRate / bestLag : 0, clarity: best };
}

export type StemLevels = Partial<Record<StemName, Float64Array>>;
export interface Detection { instrument: InstrumentId | null; confident: boolean; frames: number }

export class InstrumentDetector {
  private readonly ring = new Float32Array(SIZE);
  private readonly window = Float64Array.from({ length: SIZE }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / SIZE));
  private readonly real = new Float64Array(SIZE);
  private readonly imag = new Float64Array(SIZE);
  // Pitch is read at a quarter of the rate: plenty for notes up to 1.2 kHz, and a sixteenth of the work.
  private readonly frame = new Float32Array(SIZE / 4);
  private written = 0;
  private sinceFrame = 0;
  private frames = 0;
  private noisy = 0;
  private clear = 0;
  private readonly pitches: number[] = [];
  private readonly stemScores = new Map<StemName, { sum: number; count: number }>();
  private decided: InstrumentId | null = null;

  // `stems` returns what each stem is playing now, as band levels in dB, or null when the song is not playing.
  constructor(private readonly sampleRate: number, private readonly stems: () => StemLevels | null) {}

  push(samples: Float32Array) {
    for (let index = 0; index < samples.length; index++) {
      this.ring[this.written % SIZE] = samples[index];
      this.written++;
      if (++this.sinceFrame < HOP || this.written < SIZE) continue;
      this.sinceFrame = 0;
      this.analyse();
    }
  }

  private analyse() {
    const { real, imag, window, ring, frame } = this;
    let energy = 0;
    for (let index = 0; index < SIZE; index++) {
      const sample = ring[(this.written + index) % SIZE];
      if (index % 4 === 0) frame[index >> 2] = 0;
      frame[index >> 2] += sample / 4;
      energy += sample * sample;
      real[index] = sample * window[index];
      imag[index] = 0;
    }
    if (10 * Math.log10(energy / SIZE + 1e-12) < GATE_DB) return;
    fft(real, imag);
    const magnitudes = new Float64Array(SIZE / 2);
    let logSum = 0, sum = 0;
    const first = Math.ceil(LOWEST * SIZE / this.sampleRate), last = Math.floor(HIGHEST * SIZE / this.sampleRate);
    for (let bin = 0; bin < SIZE / 2; bin++) {
      magnitudes[bin] = Math.hypot(real[bin], imag[bin]) * 2 / SIZE;
      if (bin >= first && bin <= last) { logSum += Math.log(magnitudes[bin] + 1e-12); sum += magnitudes[bin]; }
    }
    const count = last - first + 1;
    // Spectral flatness: near 1 for noise (cymbals, snares), near 0 for notes.
    const flatness = Math.exp(logSum / count) / (sum / count + 1e-12);
    const { frequency, clarity } = pitch(frame, this.sampleRate / 4);
    this.frames++;
    if (flatness > 0.3 && clarity < 0.5) this.noisy++;
    if (clarity > 0.8 && frequency > 0) { this.clear++; this.pitches.push(frequency); }
    const playing = this.stems();
    if (playing) {
      const levels = bandLevels(magnitudes, this.sampleRate / SIZE, false);
      for (const [name, stem] of Object.entries(playing) as [StemName, Float64Array][]) {
        if (Math.max(...stem) < SILENT_STEM_DB) continue;
        const score = this.stemScores.get(name) ?? { sum: 0, count: 0 };
        score.sum += shapeSimilarity(levels, stem); score.count++;
        this.stemScores.set(name, score);
      }
    }
  }

  get detection(): Detection {
    if (this.frames < DECIDE_FRAMES) return { instrument: this.decided, confident: !!this.decided, frames: this.frames };
    this.decided = this.choose();
    return { instrument: this.decided, confident: true, frames: this.frames };
  }

  private choose(): InstrumentId {
    if (this.noisy / this.frames > 0.6) return 'drums';
    const ranked = [...this.stemScores.entries()]
      .filter(([name, score]) => name !== 'drums' && score.count >= DECIDE_FRAMES / 3)
      .map(([name, score]) => ({ name, score: score.sum / score.count }))
      .sort((a, b) => b.score - a.score);
    if (ranked.length && (ranked.length === 1 || ranked[0].score - ranked[1].score >= STEM_MARGIN)) {
      return STEM_INSTRUMENT[ranked[0].name];
    }
    // No clear match with the song (it is paused, or two parts sound alike): judge the sound alone.
    const sorted = [...this.pitches].sort((a, b) => a - b);
    const median = sorted.length ? sorted[sorted.length >> 1] : 0;
    if (median > 0 && median < 180) return 'bass';
    // A voice holds one clear pitch most of the time; strummed and struck notes ring together.
    if (this.clear / this.frames > 0.7) return 'vocals';
    return ranked.length ? STEM_INSTRUMENT[ranked[0].name] : 'guitar';
  }
}
