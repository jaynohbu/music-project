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

// What stands out in a spectrogram: for each frame, the rows that are
//   a peak along the pitch axis (at least as loud as the rows within two thirds of a semitone),
//   above their own noise floor by aboveFloor dB (the row's FLOOR_PERCENTILE level over the song: a note held
//   for long, or struck again and again, does not raise it),
//   within withinLoudest dB of the frame's loudest row, and
//   lasting at least LEAST_FRAMES frames (about 90 ms) on the same row or the next one.
// Returns, per frame and row, how far above its floor the level is (1 to 255, a dB each), 0 where nothing is.
export const FLOOR_PERCENTILE = 0.3;
export const LEAST_FRAMES = 4;  // The windows smear a 20 ms click over three frames.
export function meaningful(spectrogram: Spectrogram, aboveFloor = 12, withinLoudest = 30): Uint8Array {
  const { frames, levels } = spectrogram;
  const floors = new Float32Array(ROWS);
  const column = new Float32Array(frames);
  for (let row = 0; row < ROWS; row++) {
    for (let frame = 0; frame < frames; frame++) column[frame] = levels[frame * ROWS + row];
    column.sort();
    floors[row] = column[Math.floor(FLOOR_PERCENTILE * (frames - 1))];
  }
  const kept = new Uint8Array(frames * ROWS);
  for (let frame = 0; frame < frames; frame++) {
    const base = frame * ROWS;
    let loudest = -Infinity;
    for (let row = 0; row < ROWS; row++) loudest = Math.max(loudest, levels[base + row]);
    for (let row = 0; row < ROWS; row++) {
      const level = levels[base + row], above = level - floors[row];
      if (above < aboveFloor || level < loudest - withinLoudest) continue;
      let peak = true;
      for (let near = Math.max(0, row - 2); near <= Math.min(ROWS - 1, row + 2) && peak; near++) {
        if (near !== row && levels[base + near] > level) peak = false;
      }
      if (peak) kept[base + row] = Math.min(255, Math.max(1, Math.round(above)));
    }
  }
  // Short blips go: a kept cell needs LEAST_FRAMES frames in a row kept on its row or the next one.
  const lasting = new Uint8Array(frames * ROWS);
  const on = (frame: number, row: number) => row >= 0 && row < ROWS && kept[frame * ROWS + row] > 0;
  const here = (frame: number, row: number) => on(frame, row) || on(frame, row - 1) || on(frame, row + 1);
  for (let row = 0; row < ROWS; row++) {
    let start = 0;
    for (let frame = 0; frame <= frames; frame++) {
      if (frame < frames && here(frame, row)) continue;
      if (frame - start >= LEAST_FRAMES) {
        for (let at = start; at < frame; at++) lasting[at * ROWS + row] = kept[at * ROWS + row];
      }
      start = frame + 1;
    }
  }
  return lasting;
}

// In-place complex FFT (radix 2); inverse divides by the size.
function fft(real: Float32Array, imaginary: Float32Array, inverse: boolean): void {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let span = 2; span <= size; span <<= 1) {
    const half = span >> 1, angle = sign * 2 * Math.PI / span;
    for (let k = 0; k < half; k++) {
      const c = Math.cos(angle * k), s = Math.sin(angle * k);
      for (let block = 0; block < size; block += span) {
        const a = block + k, b = a + half;
        const tr = real[b] * c - imaginary[b] * s, ti = real[b] * s + imaginary[b] * c;
        real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
        real[a] += tr; imaginary[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < size; i++) { real[i] /= size; imaginary[i] /= size; }
}

// The signal with only what kept (meaningful's result) marks: each frame (HOP apart, the spectrogram's frames) is
// transformed with a MASK_WINDOW window, the bins of each kept row (its third of a semitone, and at least the bin
// nearest its pitch and the ones either side, the window's main lobe) are kept, the rest silenced, and the frames
// are added back together.
export const MASK_WINDOW = 2048;
export async function maskedSignal(signal: Float32Array, rate: number, kept: Uint8Array, frames: number,
  progress?: (share: number) => void, yieldEvery = 200): Promise<Float32Array<ArrayBuffer>> {
  const size = MASK_WINDOW, binHz = rate / size;
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  // Each row's bins.
  const lows = new Int32Array(ROWS), highs = new Int32Array(ROWS);
  for (let row = 0; row < ROWS; row++) {
    const pitch = rowPitch(row), center = Math.round(hz(pitch) / binHz);
    const half = 0.5 / ROWS_PER_SEMITONE;
    lows[row] = Math.max(1, Math.min(center - 1, Math.floor(hz(pitch - half) / binHz)));
    highs[row] = Math.min(size / 2 - 1, Math.max(center + 1, Math.ceil(hz(pitch + half) / binHz)));
  }
  const output = new Float32Array(signal.length), weight = new Float32Array(signal.length);
  const real = new Float32Array(size), imaginary = new Float32Array(size), mask = new Uint8Array(size / 2);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * HOP - size / 2;
    for (let i = 0; i < size; i++) {
      const at = start + i;
      if (at >= 0 && at < weight.length) weight[at] += window[i] * window[i];
    }
    mask.fill(0);
    let any = false;
    for (let row = 0; row < ROWS; row++) {
      if (kept[frame * ROWS + row]) { mask.fill(1, lows[row], highs[row] + 1); any = true; }
    }
    if (any) {
      for (let i = 0; i < size; i++) {
        const at = start + i;
        real[i] = at >= 0 && at < signal.length ? signal[at] * window[i] : 0;
        imaginary[i] = 0;
      }
      fft(real, imaginary, false);
      for (let bin = 0; bin <= size / 2; bin++) {
        const keep = bin < size / 2 && mask[bin] ? 1 : 0;
        real[bin] *= keep; imaginary[bin] *= keep;
        // The mirrored half, so the result stays real.
        if (bin > 0 && bin < size / 2) { real[size - bin] = real[bin]; imaginary[size - bin] = -imaginary[bin]; }
      }
      fft(real, imaginary, true);
      for (let i = 0; i < size; i++) {
        const at = start + i;
        if (at >= 0 && at < output.length) output[at] += real[i] * window[i];
      }
    }
    if (frame % yieldEvery === yieldEvery - 1) {
      progress?.(frame / frames);
      await new Promise(resolve => setTimeout(resolve));
    }
  }
  for (let i = 0; i < output.length; i++) output[i] = weight[i] > 1e-3 ? output[i] / weight[i] : 0;
  progress?.(1);
  return output;
}
