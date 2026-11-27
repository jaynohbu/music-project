// A score (musicxml.ts) laid on the recording: where each of its measures is in the song, and the Harmonic (other)
// stem restored from it, every score note the stem really plays at the moment, pitch and loudness it plays it.
//
// Alignment compares the score with all stems. Each stem's spectrogram (spectrogram.ts) is folded into a chroma
// (how much of each of the twelve pitch classes sounds, plus how quiet it is) every FEATURE_FRAMES frames, and its
// onsets (rises in level) are found; the score is drawn the same way at a guessed tempo. Dynamic time warping finds
// the cheapest way through the song that plays the whole score once, starting and ending anywhere, its tempo free to
// drift between half and twice the guess. The key the score is written in may differ from the song's: the pitch
// classes are tried moved by every semitone (the likeliest two by the chroma over the whole stretch), and tempos
// from the score's marking and the song's beats. The first pass compares the score with the pitched stems
// together; each part (each staff of each score part) is then given to the stem it sounds like most along that
// path (a melody to the vocals, a bass clef to the bass), and the second pass compares each stem with only its own
// parts. Measure starts are then put on the song's beats where one is near, and the beats inside a measure are the
// song's own when as many fall in it as the measure has.
//
// The restoration then looks at the other stem alone: a score note is kept where the stem has its pitch (or an
// octave either side, much louder) standing above that pitch's usual level while the note lasts; its start is the
// stem's own attack near the written one, its end where the stem's sound dies away (no later than a little after the
// written end), its velocity from how loud the attack is; a part given to the vocals is left to them. Notes the other stem does not play are listed with the
// stems that do. Pure functions only (no DOM), so they can be unit-tested.
import { HOP, LOWEST_PITCH, ROWS, ROWS_PER_SEMITONE, type Spectrogram } from './spectrogram';
import { type Score, type ScoreChord, type ScoreHit, type ScoreMeasure, type ScoreNote, unrollRepeats } from './musicxml';
import type { DrumHit, HarmonyGrid, HarmonyNote, HarmonyPart } from './services';

export type AlignStem = 'vocals' | 'bass' | 'drums' | 'other';
export const PITCHED_STEMS: readonly AlignStem[] = ['vocals', 'bass', 'other'];
export const FEATURE_FRAMES = 2;          // Spectrogram frames per feature step (about 46 ms), at the finest.
// A long score against a long song is compared on coarser steps, so the warping table stays near this many cells
// (a whole song and its whole score: steps of about 0.1 s; measures still go on the song's beats).
const MOST_CELLS = 12e6;
const LOWEST_CHROMA_PITCH = 28, HIGHEST_CHROMA_PITCH = 96;  // E1 to C7.
const COMPRESSION = 100;                  // Chroma is log(1 + COMPRESSION * level).
const QUIET = 0.15;                       // A step this share of the stem's loud steps or quieter is partly quiet.
const SILENT_DB = 45;
const SHOULDER = 0.3;                     // What a pitch that is not a peak among its neighbours counts.                     // Levels this far below a stem's loudest count as nothing.
const ONSET_WEIGHT = 0.3;                 // Cost of a score onset where nothing starts in the song.
const ONSET_LOWEST = 48;                  // C3.
const ONSET_CLEAR = 0.5;                  // An onset this strong (0 to 1) can mark a measure start.
const BEND = 0.05;                        // Cost of a step off the diagonal (a change of tempo).
const CHORD_WEIGHT = 0.4;                 // Chord symbols count this much against the notes.
const SHIFTS_TRIED = 2;
const PART_LEAST = 0.45;                  // A part goes to a stem only when it sounds this much like it.
const LAYER_NOTES = 8;                    // A staff's layer is matched on its own with at least this many notes.
const DOUBLED_LAYER = 0.6;                // A layer whose notes double the sung line this often is the vocals' too.
const SNAP = 0.35;                        // Measure starts move to a song beat within this share of a beat.
export const INTRO_SECONDS = 8;
const RIGID_BEATS = 8;                    // Beats either side of the path's start tried for the score on the beats.
const RIGID_MARGIN = 0.06;                // How much worse than the path the score on the beats may fit.
const UNCOVERED_WEIGHT = 0.4;             // Cost of a pitched stem the score has no part for playing loud.
// Restoration.
export const PRESENT_DB = 6;              // Above the pitch's usual level, for a note to be heard in the stem.
const OCTAVE_BETTER_DB = 4;               // An octave either side is taken when it is this much louder.
const FLOOR_PERCENTILE = 0.3;
const LOOK = 0.4;                         // Seconds of a note's start looked at for whether it is there.
const ATTACK_SEARCH = 0.08;               // Seconds either side of the written start searched for the stem's attack.
const ATTACK_RISE_DB = 3;
const LEAST_LENGTH = 0.06;
// Velocity from the attack's level against the stem's loudest, so the played note's level (velocity to the power 1.5)
// is the stem's: 127 at its loudest, a third of the dB below it.
const VELOCITY_LEAST = 12;
const DECAY_DB = 25;
const SPILL_DB = 24;
const LOW_OCTAVE_DB = 12;                  // A bass note's lowest octave counts when this close to its loudest.                      // Another stem this much louder at a pitch: the other stem only has its spill.

export interface StemFeatures { chroma: Float32Array; loudness: Float32Array; onsets: Float32Array; steps: number }
export interface AlignedMeasure { index: number; number: string; start: number; end: number; onBeat: boolean }
// voice: set on a layer of a staff matched on its own (one that sounds like the vocals; the staff's other layers keep
// the staff's match).
export interface PartMatch { part: number; staff: number; voice?: number; name: string; stem: AlignStem | null; likeness: Partial<Record<AlignStem, number>> }
export interface RestoredNote {
  pitch: number; start: number; end: number; velocity: number; measure: number;
  // As written (moved by the key shift), in quarter notes, and how far above its usual level each stem has it, dB.
  written: { pitch: number; start: number; length: number };
  heard: Partial<Record<AlignStem, number>>;
  octave: number;                         // Semitones moved to the octave the stem plays: -12, 0 or 12.
  // False for a score note the stem was not heard playing, filled in where the score writes it.
  found?: false;
}
// part: the stem the note's part was given to (a melody: the vocals).
export interface MissingNote { pitch: number; start: number; end: number; measure: number; stems: AlignStem[]; part?: AlignStem | null }
export interface Alignment {
  measures: AlignedMeasure[];
  shift: number;                          // Semitones the song is from the score's written key.
  secondsPerQuarter: number;              // Over the aligned stretch.
  likeness: number;                       // Mean chroma likeness along the path, 0 to 1.
  parts: PartMatch[];
  notes: RestoredNote[];
  missing: MissingNote[];
  // Song seconds at a score position (quarter notes from its start).
  timeAt(quarter: number): number;
}

const PITCH_CLASSES = 12, DIMENSIONS = PITCH_CLASSES + 1;
const rowOf = (pitch: number) => (pitch - LOWEST_PITCH) * ROWS_PER_SEMITONE;

function normalize(vectors: Float32Array, count: number): void {
  for (let step = 0; step < count; step++) {
    let sum = 0;
    for (let d = 0; d < DIMENSIONS; d++) sum += vectors[step * DIMENSIONS + d] ** 2;
    const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
    for (let d = 0; d < DIMENSIONS; d++) vectors[step * DIMENSIONS + d] *= scale;
  }
}

function percentile(values: ArrayLike<number>, share: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted.length ? sorted[Math.floor(share * (sorted.length - 1))] : 0;
}

// A stem's chroma over its first `frames` frames: `chroma` with quiet as a thirteenth component, each step of unit
// length, for comparing with the stem alone; `loudness`, its twelve pitch classes as loud as the stem plays them
// (its loud steps about 1, silence 0), for adding stems together. Levels SILENT_DB below the stem's loudest count as
// nothing, so a stem that is silent in a stretch adds nothing there. Onsets are 0 to 1.
export function stemFeatures(spectrogram: Spectrogram, frames = spectrogram.frames, per = FEATURE_FRAMES): StemFeatures {
  const steps = Math.max(1, Math.floor(Math.min(frames, spectrogram.frames) / per));
  const chroma = new Float32Array(steps * DIMENSIONS), loudness = new Float32Array(steps * PITCH_CLASSES);
  const energy = new Float32Array(steps), flux = new Float32Array(steps);
  const { levels } = spectrogram;
  const silence = Math.log1p(COMPRESSION * 10 ** (-SILENT_DB / 20));
  for (let step = 0; step < steps; step++) {
    for (let k = 0; k < per; k++) {
      const frame = step * per + k, base = frame * ROWS;
      for (let pitch = LOWEST_CHROMA_PITCH; pitch <= HIGHEST_CHROMA_PITCH; pitch++) {
        // A peak among its neighbouring semitones counts fully, the rest a little: low notes, whose windows cannot
        // tell semitones apart well, would otherwise spread over three (two notes a semitone apart are both peaks
        // only where the window tells them apart).
        const level = levels[base + rowOf(pitch)];
        const peak = level >= levels[base + rowOf(pitch - 1)] && level >= levels[base + rowOf(pitch + 1)];
        const value = (peak ? 1 : SHOULDER) * Math.max(0, Math.log1p(COMPRESSION * 10 ** (level / 20)) - silence) / per;
        loudness[step * PITCH_CLASSES + pitch % 12] += value;
        energy[step] += value;
      }
      if (frame > 0) {
        let rise = 0;
        // From C3 up only: the long windows below see a note start about a tenth of a second early.
        for (let row = rowOf(ONSET_LOWEST); row < ROWS; row++) rise += Math.max(0, levels[base + row] - levels[base - ROWS + row]);
        flux[step] += rise;
      }
    }
  }
  const loud = Math.max(percentile(energy, 0.95), 1e-9);
  for (let index = 0; index < loudness.length; index++) loudness[index] /= loud;
  for (let step = 0; step < steps; step++) {
    for (let d = 0; d < PITCH_CLASSES; d++) chroma[step * DIMENSIONS + d] = loudness[step * PITCH_CLASSES + d];
    chroma[step * DIMENSIONS + PITCH_CLASSES] = quietness(energy[step] / loud);
  }
  normalize(chroma, steps);
  const onsets = new Float32Array(steps);
  const typical = percentile(flux, 0.5), strong = Math.max(percentile(flux, 0.97), typical + 1e-9);
  for (let step = 0; step < steps; step++) onsets[step] = Math.min(1, Math.max(0, (flux[step] - typical) / (strong - typical)));
  return { chroma, loudness, onsets, steps };
}

// The quiet component for a step as loud as `share` of the loud steps: 2 in silence, 0 from QUIET up.
const quietness = (share: number) => Math.max(0, 1 - share / QUIET) * 2;

// Some stems heard together: their pitch classes added as loud as each plays them, as unit vectors with quiet.
function together(features: StemFeatures[], steps: number): Float32Array {
  const sum = new Float32Array(steps * DIMENSIONS);
  for (let step = 0; step < steps; step++) {
    let total = 0;
    for (const feature of features) {
      for (let d = 0; d < PITCH_CLASSES; d++) {
        const value = feature.loudness[step * PITCH_CLASSES + d] ?? 0;
        sum[step * DIMENSIONS + d] += value;
        total += value;
      }
    }
    sum[step * DIMENSIONS + PITCH_CLASSES] = quietness(total);
  }
  normalize(sum, steps);
  return sum;
}

// The score drawn as features at secondsPerQuarter, its pitch classes moved by shift; only the notes `include`
// takes (and the chord symbols when chords is set).
function scoreFeatures(score: Score, seconds: number, secondsPerQuarter: number, shift: number,
  include: (note: ScoreNote) => boolean, chords: boolean): { chroma: Float32Array; onsets: Float32Array; steps: number } {
  const total = score.measures.at(-1)!.start + score.measures.at(-1)!.length;
  const steps = Math.max(2, Math.ceil(total * secondsPerQuarter / seconds));
  const chroma = new Float32Array(steps * DIMENSIONS), onsets = new Float32Array(steps);
  const at = (quarter: number) => Math.min(steps - 1, Math.max(0, Math.round(quarter * secondsPerQuarter / seconds)));
  for (const note of score.notes) {
    if (!include(note)) continue;
    const from = at(note.start), to = Math.max(from + 1, at(note.start + note.length));
    const pitchClass = (((note.pitch + shift) % 12) + 12) % 12;
    // Struck notes fade: loudest at the start.
    for (let step = from; step < to; step++) chroma[step * DIMENSIONS + pitchClass] += 0.4 + 0.6 * Math.exp(-(step - from) * seconds / 1.2);
    onsets[from] = 1;
  }
  if (chords) {
    score.chords.forEach((chord, index) => {
      const next = score.chords[index + 1]?.start ?? total;
      for (let step = at(chord.start); step < at(next); step++) {
        for (const pitchClass of chord.pitchClasses) chroma[step * DIMENSIONS + (pitchClass + shift + 12) % 12] += CHORD_WEIGHT;
      }
    });
  }
  for (let step = 0; step < steps; step++) {
    let sum = 0;
    for (let d = 0; d < PITCH_CLASSES; d++) sum += chroma[step * DIMENSIONS + d];
    if (sum === 0) chroma[step * DIMENSIONS + PITCH_CLASSES] = 1;
  }
  normalize(chroma, steps);
  return { chroma, onsets, steps };
}

// Subsequence DTW: the whole score (rows) against any stretch of the song (columns). Each score step is counted once
// (steps of one score step and one or two song steps, or two score steps and one song step), so the cost does not
// favour any tempo; a step off the diagonal costs `bend` more, so where the music holds still (a long chord) the path
// keeps the tempo instead of wandering. cost(i, j) for score step i and song step j; the score starts at a song step within
// `starts`. Returns the song step of each score step and the mean cost.
export function warp(rows: number, columns: number, cost: (row: number, column: number) => number, bend = 0,
  starts: [number, number] = [0, columns - 1]): { path: Int32Array; cost: number } {
  const total = new Float32Array(rows * columns).fill(Infinity), from = new Uint8Array(rows * columns);
  const local = new Float32Array(rows * columns);
  for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) local[i * columns + j] = cost(i, j);
  for (let j = Math.max(0, starts[0]); j <= Math.min(columns - 1, starts[1]); j++) total[j] = local[j];
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < columns; j++) {
      const here = local[i * columns + j];
      let best = total[(i - 1) * columns + j - 1], step = 0;
      if (j > 1 && total[(i - 1) * columns + j - 2] + bend < best) { best = total[(i - 1) * columns + j - 2] + bend; step = 1; }
      if (i > 1) {
        const value = total[(i - 2) * columns + j - 1] + local[(i - 1) * columns + j] + bend;
        if (value < best) { best = value; step = 2; }
      }
      total[i * columns + j] = best + here;
      from[i * columns + j] = step;
    }
  }
  let end = 0;
  for (let j = 1; j < columns; j++) if (total[(rows - 1) * columns + j] < total[(rows - 1) * columns + end]) end = j;
  const path = new Int32Array(rows);
  let i = rows - 1, j = end;
  while (i >= 0) {
    path[i] = j;
    if (i === 0) break;
    const step = from[i * columns + j];
    if (step === 2) { path[i - 1] = j; i -= 2; j -= 1; } else { i -= 1; j -= step === 1 ? 2 : 1; }
    if (j < 0) j = 0;
  }
  return { path, cost: total[(rows - 1) * columns + end] / rows };
}

const dot = (a: Float32Array, i: number, b: Float32Array, j: number) => {
  let sum = 0;
  for (let d = 0; d < DIMENSIONS; d++) sum += a[i * DIMENSIONS + d] * b[j * DIMENSIONS + d];
  return sum;
};

// Tempos worth trying, seconds per quarter: the score's marking and the song's beat, its half and its double.
function tempoGuesses(score: Score, beats: number[] | undefined): number[] {
  const guesses: number[] = [];
  if (beats && beats.length > 2) {
    const gaps = beats.slice(1).map((beat, index) => beat - beats[index]).sort((a, b) => a - b);
    const beat = gaps[gaps.length >> 1];
    if (beat > 0) guesses.push(beat, beat / 2, beat * 2);
  }
  if (score.tempo) guesses.push(60 / score.tempo);
  if (!guesses.length) guesses.push(0.5);
  return guesses.filter((guess, index) => guess > 0.15 && guess < 2.5
    && guesses.slice(0, index).every(other => Math.abs(other / guess - 1) > 0.12));
}

// A line through points, evaluated at x (the points' mean when they are all at one x). Points further than
// `tolerance` from the first line (where the path wanders, as at its free start) are left out of a second.
function fitted(points: [number, number][], x: number, tolerance: number): number {
  const line = (kept: [number, number][]) => {
    const n = kept.length;
    const mx = kept.reduce((sum, [px]) => sum + px, 0) / n, my = kept.reduce((sum, [, py]) => sum + py, 0) / n;
    let sxx = 0, sxy = 0;
    for (const [px, py] of kept) { sxx += (px - mx) ** 2; sxy += (px - mx) * (py - my); }
    const slope = sxx > 1e-9 ? sxy / sxx : 0;
    return (at: number) => my + slope * (at - mx);
  };
  const first = line(points);
  const kept = points.filter(([px, py]) => Math.abs(py - first(px)) <= tolerance);
  return (kept.length >= 2 ? line(kept) : first)(x);
}

// A time as a (fractional) beat of the song's beats, and back; past the ends at the nearest beat's pace.
function beatPosition(beats: number[], time: number): number {
  let index = 0;
  while (index < beats.length - 2 && beats[index + 1] <= time) index++;
  return index + (time - beats[index]) / (beats[index + 1] - beats[index] || 0.5);
}
function timeAtBeat(beats: number[], beat: number): number {
  const index = Math.max(0, Math.min(beats.length - 2, Math.floor(beat)));
  return beats[index] + (beat - index) * (beats[index + 1] - beats[index]);
}

function interpolate(knots: [number, number][], x: number): number {
  if (knots.length === 1) return knots[0][1];
  let index = 0;
  while (index < knots.length - 2 && knots[index + 1][0] <= x) index++;
  const [x0, y0] = knots[index], [x1, y1] = knots[index + 1];
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1);
}

export interface AlignInput {
  score: Score;
  spectrograms: Partial<Record<AlignStem, Spectrogram>>;   // The other stem is needed; the rest help.
  seconds: number;                                          // How much of the song to search, from its start.
  beats?: number[];
  // The score is the song's beginning (its intro): it starts within INTRO_SECONDS of the song's first sound.
  intro?: boolean;
  // What is restored from (the other stem unless given), at the other stem's rate and frames.
  target?: RestoreTarget;
  // Every score note kept, those not heard filled in where written (alignScore; fitMeasures always does).
  fill?: boolean;
}

// The stem each note belongs to: its layer's match (a layer matched on its own first, else its staff's), and the
// vocals' for a note that doubles the sung line (the same pitch starting with a note given to the vocals, as a piano
// under a melody plays it); a layer that is mostly such doubling is the vocals' as a whole. So the sung line is left
// out of the Harmonic notes wherever the score writes it.
export function noteStems(score: Score, parts: PartMatch[]): (note: ScoreNote) => AlignStem | null {
  const matchOf = (note: ScoreNote) => parts.find(match => match.part === note.part && match.staff === note.staff && match.voice === (note.voice ?? 1))
    ?? parts.find(match => match.part === note.part && match.staff === note.staff && match.voice === undefined);
  const layerKey = (note: ScoreNote) => `${note.part}/${note.staff}/${note.voice ?? 1}`;
  const at = (note: ScoreNote) => `${note.start.toFixed(3)}/${note.pitch}`;
  const sung = new Set(score.notes.filter(note => matchOf(note)?.stem === 'vocals').map(at));
  const layers = new Map<string, { notes: number; doubled: number }>();
  for (const note of score.notes) {
    if (matchOf(note)?.stem === 'vocals') continue;
    const layer = layers.get(layerKey(note)) ?? { notes: 0, doubled: 0 };
    layer.notes++;
    if (sung.has(at(note))) layer.doubled++;
    layers.set(layerKey(note), layer);
  }
  return note => {
    const stem = matchOf(note)?.stem ?? null;
    if (stem === 'vocals' || !sung.size) return stem;
    const layer = layers.get(layerKey(note));
    return sung.has(at(note)) || (layer && layer.notes >= LAYER_NOTES && layer.doubled >= DOUBLED_LAYER * layer.notes) ? 'vocals' : stem;
  };
}

export function alignScore({ score, spectrograms, seconds, beats, intro, target, fill }: AlignInput): Alignment {
  // Measures after the last note (rests to the end of a page) match anything; they are left out.
  const lastSound = Math.max(...score.notes.map(note => note.start + note.length));
  const kept = score.measures.filter((measure, index) => index === 0 || measure.start < lastSound - 1e-6);
  if (kept.length < score.measures.length) score = { ...score, measures: kept, chords: score.chords.filter(chord => chord.start < lastSound) };
  const other = spectrograms.other;
  if (!other) throw new Error('The Harmonic stem is needed.');
  if (!score.notes.length) throw new Error('The score has no notes.');
  const frames = Math.min(other.frames, Math.ceil(seconds * other.rate / HOP));
  const stems = (Object.keys(spectrograms) as AlignStem[]).filter(stem => spectrograms[stem]!.rate === other.rate);
  // Feature steps as fine as the table allows: the score at the slowest tempo tried, against the stretch searched.
  const total = score.measures.at(-1)!.start + score.measures.at(-1)!.length;
  const guesses = tempoGuesses(score, beats), fitting = guesses.filter(guess => total * guess <= seconds);
  const slowest = Math.max(...(fitting.length ? fitting : guesses));
  const finest = FEATURE_FRAMES * HOP / other.rate;
  const cells = (total * slowest / finest) * (frames / FEATURE_FRAMES);
  const per = Math.max(FEATURE_FRAMES, Math.ceil(FEATURE_FRAMES * Math.sqrt(cells / MOST_CELLS)));
  const step = per * HOP / other.rate;
  const features = Object.fromEntries(stems.map(stem => [stem, stemFeatures(spectrograms[stem]!, frames, per)])) as Partial<Record<AlignStem, StemFeatures>>;
  const columns = features.other!.steps;
  const pitched = PITCHED_STEMS.filter(stem => features[stem]).map(stem => features[stem]!);
  const heard = together(pitched, columns);
  // Onsets from every stem, drums too.
  const onsets = new Float32Array(columns);
  for (const stem of stems) for (let j = 0; j < columns; j++) onsets[j] = Math.max(onsets[j], features[stem]!.onsets[j] ?? 0);

  // Where the score may start: anywhere, or for an intro near the song's first sound.
  let opening: [number, number] = [0, columns - 1];
  if (intro) {
    let first = 0;
    while (first < columns - 1 && heard[first * DIMENSIONS + PITCH_CLASSES] > 0.9) first++;
    opening = [Math.max(0, first - Math.round(1 / step)), first + Math.round(INTRO_SECONDS / step)];
  }

  // The likeliest key shifts, by the chroma over the whole stretch.
  const sung = new Float64Array(PITCH_CLASSES), written = new Float64Array(PITCH_CLASSES);
  for (let j = 0; j < columns; j++) for (let d = 0; d < PITCH_CLASSES; d++) sung[d] += heard[j * DIMENSIONS + d];
  for (const note of score.notes) written[((note.pitch % 12) + 12) % 12] += note.length;
  const shifts = Array.from({ length: PITCH_CLASSES }, (_, shift) => {
    let sum = 0;
    for (let d = 0; d < PITCH_CLASSES; d++) sum += written[d] * sung[(d + shift) % 12];
    return { shift: shift > 6 ? shift - 12 : shift, sum };
  }).sort((a, b) => b.sum - a.sum).slice(0, SHIFTS_TRIED).map(({ shift }) => shift);

  const run = (secondsPerQuarter: number, shift: number, compare: (i: number, j: number, drawn: ReturnType<typeof scoreFeatures>) => number,
    drawn: ReturnType<typeof scoreFeatures>) => {
    if (drawn.steps > columns) return null;
    return { ...warp(drawn.steps, columns, (i, j) => compare(i, j, drawn) + ONSET_WEIGHT * Math.max(0, drawn.onsets[i] - onsets[j]), BEND, opening), secondsPerQuarter, shift, drawn };
  };
  let best: (NonNullable<ReturnType<typeof run>>) | null = null;
  for (const guess of tempoGuesses(score, beats)) {
    for (const shift of shifts) {
      const drawn = scoreFeatures(score, step, guess, shift, () => true, true);
      const found = run(guess, shift, (i, j, d) => 1 - dot(d.chroma, i, heard, j), drawn);
      if (found && (!best || found.cost < best.cost)) best = found;
    }
  }
  if (!best) throw new Error('The score is longer than the part of the song searched.');

  // Each part to the stem it sounds most like along the path.
  const groups = [...new Set(score.notes.map(note => `${note.part}/${note.staff}`))].map(key => key.split('/').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const staves = new Set(score.notes.filter(note => note.staff > 1).map(note => note.part));
  const likenessOf = (chosen: (note: ScoreNote) => boolean) => {
    const drawn = scoreFeatures(score, step, best!.secondsPerQuarter, best!.shift, chosen, false);
    const likeness: Partial<Record<AlignStem, number>> = {};
    for (const stem of PITCHED_STEMS) {
      const feature = features[stem];
      if (!feature) continue;
      let sum = 0, count = 0;
      for (let i = 0; i < drawn.steps; i++) {
        if (drawn.chroma[i * DIMENSIONS + PITCH_CLASSES] > 0.5) continue;
        sum += dot(drawn.chroma, i, feature.chroma, best!.path[Math.min(i, best!.path.length - 1)]);
        count++;
      }
      likeness[stem] = count ? sum / count : 0;
    }
    const ranked = (Object.entries(likeness) as [AlignStem, number][]).sort((a, b) => b[1] - a[1]);
    return { likeness, stem: ranked[0] && ranked[0][1] >= PART_LEAST ? ranked[0][0] : null };
  };
  const parts: PartMatch[] = groups.map(([part, staff]) => {
    const name = (score.parts[part]?.name ?? `Part ${part + 1}`) + (staves.has(part) ? ` (staff ${staff})` : '');
    return { part, staff, name, ...likenessOf(note => note.part === part && note.staff === staff) };
  });
  // A staff written in several layers (a piano's right hand with the tune above its chords, say): a layer that
  // sounds most like the vocals is the vocals', and left out like a sung part.
  for (const [part, staff] of groups) {
    const voices = new Map<number, number>();
    for (const note of score.notes) if (note.part === part && note.staff === staff) voices.set(note.voice ?? 1, (voices.get(note.voice ?? 1) ?? 0) + 1);
    if (voices.size < 2) continue;
    const staffMatch = parts.find(match => match.part === part && match.staff === staff && match.voice === undefined)!;
    if (staffMatch.stem === 'vocals') continue;
    for (const [voice, count] of voices) {
      if (count < LAYER_NOTES) continue;
      const layer = likenessOf(note => note.part === part && note.staff === staff && (note.voice ?? 1) === voice);
      if (layer.stem === 'vocals') parts.push({ part, staff, voice, name: `${staffMatch.name} (voice ${voice})`, ...layer });
    }
  }

  // Second pass, at the tempo the first found: each stem against its own parts (parts given to no stem, against the
  // stems together).
  const found = best;
  // With the song's beats the tempo guessed from them stands (the path drifts where the music holds still);
  // without, the path's own.
  const tempo = beats && beats.length > 2 ? found.secondsPerQuarter
    : found.secondsPerQuarter * (found.path[found.path.length - 1] - found.path[0] + 1) / found.path.length;
  const ownStem = noteStems(score, parts);
  const assigned = PITCHED_STEMS.filter(stem => features[stem] && parts.some(part => part.stem === stem));
  const own = assigned.map(stem => ({ feature: features[stem]!, drawn: scoreFeatures(score, step, tempo, found.shift, note => ownStem(note) === stem, false) }));
  const rest = parts.some(part => !part.stem) ? scoreFeatures(score, step, tempo, found.shift, note => !ownStem(note), true) : null;
  const drawn = scoreFeatures(score, step, tempo, found.shift, () => true, true);
  // How loud the pitched stems no part of the score is for play (0 to 1); none when a part went to no single stem.
  const uncovered = rest ? [] : PITCHED_STEMS.filter(stem => features[stem] && !assigned.includes(stem)).map(stem => features[stem]!);
  const uncoveredAt = (j: number) => {
    let total = 0;
    for (const feature of uncovered) for (let d = 0; d < PITCH_CLASSES; d++) total += feature.loudness[j * PITCH_CLASSES + d];
    return Math.min(1, total);
  };
  const secondCost = (i: number, j: number) => {
    let sum = 0, count = 0;
    for (const { feature, drawn: part } of own) {
      if (part.chroma[i * DIMENSIONS + PITCH_CLASSES] > 0.5) continue;
      sum += 1 - dot(part.chroma, i, feature.chroma, j);
      count++;
    }
    if (rest && rest.chroma[i * DIMENSIONS + PITCH_CLASSES] <= 0.5) { sum += 1 - dot(rest.chroma, i, heard, j); count++; }
    return (count ? sum / count : 1 - dot(drawn.chroma, i, heard, j)) + UNCOVERED_WEIGHT * uncoveredAt(j);
  };
  const second = run(tempo, found.shift, secondCost, drawn);
  if (second) best = second;

  // With the song's beats, the score is also tried laid on them as a whole: its quarters on beats (or on half or
  // two beats, as the tempo found says), starting on each beat near where the path starts. A band keeps its tempo
  // and the beats follow what drift there is, so this is taken when it fits about as well as the path, which
  // wanders where the music holds still.
  let rigid: { first: number; per: number } | null = null;
  const gaps = beats && beats.length > 2 ? beats.slice(1).map((beat, index) => beat - beats[index]).sort((a, b) => a - b) : [];
  if (beats && gaps.length) {
    const typical = gaps[gaps.length >> 1];
    const per = [0.5, 1, 2].reduce((found, ratio) => Math.abs(Math.log(tempo / typical / ratio)) < Math.abs(Math.log(tempo / typical / found)) ? ratio : found, 1);
    const startBeat = Math.round(beatPosition(beats, best.path[0] * step));
    let cheapest = Infinity;
    for (let first = Math.max(0, startBeat - RIGID_BEATS); first <= Math.min(beats.length - 1, startBeat + RIGID_BEATS); first++) {
      if (beats[first] < opening[0] * step - 0.05 || beats[first] > opening[1] * step + 0.05) continue;
      let sum = 0, inside = true;
      for (let i = 0; i < best.drawn.steps && inside; i++) {
        const j = Math.round(timeAtBeat(beats, first + i * step / tempo * per) / step);
        if (j < 0 || j >= columns) { inside = false; break; }
        sum += secondCost(i, j) + ONSET_WEIGHT * Math.max(0, best.drawn.onsets[i] - onsets[j]);
      }
      if (inside && sum / best.drawn.steps < cheapest) { cheapest = sum / best.drawn.steps; rigid = { first, per }; }
    }
    if (cheapest > best.cost + RIGID_MARGIN) rigid = null;
  }

  // Song seconds at each measure start, from a line through the path over the measures either side; then on a beat
  // where one is near.
  const { path, secondsPerQuarter: guess } = best;
  const quarterSteps = guess / step;
  const timeOfStep = (i: number) => path[Math.max(0, Math.min(path.length - 1, i))] * step;
  const boundaries = [...score.measures.map(measure => measure.start), score.measures.at(-1)!.start + score.measures.at(-1)!.length];
  let starts = boundaries.map((quarter, index) => {
    const from = Math.round(boundaries[Math.max(0, index - 1)] * quarterSteps);
    const to = Math.round(boundaries[Math.min(boundaries.length - 1, index + 1)] * quarterSteps);
    const points: [number, number][] = [];
    for (let i = from; i <= Math.min(to, path.length - 1); i++) points.push([i / quarterSteps, timeOfStep(i)]);
    return points.length ? fitted(points, quarter, 2 * step) : timeOfStep(Math.round(quarter * quarterSteps));
  });
  for (let index = 1; index < starts.length; index++) starts[index] = Math.max(starts[index], starts[index - 1] + 0.05);
  const beatGap = (time: number) => {
    if (!beats || beats.length < 2) return guess;
    let index = 0;
    while (index < beats.length - 2 && beats[index + 1] <= time) index++;
    return beats[index + 1] - beats[index];
  };
  const nearestBeat = (time: number) => beats?.reduce((found, beat) => Math.abs(beat - time) < Math.abs(found - time) ? beat : found, Infinity) ?? Infinity;
  const onBeat = starts.map(time => Math.abs(nearestBeat(time) - time) <= SNAP * beatGap(time));
  // Off the beats (or with none), a measure starts on the strongest onset near, when there is a clear one.
  const nearestOnset = (time: number) => {
    let found = -1;
    for (let j = Math.max(0, Math.round((time - SNAP * guess) / step)); j <= Math.min(columns - 1, Math.round((time + SNAP * guess) / step)); j++) {
      if (onsets[j] >= ONSET_CLEAR && (found < 0 || onsets[j] > onsets[found])) found = j;
    }
    return found < 0 ? time : found * step;
  };
  starts = starts.map((time, index) => onBeat[index] ? nearestBeat(time) : nearestOnset(time));
  for (let index = 1; index < starts.length; index++) {
    if (starts[index] <= starts[index - 1]) { starts[index] = starts[index - 1] + 0.05; onBeat[index] = false; }
  }
  if (rigid && beats) {
    starts = boundaries.map(quarter => timeAtBeat(beats, rigid!.first + quarter * rigid!.per));
    boundaries.forEach((quarter, index) => { onBeat[index] = Math.abs(quarter * rigid!.per - Math.round(quarter * rigid!.per)) < 1e-6; });
  }
  // The knots of the time map: measure starts, and the song's beats inside a measure that has as many as it should.
  const knots: [number, number][] = [];
  score.measures.forEach((measure, index) => {
    knots.push([boundaries[index], starts[index]]);
    const inside = (beats ?? []).filter(beat => beat > starts[index] + 0.02 && beat < starts[index + 1] - 0.02);
    const quarters = Math.round(measure.length);
    if (onBeat[index] && onBeat[index + 1] && measure.beatType === 4 && Math.abs(measure.length - quarters) < 1e-6 && inside.length === quarters - 1) {
      inside.forEach((beat, k) => knots.push([boundaries[index] + k + 1, beat]));
    }
  });
  knots.push([boundaries.at(-1)!, starts.at(-1)!]);
  const timeAt = rigid && beats ? (quarter: number) => timeAtBeat(beats, rigid!.first + quarter * rigid!.per)
    : (quarter: number) => interpolate(knots, quarter);
  const measures: AlignedMeasure[] = score.measures.map((measure, index) => ({
    index, number: measure.number, start: starts[index], end: starts[index + 1], onBeat: onBeat[index],
  }));
  const span = boundaries.at(-1)! - boundaries[0];
  const secondsPerQuarter = span > 0 ? (starts.at(-1)! - starts[0]) / span : guess;
  let likeness = 0;
  for (let i = 0; i < best.drawn.steps; i++) likeness += dot(best.drawn.chroma, i, heard, Math.max(0, Math.min(columns - 1, Math.round(timeAt(i * step / guess) / step))));
  likeness /= best.drawn.steps;

  // A melody is the singer's, though the other stem's overtones sound at its pitches; a bass line the other stem
  // also plays (a piano's left hand, a guitar's low strings) is restored where it has it.
  const stemOf = ownStem;
  const { notes, missing } = restore(score, spectrograms, target ?? { spectrogram: other, stems: ['other'] }, timeAt, best.shift, beatGap, stemOf, undefined, false, fill);
  return { measures, shift: best.shift, secondsPerQuarter, likeness, parts, notes, missing, timeAt };
}

// The level a stem has at a pitch (its row and the rows a third of a semitone either side, the loudest), dB.
function levelAt(spectrogram: Spectrogram, frame: number, pitch: number): number {
  const row = rowOf(pitch);
  let level = -Infinity;
  for (let near = Math.max(0, row - 1); near <= Math.min(ROWS - 1, row + 1); near++) level = Math.max(level, spectrogram.levels[frame * ROWS + near]);
  return level;
}

// Each pitch's usual level in a stem: its FLOOR_PERCENTILE level over the frames.
function floorsOf(spectrogram: Spectrogram, frames: number): Float32Array {
  const floors = new Float32Array(128).fill(0);
  const column = new Float32Array(frames);
  for (let pitch = LOWEST_PITCH; pitch <= 108; pitch++) {
    for (let frame = 0; frame < frames; frame++) column[frame] = levelAt(spectrogram, frame, pitch);
    floors[pitch] = percentile(column, FLOOR_PERCENTILE);
  }
  return floors;
}

// The stems restored from: the spectrogram of their sound together (one stem's own, or a mix of them) and which they are.
export interface RestoreTarget { spectrogram: Spectrogram; stems: AlignStem[] }

function restore(score: Score, spectrograms: Partial<Record<AlignStem, Spectrogram>>, target: RestoreTarget, timeAt: (quarter: number) => number,
  shift: number, beatGap: (time: number) => number, stemOf: (note: ScoreNote) => AlignStem | null,
  octaves: number[] = [-12, 12], lowestOctave = false, fill = false): { notes: RestoredNote[]; missing: MissingNote[] } {
  // Named for the usual target, the other stem.
  const other = target.spectrogram;
  const perSecond = other.rate / HOP;
  const frameAt = (time: number) => Math.round(time * perSecond);
  const lastNote = Math.max(...score.notes.map(note => timeAt(note.start + note.length)));
  const lookFrames = Math.min(other.frames, frameAt(lastNote + 2));
  const stems = (Object.keys(spectrograms) as AlignStem[]).filter(stem => stem !== 'drums' && spectrograms[stem]!.rate === other.rate);
  // Floors over the whole stretch the stems were searched in, so a pitch the score holds throughout still stands out.
  const floorsFor = (spectrogram: Spectrogram) => floorsOf(spectrogram, Math.min(spectrogram.frames, Math.max(lookFrames, frameAt(60))));
  const floors = Object.fromEntries(stems.map(stem => [stem, floorsFor(spectrograms[stem]!)])) as Record<AlignStem, Float32Array>;
  const targetFloors = target.stems.length === 1 && target.spectrogram === spectrograms[target.stems[0]] ? floors[target.stems[0]] : floorsFor(other);
  // How far above its usual level a spectrogram has a pitch over a note's first moments, dB (mean over the frames).
  const aboveIn = (spectrogram: Spectrogram, usual: Float32Array, pitch: number, from: number, to: number) => {
    if (pitch < LOWEST_PITCH || pitch > 108) return -Infinity;
    let sum = 0, count = 0;
    for (let frame = Math.max(0, from); frame < Math.min(to, spectrogram.frames); frame++) { sum += levelAt(spectrogram, frame, pitch) - usual[pitch]; count++; }
    return count ? sum / count : -Infinity;
  };
  const above = (stem: AlignStem, pitch: number, from: number, to: number) => aboveIn(spectrograms[stem]!, floors[stem], pitch, from, to);
  const inTarget = (pitch: number, from: number, to: number) => aboveIn(other, targetFloors, pitch, from, to);
  const notes: RestoredNote[] = [], missing: MissingNote[] = [];
  // With `fill`, a score note the stem is not heard playing is still the score's: it goes where the score writes it
  // (its velocity set from the notes heard around it, below); only the vocals' parts are left out.
  const filled: RestoredNote[] = [];
  const fillIn = (note: ScoreNote, pitch: number, start: number, end: number, heard: Partial<Record<AlignStem, number>>) =>
    filled.push({ pitch, start, end, velocity: 0, measure: note.measure, written: { pitch, start: note.start, length: note.length }, heard, octave: 0, found: false });
  // Notes whose pitch the score has sounding up to their start (struck again).
  const struck = new Set(score.notes.filter(note => score.notes.some(before => before !== note && before.pitch === note.pitch
    && before.start < note.start && before.start + before.length > note.start - 1e-6)));
  for (const note of score.notes) {
    const pitch = note.pitch + shift;
    const start = timeAt(note.start), end = Math.max(start + LEAST_LENGTH, timeAt(note.start + note.length));
    const from = frameAt(start), to = Math.max(from + 2, frameAt(Math.min(end, start + LOOK)));
    const heard: Partial<Record<AlignStem, number>> = {};
    for (const stem of stems) heard[stem] = Math.round(above(stem, pitch, from, to) * 10) / 10;
    // The octave the target plays it in, when it does not have the written one.
    let octave = 0, level = inTarget(pitch, from, to);
    for (const moved of level < PRESENT_DB ? octaves : []) {
      const there = inTarget(pitch + moved, from, to);
      if (there > level + OCTAVE_BETTER_DB && there >= PRESENT_DB) { octave = moved; level = there; }
    }
    // A bass line is where its lowest clear octave is: what sounds above it is its overtones.
    if (lowestOctave) {
      const options = [0, ...octaves].map(moved => ({ moved, there: moved === octave ? level : inTarget(pitch + moved, from, to) }));
      const loudest = Math.max(...options.map(option => option.there));
      const low = options.filter(option => option.there >= PRESENT_DB && option.there >= loudest - LOW_OCTAVE_DB).sort((a, b) => a.moved - b.moved)[0];
      if (low) { octave = low.moved; level = low.there; }
    }
    // A part given to a stem outside the target: the vocals' is theirs (the target's overtones sound at a melody's
    // pitches); another's (a piano's left hand, given to the bass, when only the other stem is the target) is
    // restored where the target has it, not where what it has is only its faint spill of that stem.
    const own = stemOf(note);
    const spill = !!own && !target.stems.includes(own) && (heard[own] ?? -Infinity) - level > SPILL_DB;
    if (level < PRESENT_DB || own === 'vocals' || spill) {
      if (fill && own !== 'vocals') fillIn(note, pitch, start, end, heard);
      else missing.push({ pitch, start, end, measure: note.measure, stems: stems.filter(stem => (heard[stem] ?? -Infinity) >= PRESENT_DB), part: own });
      continue;
    }
    const played = pitch + octave;
    // The attack: the biggest rise near the written start.
    const search = Math.min(ATTACK_SEARCH, beatGap(start) / 4);
    let attack = from, rise = -Infinity;
    for (let frame = Math.max(2, frameAt(start - search)); frame <= Math.min(other.frames - 1, frameAt(start + search)); frame++) {
      const value = levelAt(other, frame, played) - levelAt(other, frame - 2, played);
      if (value > rise) { rise = value; attack = frame; }
    }
    if (rise < ATTACK_RISE_DB) {
      // The same pitch sounding on from the note before it is not this note unless the stem strikes it again.
      if (struck.has(note)) {
        if (fill) { fillIn(note, pitch, start, end, heard); continue; }
        missing.push({ pitch, start, end, measure: note.measure, stems: stems.filter(stem => !target.stems.includes(stem) && (heard[stem] ?? -Infinity) >= PRESENT_DB), part: own });
        continue;
      }
      attack = from;
    }
    // The attack's level, for its velocity.
    let peak = -Infinity;
    for (let frame = attack; frame <= Math.min(other.frames - 1, attack + Math.round(0.15 * perSecond)); frame++) peak = Math.max(peak, levelAt(other, frame, played));
    // The end: where the sound sinks to near its usual level or DECAY_DB below its attack (what is left there is
    // the next notes' spill), no later than a little past the written end.
    const floor = targetFloors[played] ?? 0, gone = Math.max(floor + PRESENT_DB / 2, peak - DECAY_DB);
    const latest = Math.min(other.frames - 1, frameAt(end + beatGap(end) / 2));
    let last = attack + 1, quiet = 0;
    for (let frame = attack + 1; frame <= latest; frame++) {
      if (levelAt(other, frame, played) < gone) { if (++quiet >= 2) break; } else { quiet = 0; last = frame; }
    }
    notes.push({
      pitch: played, start: attack / perSecond, end: Math.max(attack / perSecond + LEAST_LENGTH, (last + 1) / perSecond),
      velocity: Math.round(Math.max(VELOCITY_LEAST, Math.min(127, 127 * 10 ** (peak / 30)))), measure: note.measure,
      written: { pitch, start: note.start, length: note.length }, heard, octave,
    });
  }
  // Filled notes are as loud as the notes heard in their measure (or in the song).
  const typical = (list: RestoredNote[]) => {
    const sorted = list.map(note => note.velocity).sort((a, b) => a - b);
    return sorted.length ? sorted[sorted.length >> 1] : 80;
  };
  const songVelocity = typical(notes);
  for (const note of filled) {
    const near = notes.filter(other => other.measure === note.measure);
    notes.push({ ...note, velocity: near.length ? typical(near) : songVelocity });
  }
  // A restored note ends where the next one on its pitch starts.
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  notes.forEach((note, index) => {
    const next = notes.slice(index + 1).find(other => other.pitch === note.pitch);
    if (next && next.start < note.end) note.end = Math.max(note.start + 0.02, next.start - 0.01);
  });
  return { notes, missing };
}

// The restored notes as the Harmonic score's notes, on a grid of the score's own quarter notes as the song plays
// them (for score-export's MIDI file, whose bars are then the score's; a short first measure is a pickup).
export function restoredScore(alignment: Alignment, score: Score): { notes: HarmonyNote[]; grid: HarmonyGrid } {
  const last = score.measures.at(-1)!, total = Math.ceil(last.start + last.length);
  const beats = Array.from({ length: total + 1 }, (_, quarter) => alignment.timeAt(quarter));
  const first = score.measures[0];
  const pickup = score.measures.length > 1 && first.length < first.beats * 4 / first.beatType - 1e-6 ? Math.round(first.length) : 0;
  const notes = alignment.notes.map(note => ({
    start: note.start, end: note.end, pitch: note.pitch, velocity: note.velocity,
    unit: Math.round(note.written.start * 4), length: Math.max(1, Math.round(note.written.length * 4)),
  }));
  return { notes, grid: { beats, firstBar: pickup } };
}

// Where the restored notes sound in a spectrogram of the other stem, for spectrogram.ts maskedSignal to keep them
// alone: for each note, from its start to a little past its end, the rows of its pitch and of its overtones (up to
// PARTIALS of them), each with the rows a third of a semitone either side.
export const PARTIALS = 10;
const MASK_TAIL = 0.05;
export function scoreMask(notes: RestoredNote[], frames: number, rate: number): Uint8Array {
  const kept = new Uint8Array(frames * ROWS), perSecond = rate / HOP;
  for (const note of notes) {
    // A filled-in note was not heard: there is nothing of it to keep.
    if (note.found === false) continue;
    const from = Math.max(0, Math.floor(note.start * perSecond)), to = Math.min(frames - 1, Math.ceil((note.end + MASK_TAIL) * perSecond));
    for (let partial = 1; partial <= PARTIALS; partial++) {
      const row = Math.round(rowOf(note.pitch + 12 * Math.log2(partial)));
      if (row > ROWS) break;
      for (let near = Math.max(0, row - 1); near <= Math.min(ROWS - 1, row + 1); near++) {
        for (let frame = from; frame <= to; frame++) kept[frame * ROWS + near] = 1;
      }
    }
  }
  return kept;
}

// Measure by measure: the score's measures laid on the song, each over the drum analysis's beats it fits best, the
// drum bars corrected to them.
//
// The song is gone through once (dynamic programming over its beats). Each step lays a score measure over the next
// beats: as many as the measure has quarters, or one or two more or fewer where the drum analysis has a beat too
// many or too few (each such beat costs STRETCH), and costs how unlike the song it is there (each stem against the
// parts given to it, an eighth note at a time; a pitched stem no part is for, playing loud, costs too). The next
// measure in the score costs nothing more; any other (a repeat, a jump, the same measure again) costs JUMP. Where
// the song has bars the score does not (a longer interlude, an outro), a free bar of about four beats is laid,
// costing FREE_BAR as loud as the song is there. The cheapest way through is taken.
//
// The beats are then made again from it: each measure as many beats as its quarters, spread evenly over the drum
// beats it was laid on, every free bar four; the beats before the first measure stay as they were. A drum bar is
// counted corrected where its measure was laid over more or fewer beats than it has, or where it starts on a beat
// that was not a downbeat before.
export interface PlacedMeasure {
  measure: number | null;                 // Index of the score measure; null for a bar the score does not have.
  number: string;
  from: number;                           // The drum beat it starts on (index in the drum analysis's beats).
  drumBeats: number;                      // How many of those beats it covers.
  start: number; end: number;             // Song seconds.
  cost: number;
  corrected: '' | 'extra-beat' | 'missing-beat' | 'moved';
}
export interface MeasureFit {
  placed: PlacedMeasure[];
  beats: number[]; firstBar: number;      // The corrected beats; bars of four from firstBar.
  corrections: { bars: number; extraBeats: number; missingBeats: number; moved: number; checked: number };
  alignment: Alignment;                   // The score as laid (measures in song order), restored.
  // Named from the score's own notes, as laid: a chord a measure (or a half where it changes), N.C. in bars the
  // score does not have. Pitch classes as numbers; harmonyFromScore spells them in the song's key.
  chords: { start: number; root: number; quality: string; bass: number }[];
  bass?: RestoredNote[];                  // The score's notes the bass stem plays, as it plays them.
}
const STRETCH = 0.3, JUMP = 0.5, FREE_BAR = 0.75, FREE_QUIET = 0.1, SLOTS_PER_QUARTER = 2;

// The beat times of a measure of `quarters` laid over drum beats from..from + count: the drum beats themselves, less
// the ones that most break their even spacing where there are too many, with one in the middle of the widest gap
// where there are too few.
export function measureBeats(beats: number[], from: number, count: number, quarters: number): number[] {
  const times = Array.from({ length: count + 1 }, (_, k) => timeAtBeat(beats, from + k));
  const spread = (list: number[]) => {
    const gaps = list.slice(1).map((time, k) => time - list[k]), mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return gaps.reduce((total, gap) => total + (gap - mean) ** 2, 0);
  };
  while (times.length - 1 > quarters) {
    let best = 1, least = Infinity;
    for (let k = 1; k < times.length - 1; k++) {
      const value = spread([...times.slice(0, k), ...times.slice(k + 1)]);
      if (value < least) { least = value; best = k; }
    }
    times.splice(best, 1);
  }
  while (times.length - 1 < quarters) {
    let widest = 0;
    for (let k = 1; k < times.length - 1; k++) if (times[k + 1] - times[k] > times[widest + 1] - times[widest]) widest = k;
    times.splice(widest + 1, 0, (times[widest] + times[widest + 1]) / 2);
  }
  return times.slice(0, quarters);
}

// fixed: the beats are a grid an earlier score laid, kept as they are.
export function fitMeasures({ score, spectrograms, beats: original, target }: AlignInput & { beats: number[] }, base: Alignment, firstBar: number,
  fixed = false): MeasureFit {
  const beats = fixed ? original : repairBeats(original);
  const other = spectrograms.other!;
  const step = FEATURE_FRAMES * HOP / other.rate;
  const stems = PITCHED_STEMS.filter(stem => spectrograms[stem] && spectrograms[stem]!.rate === other.rate);
  const features = Object.fromEntries(stems.map(stem => [stem, stemFeatures(spectrograms[stem]!)])) as Partial<Record<AlignStem, StemFeatures>>;
  const steps = Math.min(...stems.map(stem => features[stem]!.steps));
  const stemOf = noteStems(score, base.parts);
  const assigned = stems.filter(stem => base.parts.some(part => part.stem === stem));
  const unassigned = base.parts.some(part => !part.stem);
  const uncovered = unassigned ? [] : stems.filter(stem => !assigned.includes(stem));
  // The song's pitch classes over a stretch of drum beats, per stem, as loud as played (mean over its steps), from
  // running sums over the steps.
  const sums = Object.fromEntries(stems.map(stem => {
    const loudness = features[stem]!.loudness, running = new Float64Array((steps + 1) * PITCH_CLASSES);
    for (let j = 0; j < steps; j++) for (let d = 0; d < PITCH_CLASSES; d++) running[(j + 1) * PITCH_CLASSES + d] = running[j * PITCH_CLASSES + d] + loudness[j * PITCH_CLASSES + d];
    return [stem, running];
  })) as Partial<Record<AlignStem, Float64Array>>;
  const songSlot = (stem: AlignStem, from: number, to: number, out: Float64Array) => {
    const first = Math.max(0, Math.min(steps - 1, Math.floor(timeAtBeat(beats, from) / step)));
    const last = Math.min(steps, Math.max(first + 1, Math.floor(timeAtBeat(beats, to) / step)));
    const running = sums[stem]!;
    for (let d = 0; d < PITCH_CLASSES; d++) out[d] = (running[last * PITCH_CLASSES + d] - running[first * PITCH_CLASSES + d]) / (last - first);
    return out;
  };
  // Each score measure's pitch classes per eighth, per group of parts (a stem's, or those given to none).
  type Group = AlignStem | 'together';
  const groups: Group[] = [...assigned, ...(unassigned ? ['together' as const] : [])];
  const measureSlots = score.measures.map((measure, index) => {
    const slots = Math.max(1, Math.round(measure.length * SLOTS_PER_QUARTER));
    const table = new Map<Group, Float64Array[]>(groups.map(group => [group, Array.from({ length: slots }, () => new Float64Array(PITCH_CLASSES))]));
    for (const note of score.notes) {
      if (note.measure !== index) continue;
      const group: Group = stemOf(note) ?? 'together';
      const rows = table.get(group);
      if (!rows) continue;
      const pitchClass = (((note.pitch + base.shift) % 12) + 12) % 12;
      for (let slot = 0; slot < slots; slot++) {
        const q0 = measure.start + slot / SLOTS_PER_QUARTER, q1 = q0 + 1 / SLOTS_PER_QUARTER;
        const overlap = Math.min(q1, note.start + note.length) - Math.max(q0, note.start);
        if (overlap > 0) rows[slot][pitchClass] += overlap * SLOTS_PER_QUARTER * (note.start >= q0 - 1e-6 && note.start < q1 ? 1 : 0.6);
      }
    }
    return { slots, table };
  });
  const cosine = (a: Float64Array, b: Float64Array) => {
    let ab = 0, aa = 0, bb = 0;
    for (let d = 0; d < PITCH_CLASSES; d++) { ab += a[d] * b[d]; aa += a[d] * a[d]; bb += b[d] * b[d]; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  };
  const sum = (a: Float64Array) => a.reduce((total, value) => total + value, 0);
  const heard = new Float64Array(PITCH_CLASSES), part = new Float64Array(PITCH_CLASSES);
  // How unlike the song a measure is laid over drum beats from..from + count.
  const unlike = (index: number, from: number, count: number) => {
    const { slots, table } = measureSlots[index];
    let total = 0, counted = 0;
    for (let slot = 0; slot < slots; slot++) {
      const b0 = from + slot / slots * count, b1 = from + (slot + 1) / slots * count;
      for (const group of groups) {
        const written = table.get(group)![slot];
        if (group === 'together') {
          heard.fill(0);
          for (const stem of stems) { songSlot(stem, b0, b1, part); for (let d = 0; d < PITCH_CLASSES; d++) heard[d] += part[d]; }
        } else songSlot(group, b0, b1, heard);
        const writtenSum = sum(written), heardSum = sum(heard);
        if (writtenSum === 0 && heardSum < QUIET) continue;
        total += writtenSum === 0 ? Math.min(1, heardSum) : heardSum < QUIET ? 1 : 1 - cosine(written, heard);
        counted++;
      }
      for (const stem of uncovered) { total += UNCOVERED_WEIGHT * Math.min(1, sum(songSlot(stem, b0, b1, heard))); }
    }
    return counted ? total / counted : 0.5;
  };
  // How loud the pitched stems are over drum beats (0 to 1), for a free bar's cost.
  const loudness = (from: number, count: number) => {
    let total = 0;
    for (const stem of stems) total += sum(songSlot(stem, from, from + count, heard));
    return Math.min(1, total);
  };

  const { placed, beats: newBeats, first, firstBar: newFirstBar, corrections, laid } = layOnBeats(score, beats, firstBar, unlike, loudness, JUMP, original, fixed);
  const at = laid.measures.reduce((total, measure) => total + measure.length, 0);
  const timeAt = (quarter: number) => timeAtBeat(newBeats, first + quarter);
  const beatGap = (time: number) => {
    const position = beatPosition(newBeats, time), index = Math.max(0, Math.min(newBeats.length - 2, Math.floor(position)));
    return newBeats[index + 1] - newBeats[index];
  };
  // The score's notes, every one (it was laid on the song): as played where the stems are heard playing them.
  const restored = restore(laid, spectrograms, target ?? { spectrogram: other, stems: ['other'] }, timeAt, base.shift, beatGap, stemOf, undefined, false, true);
  // The bass line: the score's lowest note at each moment (the parts given to the vocals left out), as the bass
  // stem plays it, an octave or two lower where it does.
  const lowest = new Map<string, ScoreNote>();
  for (const note of laid.notes) {
    if (stemOf(note) === 'vocals') continue;
    const key = `${note.measure}/${note.start.toFixed(4)}`, held = lowest.get(key);
    if (!held || note.pitch < held.pitch) lowest.set(key, note);
  }
  const line = { ...laid, notes: [...lowest.values()].sort((a, b) => a.start - b.start) };
  const bass = spectrograms.bass && spectrograms.bass.rate === other.rate
    ? restore(line, spectrograms, { spectrogram: spectrograms.bass, stems: ['bass'] }, timeAt, base.shift, beatGap, stemOf, [-12, -24], true).notes : undefined;
  const chords = scoreChords(laid, placed.map(place => place.measure !== null), timeAt, base.shift, stemOf);
  const aligned: AlignedMeasure[] = placed.map((place, index) => ({ index, number: place.number, start: place.start, end: place.end, onBeat: !place.corrected }));
  const span = placed.length ? placed[placed.length - 1].end - placed[0].start : 0;
  return {
    placed, beats: newBeats, firstBar: newFirstBar, corrections, chords, ...(bass ? { bass } : {}),
    alignment: {
      ...base, measures: aligned, notes: restored.notes, missing: restored.missing, timeAt,
      secondsPerQuarter: at > 0 ? span / at : base.secondsPerQuarter,
    },
  };
}

// The drum analysis's beats with its plain mistakes mended before a score is laid on them: a gap of about two (or
// more) usual gaps (the median of the eight around) gets beats evenly in it, and two gaps of about half one together
// lose the beat between them. What is left (a beat the tempo hides) the laying itself corrects.
const BEAT_SAME = 0.03;
export function repairBeats(beats: number[]): number[] {
  const gaps = beats.slice(1).map((beat, k) => beat - beats[k]);
  const usualAt = (k: number) => {
    const near = gaps.slice(Math.max(0, k - 4), k + 5).sort((a, b) => a - b);
    return near[near.length >> 1] || 0.5;
  };
  const out = [beats[0]];
  for (let k = 0; k < gaps.length; k++) {
    const usual = usualAt(k), gap = gaps[k];
    if (gap < 0.65 * usual && k + 1 < gaps.length && Math.abs(gap + gaps[k + 1] - usual) < 0.3 * usual) {
      out.push(beats[k + 2]);
      k++;
      continue;
    }
    const missing = gap > 1.6 * usual ? Math.round(gap / usual) - 1 : 0;
    for (let extra = 1; extra <= missing; extra++) out.push(beats[k] + gap * extra / (missing + 1));
    out.push(beats[k + 1]);
  }
  return out;
}

// A score laid measure by measure on drum beats, by dynamic programming over the beats: each measure over as many
// beats as it has quarters (or one more or fewer, at STRETCH), the next measure after it or any other (a repeat or a
// skip, at JUMP), or free bars the score does not have (at FREE_QUIET, and FREE_BAR as loud as the song is there);
// `unlike` is how unlike the song measure `index` is over beats from..from + count (0 to 1), `loudness` how much is
// playing over them (0 to 1). The beats come back corrected (measureBeats) with what changed, and the score as laid.
interface Laying {
  placed: PlacedMeasure[]; beats: number[]; first: number; firstBar: number;
  corrections: MeasureFit['corrections']; laid: Score;
}
export function layOnBeats(score: Score, beats: number[], firstBar: number,
  unlike: (index: number, from: number, count: number) => number, loudness: (from: number, count: number) => number, jumpCost = JUMP,
  original = beats, fixed = false): Laying {
  // States: 0..M-1 after measure m; M..2M-1 in free bars after measure m - M; 2M before any measure.
  const M = score.measures.length, N = beats.length, S = 2 * M + 1, START = 2 * M;
  const total = new Float64Array(N * S).fill(Infinity);
  const back = new Int32Array(N * S).fill(-1), backBeats = new Int8Array(N * S);
  // The first measure may start on any of the first few beats... or anywhere, after free bars.
  for (let i = 0; i < Math.min(N, 8); i++) total[i * S + START] = 0;
  // On a fixed grid (one an earlier score laid) each measure takes just its own beats, and free bars four.
  const lengths = (quarters: number) => (fixed ? [0] : [-1, 0, 1]).map(change => Math.round(quarters) + change).filter(count => count >= 1);
  // A beat the drum analysis missed leaves a gap of about two beats, and a false one two gaps of about half: a
  // measure laid over one beat fewer (or more) costs less the more its beats look like that, against the usual gap
  // there (the median of the eight around), down to a tenth of STRETCH.
  const gaps = Array.from({ length: Math.max(0, N - 1) }, (_, k) => beats[k + 1] - beats[k]);
  const usual = gaps.map((_, k) => {
    const near = gaps.slice(Math.max(0, k - 4), k + 5).sort((a, b) => a - b);
    return near[near.length >> 1] || 0.5;
  });
  const stretchCost = (from: number, count: number, quarters: number) => {
    const change = count - Math.round(quarters);
    if (!change) return 0;
    let widest = 0, narrowest = Infinity;
    // A missing beat may be the measure's first: the gap leading into it counts too.
    for (let k = Math.max(0, change < 0 ? from - 1 : from); k < Math.min(from + count, gaps.length); k++) {
      widest = Math.max(widest, gaps[k] / usual[k]);
      narrowest = Math.min(narrowest, gaps[k] / usual[k]);
    }
    const evidence = change < 0 ? 2 - widest : (narrowest - 0.5) * 2;
    return STRETCH * Math.abs(change) * Math.min(1, Math.max(0.1, evidence));
  };
  for (let i = 0; i < N - 1; i++) {
    let cheapest = Infinity;
    for (let s = 0; s < S; s++) cheapest = Math.min(cheapest, total[i * S + s]);
    if (cheapest === Infinity) continue;
    const relax = (to: number, state: number, cost: number, from: number, count: number) => {
      if (to >= N || cost >= total[to * S + state]) return;
      total[to * S + state] = cost; back[to * S + state] = from; backBeats[to * S + state] = count;
    };
    for (let m = 0; m < M; m++) {
      // The cheapest way into measure m from here: after the measure before it (or free bars after it), or a jump.
      const previous = m > 0 ? Math.min(total[i * S + m - 1], total[i * S + M + m - 1]) : total[i * S + START];
      let into = previous, from = m > 0 ? (total[i * S + m - 1] <= total[i * S + M + m - 1] ? m - 1 : M + m - 1) : START;
      const jump = cheapest + jumpCost;
      if (jump < into) {
        into = jump;
        for (let s = 0; s < S; s++) if (total[i * S + s] === cheapest) { from = s; break; }
      }
      if (into === Infinity) continue;
      const quarters = score.measures[m].length;
      for (const count of lengths(quarters)) {
        if (i + count >= N) continue;
        const cost = into + unlike(m, i, count) + stretchCost(i, count, quarters);
        relax(i + count, m, cost, i * S + from, count);
      }
    }
    // A free bar after whatever came last.
    for (let s = 0; s < S; s++) {
      const here = total[i * S + s];
      if (here === Infinity) continue;
      const free = s === START ? START : s < M ? M + s : s;
      for (const count of fixed ? [4] : [3, 4, 5]) {
        if (i + count >= N) continue;
        relax(i + count, free, here + FREE_QUIET + FREE_BAR * loudness(i, count) + STRETCH * Math.abs(count - 4), i * S + s, count);
      }
    }
  }
  // The end: the cheapest state on one of the last beats.
  let end = -1, best = Infinity;
  for (let i = Math.max(0, N - 6); i < N; i++) for (let s = 0; s < S; s++) if (total[i * S + s] < best) { best = total[i * S + s]; end = i * S + s; }
  if (end < 0) throw new Error('The score could not be laid on the song\'s beats.');
  const steps_: { from: number; count: number; state: number; to: number }[] = [];
  for (let at = end; back[at] >= 0; at = back[at]) {
    const to = Math.floor(at / S), count = backBeats[at];
    steps_.push({ from: to - count, count, state: at % S, to });
  }
  steps_.reverse();

  // The corrected beats and what changed.
  const oldDownbeats: number[] = [];
  for (let b = ((firstBar % 4) + 4) % 4; b < original.length; b += 4) oldDownbeats.push(original[b]);
  const first = steps_.length ? steps_[0].from : 0;
  const newBeats = beats.slice(0, first);
  const placed: PlacedMeasure[] = [];
  const corrections = { bars: 0, extraBeats: 0, missingBeats: 0, moved: 0, checked: 0 };
  let pickupBeats = 0;
  for (const { from, count, state } of steps_) {
    const real = state < M ? state : null;
    const quarters = real !== null ? Math.max(1, Math.round(score.measures[real].length)) : 4;
    if (real !== null && placed.length === 0 && quarters < 4) pickupBeats = quarters;
    const start = timeAtBeat(beats, from), end = timeAtBeat(beats, from + count);
    newBeats.push(...measureBeats(beats, from, count, quarters));
    // Against the drum analysis's own beats: a measure over fewer or more of them than it has quarters, or starting
    // where it had no downbeat.
    const had = original.filter(time => time >= start - BEAT_SAME && time < end - BEAT_SAME).length;
    const corrected: PlacedMeasure['corrected'] = had > quarters ? 'extra-beat' : had < quarters ? 'missing-beat'
      : !oldDownbeats.some(time => Math.abs(time - start) < BEAT_SAME) && !(placed.length === 0 && pickupBeats) ? 'moved' : '';
    corrections.checked++;
    if (corrected) {
      corrections.bars++;
      if (corrected === 'extra-beat') corrections.extraBeats++;
      else if (corrected === 'missing-beat') corrections.missingBeats++;
      else corrections.moved++;
    }
    placed.push({
      measure: real, number: real !== null ? score.measures[real].number : '–', from, drumBeats: count,
      start, end, cost: 0, corrected,
    });
  }
  const last = steps_.length ? steps_[steps_.length - 1].to : N;
  newBeats.push(...beats.slice(last));
  const newFirstBar = first + pickupBeats;

  // The score as laid: its measures in song order (free bars empty), restored on the corrected beats.
  const measures: ScoreMeasure[] = [], notes: ScoreNote[] = [], printedChords: ScoreChord[] = [], hits: ScoreHit[] = [];
  let at = 0;
  placed.forEach((place, index) => {
    const quarters = place.measure !== null ? Math.max(1, Math.round(score.measures[place.measure].length)) : 4;
    if (place.measure !== null) {
      const measure = score.measures[place.measure];
      for (const note of score.notes) {
        if (note.measure === place.measure) notes.push({ ...note, start: note.start - measure.start + at, measure: index });
      }
      for (const chord of score.chords) {
        if (chord.measure === place.measure) printedChords.push({ ...chord, start: chord.start - measure.start + at, measure: index });
      }
      for (const hit of score.hits ?? []) {
        if (hit.measure === place.measure) hits.push({ ...hit, start: hit.start - measure.start + at, measure: index });
      }
    }
    measures.push({ number: place.number, start: at, length: quarters, beats: quarters, beatType: 4 });
    at += quarters;
  });
  const laid: Score = { ...score, measures, notes, chords: printedChords, ...(score.hits ? { hits } : {}) };
  return { placed, beats: newBeats, first, firstBar: newFirstBar, corrections, laid };
}

// Drum hits (sixteenths from the first beat) moved from one set of beats to another: each at its time on the old
// beats, as a sixteenth of the new.
export function regridHits<Hit extends { unit: number }>(hits: Hit[], from: number[], to: number[]): Hit[] {
  return hits.map(hit => ({ ...hit, unit: Math.max(0, Math.round(beatPosition(to, timeAtBeat(from, hit.unit / 4)) * 4)) }));
}

// The song's harmony result made from the aligned score: the Harmonic (ensemble) part is the restored notes only,
// on the beats the score was laid on (each at its written place on that grid, played as the stem plays it); the
// analysis's chord names, bass notes and drum hits are kept, moved onto those beats. What the score does not have
// is not in it.
export interface HarmonyDocument {
  beats: number[]; firstBar: number;
  ensemble?: HarmonyPart; stems?: Record<string, HarmonyPart | undefined>;
  [field: string]: unknown;
}
export function harmonyFromScore(analysis: HarmonyDocument, alignment: Alignment, fit: MeasureFit | null,
  fromScore: { title: string; correctedBars: number; family?: 'guitar' | 'keys'; scoreSavedAt?: string }): HarmonyDocument {
  const beats = fit?.beats ?? analysis.beats, firstBar = fit?.firstBar ?? analysis.firstBar;
  const unitAt = (time: number) => Math.round(beatPosition(beats, time) * 4);
  const moved = (part: HarmonyPart | undefined): HarmonyPart | undefined => part && {
    ...part,
    notes: part.notes.map(note => {
      const unit = Math.max(0, unitAt(note.start));
      return { ...note, unit, length: Math.max(1, unitAt(note.end) - unit) };
    }),
    ...(part.hits ? { hits: regridHits(part.hits, analysis.beats, beats) } : {}),
  };
  const notes: HarmonyNote[] = alignment.notes.map(note => {
    const unit = Math.max(0, unitAt(alignment.timeAt(note.written.start)));
    const end = unitAt(alignment.timeAt(note.written.start + note.written.length));
    return { start: note.start, end: note.end, pitch: note.pitch, unit, length: Math.max(1, end - unit), velocity: note.velocity, confidence: 1 };
  }).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  // The score's sung line (the parts given to the vocals), where the score writes it, for parts that play the score.
  const melody: HarmonyNote[] = alignment.missing.filter(note => note.part === 'vocals').map(note => {
    const unit = Math.max(0, unitAt(note.start));
    return { start: note.start, end: note.end, pitch: note.pitch, unit, length: Math.max(1, unitAt(note.end) - unit), velocity: 100, confidence: 1 };
  }).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const { second: _second, repeats: _repeats, corrections: _corrections, ...ensemble } = analysis.ensemble ?? { chords: [], notes: [] };
  // With the score laid measure by measure, the chords and the bass line are the score's too: nothing the analysis
  // found that the score does not have is kept.
  const key = ensemble.key;
  const chords = fit ? fit.chords.map(chord => ({ start: Math.round(chord.start * 1000) / 1000, name: chordName(chord, key) })) : ensemble.chords ?? [];
  const bassNotes = fit?.bass?.map(note => {
    const unit = Math.max(0, unitAt(alignment.timeAt(note.written.start)));
    const end = unitAt(alignment.timeAt(note.written.start + note.written.length));
    return { start: note.start, end: note.end, pitch: note.pitch, unit, length: Math.max(1, end - unit), velocity: note.velocity, confidence: 1 };
  }).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return {
    ...analysis, beats, firstBar,
    ensemble: { ...ensemble, chords, notes, ...(melody.length ? { melody } : {}) },
    stems: Object.fromEntries(Object.entries(analysis.stems ?? {}).map(([name, part]) => [name,
      name === 'bass' && part && bassNotes ? { ...part, chords, notes: bassNotes, second: undefined, repeats: undefined, corrections: undefined } : moved(part)])),
    fromScore: {
      title: fromScore.title, measures: alignment.measures.length, notes: notes.length, correctedBars: fromScore.correctedBars,
      heard: alignment.notes.filter(note => note.found !== false).length,
      ...(fromScore.family ? { family: fromScore.family } : {}),
      ...(fromScore.scoreSavedAt ? { scoreSavedAt: fromScore.scoreSavedAt } : {}),
      // Where each of the score's measures is in the song (– for a bar it does not have), for the spectrum page.
      bars: alignment.measures.map(measure => ({ number: measure.number, start: Math.round(measure.start * 1000) / 1000,
        end: Math.round(measure.end * 1000) / 1000, ...(measure.onBeat ? {} : { corrected: true }) })),
    },
  };
}

// A part moved onto other beats: its notes (song seconds) placed again as sixteenths of the new beats, its drum hits
// from the old beats to the new.
export function movePart(part: HarmonyPart | undefined, from: number[], to: number[]): HarmonyPart | undefined {
  if (!part) return part;
  const unitAt = (time: number) => Math.round(beatPosition(to, time) * 4);
  const placed = (note: HarmonyNote) => {
    const unit = Math.max(0, unitAt(note.start));
    return { ...note, unit, length: Math.max(1, unitAt(note.end) - unit) };
  };
  return {
    ...part, notes: part.notes.map(placed),
    ...(part.second ? { second: part.second.map(placed) } : {}),
    ...(part.melody ? { melody: part.melody.map(placed) } : {}),
    ...(part.hits ? { hits: regridHits(part.hits, from, to) } : {}),
  };
}
// The whole result moved onto other beats (a later score laid on the song corrected them).
export function moveDocument(document: HarmonyDocument, beats: number[], firstBar: number): HarmonyDocument {
  const from = document.beats;
  return {
    ...document, beats, firstBar,
    ...(document.ensemble ? { ensemble: movePart(document.ensemble, from, beats) } : {}),
    stems: Object.fromEntries(Object.entries(document.stems ?? {}).map(([name, part]) => [name, movePart(part, from, beats)])),
  };
}

// What a score laid on the song tells of itself, for the page: its measures, notes (hits for drums), how many were
// heard in the stem, how many drum bars it corrected, and where each of its measures is in the song.
export interface ScoreSummary {
  title: string; measures: number; notes: number; heard: number; correctedBars: number;
  family?: 'guitar' | 'keys'; scoreSavedAt?: string;
  bars: { number: string; start: number; end: number; corrected?: true }[];
}
const barsOf = (placed: PlacedMeasure[]) => placed.map(place => ({ number: place.number, start: Math.round(place.start * 1000) / 1000,
  end: Math.round(place.end * 1000) / 1000, ...(place.corrected ? { corrected: true as const } : {}) }));

// A drum score laid measure by measure on the drum beats (layOnBeats), each measure compared with the drum
// transcription's hits over the beats it is laid on: a written hit counts as found where the same drum is heard on
// that sixteenth or the next either side (a hi-hat for a cymbal, or a tom for a snare, half); unlike is one less
// how much the written and heard hits have in common (Dice). Drum bars repeat one another far more than a song's
// harmony does, so the score is laid as played (its repeats taken) and leaving its order costs DRUM_JUMP. The song's
// drums become the score's hits, every one, on the corrected beats.
const DRUM_KIN: Partial<Record<string, string>> = { hihat: 'cymbal', cymbal: 'hihat', tom: 'snare', snare: 'tom' };
export interface DrumFit { placed: PlacedMeasure[]; beats: number[]; firstBar: number; corrections: MeasureFit['corrections']; hits: DrumHit[]; heard: number }
const DRUM_JUMP = 3;
export function fitDrumScore(printed: Score, heardHits: DrumHit[], beats: number[], firstBar: number, fixed = false): DrumFit {
  if (!printed.hits?.length) throw new Error('No drum notes were found in the score.');
  const score = unrollRepeats(printed);
  const original = beats;
  if (!fixed) {
    beats = repairBeats(beats);
    heardHits = regridHits(heardHits, original, beats);
  }
  const heard = new Map<number, Set<string>>();
  for (const hit of heardHits) (heard.get(hit.unit) ?? heard.set(hit.unit, new Set()).get(hit.unit)!).add(hit.drum);
  const units = [...heard.keys()].sort((a, b) => a - b);
  const countIn = (from: number, to: number) => {
    let total = 0;
    for (const unit of units) if (unit >= from && unit < to) total += heard.get(unit)!.size;
    return total;
  };
  const byMeasure = score.measures.map((_, index) => score.hits!.filter(hit => hit.measure === index));
  const found = (unit: number, drum: string) => {
    let best = 0;
    for (const near of [unit, unit - 1, unit + 1]) {
      const drums = heard.get(near);
      if (!drums) continue;
      if (drums.has(drum)) return 1;
      if (DRUM_KIN[drum] && drums.has(DRUM_KIN[drum]!)) best = 0.5;
    }
    return best;
  };
  const unlike = (index: number, from: number, count: number) => {
    const measure = score.measures[index], written = byMeasure[index];
    const heardCount = countIn(from * 4, (from + count) * 4);
    if (!written.length) return heardCount ? Math.min(1, heardCount / 8) : 0;
    let matched = 0;
    for (const hit of written) matched += found(Math.round(4 * (from + (hit.start - measure.start) / measure.length * count)), hit.drum);
    return 1 - 2 * matched / (written.length + heardCount);
  };
  const loudness = (from: number, count: number) => Math.min(1, countIn(from * 4, (from + count) * 4) / (count * 2));
  const laying = layOnBeats(score, beats, firstBar, unlike, loudness, DRUM_JUMP, original, fixed);
  const hits = (laying.laid.hits ?? []).map(hit => ({ unit: Math.round((laying.first + hit.start) * 4), drum: hit.drum as DrumHit['drum'] }))
    .sort((a, b) => a.unit - b.unit);
  // How many of the score's hits the transcription has, on the mended beats it was compared on.
  const moved = regridHits(hits, laying.beats, beats);
  const heardCount = moved.filter(hit => found(hit.unit, hit.drum) === 1).length;
  return { placed: laying.placed, beats: laying.beats, firstBar: laying.firstBar, corrections: laying.corrections, hits, heard: heardCount };
}
export function drumsFromScore(document: HarmonyDocument, fit: DrumFit, title: string, scoreSavedAt?: string): { document: HarmonyDocument; summary: ScoreSummary } {
  const moved = moveDocument(document, fit.beats, fit.firstBar);
  const part = moved.stems?.drums ?? { chords: [], notes: [] };
  const { second: _second, repeats: _repeats, corrections: _corrections, ...rest } = part as HarmonyPart & Record<string, unknown>;
  return {
    document: { ...moved, stems: { ...moved.stems, drums: { ...rest, notes: [], hits: fit.hits } } },
    summary: { title, measures: fit.placed.filter(place => place.measure !== null).length, notes: fit.hits.length, heard: fit.heard,
      correctedBars: fit.corrections.bars, ...(scoreSavedAt ? { scoreSavedAt } : {}), bars: barsOf(fit.placed) },
  };
}

// A bass score's notes laid on the song (fitMeasures, with the bass stem in the Harmonic stem's place), every one,
// as the bass stem plays them where it is heard: the song's bass part, on the corrected beats.
export function bassFromScore(document: HarmonyDocument, fit: MeasureFit, title: string, scoreSavedAt?: string): { document: HarmonyDocument; summary: ScoreSummary } {
  const moved = moveDocument(document, fit.beats, fit.firstBar);
  const unitAt = (time: number) => Math.round(beatPosition(fit.beats, time) * 4);
  const notes: HarmonyNote[] = fit.alignment.notes.map(note => {
    const unit = Math.max(0, unitAt(fit.alignment.timeAt(note.written.start)));
    const end = unitAt(fit.alignment.timeAt(note.written.start + note.written.length));
    return { start: note.start, end: note.end, pitch: note.pitch, unit, length: Math.max(1, end - unit), velocity: note.velocity, confidence: 1 };
  }).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const part = moved.stems?.bass ?? { chords: moved.ensemble?.chords ?? [], notes: [] };
  const { second: _second, repeats: _repeats, corrections: _corrections, ...rest } = part as HarmonyPart & Record<string, unknown>;
  return {
    document: { ...moved, stems: { ...moved.stems, bass: { ...rest, chords: moved.ensemble?.chords ?? part.chords, notes } } },
    summary: { title, measures: fit.placed.filter(place => place.measure !== null).length, notes: notes.length,
      heard: fit.alignment.notes.filter(note => note.found !== false).length, correctedBars: fit.corrections.bars,
      ...(scoreSavedAt ? { scoreSavedAt } : {}), bars: barsOf(fit.placed) },
  };
}

// Chords as the score prints them, and where it prints none (or its symbols could not be read), named from its
// notes, a measure at a time: the pitch classes sounding (as long as they sound; the
// sung line counts half), matched to the chord shapes below (the closest shape wins; a seventh or a suspension must
// earn its place by CHORD_EXTRA), and the lowest note as the bass when it is not the root. A measure's second half
// gets its own chord where it is clearly another. Measures the score does not have (`written` false) are N.C.
const CHORD_SHAPES: [string, number[]][] = [['', [0, 4, 7]], ['m', [0, 3, 7]], ['7', [0, 4, 7, 10]], ['maj7', [0, 4, 7, 11]],
  ['m7', [0, 3, 7, 10]], ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]], ['dim', [0, 3, 6]]];
const CHORD_EXTRA = 0.01, CHORD_CHANGE = 0.08, BASS_ROOT = 0.03;
export function nameChord(weights: number[], lowest: number | null): { root: number; quality: string; bass: number; fit: number } | null {
  const total = weights.reduce((sum, value) => sum + value * value, 0);
  if (total <= 0) return null;
  let best: { root: number; quality: string; bass: number; fit: number } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const [quality, shape] of CHORD_SHAPES) {
      let dot = 0;
      for (const step of shape) dot += weights[(root + step) % 12];
      // Between shapes that fit alike, the one built on the lowest note.
      const fit = dot / Math.sqrt(total * shape.length) - (quality === '' || quality === 'm' ? 0 : CHORD_EXTRA) + (root === lowest ? BASS_ROOT : 0);
      if (!best || fit > best.fit) best = { root, quality, bass: root, fit };
    }
  }
  if (best && lowest !== null && lowest !== best.root) {
    const shape = CHORD_SHAPES.find(([name]) => name === best!.quality)![1];
    // A bass on another chord tone, or a passing one held long enough to count, is written after a slash.
    if (shape.some(step => (best!.root + step) % 12 === lowest) || weights[lowest] > 0) best.bass = lowest;
  }
  return best;
}

export function scoreChords(laid: Score, written: boolean[], timeAt: (quarter: number) => number, shift: number,
  stemOf: (note: ScoreNote) => AlignStem | null): MeasureFit['chords'] {
  const chords: MeasureFit['chords'] = [];
  const add = (start: number, chord: { root: number; quality: string; bass: number } | null) => {
    const last = chords[chords.length - 1];
    const same = (a: MeasureFit['chords'][number], b: { root: number; quality: string; bass: number } | null) =>
      b ? a.root === b.root && a.quality === b.quality && a.bass === b.bass : a.quality === 'N.C.';
    if (last && same(last, chord)) return;
    chords.push(chord ? { start, ...chord } : { start, root: 0, quality: 'N.C.', bass: 0 });
  };
  laid.measures.forEach((measure, index) => {
    if (!written[index]) { add(timeAt(measure.start), null); return; }
    // The chord symbols printed in the measure, where printed (moved to the song's key).
    const printed = laid.chords.filter(chord => chord.measure === index);
    if (printed.length) {
      for (const chord of printed) add(timeAt(chord.start), { root: (chord.root + shift + 12) % 12, quality: chord.quality, bass: (chord.bass + shift + 12) % 12 });
      return;
    }
    const span = (from: number, to: number) => {
      const weights = new Array(12).fill(0);
      let lowest: number | null = null, lowestPitch = Infinity;
      for (const note of laid.notes) {
        if (note.measure !== index) continue;
        const overlap = Math.min(to, note.start + note.length) - Math.max(from, note.start);
        if (overlap <= 0) continue;
        const pitch = note.pitch + shift, sung = stemOf(note) === 'vocals';
        weights[((pitch % 12) + 12) % 12] += overlap * (sung ? 0.5 : 1);
        if (!sung && pitch < lowestPitch) { lowestPitch = pitch; lowest = ((pitch % 12) + 12) % 12; }
      }
      return nameChord(weights, lowest);
    };
    const start = measure.start, half = measure.start + measure.length / 2, end = measure.start + measure.length;
    const whole = span(start, end), first = span(start, half), second = span(half, end);
    const split = first && second && (first.root !== second.root || first.quality !== second.quality || first.bass !== second.bass)
      && first.fit + second.fit > 2 * (whole?.fit ?? 0) + CHORD_CHANGE;
    if (split) { add(timeAt(start), first); add(timeAt(half), second); }
    else add(timeAt(start), whole);
  });
  return chords;
}

// A chord's name in the song's key: sharps or flats as the key has them.
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);
export function chordName(chord: { root: number; quality: string; bass: number }, key?: string): string {
  if (chord.quality === 'N.C.') return 'N.C.';
  const names = key && FLAT_KEYS.has(key) ? FLAT_NAMES : SHARP_NAMES;
  return names[chord.root] + chord.quality + (chord.bass !== chord.root ? `/${names[chord.bass]}` : '');
}
