// Live follow: hears the player's strums, compares them with the song's beat map and
// works out how fast the backing stems should play so they stay with the player.
// Pure functions and classes only, so it runs in tests without audio.

// How the backing was stretched during a take, on the take's own clock (seconds into the
// recording). From each point on, the song advanced at `rate` song seconds per second.
export interface TempoPoint { at: number; pos: number; rate: number }

export const MIN_RATE = 0.7;
export const MAX_RATE = 1.3;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function segmentAt(points: TempoPoint[], at: number) {
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (points[middle].at <= at) low = middle; else high = middle - 1;
  }
  return points[low];
}

// Song position heard at take time `at`; before the first point the song runs at normal speed.
export function songPositionAt(points: TempoPoint[], at: number) {
  if (!points.length) return at;
  if (at < points[0].at) return points[0].pos - (points[0].at - at);
  const point = segmentAt(points, at);
  return point.pos + (at - point.at) * point.rate;
}

export function rateAt(points: TempoPoint[], at: number) {
  return points.length && at >= points[0].at ? segmentAt(points, at).rate : 1;
}

// The take time at which the song reached `pos`; the inverse of songPositionAt.
export function takeTimeAt(points: TempoPoint[], pos: number) {
  if (!points.length) return pos;
  if (pos < points[0].pos) return points[0].at - (points[0].pos - pos);
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (points[middle].pos <= pos) low = middle; else high = middle - 1;
  }
  const point = points[low];
  return point.at + (pos - point.pos) / point.rate;
}

// Fractional beat index of a song position, continuing the edge tempo outside the map.
export function beatAt(beats: number[], pos: number) {
  const last = beats.length - 1;
  if (last < 1) return 0;
  if (pos <= beats[0]) return (pos - beats[0]) / (beats[1] - beats[0]);
  if (pos >= beats[last]) return last + (pos - beats[last]) / (beats[last] - beats[last - 1]);
  let low = 0, high = last - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (beats[middle] <= pos) low = middle; else high = middle - 1;
  }
  return low + (pos - beats[low]) / (beats[low + 1] - beats[low]);
}

// Song seconds per beat around a fractional beat index.
function beatLength(beats: number[], beat: number) {
  const index = clamp(Math.floor(beat), 0, beats.length - 2);
  return beats[index + 1] - beats[index];
}

// Finds note attacks: a sudden rise in high-passed loudness above the last few
// milliseconds, loud enough above the background, and not right after another one.
export class OnsetDetector {
  private readonly hop: number;
  private previous = 0;
  private filled = 0;
  private energy = 0;
  private hopStart = 0;
  private readonly recent: number[] = [];
  private floor = -60;
  private last = -Infinity;
  constructor(private readonly sampleRate: number, private readonly options = { hop: 256, rise: 9, aboveFloor: 14, gap: 0.08, silence: -58 }) {
    this.hop = options.hop;
  }

  // `when` is the take time of the first sample. Returns the take times of new onsets.
  push(samples: Float32Array, when: number): number[] {
    const found: number[] = [];
    for (let index = 0; index < samples.length; index++) {
      if (this.filled === 0) this.hopStart = when + index / this.sampleRate;
      const sample = samples[index], emphasised = sample - 0.95 * this.previous;
      this.previous = sample;
      this.energy += emphasised * emphasised;
      if (++this.filled < this.hop) continue;
      const level = 10 * Math.log10(this.energy / this.hop + 1e-12);
      this.filled = 0; this.energy = 0;
      const before = this.recent.length ? Math.min(...this.recent) : level;
      const { rise, aboveFloor, gap, silence } = this.options;
      if (level - before >= rise && level - this.floor >= aboveFloor && level > silence && this.hopStart - this.last >= gap) {
        this.last = this.hopStart;
        found.push(this.hopStart);
      }
      this.recent.push(level);
      if (this.recent.length > 4) this.recent.shift();
      // The background level falls quickly and creeps up slowly, so notes do not raise it much.
      this.floor = level < this.floor ? level : this.floor + 0.02;
    }
    return found;
  }
}

export interface FollowStatus { rate: number; tempo: number; beat: number; locked: boolean }

// Strength 0 follows only lasting tempo changes; 1 reacts within about a beat.
export class Follower {
  rate = 1;
  tempo = 1;
  beat = 0;
  private history: { at: number; beat: number }[] = [];
  private misses = 0;
  private settleAt = Infinity;
  private lastMatch = -Infinity;
  constructor(private readonly beats: number[], private readonly strength = 0.5) {}

  get status(): FollowStatus {
    return { rate: this.rate, tempo: this.tempo, beat: this.beat, locked: this.history.length >= 3 };
  }

  // `at` is when the note was played (take seconds); `pos` is the song position the player heard then.
  // Returns the new stem speed, or null when this note is not used.
  onset(at: number, pos: number): number | null {
    if (this.beats.length < 2) return null;
    const heard = beatAt(this.beats, pos);
    // Where the player should be by their own recent timing; the band is only a fallback.
    const lost = this.misses >= 3;
    const model = lost ? null : this.playerLine();
    const expected = model ? model.beat + (at - model.at) * model.speed : heard;
    const whole = Math.round(expected), half = Math.round(expected * 2) / 2;
    let target: number;
    if (Math.abs(whole - expected) <= (lost ? 0.45 : 0.3)) target = whole;
    else if (!lost && Math.abs(half - expected) <= 0.15) target = half;
    else { this.misses++; return null; }
    // A note that would put the player back in time is a stray, not a beat.
    if (this.history.length && target <= this.history[this.history.length - 1].beat) { this.misses++; return null; }
    this.misses = 0;
    if (lost) this.history = [];
    this.beat = target;
    this.lastMatch = at;
    this.history.push({ at, beat: target });
    this.history = this.history.filter(point => target - point.beat <= 6);
    const length = beatLength(this.beats, target);
    const line = this.playerLine();
    if (line) {
      const played = clamp(line.speed * length, MIN_RATE, MAX_RATE);
      this.tempo += (played - this.tempo) * (0.4 + 0.6 * this.strength);
    }
    // Close the gap to the player over a few beats: positive when the player is ahead.
    const ahead = target - heard, over = 1 + 3 * (1 - this.strength);
    this.rate = clamp(this.tempo * (1 + ahead / over), Math.max(MIN_RATE, this.tempo * 0.85), Math.min(MAX_RATE, this.tempo * 1.15));
    this.settleAt = at + over * length / this.tempo;
    return this.rate;
  }

  // A straight line through the player's recent notes: their beat at a time and beats per second.
  // Recent notes weigh more so a tempo change shows up within a couple of beats.
  private playerLine() {
    const points = this.history;
    if (points.length < 3 || points[points.length - 1].beat - points[0].beat < 1.5) return null;
    const last = points[points.length - 1];
    let total = 0, meanAt = 0, meanBeat = 0;
    const weights = points.map(point => 0.6 ** (last.beat - point.beat));
    points.forEach((point, index) => { total += weights[index]; meanAt += weights[index] * point.at; meanBeat += weights[index] * point.beat; });
    meanAt /= total; meanBeat /= total;
    let top = 0, bottom = 0;
    points.forEach((point, index) => { top += weights[index] * (point.at - meanAt) * (point.beat - meanBeat); bottom += weights[index] * (point.at - meanAt) ** 2; });
    if (bottom <= 0 || top <= 0) return null;
    const speed = top / bottom;
    return { at: last.at, beat: meanBeat + (last.at - meanAt) * speed, speed };
  }

  // Call regularly: once the catch-up has had its time, play at the player's tempo.
  idle(at: number): number | null {
    if (at < this.settleAt || this.rate === this.tempo) return null;
    this.settleAt = Infinity;
    this.rate = this.tempo;
    return this.rate;
  }

  get lastNote() { return this.lastMatch; }
}
