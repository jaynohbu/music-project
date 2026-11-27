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
import type { Score, ScoreNote } from './musicxml';
import type { HarmonyGrid, HarmonyNote } from './services';

export type AlignStem = 'vocals' | 'bass' | 'drums' | 'other';
export const PITCHED_STEMS: readonly AlignStem[] = ['vocals', 'bass', 'other'];
export const FEATURE_FRAMES = 2;          // Spectrogram frames per feature step (about 46 ms).
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
const VELOCITY_DB = 36;
const DECAY_DB = 25;
const SPILL_DB = 24;                      // Another stem this much louder at a pitch: the other stem only has its spill.

export interface StemFeatures { chroma: Float32Array; loudness: Float32Array; onsets: Float32Array; steps: number }
export interface AlignedMeasure { index: number; number: string; start: number; end: number; onBeat: boolean }
export interface PartMatch { part: number; staff: number; name: string; stem: AlignStem | null; likeness: Partial<Record<AlignStem, number>> }
export interface RestoredNote {
  pitch: number; start: number; end: number; velocity: number; measure: number;
  // As written (moved by the key shift), in quarter notes, and how far above its usual level each stem has it, dB.
  written: { pitch: number; start: number; length: number };
  heard: Partial<Record<AlignStem, number>>;
  octave: number;                         // Semitones moved to the octave the stem plays: -12, 0 or 12.
}
export interface MissingNote { pitch: number; start: number; end: number; measure: number; stems: AlignStem[] }
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
const stepSeconds = (spectrogram: Spectrogram) => FEATURE_FRAMES * HOP / spectrogram.rate;
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
export function stemFeatures(spectrogram: Spectrogram, frames = spectrogram.frames): StemFeatures {
  const steps = Math.max(1, Math.floor(Math.min(frames, spectrogram.frames) / FEATURE_FRAMES));
  const chroma = new Float32Array(steps * DIMENSIONS), loudness = new Float32Array(steps * PITCH_CLASSES);
  const energy = new Float32Array(steps), flux = new Float32Array(steps);
  const { levels } = spectrogram;
  const silence = Math.log1p(COMPRESSION * 10 ** (-SILENT_DB / 20));
  for (let step = 0; step < steps; step++) {
    for (let k = 0; k < FEATURE_FRAMES; k++) {
      const frame = step * FEATURE_FRAMES + k, base = frame * ROWS;
      for (let pitch = LOWEST_CHROMA_PITCH; pitch <= HIGHEST_CHROMA_PITCH; pitch++) {
        // A peak among its neighbouring semitones counts fully, the rest a little: low notes, whose windows cannot
        // tell semitones apart well, would otherwise spread over three (two notes a semitone apart are both peaks
        // only where the window tells them apart).
        const level = levels[base + rowOf(pitch)];
        const peak = level >= levels[base + rowOf(pitch - 1)] && level >= levels[base + rowOf(pitch + 1)];
        const value = (peak ? 1 : SHOULDER) * Math.max(0, Math.log1p(COMPRESSION * 10 ** (level / 20)) - silence) / FEATURE_FRAMES;
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
}

export function alignScore({ score, spectrograms, seconds, beats, intro }: AlignInput): Alignment {
  // Measures after the last note (rests to the end of a page) match anything; they are left out.
  const lastSound = Math.max(...score.notes.map(note => note.start + note.length));
  const kept = score.measures.filter((measure, index) => index === 0 || measure.start < lastSound - 1e-6);
  if (kept.length < score.measures.length) score = { ...score, measures: kept, chords: score.chords.filter(chord => chord.start < lastSound) };
  const other = spectrograms.other;
  if (!other) throw new Error('The Harmonic stem is needed.');
  if (!score.notes.length) throw new Error('The score has no notes.');
  const step = stepSeconds(other);
  const frames = Math.min(other.frames, Math.ceil(seconds * other.rate / HOP));
  const stems = (Object.keys(spectrograms) as AlignStem[]).filter(stem => spectrograms[stem]!.rate === other.rate);
  const features = Object.fromEntries(stems.map(stem => [stem, stemFeatures(spectrograms[stem]!, frames)])) as Partial<Record<AlignStem, StemFeatures>>;
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
  const parts: PartMatch[] = groups.map(([part, staff]) => {
    const drawn = scoreFeatures(score, step, best!.secondsPerQuarter, best!.shift, note => note.part === part && note.staff === staff, false);
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
    const name = (score.parts[part]?.name ?? `Part ${part + 1}`) + (staves.has(part) ? ` (staff ${staff})` : '');
    return { part, staff, name, stem: ranked[0] && ranked[0][1] >= PART_LEAST ? ranked[0][0] : null, likeness };
  });

  // Second pass, at the tempo the first found: each stem against its own parts (parts given to no stem, against the
  // stems together).
  const found = best;
  // With the song's beats the tempo guessed from them stands (the path drifts where the music holds still);
  // without, the path's own.
  const tempo = beats && beats.length > 2 ? found.secondsPerQuarter
    : found.secondsPerQuarter * (found.path[found.path.length - 1] - found.path[0] + 1) / found.path.length;
  const ownStem = (note: ScoreNote) => parts.find(part => part.part === note.part && part.staff === note.staff)?.stem ?? null;
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
  const stemOf = (note: ScoreNote) => parts.find(part => part.part === note.part && part.staff === note.staff)?.stem ?? null;
  const { notes, missing } = restore(score, spectrograms, timeAt, best.shift, beatGap, stemOf);
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

function restore(score: Score, spectrograms: Partial<Record<AlignStem, Spectrogram>>, timeAt: (quarter: number) => number,
  shift: number, beatGap: (time: number) => number, stemOf: (note: ScoreNote) => AlignStem | null): { notes: RestoredNote[]; missing: MissingNote[] } {
  const other = spectrograms.other!;
  const perSecond = other.rate / HOP;
  const frameAt = (time: number) => Math.round(time * perSecond);
  const lastNote = Math.max(...score.notes.map(note => timeAt(note.start + note.length)));
  const lookFrames = Math.min(other.frames, frameAt(lastNote + 2));
  const stems = (Object.keys(spectrograms) as AlignStem[]).filter(stem => stem !== 'drums' && spectrograms[stem]!.rate === other.rate);
  // Floors over the whole stretch the stems were searched in, so a pitch the score holds throughout still stands out.
  const floors = Object.fromEntries(stems.map(stem => [stem, floorsOf(spectrograms[stem]!, Math.min(spectrograms[stem]!.frames, Math.max(lookFrames, frameAt(60))))])) as Record<AlignStem, Float32Array>;
  // How far above its usual level a stem has a pitch over a note's first moments, dB (mean over the frames).
  const above = (stem: AlignStem, pitch: number, from: number, to: number) => {
    const spectrogram = spectrograms[stem]!;
    if (pitch < LOWEST_PITCH || pitch > 108) return -Infinity;
    let sum = 0, count = 0;
    for (let frame = Math.max(0, from); frame < Math.min(to, spectrogram.frames); frame++) { sum += levelAt(spectrogram, frame, pitch) - floors[stem][pitch]; count++; }
    return count ? sum / count : -Infinity;
  };
  const notes: RestoredNote[] = [], missing: MissingNote[] = [];
  // Notes whose pitch the score has sounding up to their start (struck again).
  const struck = new Set(score.notes.filter(note => score.notes.some(before => before !== note && before.pitch === note.pitch
    && before.start < note.start && before.start + before.length > note.start - 1e-6)));
  for (const note of score.notes) {
    const pitch = note.pitch + shift;
    const start = timeAt(note.start), end = Math.max(start + LEAST_LENGTH, timeAt(note.start + note.length));
    const from = frameAt(start), to = Math.max(from + 2, frameAt(Math.min(end, start + LOOK)));
    const heard: Partial<Record<AlignStem, number>> = {};
    for (const stem of stems) heard[stem] = Math.round(above(stem, pitch, from, to) * 10) / 10;
    // The octave the other stem plays it in, when it does not have the written one.
    let octave = 0, level = heard.other ?? -Infinity;
    for (const moved of level < PRESENT_DB ? [-12, 12] : []) {
      const there = above('other', pitch + moved, from, to);
      if (there > level + OCTAVE_BETTER_DB && there >= PRESENT_DB) { octave = moved; level = there; }
    }
    // A part given to another stem: the vocals' is theirs (the other stem's overtones sound at a melody's pitches);
    // another's (a piano's left hand, given to the bass) is restored where the other stem has it, not where what it
    // has is only the other stem's faint spill of that stem.
    const own = stemOf(note);
    const spill = !!own && own !== 'other' && (heard[own] ?? -Infinity) - level > SPILL_DB;
    if (level < PRESENT_DB || own === 'vocals' || spill) {
      missing.push({ pitch, start, end, measure: note.measure, stems: stems.filter(stem => (heard[stem] ?? -Infinity) >= PRESENT_DB) });
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
        missing.push({ pitch, start, end, measure: note.measure, stems: stems.filter(stem => stem !== 'other' && (heard[stem] ?? -Infinity) >= PRESENT_DB) });
        continue;
      }
      attack = from;
    }
    // Velocity from the attack's level against the stem's loudest (0 dB): VELOCITY_DB below it is the softest.
    let peak = -Infinity;
    for (let frame = attack; frame <= Math.min(other.frames - 1, attack + Math.round(0.15 * perSecond)); frame++) peak = Math.max(peak, levelAt(other, frame, played));
    // The end: where the sound sinks to near its usual level or DECAY_DB below its attack (what is left there is
    // the next notes' spill), no later than a little past the written end.
    const floor = floors.other[played] ?? 0, gone = Math.max(floor + PRESENT_DB / 2, peak - DECAY_DB);
    const latest = Math.min(other.frames - 1, frameAt(end + beatGap(end) / 2));
    let last = attack + 1, quiet = 0;
    for (let frame = attack + 1; frame <= latest; frame++) {
      if (levelAt(other, frame, played) < gone) { if (++quiet >= 2) break; } else { quiet = 0; last = frame; }
    }
    notes.push({
      pitch: played, start: attack / perSecond, end: Math.max(attack / perSecond + LEAST_LENGTH, (last + 1) / perSecond),
      velocity: Math.round(20 + 107 * Math.max(0, Math.min(1, 1 + peak / VELOCITY_DB))), measure: note.measure,
      written: { pitch, start: note.start, length: note.length }, heard, octave,
    });
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
