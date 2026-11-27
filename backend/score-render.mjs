// A song's scores played on sampled sounds, made on the server as audio stems (the app plays them with the stems):
// the Harmonic score on guitar and on keys, the bass part on a bass, the drum part on a kit, each in a sound from the
// website's library (web/public/accompaniment) — one note every three semitones, read faster or slower for the
// notes between (a kit: one hit of each drum) — started early by the sound's own attack, and as loud through the song
// as its stem (the result's loudness). Rendered at the song's key: the app moves it with the stems.
//   renderPart: a part whole as one signal; renderStem: a family's part of a result as an AAC file.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const LIBRARY_URL = process.env.ACCOMPANIMENT_URL ?? 'https://tunesbasis.com/accompaniment';
export const SCORE_FAMILIES = ['guitar', 'keys', 'bass', 'drums'];
// The stem whose score each family plays.
export const FAMILY_STEM = { guitar: 'other', keys: 'other', bass: 'bass', drums: 'drums' };
export const RENDER_RATE = 44100;

// Where a family's notes are in its sounds' samples.
export const samplesFor = (library, family) =>
  (family === 'bass' || family === 'drums' ? library.layouts?.[family] : undefined) ?? library.samples;

// The sounds offered for a family: the song's ranked ones first, then the genre group's, then every other.
export function offered(library, choices, family) {
  const group = library.groups[choices?.genre ?? 'pop'] ?? library.groups.pop;
  const ranked = (choices?.[family]?.sounds?.length ? choices[family].sounds : group?.[family] ?? []).filter(sound => library.sounds[String(sound)]);
  const rest = Object.entries(library.sounds).filter(([id, sound]) => sound.family === family && !ranked.includes(Number(id))).map(([id]) => Number(id));
  return [...ranked, ...rest];
}

export function sampleFor(pitches, pitch) {
  let index = 0;
  for (let i = 1; i < pitches.length; i++) if (Math.abs(pitches[i] - pitch) < Math.abs(pitches[index] - pitch)) index = i;
  return { index, rate: 2 ** ((pitch - pitches[index]) / 12) };
}

// The parts a result's families play from: the ensemble is the Harmonic stem's score.
export const resultParts = result => result.ensemble ? { ...result.stems, other: result.ensemble } : result.stems ?? {};
// Whether a family's part was laid from an uploaded score (results from before the bass and drum scores have the
// Harmonic one only).
export const fromScore = (result, family) => {
  const laid = result.fromScore;
  return laid?.parts ? !!laid.parts[FAMILY_STEM[family]] : FAMILY_STEM[family] === 'other' && !!laid;
};

// A drum part's hits as notes for a kit: each drum is its slot, held as its sound rings (a cymbal longest), as loud
// as a drummer plays it (as the website's drumEvents).
export const DRUM_ORDER = ['kick', 'snare', 'tom', 'hihat', 'cymbal'];
const DRUM_PLAY = {
  kick: { duration: 0.6, velocity: 110 }, snare: { duration: 0.6, velocity: 105 }, tom: { duration: 0.8, velocity: 100 },
  hihat: { duration: 0.3, velocity: 80 }, cymbal: { duration: 2.5, velocity: 100 },
};
const beatTime = (beats, beat) => {
  const index = Math.max(0, Math.min(beats.length - 2, Math.floor(beat)));
  return beats[index] + (beat - index) * (beats[index + 1] - beats[index]);
};
// The notes a family plays from a result (none when its part is missing): every note of the part as played (not its
// sung line, which is the vocals'), a kit's drums on the result's beats.
export function familyEvents(family, result) {
  const part = resultParts(result)[FAMILY_STEM[family]];
  if (!part) return [];
  const events = family === 'drums'
    ? (part.hits ?? []).filter(hit => DRUM_PLAY[hit.drum]).map(hit => ({
      time: beatTime(result.beats, hit.unit / 4), duration: DRUM_PLAY[hit.drum].duration,
      pitch: DRUM_ORDER.indexOf(hit.drum), velocity: DRUM_PLAY[hit.drum].velocity,
    }))
    : (part.notes ?? []).map(note => ({ time: note.start, duration: Math.max(0.05, note.end - note.start), pitch: note.pitch, velocity: note.velocity ?? 90 }));
  return events.sort((a, b) => a.time - b.time);
}

// Per sample: seconds until it is heard (its level, a 10 ms running mean, first reaches half its peak in its first
// second), and its level every `window` seconds over its length; from the sound's samples at `rate`.
export function sampleShape(data, rate, samples, window) {
  const smooth = Math.max(1, Math.round(0.01 * rate)), attacks = [], levels = [];
  samples.pitches.forEach((_, index) => {
    const from = Math.round(index * samples.slot * rate), to = Math.min(data.length, from + Math.round(samples.length * rate));
    let sum = 0, peak = 0;
    const look = Math.min(to, from + rate);
    const running = new Float32Array(Math.max(0, look - from));
    for (let at = from; at < look; at++) {
      sum += Math.abs(data[at]) - (at - smooth >= from ? Math.abs(data[at - smooth]) : 0);
      running[at - from] = sum / smooth;
      peak = Math.max(peak, running[at - from]);
    }
    const heard = running.findIndex(value => value >= peak / 2);
    attacks.push(peak > 0 && heard > 0 ? heard / rate : 0);
    const steps = [], size = Math.round(window * rate);
    for (let start = from; start < to; start += size) {
      let energy = 0;
      const end = Math.min(to, start + size);
      for (let at = start; at < end; at++) energy += data[at] * data[at];
      steps.push(Math.sqrt(energy / Math.max(1, end - start)));
    }
    levels.push(steps);
  });
  return { attacks, levels };
}

// How many dB a part must move in each window to be as loud as a recording, against their typical ratio (as the
// website's levelChanges): smoothed over two windows either side, at most four times either way.
export function levelChanges(heard, played) {
  const ratio = heard.map((value, w) => value > 1e-4 && played[w] > 1e-4 ? 20 * Math.log10(value / played[w]) : NaN);
  const valid = ratio.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return { change: heard.map(() => 0), typical: 0 };
  const typical = valid[valid.length >> 1], limit = 20 * Math.log10(4);
  const smooth = ratio.map((_, w) => {
    const near = ratio.slice(Math.max(0, w - 2), w + 3).filter(Number.isFinite).sort((a, b) => a - b);
    return near.length ? Math.max(-limit, Math.min(limit, near[near.length >> 1] - typical)) : NaN;
  });
  const change = smooth.map((_, w) => {
    for (let reach = 0; reach <= 8; reach++) {
      for (const at of [w - reach, w + reach]) if (at >= 0 && at < smooth.length && Number.isFinite(smooth[at])) return smooth[at];
    }
    return 0;
  });
  return { change, typical };
}

const LEVEL = 0.5, MOST_LEAD = 0.25;
// The part's level at which it is as loud as its stem, and its notes' velocities moved to follow the stem's
// loudness: the part's loudness is reckoned from its samples' levels, each note sounding its sample's level curve
// from its start for its length. `heard`: the stem's level every `window` seconds.
export function matchLoudness(events, heard, window, samples, levels) {
  const energy = new Array(heard.length).fill(0);
  for (const event of events) {
    const { index } = sampleFor(samples.pitches, event.pitch);
    const amplitude = (event.velocity / 127) ** 1.5 * LEVEL;
    const first = Math.floor(event.time / window), steps = Math.ceil(event.duration / window);
    for (let k = 0; k < steps && first + k < energy.length && k < levels[index].length; k++) {
      energy[first + k] += (amplitude * levels[index][k]) ** 2;
    }
  }
  const { change, typical } = levelChanges(heard, energy.map(Math.sqrt));
  const at = time => change[Math.max(0, Math.min(change.length - 1, Math.floor(time / window)))] ?? 0;
  return {
    events: events.map(event => ({ ...event, velocity: Math.max(1, Math.min(127, Math.round(event.velocity * 10 ** (at(event.time) / 30)))) })),
    gain: 10 ** (typical / 20),
  };
}

const ATTACK = 0.004, RELEASE = 0.12, TOGETHER = 0.05;
// A part rendered whole, as one signal at `rate` from the song's start: each note its sample read faster or slower
// for its pitch, started early by the sample's attack (at most MOST_LEAD) and held as much longer, faded in and out,
// as loud as its velocity and shared with the notes starting with it (a chord is no louder than a few notes).
// `sound`: the sound's samples (its first channel) at `soundRate`.
export function renderPart(events, sound, soundRate, samples, attacks, seconds, rate = RENDER_RATE) {
  const out = new Float32Array(Math.ceil(seconds * rate));
  const sorted = [...events].sort((a, b) => a.time - b.time);
  let from = 0, to = 0;
  for (const event of sorted) {
    while (sorted[from].time < event.time - TOGETHER) from++;
    while (to < sorted.length && sorted[to].time <= event.time + TOGETHER) to++;
    const share = 1 / Math.sqrt(Math.max(1, (to - from) / 2));
    const { index, rate: speed } = sampleFor(samples.pitches, event.pitch);
    const lead = Math.min(MOST_LEAD, (attacks[index] ?? 0) / speed);
    const held = Math.max(ATTACK, Math.min(event.duration + lead, samples.length / speed - RELEASE));
    const level = (event.velocity / 127) ** 1.5 * LEVEL * share;
    const begin = Math.round((event.time - lead) * rate), length = Math.round((held + RELEASE) * rate);
    const offset = index * samples.slot * soundRate, step = speed * soundRate / rate, last = offset + samples.length * soundRate - 1;
    const attackEnd = ATTACK * rate, releaseStart = held * rate;
    for (let k = Math.max(0, -begin); k < length && begin + k < out.length; k++) {
      const position = offset + k * step;
      if (position >= last) break;
      const whole = Math.floor(position), fraction = position - whole;
      const value = sound[whole] + (sound[whole + 1] - sound[whole]) * fraction;
      const envelope = k < attackEnd ? k / attackEnd : k < releaseStart ? 1 : Math.max(0, 1 - (k - releaseStart) / (RELEASE * rate));
      out[begin + k] += value * level * envelope;
    }
  }
  return out;
}

// A family's part of a result in a sound, as loud through the song as its stem, its level at which it is as loud
// as the stem included; null when the family plays nothing.
export function renderFamily({ result, family, library, sound, soundRate, seconds, rate = RENDER_RATE }) {
  const events = familyEvents(family, result);
  if (!events.length) return null;
  const samples = samplesFor(library, family), stem = FAMILY_STEM[family];
  const { attacks, levels } = sampleShape(sound, soundRate, samples, result.loudness?.window ?? 0.25);
  const heard = result.loudness?.[stem];
  const matched = heard ? matchLoudness(events, heard, result.loudness.window, samples, levels) : { events, gain: 1 };
  const signal = renderPart(matched.events, sound, soundRate, samples, attacks, seconds, rate);
  if (matched.gain !== 1) for (let index = 0; index < signal.length; index++) signal[index] *= matched.gain;
  return signal;
}

// The library and its sounds, fetched once per task.
let library;
export function loadLibrary(fetcher = fetch) {
  library ??= fetcher(`${LIBRARY_URL}/styles.json`, { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error(`Sound library request failed (HTTP ${response.status}).`);
    return response.json();
  });
  library.catch(() => { library = undefined; });
  return library;
}

// Makes a family's part of a result in a sound as an AAC file at `output` (stereo, RENDER_RATE, limited); false when the
// family plays nothing. The sound's FLAC is fetched and read by ffmpeg (its first channel, at its own rate).
export async function renderStem({ result, family, sound, seconds, directory, output,
  ffmpegPath = process.env.LOCAL_FFMPEG_PATH ?? 'ffmpeg', run = promisify(execFile), fetcher = fetch }) {
  const sounds = await loadLibrary(fetcher);
  if (sounds.sounds[String(sound)]?.family !== family) throw new Error('That sound is not one of this part\'s.');
  const soundRate = sounds.samples.rate;
  const flac = path.join(directory, `${family}-${sound}.flac`), raw = path.join(directory, `${family}-${sound}.f32`);
  const response = await fetcher(`${LIBRARY_URL}/sounds/${sound}.flac`);
  if (!response.ok) throw new Error(`Sound request failed (HTTP ${response.status}).`);
  await writeFile(flac, Buffer.from(await response.arrayBuffer()));
  await run(ffmpegPath, ['-nostdin', '-y', '-loglevel', 'error', '-i', flac, '-af', 'pan=mono|c0=c0', '-ar', String(soundRate), '-f', 'f32le', raw],
    { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  const bytes = await readFile(raw);
  const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
  const signal = renderFamily({ result, family, library: sounds, sound: data, soundRate, seconds });
  if (!signal) return false;
  const rendered = path.join(directory, `${family}-${sound}.out.f32`);
  await writeFile(rendered, Buffer.from(signal.buffer, signal.byteOffset, signal.byteLength));
  await run(ffmpegPath, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', String(RENDER_RATE), '-ac', '1', '-i', rendered,
    // Peaks where many notes meet are held under full scale; the level is not raised.
    '-af', 'alimiter=limit=0.9:level=false', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
  return true;
}
