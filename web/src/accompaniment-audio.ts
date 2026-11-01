export type Instrument = 'synth' | 'acoustic-guitar' | 'electric-guitar' | 'piano';
export type PlayingStyle = 'pad' | 'strum' | 'arpeggio' | 'rhythm';
export interface ChordEvent { start: number; end: number; chord: string; confidence?: number }
export interface HarmonySource { name: string; buffer: AudioBuffer }
interface TimeSpan { start: number; end: number }
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

// `strike` groups the notes of one played chord so they vary together.
export interface NoteEvent { midi: number; start: number; duration: number; velocity: number; strike: number }
export function accompanimentNotes(chords: ChordEvent[], style: PlayingStyle, tempo: number): NoteEvent[] {
  if (!Number.isFinite(tempo) || tempo < 40 || tempo > 240) throw new Error('Tempo must be between 40 and 240 BPM.');
  const beat = 60 / tempo;
  const result: NoteEvent[] = [];
  let strike = 0;
  for (const chord of chords) {
    const notes = chordNotes(chord.chord);
    if (!notes.length) continue;
    if (style === 'pad') {
      strike++;
      for (const midi of notes) result.push({ midi, start: chord.start, duration: chord.end - chord.start, velocity: 0.13, strike });
      continue;
    }
    const step = style === 'arpeggio' ? beat / 2 : beat;
    for (let start = chord.start, index = 0; start < chord.end - 0.001; start += step, index++) {
      strike++;
      if (style === 'arpeggio') {
        result.push({ midi: notes[index % notes.length], start,
          duration: Math.min(step * 1.5, chord.end - start), velocity: 0.24, strike });
      } else {
        for (let i = 0; i < notes.length; i++) {
          const time = start + (style === 'strum' ? i * 0.025 : 0);
          if (time < chord.end) result.push({ midi: notes[i], start: time,
            duration: Math.min(beat * 0.85, chord.end - time), velocity: 0.13, strike });
        }
      }
    }
  }
  return result;
}

export async function loadInstrument(
  instrument: Instrument, context: BaseAudioContext, signal: AbortSignal,
): Promise<Map<number, AudioBuffer>> {
  const buffers = new Map<number, AudioBuffer>();
  if (instrument === 'synth') return buffers;
  const response = await fetch(`/instruments/${instrument}.json`, { signal });
  if (!response.ok) throw new Error(`Instrument samples could not load (HTTP ${response.status}).`);
  const samples: unknown = await response.json();
  if (!samples || typeof samples !== 'object') throw new Error('Invalid instrument sample map.');
  for (const [note, value] of Object.entries(samples)) {
    signal.throwIfAborted();
    if (typeof value !== 'string' || !value.startsWith('data:audio/mp3;base64,')) {
      throw new Error('Invalid instrument sample data.');
    }
    const binary = atob(value.slice(value.indexOf(',') + 1));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    buffers.set(Number(note), await context.decodeAudioData(bytes.buffer));
  }
  if (buffers.size !== 37) throw new Error('Instrument samples are incomplete.');
  return buffers;
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

export const MAX_TIMING_VARIATION = 0.01;
export function humanizeNotes(notes: NoteEvent[], random: () => number): NoteEvent[] {
  const variation = (): number => (random() * 2 - 1) * MAX_TIMING_VARIATION;
  const strikes = new Map<number, { onset: number; length: number }>();
  return notes.map(note => {
    let choice = strikes.get(note.strike);
    if (!choice) { choice = { onset: variation(), length: variation() }; strikes.set(note.strike, choice); }
    return { ...note, start: Math.max(0, note.start + choice.onset * note.duration),
      duration: note.duration * (1 + choice.length) };
  });
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
  notes: NoteEvent[], instrument: Instrument, samples: Map<number, AudioBuffer>, duration: number, offset: number,
  shape: (channels: Float32Array[], sampleRate: number) => void,
): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, Math.round(duration * 44100), 44100);
  for (const note of notes) {
    const start = Math.max(0, note.start - offset);
    const remaining = note.start + note.duration - offset;
    if (remaining <= 0 || note.start >= offset + duration) continue;
    const length = Math.min(remaining - start, duration - start);
    if (length <= 0) continue;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(note.velocity, start + Math.min(0.02, length / 3));
    gain.gain.setValueAtTime(note.velocity, start + Math.max(length / 3, length - 0.08));
    gain.gain.linearRampToValueAtTime(0, start + length);
    gain.connect(context.destination);
    if (instrument === 'synth') {
      const oscillator = context.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
      oscillator.connect(gain);
      oscillator.start(start);
      oscillator.stop(start + length);
    } else {
      const buffer = samples.get(note.midi);
      if (!buffer) throw new Error(`Missing instrument note ${note.midi}.`);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(start, Math.min(Math.max(0, offset - note.start), Math.max(0, buffer.duration - 0.01)));
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
