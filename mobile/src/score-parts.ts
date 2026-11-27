// The song's scores played: the Harmonic score on guitar and on keys, the bass part on a bass, the drum part on a kit,
// each in a sampled sound from the website's library. Each part is made on the server as a stem in the chosen sound
// (backend/score-render.mjs; the closest one when the score is laid) and played with the stems (player.ts).
import { Directory, File, Paths } from 'expo-file-system';
import type { HarmonyGrid, HarmonyNote, HarmonyPart } from './api';

export type Family = 'guitar' | 'keys' | 'bass' | 'drums';
export const SCORE_FAMILIES: readonly Family[] = ['guitar', 'keys', 'bass', 'drums'];
// The stem whose score each family plays.
export const FAMILY_STEM: Record<Family, 'other' | 'bass' | 'drums'> = { guitar: 'other', keys: 'other', bass: 'bass', drums: 'drums' };
const LIBRARY_URL = 'https://tunesbasis.com/accompaniment';

export interface Samples { rate: number; pitches: number[]; slot: number; length: number }
export interface SoundLibrary {
  groups: Record<string, Partial<Record<Family, number[]>> & { styles: string[] }>;
  sounds: Record<string, { name: string; family: Family }>;
  samples: Samples;
  // The basses' notes are on lower pitches; a kit's slots are its drums (DRUM_ORDER), pitch i being drum i.
  layouts?: Partial<Record<'bass' | 'drums', Samples>>;
}
// The song's analysis's choice of sounds for it, closest first (backend/accompaniment.py).
export type SoundChoices = { genre: string; closest?: 'guitar' | 'keys' } & Partial<Record<Family, { sounds: number[] }>>;
export interface NoteEvent { time: number; duration: number; pitch: number; velocity: number }

let library: Promise<SoundLibrary> | undefined;
// Asked for afresh each run of the app: sounds are added to the library.
export function loadLibrary(): Promise<SoundLibrary> {
  library ??= fetch(`${LIBRARY_URL}/styles.json`, { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error(`Sounds request failed (HTTP ${response.status}).`);
    return await response.json() as SoundLibrary;
  });
  library.catch(() => { library = undefined; });
  return library;
}

// A part made on the server, kept on the phone by its rendering's id (a rendering never changes).
export async function renderedFile(id: string, url: string): Promise<string> {
  const folder = new Directory(Paths.cache, 'renderings');
  folder.create({ idempotent: true, intermediates: true });
  const file = new File(folder, `${id}.m4a`);
  if (!file.exists) await File.downloadFileAsync(url, file, { idempotent: true });
  return file.uri;
}

// The sounds offered for a family: the song's ranked ones first, then the genre group's, then every other.
export function offered(sounds: SoundLibrary, choices: SoundChoices | undefined, family: Family): number[] {
  const group = sounds.groups[choices?.genre ?? 'pop'] ?? sounds.groups.pop;
  const ranked = (choices?.[family]?.sounds?.length ? choices[family]!.sounds : group?.[family] ?? []).filter(sound => sounds.sounds[String(sound)]);
  const rest = Object.entries(sounds.sounds).filter(([id, sound]) => sound.family === family && !ranked.includes(Number(id))).map(([id]) => Number(id));
  return [...ranked, ...rest];
}

const velocityOf = (note: HarmonyNote) => note.velocity ?? 90;
// Every note of the part as played (not its sung line, which is the vocals'); moved by the key change.
export function scoreEvents(part: HarmonyPart, semitones: number): NoteEvent[] {
  return part.notes.map(note => ({
    time: note.start, duration: Math.max(0.05, note.end - note.start), pitch: note.pitch + semitones, velocity: velocityOf(note),
  })).sort((a, b) => a.time - b.time);
}

// A drum part's hits as notes for a kit: each drum is its slot, held as its sound rings (a cymbal longest), as loud
// as a drummer plays it (as the website's drumEvents).
export const DRUM_ORDER = ['kick', 'snare', 'tom', 'hihat', 'cymbal'] as const;
const DRUM_PLAY: Record<string, { duration: number; velocity: number }> = {
  kick: { duration: 0.6, velocity: 110 }, snare: { duration: 0.6, velocity: 105 }, tom: { duration: 0.8, velocity: 100 },
  hihat: { duration: 0.3, velocity: 80 }, cymbal: { duration: 2.5, velocity: 100 },
};
const beatTime = (beats: number[], beat: number) => {
  const index = Math.max(0, Math.min(beats.length - 2, Math.floor(beat)));
  return beats[index] + (beat - index) * (beats[index + 1] - beats[index]);
};
export function drumEvents(part: HarmonyPart, grid: HarmonyGrid): NoteEvent[] {
  return (part.hits ?? []).filter(hit => DRUM_PLAY[hit.drum]).map(hit => ({
    time: beatTime(grid.beats, hit.unit / 4), duration: DRUM_PLAY[hit.drum].duration,
    pitch: DRUM_ORDER.indexOf(hit.drum as typeof DRUM_ORDER[number]), velocity: DRUM_PLAY[hit.drum].velocity,
  })).sort((a, b) => a.time - b.time);
}
// The notes a family plays from the song's parts (none when its part is missing): the Harmonic notes only, on guitar
// and keys too, since the sung line is the vocals', not theirs.
export function familyEvents(family: Family, parts: Partial<Record<string, HarmonyPart>>, grid: HarmonyGrid, semitones: number): NoteEvent[] | null {
  const part = parts[FAMILY_STEM[family]];
  if (!part) return null;
  const events = family === 'drums' ? drumEvents(part, grid) : scoreEvents(part, semitones);
  return events.length ? events : null;
}
