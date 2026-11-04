// Waveform peaks for the timeline, as on the website (web/src/stem-pages.ts waveformPeaks).
// The mixer streams stems from disk, so each stem is decoded once more at a low sample
// rate, one at a time, and the peaks are cached beside the song.
import { decodeAudioData } from 'react-native-audio-api';
import { songFile } from './cache';

export const PEAK_COUNT = 100;
const PEAK_RATE = 2000;

// The loudest sample in each of `count` equal slices of the first `frames` frames, scaled so the loudest slice is 1.
export function peaksFrom(channels: ArrayLike<number>[], frames: number, count = PEAK_COUNT): number[] {
  const peaks: number[] = [];
  const length = Math.min(frames, ...channels.map(channel => channel.length));
  for (let index = 0; index < count; index++) {
    const start = Math.floor(index * length / count), end = Math.floor((index + 1) * length / count);
    let peak = 0;
    for (const channel of channels) {
      for (let sample = start; sample < end; sample++) peak = Math.max(peak, Math.abs(channel[sample]));
    }
    peaks.push(peak);
  }
  const maximum = Math.max(0, ...peaks);
  return maximum > 0 ? peaks.map(peak => peak / maximum) : peaks;
}

export async function decodePeaks(path: string, duration: number): Promise<number[]> {
  const buffer = await decodeAudioData(path, PEAK_RATE);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  return peaksFrom(channels, Math.round(duration * buffer.sampleRate));
}

let queue: Promise<unknown> = Promise.resolve();

// `cancelled` lets a closed song skip decodes still waiting in the queue.
export function stemPeaks(jobId: string, fileName: string, duration: number, cancelled = () => false): Promise<number[] | null> {
  const file = songFile(jobId, `${fileName}.peaks.json`);
  try {
    if (file.exists) {
      const cached: unknown = JSON.parse(file.textSync());
      if (Array.isArray(cached) && cached.length === PEAK_COUNT && cached.every(peak => typeof peak === 'number')) return Promise.resolve(cached);
    }
  } catch (failure) {
    console.warn('Cached waveform could not be read; decoding again', failure);
  }
  const run = queue.then(async () => {
    if (cancelled()) return null;
    const path = decodeURI(songFile(jobId, fileName).uri.replace(/^file:\/\//, ''));
    const peaks = await decodePeaks(path, duration);
    file.write(JSON.stringify(peaks));
    return peaks;
  });
  queue = run.catch(() => undefined);
  return run;
}
