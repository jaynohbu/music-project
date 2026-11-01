export interface Region { start: number; end: number }
export interface StemAnalysis { name: string; peaks: Float32Array; levels: Float32Array; active: Uint8Array }
export interface LoudnessProfile { target: number; gains: Float32Array }

export const HOP_SECONDS = 0.05;
export const MINIMUM_REGION = 0.05;
const PEAK_BINS = 1200;
const dB = (value: number): number => 10 ** (value / 20);
// Separation leaves faint bleed in every stem, so "audible" is relative to the
// stem's own loud passages as well as an absolute floor.
const ABSOLUTE_FLOOR = dB(-50);
const RELATIVE_FLOOR = dB(-30);
const BRIDGE_GAP = 1;
const SHORTEST_DETECTED = 0.5;
const DETECTED_MARGIN = 0.1;
// A region dragged over silent source audio stays quietly audible, not removed.
const MINIMUM_GAIN = dB(-18);
const MAXIMUM_GAIN = dB(6);
const ATTACK_SECONDS = 0.1;
const RELEASE_SECONDS = 0.5;
const FADE_SECONDS = 0.01;
const PEAK_CEILING = 0.85;
const SILENCE = 0.000001;
const FALLBACK_TARGET = 0.12;

const roundTime = (value: number): number => Math.round(value * 100) / 100;

export function analyzeStem(name: string, channels: Float32Array[], sampleRate: number): StemAnalysis {
  const length = channels[0]?.length ?? 0;
  const peaks = new Float32Array(PEAK_BINS);
  const hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
  const levels = new Float32Array(Math.ceil(length / hop));
  for (const channel of channels) {
    for (let frame = 0; frame < levels.length; frame++) {
      const end = Math.min(length, (frame + 1) * hop);
      let energy = 0;
      for (let i = frame * hop; i < end; i++) energy += channel[i] * channel[i];
      levels[frame] += energy / (end - frame * hop) / channels.length;
    }
    for (let bin = 0; bin < PEAK_BINS; bin++) {
      const end = Math.floor((bin + 1) * length / PEAK_BINS);
      let peak = peaks[bin];
      for (let i = Math.floor(bin * length / PEAK_BINS); i < end; i++) {
        const value = Math.abs(channel[i]);
        if (value > peak) peak = value;
      }
      peaks[bin] = peak;
    }
  }
  for (let frame = 0; frame < levels.length; frame++) levels[frame] = Math.sqrt(levels[frame]);
  return { name, peaks, levels, active: activeFrames(levels) };
}

function activeFrames(levels: Float32Array): Uint8Array {
  const audible = [...levels].filter(level => level >= ABSOLUTE_FLOOR).sort((a, b) => a - b);
  const active = new Uint8Array(levels.length);
  if (!audible.length) return active;
  const threshold = Math.max(ABSOLUTE_FLOOR, audible[Math.floor((audible.length - 1) * 0.95)] * RELATIVE_FLOOR);
  for (let frame = 0; frame < levels.length; frame++) active[frame] = levels[frame] >= threshold ? 1 : 0;
  return active;
}

export function normalizeRegions(regions: Region[], duration: number): Region[] {
  const clamped = regions
    .map(({ start, end }) => ({
      start: roundTime(Math.max(0, Math.min(start, duration))),
      end: Math.min(duration, roundTime(Math.max(0, end))),
    }))
    .filter(region => Number.isFinite(region.start) && Number.isFinite(region.end) &&
      region.end - region.start >= MINIMUM_REGION)
    .sort((a, b) => a.start - b.start);
  const merged: Region[] = [];
  for (const region of clamped) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) last.end = Math.max(last.end, region.end);
    else merged.push({ ...region });
  }
  return merged;
}

export function detectRegions(stems: StemAnalysis[], duration: number): Region[] {
  const frames = Math.max(0, ...stems.map(stem => stem.active.length));
  const runs: Region[] = [];
  let open = -1;
  for (let frame = 0; frame <= frames; frame++) {
    const active = frame < frames && stems.some(stem => stem.active[frame]);
    if (active && open < 0) open = frame;
    if (!active && open >= 0) { runs.push({ start: open * HOP_SECONDS, end: frame * HOP_SECONDS }); open = -1; }
  }
  const bridged: Region[] = [];
  for (const run of runs) {
    const last = bridged[bridged.length - 1];
    if (last && run.start - last.end < BRIDGE_GAP) last.end = run.end;
    else bridged.push(run);
  }
  return normalizeRegions(bridged.filter(run => run.end - run.start >= SHORTEST_DETECTED)
    .map(run => ({ start: run.start - DETECTED_MARGIN, end: run.end + DETECTED_MARGIN })), duration);
}

const inRegions = (frame: number, regions: Region[]): boolean => {
  const time = (frame + 0.5) * HOP_SECONDS;
  return regions.some(region => time >= region.start && time < region.end);
};

// The target is the sources' average loudness while they play inside the selection;
// gains make the accompaniment rise and fall with them around that average.
export function loudnessProfile(stems: StemAnalysis[], regions: Region[]): LoudnessProfile {
  const frames = Math.max(0, ...stems.map(stem => stem.levels.length));
  const combined = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let energy = 0, playing = 0;
    for (const stem of stems) {
      if (!stem.active[frame]) continue;
      energy += stem.levels[frame] * stem.levels[frame];
      playing++;
    }
    combined[frame] = playing ? Math.sqrt(energy / playing) : 0;
  }
  const average = (selected: (frame: number) => boolean): number => {
    let energy = 0, count = 0;
    for (let frame = 0; frame < frames; frame++) {
      if (combined[frame] > 0 && selected(frame)) { energy += combined[frame] * combined[frame]; count++; }
    }
    return count ? Math.sqrt(energy / count) : 0;
  };
  const target = average(frame => inRegions(frame, regions)) || average(() => true);
  if (!target) return { target: FALLBACK_TARGET, gains: new Float32Array(frames).fill(1) };
  const attack = Math.exp(-HOP_SECONDS / ATTACK_SECONDS), release = Math.exp(-HOP_SECONDS / RELEASE_SECONDS);
  const gains = new Float32Array(frames);
  let smooth = target;
  for (let frame = 0; frame < frames; frame++) {
    const coefficient = combined[frame] > smooth ? attack : release;
    smooth = combined[frame] + (smooth - combined[frame]) * coefficient;
    gains[frame] = Math.min(MAXIMUM_GAIN, Math.max(MINIMUM_GAIN, smooth / target));
  }
  return { target, gains };
}

function activeRms(channels: Float32Array[]): { rms: number; peak: number } {
  let energy = 0, count = 0, peak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      const size = Math.abs(sample);
      if (size > peak) peak = size;
      if (size > SILENCE) { energy += sample * sample; count++; }
    }
  }
  return { rms: count ? Math.sqrt(energy / count) : 0, peak };
}

const scaleChannels = (channels: Float32Array[], scale: number): void => {
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= scale;
};

// Follows source loudness, zeroes everything outside the regions, then matches the
// source average. `exact` measures the finished result; a short preview keeps the
// flat-instrument scale so a quiet excerpt stays quiet as it will in the full song.
export function shapeRender(
  channels: Float32Array[], sampleRate: number, offset: number,
  profile: LoudnessProfile, regions: Region[], exact: boolean,
): void {
  const flat = activeRms(channels);
  if (!flat.rms) throw new Error('The chosen chords produced no audible accompaniment.');
  const fadeLength = FADE_SECONDS * sampleRate;
  const length = channels[0].length;
  const lastGain = profile.gains.length - 1;
  let index = 0;
  for (let i = 0; i < length; i++) {
    const time = offset + i / sampleRate;
    while (index < regions.length && time >= regions[index].end) index++;
    const region = regions[index];
    let gain = 0;
    if (region && time >= region.start) {
      const position = Math.max(0, Math.min(lastGain, time / HOP_SECONDS));
      const frame = Math.floor(position);
      const next = Math.min(lastGain, frame + 1);
      gain = lastGain < 0 ? 1 : profile.gains[frame] + (profile.gains[next] - profile.gains[frame]) * (position - frame);
      const fromEdge = Math.min(time - region.start, region.end - time) * sampleRate;
      if (fromEdge < fadeLength) gain *= fromEdge / fadeLength;
    }
    for (const channel of channels) channel[i] *= gain;
  }
  const shaped = activeRms(channels);
  if (!shaped.rms) throw new Error('The chosen chords produced no audible accompaniment.');
  const level = exact ? shaped.rms : flat.rms;
  scaleChannels(channels, Math.min(profile.target / level, PEAK_CEILING / shaped.peak));
}

export function regionHasChord(region: Region, chords: readonly { start: number; end: number; chord: string }[]): boolean {
  return chords.some(chord => chord.chord !== 'N' && chord.start < region.end && chord.end > region.start);
}

export function largestGap(regions: Region[], duration: number): Region | undefined {
  let best: Region | undefined, cursor = 0;
  for (const region of [...regions, { start: duration, end: duration }]) {
    if (region.start - cursor >= MINIMUM_REGION && (!best || region.start - cursor > best.end - best.start)) {
      best = { start: cursor, end: region.start };
    }
    cursor = region.end;
  }
  return best;
}

export function waveformPath(peaks: Float32Array, scale: number): string {
  if (!scale || !peaks.length) return '';
  const width = 1000 / peaks.length;
  let path = '';
  for (let bin = 0; bin < peaks.length; bin++) {
    const height = Math.max(0.5, peaks[bin] / scale * 50);
    path += `M${(bin * width).toFixed(1)} ${(50 - height).toFixed(1)}v${(height * 2).toFixed(1)}h${width.toFixed(2)}v${(-height * 2).toFixed(1)}z`;
  }
  return path;
}
