// Live accompaniment: parts played from the song's score instead of a recording. The rhythm parts strike every
// tone of each chord on a style's comping rhythm, steady over the chord progression; the melody + rhythm parts play
// exactly that comping with the Harmonic score's melody (its top line) on it. No chord (N.C.) is silence. Styles and sounds come from public/accompaniment/styles.json (tools/accompaniment), and the
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
// In melody + rhythm parts the melody plays at this velocity; a melody note starting within ALIGN seconds of a
// stroke sounds with it.
const MELODY_VELOCITY = 108, ALIGN = 0.07;

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
const below = (pitchClass: number, ceiling: number) => ceiling - (((ceiling - pitchClass) % 12) + 12) % 12;

// Where the Harmonic stem plays a chord: its low and high notes (10th and 90th percentile, so a stray note does
// not move the chord), from the notes starting while it lasts; null with fewer than two.
export interface Register { low: number; high: number }
export function registerOf(notes: HarmonyNote[], start: number, end: number): Register | null {
  const pitches = notes.filter(note => note.start >= start - 0.05 && note.start < end).map(note => note.pitch).sort((a, b) => a - b);
  if (pitches.length < 2) return null;
  return { low: pitches[Math.floor(0.1 * (pitches.length - 1))], high: pitches[Math.ceil(0.9 * (pitches.length - 1))] };
}

const RANGE: Record<Family, [number, number]> = { guitar: [40, 84], keys: [28, 96] };

// Every chord tone, spread as the instrument plays it, with the bass (or slash bass) at the bottom.
// With a register, the chord sits where the Harmonic stem played it: a high chord high, a low chord low. The
// bass goes near the stem's low note (keys: an octave under it, for the left hand), every chord tone in the
// octave under its high note, and the gap between them is filled (guitar: the root or fifth; keys: the bass's
// octave). Without one: guitar like an open-position strum, the bass on a low string, the chord tones in the
// octave above and the root again on top; keys the bass and its octave in the left hand, the chord tones close
// together in the right.
export function voicing(name: string, family: Family, register?: Register | null): number[] {
  const chord = chordTones(name);
  if (!chord) return [];
  if (register) {
    const [floor, ceiling] = RANGE[family];
    const low = Math.min(Math.max(register.low, floor), ceiling - 12);
    const high = Math.min(Math.max(register.high, low + 12), ceiling);
    const bass = above(chord.bass, Math.max(floor, family === 'keys' ? low - 12 : low - 2));
    const upper = [...new Set(chord.tones.map(tone => {
      const pitch = below(tone, high);
      return pitch > bass + 2 ? pitch : pitch + 12;
    }).filter(pitch => pitch <= ceiling))].sort((a, b) => a - b);
    const fill: number[] = [];
    if (upper.length && upper[0] - bass > 12) {
      const middle = family === 'guitar' ? above(chord.root, bass + 5) : bass + 12;
      if (middle < upper[0] - 2) fill.push(middle);
      const fifth = above((chord.root + 7) % 12, (fill[0] ?? bass) + 3);
      if (family === 'guitar' && fifth < upper[0] - 2 && upper.length + fill.length < 5) fill.push(fifth);
    }
    return [bass, ...fill, ...upper];
  }
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

interface Strike { time: number; end: number; velocity: number }

// The style's strokes over the song's bars, each lasting its length or until the next.
function styleStrikes(grid: HarmonyGrid, pattern: Stroke[][]): Strike[] {
  const bars = Math.floor((grid.beats.length - grid.firstBar) / 4);
  const strokes: { beat: number; length: number; velocity: number }[] = [];
  for (let bar = 0; bar < bars && pattern.length; bar++) {
    for (const [beat, length, velocity] of pattern[bar % pattern.length]) {
      strokes.push({ beat: grid.firstBar + bar * 4 + beat, length, velocity });
    }
  }
  return strokes.map((stroke, index) => ({
    time: beatTime(grid.beats, stroke.beat), velocity: stroke.velocity,
    end: beatTime(grid.beats, Math.min(stroke.beat + stroke.length, strokes[index + 1]?.beat ?? Infinity)),
  }));
}

// The score's chords (notes starting together, on one sixteenth or spread as a strum), when the stem played them.
function chordsOf(notes: HarmonyNote[]): HarmonyNote[][] {
  const groups: HarmonyNote[][] = [];
  let first = -Infinity, previous = -Infinity;
  for (const note of [...notes].sort((a, b) => a.start - b.start || a.unit - b.unit)) {
    const group = groups[groups.length - 1];
    // Within CHORD_SPREAD of the note before, up to twice that from the chord's first, as a strum spreads them.
    if (group && (note.unit === group[0].unit || (note.start - previous <= CHORD_SPREAD && note.start - first <= 2 * CHORD_SPREAD))) {
      group.push(note);
    } else {
      groups.push([note]);
      first = note.start;
    }
    previous = note.start;
  }
  return groups;
}

// The style's strokes, each voiced with every tone of the chord playing at that moment.
export function comping(part: HarmonyPart, grid: HarmonyGrid, pattern: Stroke[][], family: Family): NoteEvent[] {
  const chords = [...part.chords].sort((a, b) => a.start - b.start);
  const strikes = styleStrikes(grid, pattern);
  // A rest (no chord) also stops what is ringing.
  const rests = chords.filter(chord => !chordTones(chord.name)).map(chord => chord.start);
  // Each chord's register, read once from the score's notes while it lasts.
  const registers = new Map<number, Register | null>();
  const registerAt = (time: number) => {
    let index = -1;
    for (let at = 0; at < chords.length && chords[at].start <= time + 0.05; at++) index = at;
    if (index < 0) return null;
    if (!registers.has(index)) registers.set(index, registerOf(part.notes, chords[index].start, chords[index + 1]?.start ?? Infinity));
    return registers.get(index)!;
  };
  const events: NoteEvent[] = [];
  for (const { time, end: until, velocity } of strikes) {
    const end = Math.min(until, rests.find(start => start > time + 0.05) ?? Infinity);
    const name = chordAt(chords, time);
    if (!name) continue;
    voicing(name, family, registerAt(time)).forEach((pitch, string) => {
      // A strum rolls from the low string up.
      const offset = family === 'guitar' ? string * 0.008 : 0;
      events.push({ time: time + offset, duration: Math.max(0.05, end - time - offset), pitch, velocity });
    });
  }
  return events;
}

// The same pitch again within this many seconds of the note's end is the same note held, not a new attack.
const JOIN_GAP = 0.12;
// Upper and lower notes starting within this many seconds of each other are one chord, as a strum spreads them.
const CHORD_SPREAD = 0.07;

// The melody: the top note of each chord the score writes (notes starting together, on one sixteenth or spread
// as a strum), with the same pitch repeated back to back joined into one held note.
export function melodyLine(notes: HarmonyNote[]): HarmonyNote[] {
  const tops = chordsOf(notes).map(group => {
    const top = group.reduce((best, note) => note.pitch > best.pitch ? note : best);
    return { ...top, start: group[0].start, unit: group[0].unit };
  });
  const joined: HarmonyNote[] = [];
  for (const note of tops) {
    const last = joined[joined.length - 1];
    if (last && last.pitch === note.pitch && note.start <= last.end + JOIN_GAP) {
      joined[joined.length - 1] = { ...last, end: Math.max(last.end, note.end), length: note.unit + note.length - last.unit };
    } else joined.push(note);
  }
  return joined;
}

const line = (notes: HarmonyNote[], velocity: number): NoteEvent[] => notes.map(note => ({
  time: note.start, duration: Math.max(0.08, note.end - note.start), pitch: note.pitch, velocity,
}));

// Melody + rhythm: the rhythm part's comping as it is, with the melody on it. A melody note close to a stroke
// sounds with it, and takes over a stroke's note of the same pitch rather than doubling it.
export function withMelody(comped: NoteEvent[], notes: HarmonyNote[]): NoteEvent[] {
  const strokes = [...new Set(comped.map(event => event.time))].sort((a, b) => a - b);
  const melody = line(notes, MELODY_VELOCITY).map(event => {
    const nearest = strokes.reduce((best, time) => Math.abs(time - event.time) < Math.abs(best - event.time) ? time : best, Infinity);
    return Math.abs(nearest - event.time) <= ALIGN ? { ...event, time: nearest, duration: event.duration + event.time - nearest } : event;
  });
  const doubled = (event: NoteEvent) => melody.some(note => note.pitch === event.pitch && Math.abs(note.time - event.time) <= ALIGN);
  return [...comped.filter(event => !doubled(event)), ...melody];
}

// Every note of a part, in song seconds, moved by the key change.
export function accompanimentEvents(kind: AccompanimentKind, part: HarmonyPart, grid: HarmonyGrid, pattern: Stroke[][], semitones = 0): NoteEvent[] {
  const family = familyOf(kind);
  const comped = comping(part, grid, pattern, family);
  const events = kind.endsWith('rhythm') ? comped : withMelody(comped, melodyLine(part.notes));
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
