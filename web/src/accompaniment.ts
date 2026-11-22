// Live accompaniment: parts played from the song's score instead of a recording. The rhythm parts strike every
// tone of each chord on a style's comping rhythm; the melody + chords parts play the Harmonic score as written:
// every chord tone the guitars and keys were heard playing. No chord (N.C.) is silence for both. Styles and sounds come from public/accompaniment/styles.json (tools/accompaniment), and the
// analysis ranks them for the song (backend/accompaniment.py). Pure functions only, so they can be unit-tested.
import type { HarmonyGrid, HarmonyNote, HarmonyPart } from './services';

export type AccompanimentKind = 'guitar-rhythm' | 'keys-rhythm' | 'guitar-melody' | 'keys-melody';
export type Family = 'guitar' | 'keys';
export const ACCOMPANIMENT_KINDS: readonly AccompanimentKind[] = ['guitar-rhythm', 'keys-rhythm', 'guitar-melody', 'keys-melody'];
export const familyOf = (kind: AccompanimentKind): Family => kind.startsWith('guitar') ? 'guitar' : 'keys';

// [beat in the bar, length in beats, velocity] per stroke; eight bars per style, repeated.
export type Stroke = [number, number, number];
export interface StyleLibrary {
  groups: Record<string, { styles: string[]; guitar: number[]; keys: number[] }>;
  styles: Record<string, Record<Family, Stroke[][]>>;
  sounds: Record<string, { name: string; family: Family }>;
  samples: { rate: number; pitches: number[]; slot: number; length: number };
}
// The analysis's choices for a song, closest first.
export interface AccompanimentChoices {
  genre: string;
  genres?: [string, number][];
  guitar: { styles: string[]; sounds: number[] };
  keys: { styles: string[]; sounds: number[] };
}
export interface NoteEvent { time: number; duration: number; pitch: number; velocity: number }

const PITCH_CLASS: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11, Fb: 4, 'E#': 5, 'B#': 0,
};
const INTERVALS: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7],
  add9: [0, 4, 7, 2], madd9: [0, 3, 7, 2], dim: [0, 3, 6], aug: [0, 4, 8], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '9': [0, 4, 7, 10, 2],
  m9: [0, 3, 7, 10, 2], maj9: [0, 4, 7, 11, 2], '7sus4': [0, 5, 7, 10], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], '5': [0, 7],
};
const CHORD = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/;

// Root, every chord tone and the bass, as pitch classes; null for no chord.
export function chordTones(name: string): { root: number; tones: number[]; bass: number } | null {
  const match = CHORD.exec(name);
  if (!match || PITCH_CLASS[match[1]] === undefined) return null;
  const root = PITCH_CLASS[match[1]], quality = match[2];
  const intervals = INTERVALS[quality] ?? (quality.startsWith('m') && !quality.startsWith('maj') ? INTERVALS.m : INTERVALS['']);
  return { root, tones: intervals.map(step => (root + step) % 12), bass: match[3] ? PITCH_CLASS[match[3]] ?? root : root };
}

const above = (pitchClass: number, floor: number) => floor + (((pitchClass - floor) % 12) + 12) % 12;

// Every chord tone, spread as the instrument plays it, with the bass (or slash bass) at the bottom.
// Guitar: like an open-position strum, the bass on a low string, the chord tones in the octave above and the root
// again on top. Keys: the bass and its octave in the left hand, the chord tones close together in the right.
export function voicing(name: string, family: Family): number[] {
  const chord = chordTones(name);
  if (!chord) return [];
  if (family === 'guitar') {
    const low = above(chord.bass, 40);
    const notes = [low, ...chord.tones.map(tone => above(tone, low + 5)).sort((a, b) => a - b)];
    const top = above(chord.root, notes[notes.length - 1] + 1);
    if (notes.length < 6 && top <= 76) notes.push(top);
    return notes;
  }
  const low = above(chord.bass, 36);
  return [low, low + 12, ...chord.tones.map(tone => above(tone, 60)).sort((a, b) => a - b)];
}

// Song seconds at a (fractional) beat, extrapolating past the ends.
export function beatTime(beats: number[], beat: number): number {
  const last = beats.length - 1;
  if (beat <= 0) return beats[0] + beat * (beats[1] - beats[0]);
  if (beat >= last) return beats[last] + (beat - last) * (beats[last] - beats[last - 1]);
  const index = Math.floor(beat);
  return beats[index] + (beat - index) * (beats[index + 1] - beats[index]);
}

function chordAt(chords: { start: number; name: string }[], time: number): string | null {
  let current: string | null = null;
  for (const chord of chords) {
    if (chord.start <= time + 0.05) current = chord.name;
    else break;
  }
  return current;
}

// The style's strokes over the song's bars, each voiced with every tone of the chord playing at that moment.
export function comping(part: HarmonyPart, grid: HarmonyGrid, pattern: Stroke[][], family: Family, strength = 1): NoteEvent[] {
  const chords = [...part.chords].sort((a, b) => a.start - b.start);
  const bars = Math.floor((grid.beats.length - grid.firstBar) / 4);
  const strokes: { beat: number; length: number; velocity: number }[] = [];
  for (let bar = 0; bar < bars && pattern.length; bar++) {
    for (const [beat, length, velocity] of pattern[bar % pattern.length]) {
      strokes.push({ beat: grid.firstBar + bar * 4 + beat, length, velocity });
    }
  }
  const events: NoteEvent[] = [];
  strokes.forEach((stroke, index) => {
    const next = strokes[index + 1]?.beat ?? Infinity;
    const time = beatTime(grid.beats, stroke.beat);
    const end = beatTime(grid.beats, Math.min(stroke.beat + stroke.length, next));
    const name = chordAt(chords, time);
    if (!name) return;
    voicing(name, family).forEach((pitch, string) => {
      // A strum rolls from the low string up.
      const offset = family === 'guitar' ? string * 0.008 : 0;
      events.push({ time: time + offset, duration: Math.max(0.05, end - time - offset), pitch, velocity: Math.min(127, Math.round(stroke.velocity * strength)) });
    });
  });
  return events;
}

const line = (notes: HarmonyNote[] | undefined, velocity: number): NoteEvent[] => (notes ?? []).map(note => ({
  time: note.start, duration: Math.max(0.08, note.end - note.start), pitch: note.pitch, velocity,
}));

// Every note of a part, in song seconds, moved by the key change.
export function accompanimentEvents(kind: AccompanimentKind, part: HarmonyPart, grid: HarmonyGrid, pattern: Stroke[][], semitones = 0): NoteEvent[] {
  const family = familyOf(kind);
  // Older scores have a melody and a second line instead of every chord tone; the second line plays softer.
  const events = kind.endsWith('rhythm') ? comping(part, grid, pattern, family) : [...line(part.notes, 100), ...line(part.second, 76)];
  return events.map(event => ({ ...event, pitch: event.pitch + semitones })).sort((a, b) => a.time - b.time);
}

// The sample nearest a pitch and how fast to play it: samples are three semitones apart.
export function sampleFor(pitches: number[], pitch: number): { index: number; rate: number } {
  let index = 0;
  for (let i = 1; i < pitches.length; i++) if (Math.abs(pitches[i] - pitch) < Math.abs(pitches[index] - pitch)) index = i;
  return { index, rate: 2 ** ((pitch - pitches[index]) / 12) };
}

// What to offer: the song's ranked styles and sounds (its genre's group), or a group's own order without them.
export function offered(library: StyleLibrary, choices: AccompanimentChoices | undefined, family: Family): { styles: string[]; sounds: number[] } {
  const group = library.groups[choices?.genre ?? 'pop'] ?? library.groups.pop;
  const ranked = choices?.[family];
  const styles = (ranked?.styles.length ? ranked.styles : group.styles).filter(name => library.styles[name]);
  const sounds = (ranked?.sounds.length ? ranked.sounds : group[family]).filter(sound => library.sounds[String(sound)]);
  // Every other sound of the family stays reachable after the group's.
  const rest = Object.entries(library.sounds).filter(([id, sound]) => sound.family === family && !sounds.includes(Number(id))).map(([id]) => Number(id));
  return { styles, sounds: [...sounds, ...rest] };
}
