export const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const CHORD_NAMES = ['N', ...PITCHES.flatMap(name => [name, `${name}m`])];

function spectrum(samples, start) {
  const size = 4096;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    real[i] = (samples[start + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
  }
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let length = 2; length <= size; length *= 2) {
    const angle = -2 * Math.PI / length;
    for (let start = 0; start < size; start += length) {
      let wr = 1, wi = 0;
      for (let i = 0; i < length / 2; i++) {
        const a = start + i, b = a + length / 2;
        const tr = wr * real[b] - wi * imaginary[b];
        const ti = wr * imaginary[b] + wi * real[b];
        real[b] = real[a] - tr;
        imaginary[b] = imaginary[a] - ti;
        real[a] += tr;
        imaginary[a] += ti;
        const next = wr * Math.cos(angle) - wi * Math.sin(angle);
        wi = wr * Math.sin(angle) + wi * Math.cos(angle);
        wr = next;
      }
    }
  }
  return real.map((value, i) => Math.hypot(value, imaginary[i]));
}

export function detectChord(chroma, energy) {
  if (energy < 0.000005) return { chord: 'N', confidence: 0 };
  const ranked = [];
  const total = chroma.reduce((sum, value) => sum + value, 0);
  if (total === 0) return { chord: 'N', confidence: 0 };
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const notes = [root, (root + (minor ? 3 : 4)) % 12, (root + 7) % 12];
      const score = notes.reduce((sum, note) => sum + chroma[note], 0) / total;
      ranked.push({ chord: PITCHES[root] + (minor ? 'm' : ''), score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return { chord: ranked[0].chord, confidence: Math.min(1, (ranked[0].score - ranked[1].score) * 8) };
}

export function analyzeHarmony(samples, sampleRate, duration, tempo, progress = () => {}) {
  const segment = 4 * 60 / tempo;
  const chords = [];
  for (let start = 0; start < duration; start += segment) {
    const end = Math.min(duration, start + segment);
    const chroma = new Float64Array(12);
    let energy = 0, count = 0;
    for (let time = start; time < end; time += 0.25) {
      const index = Math.floor(time * sampleRate);
      const bins = spectrum(samples, index);
      for (let bin = 20; bin < bins.length / 2; bin++) {
        const frequency = bin * sampleRate / bins.length;
        if (frequency < 65 || frequency > 2000) continue;
        const midi = 69 + 12 * Math.log2(frequency / 440);
        if (Math.abs(midi - Math.round(midi)) > 0.35) continue;
        chroma[((Math.round(midi) % 12) + 12) % 12] += bins[bin] / Math.sqrt(frequency);
      }
      for (let i = index; i < Math.min(samples.length, index + 2048); i++) {
        energy += samples[i] * samples[i];
        count++;
      }
    }
    const detected = detectChord(chroma, count ? energy / count : 0);
    const previous = chords.at(-1);
    if (previous?.chord === detected.chord) {
      previous.end = end;
      previous.confidence = Math.min(previous.confidence, detected.confidence);
    } else chords.push({ start, end, ...detected });
    progress(end / duration);
  }
  return chords;
}
