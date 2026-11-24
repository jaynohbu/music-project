// A stem's spectrogram on a piano-key frequency scale, for looking at what a stem really plays. Each row is a third
// of a semitone from A0 up to C8; each column a hop of 512 samples at about 22 kHz (23 ms). Low notes need long
// windows to be told apart and high ones short windows to stay sharp in time, so three window sizes are used, each
// for its own range. Pure functions only (no DOM), so they can be unit-tested; the strip draws the result.

export const LOWEST_PITCH = 21;            // A0
export const HIGHEST_PITCH = 108;          // C8
export const ROWS_PER_SEMITONE = 3;
export const ROWS = (HIGHEST_PITCH - LOWEST_PITCH) * ROWS_PER_SEMITONE + 1;
export const HOP = 512;
export const RANGE_DB = 60;                // The quietest shown, below the loudest.
const TARGET_RATE = 22050;
// [window size, highest pitch it is used for]: long windows below C3, short ones above C5.
const BANDS: [number, number][] = [[4096, 48], [2048, 72], [1024, HIGHEST_PITCH]];

export interface Spectrogram {
  rate: number;          // Samples per second the frames were taken at.
  frames: number;
  // Level in dB below the loudest (0 loudest, -RANGE_DB quietest), row by row of each frame: frames * ROWS.
  levels: Float32Array;
}

export const rowPitch = (row: number) => LOWEST_PITCH + row / ROWS_PER_SEMITONE;
const hz = (pitch: number) => 440 * 2 ** ((pitch - 69) / 12);

// Channels averaged and the rate brought down to about 22 kHz (by averaging neighbouring samples).
export function monoSignal(channels: Float32Array[], sampleRate: number): { signal: Float32Array; rate: number } {
  const step = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const length = Math.floor(channels[0].length / step);
  const signal = new Float32Array(length);
  for (const channel of channels) {
    for (let index = 0; index < length; index++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += channel[index * step + k];
      signal[index] += sum / step / channels.length;
    }
  }
  return { signal, rate: sampleRate / step };
}

// In-place radix-2 FFT of real input (imaginary part starts at zero); returns magnitudes of the first half. The
// window is half the transform, zero-padded, so the spectrum is sampled twice as finely as the window resolves.
const PADDING = 2;
class Transform {
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly reversed: Uint32Array;
  readonly window: Float32Array;
  private readonly real: Float32Array;
  private readonly imaginary: Float32Array;

  constructor(readonly length: number, readonly size = length * PADDING) {
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / size); this.sin[i] = -Math.sin(2 * Math.PI * i / size); }
    this.reversed = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let value = 0;
      for (let bit = 0; bit < bits; bit++) value = (value << 1) | ((i >> bit) & 1);
      this.reversed[i] = value;
    }
    this.window = new Float32Array(length);
    for (let i = 0; i < length; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / length);
    this.real = new Float32Array(size);
    this.imaginary = new Float32Array(size);
  }

  // Magnitudes of the window centred on sample center (zeros past the ends).
  magnitudes(signal: Float32Array, center: number, out: Float32Array): void {
    const { size, length, real, imaginary, reversed, window } = this;
    const start = center - length / 2;
    for (let i = 0; i < size; i++) {
      const at = start + i;
      real[reversed[i]] = i < length && at >= 0 && at < signal.length ? signal[at] * window[i] : 0;
      imaginary[i] = 0;
    }
    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1, step = size / span;
      for (let block = 0; block < size; block += span) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], s = this.sin[k * step];
          const a = block + k, b = a + half;
          const tr = real[b] * c - imaginary[b] * s, ti = real[b] * s + imaginary[b] * c;
          real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
          real[a] += tr; imaginary[a] += ti;
        }
      }
    }
    for (let i = 0; i < size / 2; i++) out[i] = Math.hypot(real[i], imaginary[i]) * 2 / length;
  }
}

// For each row: which window it is read from, and the bins it covers (the strongest counts), or, where bins are
// wider than the row, the fractional bin at its centre (read between the two nearest).
interface RowSource { band: number; low: number; high: number; at: number }
function rowSources(rate: number): RowSource[] {
  const sources: RowSource[] = [];
  for (let row = 0; row < ROWS; row++) {
    const pitch = rowPitch(row);
    const band = BANDS.findIndex(([, highest]) => pitch < highest || highest === HIGHEST_PITCH);
    const binHz = rate / (BANDS[band][0] * PADDING);
    const half = 0.5 / ROWS_PER_SEMITONE;
    sources.push({ band, low: Math.ceil(hz(pitch - half) / binHz), high: Math.floor(hz(pitch + half) / binHz), at: hz(pitch) / binHz });
  }
  return sources;
}

// Computes the spectrogram a slice of frames at a time, yielding between slices so the page keeps playing;
// progress(share) is called as it goes.
export async function spectrogramOf(signal: Float32Array, rate: number, progress?: (share: number) => void,
  yieldEvery = 100): Promise<Spectrogram> {
  const frames = Math.max(1, Math.ceil(signal.length / HOP));
  const transforms = BANDS.map(([size]) => new Transform(size));
  const spectra = transforms.map(transform => new Float32Array(transform.size / 2));
  const sources = rowSources(rate);
  const levels = new Float32Array(frames * ROWS);
  let loudest = 1e-12;
  for (let frame = 0; frame < frames; frame++) {
    transforms.forEach((transform, band) => transform.magnitudes(signal, frame * HOP, spectra[band]));
    for (let row = 0; row < ROWS; row++) {
      const { band, low, high, at } = sources[row];
      const spectrum = spectra[band];
      let value = 0;
      if (high >= low) {
        for (let bin = low; bin <= high && bin < spectrum.length; bin++) value = Math.max(value, spectrum[bin]);
      } else {
        const below = Math.floor(at), share = at - below;
        value = (spectrum[below] ?? 0) * (1 - share) + (spectrum[below + 1] ?? 0) * share;
      }
      levels[frame * ROWS + row] = value;
      if (value > loudest) loudest = value;
    }
    if (frame % yieldEvery === yieldEvery - 1) {
      progress?.(frame / frames);
      await new Promise(resolve => setTimeout(resolve));
    }
  }
  for (let index = 0; index < levels.length; index++) {
    levels[index] = Math.max(-RANGE_DB, 20 * Math.log10(Math.max(levels[index], 1e-12) / loudest));
  }
  progress?.(1);
  return { rate, frames, levels };
}

// Black through purple, red and orange to pale yellow, as RGB per level step (0 quietest, 255 loudest).
export function heatColors(): Uint8ClampedArray {
  const stops: [number, number, number, number][] = [
    [0, 0, 0, 4], [0.25, 59, 15, 112], [0.5, 140, 41, 129], [0.7, 222, 73, 104], [0.85, 254, 159, 109], [1, 252, 253, 191],
  ];
  const colors = new Uint8ClampedArray(256 * 3);
  for (let step = 0; step < 256; step++) {
    const value = step / 255;
    const upper = stops.findIndex(stop => stop[0] >= value);
    const [x1, ...high] = stops[Math.max(upper, 1)], [x0, ...low] = stops[Math.max(upper, 1) - 1];
    const share = (value - x0) / (x1 - x0 || 1);
    for (let channel = 0; channel < 3; channel++) colors[step * 3 + channel] = low[channel] + (high[channel] - low[channel]) * share;
  }
  return colors;
}

// Song seconds at a position on the grid (sixteenths from the first beat), extrapolating past its ends; the
// inverse of the score's positionAt.
export function timeAtPosition(beats: number[], position: number): number {
  const beat = position / 4, last = beats.length - 1;
  if (beat <= 0) return beats[0] + beat * (beats[1] - beats[0]);
  if (beat >= last) return beats[last] + (beat - last) * (beats[last] - beats[last - 1]);
  const index = Math.floor(beat);
  return beats[index] + (beat - index) * (beats[index + 1] - beats[index]);
}
