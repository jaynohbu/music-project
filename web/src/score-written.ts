// The pure parts of the score check (score-check.ts): an uploaded score as printed, made a part on a grid of its own
// to draw and play, and the notes of the part laid on the song. No Angular, so they can be unit-tested.
import type { HarmonyGrid, HarmonyPart, ScorePartName } from './services';
import { type NoteEvent, drumEvents, playedNotes } from './accompaniment';
import type { Score } from './musicxml';

// Major keys by the signature's fifths (−7 to 7), and their relative minors.
const MAJOR = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MINOR = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'];
export function writtenKey(musicxml: string): string | undefined {
  const fifths = Number(/<fifths>\s*(-?\d+)\s*<\/fifths>/.exec(musicxml)?.[1]);
  if (!Number.isInteger(fifths) || fifths < -7 || fifths > 7) return undefined;
  return (/<mode>\s*minor\s*<\/mode>/.test(musicxml) ? MINOR : MAJOR)[fifths + 7];
}

const WRITTEN_VELOCITY = 90;
// The score as printed (no repeats taken), as a part on a grid of its own at `qpm` quarters a minute: its notes
// (every part's, the sung line among them) or its drum hits, and its printed chords; with its notes to play.
export function writtenPart(score: Score, part: ScorePartName, qpm: number, key: string | undefined,
  chordName: (chord: { root: number; quality: string; bass: number }, key?: string) => string): { part: HarmonyPart; grid: HarmonyGrid; events: NoteEvent[]; seconds: number } {
  const quarter = 60 / qpm;
  const last = score.measures.at(-1), total = last ? last.start + last.length : 0;
  const beats = Array.from({ length: Math.ceil(total) + 9 }, (_, index) => index * quarter);
  // A pickup measure (shorter than its time signature) is a bar of its own before the first.
  const first = score.measures[0];
  const pickup = first && first.length < first.beats * 4 / first.beatType - 1e-6 ? Math.max(0, Math.round(first.length)) : 0;
  const grid = { beats, firstBar: pickup };
  if (part === 'drums') {
    const hits = (score.hits ?? []).map(hit => ({ unit: Math.round(hit.start * 4), drum: hit.drum }));
    return { part: { chords: [], notes: [], hits }, grid, events: drumEvents(hits, grid), seconds: total * quarter + 2 };
  }
  const notes = score.notes.map(note => ({
    start: note.start * quarter, end: (note.start + note.length) * quarter, pitch: note.pitch,
    unit: Math.round(note.start * 4), length: Math.max(1, Math.round(note.length * 4)), velocity: WRITTEN_VELOCITY,
  })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const chords = score.chords.map(chord => ({ start: chord.start * quarter, name: chordName(chord, key) }));
  return { part: { chords, notes, ...(part === 'other' && key ? { key } : {}) }, grid, events: playedNotes(notes), seconds: total * quarter + 2 };
}

// The notes of the part laid on the song, as played.
export function laidEvents(check: { part: ScorePartName; laid: HarmonyPart; grid: HarmonyGrid }): NoteEvent[] {
  return check.part === 'drums' ? drumEvents(check.laid.hits ?? [], check.grid) : playedNotes(check.laid.notes).sort((a, b) => a.time - b.time);
}

export const percent = (value?: number) => value === undefined ? '–' : `${Math.round(value * 100)}%`;
