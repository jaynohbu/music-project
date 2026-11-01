export type Instrument = 'synth' | 'acoustic-guitar' | 'electric-guitar' | 'piano';
export type PlayingStyle = 'pad' | 'strum' | 'arpeggio' | 'rhythm';
export interface ChordEvent { start: number; end: number; chord: string; confidence?: number }
export interface HarmonySource { name: string; buffer: AudioBuffer }
interface TimeSpan { start: number; end: number }
export interface InstrumentSample { buffer: AudioBuffer; onset: number; gain: number }
export interface InstrumentSamples { layers: Map<number, InstrumentSample>[] }
const INSTRUMENT_FILES: Record<Exclude<Instrument, 'synth'>, string> = {
  piano: 'salamander-piano-v1',
  'acoustic-guitar': 'musyngkite-acoustic-guitar-v1',
  'electric-guitar': 'musyngkite-electric-guitar-v1',
};
export const INSTRUMENTS: readonly { id: Instrument; label: string }[] = [
  { id: 'synth', label: 'Warm synth' }, { id: 'acoustic-guitar', label: 'Acoustic guitar' },
  { id: 'electric-guitar', label: 'Clean electric guitar' }, { id: 'piano', label: 'Piano' },
];
export const CHORD_NAMES = ['N', ...['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  .flatMap(name => [name, `${name}m`])];
export const STYLE_LABELS: Record<PlayingStyle, string> = {
  pad: 'Sustained chords', strum: 'Strumming', arpeggio: 'Arpeggio', rhythm: 'Rhythmic chords',
};
export function stylesFor(instrument: Instrument): PlayingStyle[] {
  return instrument.endsWith('guitar') ? ['strum', 'arpeggio', 'rhythm'] : ['pad', 'arpeggio', 'rhythm'];
}

export function downsampleSources(sources: HarmonySource[], duration: number): Float32Array {
  if (!sources.length) throw new Error('Select at least one harmonic stem.');
  const rate = 11025;
  const mixed = new Float32Array(Math.ceil(duration * rate));
  for (const { buffer } of sources) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const input = buffer.getChannelData(channel);
      const scale = 1 / sources.length / buffer.numberOfChannels;
      const ratio = buffer.sampleRate / rate;
      for (let i = 0; i < mixed.length; i++) {
        const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let j = start; j < end; j++) sum += input[j];
        mixed[i] += end > start ? sum / (end - start) * scale : 0;
      }
    }
  }
  return mixed;
}

function chordNotes(chord: string): number[] {
  if (chord === 'N') return [];
  const match = /^(C#?|D#?|E|F#?|G#?|A#?|B)(m?)$/.exec(chord);
  if (!match) throw new Error(`Unsupported chord: ${chord}`);
  const root = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(match[1]);
  return [48 + root, 60 + root, 60 + root + (match[2] ? 3 : 4), 60 + root + 7];
}

export interface NoteEvent { midi: number; start: number; duration: number; velocity: number }
export function accompanimentNotes(chords: ChordEvent[], style: PlayingStyle, tempo: number): NoteEvent[] {
  if (!Number.isFinite(tempo) || tempo < 40 || tempo > 240) throw new Error('Tempo must be between 40 and 240 BPM.');
  const beat = 60 / tempo;
  const result: NoteEvent[] = [];
  for (const chord of chords) {
    const notes = chordNotes(chord.chord);
    if (!notes.length) continue;
    if (style === 'pad') {
      for (const midi of notes) result.push({ midi, start: chord.start, duration: chord.end - chord.start, velocity: 0.13 });
      continue;
    }
    const step = style === 'arpeggio' ? beat / 2 : beat;
    for (let start = chord.start, index = 0; start < chord.end - 0.001; start += step, index++) {
      if (style === 'arpeggio') {
        result.push({ midi: notes[index % notes.length], start,
          duration: Math.min(step * 1.5, chord.end - start), velocity: 0.24 });
      } else {
        for (let i = 0; i < notes.length; i++) {
          const time = start + (style === 'strum' ? i * 0.025 : 0);
          if (time < chord.end) result.push({ midi: notes[i], start: time,
            duration: Math.min(beat * 0.85, chord.end - time), velocity: 0.13 });
        }
      }
    }
  }
  return result;
}

const LOWEST_NOTE = 48, HIGHEST_NOTE = 84, FURTHEST_SAMPLE = 2;
const LEVEL_SECONDS = 0.4, LEVEL_REFERENCE = 0.1;

// Finds where a recording starts sounding and levels it, so velocity layers change
// the tone only. Loudness itself comes from the source stems.
export function measureSample(channels: Float32Array[], sampleRate: number): { onset: number; gain: number } {
  let peak = 0;
  for (const channel of channels) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  if (!peak) throw new Error('Instrument sample is silent.');
  const length = channels[0].length;
  let first = 0;
  while (first < length && channels.every(channel => Math.abs(channel[first]) < peak * 0.02)) first++;
  const end = Math.min(length, first + Math.round(LEVEL_SECONDS * sampleRate));
  let energy = 0;
  for (const channel of channels) for (let i = first; i < end; i++) energy += channel[i] * channel[i];
  const rms = Math.sqrt(energy / Math.max(1, end - first) / channels.length);
  return { onset: Math.max(0, first / sampleRate - 0.002), gain: LEVEL_REFERENCE / rms };
}

export function pickSample(
  samples: InstrumentSamples, midi: number, layer: number,
): { sample: InstrumentSample; rate: number } {
  const notes = samples.layers[Math.max(0, Math.min(samples.layers.length - 1, layer))];
  let nearest: number | undefined;
  for (const note of notes?.keys() ?? []) {
    if (nearest === undefined || Math.abs(note - midi) < Math.abs(nearest - midi)) nearest = note;
  }
  if (nearest === undefined || Math.abs(nearest - midi) > FURTHEST_SAMPLE) throw new Error(`Missing instrument note ${midi}.`);
  return { sample: notes.get(nearest)!, rate: 2 ** ((midi - nearest) / 12) };
}

export async function loadInstrument(
  instrument: Instrument, context: BaseAudioContext, signal: AbortSignal,
): Promise<InstrumentSamples> {
  if (instrument === 'synth') return { layers: [] };
  const response = await fetch(`/instruments/${INSTRUMENT_FILES[instrument]}.json`, { signal });
  if (!response.ok) throw new Error(`Instrument samples could not load (HTTP ${response.status}).`);
  const content: unknown = await response.json();
  const layers = (content as { layers?: unknown } | null)?.layers;
  if (!Array.isArray(layers) || !layers.length) throw new Error('Invalid instrument sample map.');
  const samples: InstrumentSamples = {
    layers: await Promise.all(layers.map(async (layer: unknown) => {
      if (!layer || typeof layer !== 'object') throw new Error('Invalid instrument sample map.');
      return new Map(await Promise.all(Object.entries(layer).map(async ([note, value]) => {
        signal.throwIfAborted();
        if (typeof value !== 'string' || !value.startsWith('data:audio/mp3;base64,')) {
          throw new Error('Invalid instrument sample data.');
        }
        const binary = atob(value.slice(value.indexOf(',') + 1));
        const buffer = await context.decodeAudioData(Uint8Array.from(binary, char => char.charCodeAt(0)).buffer);
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
        return [Number(note), { buffer, ...measureSample(channels, buffer.sampleRate) }] as const;
      })));
    })),
  };
  // Throws if any playable note has no recording close enough.
  samples.layers.forEach((_, layer) => {
    for (let midi = LOWEST_NOTE; midi <= HIGHEST_NOTE; midi++) pickSample(samples, midi, layer);
  });
  return samples;
}

// Seeded so a preview and the saved render make the same random choices.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export const MIN_TIMING_VARIATION = 0.0001;
export const MAX_TIMING_VARIATION = 0.0005;
// Every note draws its own onset and length change, early or late, short or long.
export function humanizeNotes(notes: NoteEvent[], random: () => number): NoteEvent[] {
  const variation = (): number => {
    const size = MIN_TIMING_VARIATION + random() * (MAX_TIMING_VARIATION - MIN_TIMING_VARIATION);
    return random() < 0.5 ? -size : size;
  };
  return notes.map(note => ({
    ...note,
    start: Math.max(0, note.start + variation() * note.duration),
    duration: note.duration * (1 + variation()),
  }));
}

// A note crossing a region start restarts there; a short leftover would only click.
const MINIMUM_CLIPPED_NOTE = 0.12;
export function clipNotesToRegions(notes: NoteEvent[], regions: TimeSpan[]): NoteEvent[] {
  return notes.flatMap(note => regions.flatMap(region => {
    const start = Math.max(note.start, region.start), end = Math.min(note.start + note.duration, region.end);
    if (end <= start || (start > note.start && end - start < MINIMUM_CLIPPED_NOTE)) return [];
    return [{ ...note, start, duration: end - start }];
  }));
}

export function planNotes(
  chords: ChordEvent[], instrument: Instrument, style: PlayingStyle, tempo: number,
  regions: TimeSpan[], seed: number,
): NoteEvent[] {
  // Sampled piano decays naturally; re-articulate long sustained chords.
  const pianoChords = instrument === 'piano' && style === 'pad' ? chords.flatMap(chord => {
    const segments: ChordEvent[] = [];
    for (let start = chord.start; start < chord.end; start += 120 / tempo) {
      segments.push({ ...chord, start, end: Math.min(chord.end, start + 120 / tempo) });
    }
    return segments;
  }) : chords;
  return clipNotesToRegions(humanizeNotes(accompanimentNotes(pianoChords, style, tempo), seededRandom(seed)), regions);
}

export async function renderAccompaniment(
  notes: NoteEvent[], instrument: Instrument, samples: InstrumentSamples, duration: number, offset: number,
  shape: (channels: Float32Array[], sampleRate: number) => void,
  layerAt: (time: number, layers: number) => number,
): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, Math.round(duration * 44100), 44100);
  for (const note of notes) {
    const start = Math.max(0, note.start - offset);
    const remaining = note.start + note.duration - offset;
    if (remaining <= 0 || note.start >= offset + duration) continue;
    const length = Math.min(remaining - start, duration - start);
    if (length <= 0) continue;
    const picked = instrument === 'synth'
      ? undefined : pickSample(samples, note.midi, layerAt(note.start, samples.layers.length));
    const level = note.velocity * (picked?.sample.gain ?? 1);
    // Samples carry their own attack; a longer ramp would soften it.
    const attack = Math.min(picked ? 0.002 : 0.02, length / 3);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + attack);
    gain.gain.setValueAtTime(level, start + Math.max(length / 3, length - 0.08));
    gain.gain.linearRampToValueAtTime(0, start + length);
    gain.connect(context.destination);
    if (!picked) {
      const oscillator = context.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
      oscillator.connect(gain);
      oscillator.start(start);
      oscillator.stop(start + length);
    } else {
      const source = context.createBufferSource();
      source.buffer = picked.sample.buffer;
      source.playbackRate.value = picked.rate;
      source.connect(gain);
      const into = picked.sample.onset + Math.max(0, offset - note.start) * picked.rate;
      source.start(start, Math.min(into, Math.max(0, picked.sample.buffer.duration - 0.01)));
      source.stop(start + length);
    }
  }
  const rendered = await context.startRendering();
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
  for (const channel of channels) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new Error('Instrument rendering produced invalid audio.');
    }
  }
  shape(channels, rendered.sampleRate);
  return rendered;
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const bytes = new ArrayBuffer(44 + buffer.length * 4);
  const view = new DataView(bytes);
  const text = (start: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(start + i, value.charCodeAt(i));
  };
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true);
  text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true); view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, buffer.length * 4, true);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  // Only out-of-range audio is rescaled, so the saved level matches the preview.
  const scale = peak > 1 ? 0.9 / peak : 1;
  for (let i = 0; i < buffer.length; i++) {
    view.setInt16(44 + i * 4, Math.round(left[i] * scale * 32767), true);
    view.setInt16(46 + i * 4, Math.round(right[i] * scale * 32767), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
