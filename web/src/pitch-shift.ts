// Key change for the website: each stem is moved by semitones without changing its speed, as the app does
// (WSOLA, mobile/patches/). The audio is stretched by the pitch ratio with overlapping windows that are
// lined up by cross-correlation, then read back faster or slower to its own length.

// Self-contained, because it is also the body of the worker below; nothing outside it may be referenced.
export function pitchShift(channels: Float32Array[], semitones: number, sampleRate: number): Float32Array[] {
  const ratio = Math.pow(2, semitones / 12);
  const length = channels[0]?.length ?? 0;
  if (!semitones || length === 0) return channels.map(channel => channel.slice());
  // About 46 ms windows overlapping by half; matches are searched within a quarter window either way.
  const frame = Math.pow(2, Math.round(Math.log2(sampleRate * 0.046)));
  const hop = frame / 2, tolerance = frame / 4, coarse = 4;
  const analysisHop = hop / ratio;
  const window = new Float32Array(frame);
  for (let index = 0; index < frame; index++) window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / frame);
  // The search runs on a mono mix.
  const mono = new Float32Array(length);
  for (const channel of channels) for (let index = 0; index < length; index++) mono[index] += channel[index] / channels.length;
  const at = (index: number) => (index >= 0 && index < length ? mono[index] : 0);
  const similarity = (target: number, candidate: number, stride: number) => {
    let sum = 0;
    for (let index = 0; index < hop; index += stride) sum += at(target + index) * at(candidate + index);
    return sum;
  };
  const stretchedLength = Math.ceil(length * ratio) + frame;
  const stretched = channels.map(() => new Float32Array(stretchedLength));
  let previous = 0;
  for (let step = 0; step * hop < stretchedLength - frame; step++) {
    const nominal = Math.round(step * analysisHop);
    let best = nominal;
    if (step > 0) {
      // The input that would naturally follow the last window, and the nearest place that sounds like it.
      const target = previous + hop;
      let bestScore = -Infinity;
      for (let offset = -tolerance; offset <= tolerance; offset += coarse) {
        const score = similarity(target, nominal + offset, coarse * 2);
        if (score > bestScore) { bestScore = score; best = nominal + offset; }
      }
      const rough = best;
      for (let offset = 1 - coarse; offset < coarse; offset++) {
        const score = similarity(target, rough + offset, 2);
        if (offset === 1 - coarse || score > bestScore) { bestScore = score; best = rough + offset; }
      }
      best = Math.max(0, best);
    }
    const out = step * hop;
    channels.forEach((channel, index) => {
      const into = stretched[index];
      for (let sample = 0; sample < frame; sample++) {
        const from = best + sample;
        if (from < length) into[out + sample] += channel[from] * window[sample];
      }
    });
    previous = best;
  }
  // Read back at the pitch ratio, so the stretched audio returns to its length and moves in pitch.
  return stretched.map(source => {
    const result = new Float32Array(length);
    for (let index = 0; index < length; index++) {
      const position = index * ratio, whole = Math.floor(position), part = position - whole;
      result[index] = (source[whole] ?? 0) * (1 - part) + (source[whole + 1] ?? 0) * part;
    }
    return result;
  });
}

const workers: Worker[] = [];
let nextJob = 0;
const pending = new Map<number, { resolve: (channels: Float32Array[]) => void; reject: (error: Error) => void }>();

// Background workers, one per stem up to the processor count, so the page stays responsive.
function shiftWorker(id: number): Worker {
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  if (workers.length >= size) return workers[id % size];
  const body = `const pitchShift = ${pitchShift.toString()};
self.onmessage = event => {
  const { id, channels, semitones, sampleRate } = event.data;
  try {
    const shifted = pitchShift(channels, semitones, sampleRate);
    self.postMessage({ id, channels: shifted }, shifted.map(channel => channel.buffer));
  } catch (error) { self.postMessage({ id, error: String(error) }); }
};`;
  const worker = new Worker(URL.createObjectURL(new Blob([body], { type: 'text/javascript' })));
  workers.push(worker);
  worker.onmessage = (event: MessageEvent<{ id: number; channels?: Float32Array[]; error?: string }>) => {
    const job = pending.get(event.data.id);
    pending.delete(event.data.id);
    if (event.data.channels) job?.resolve(event.data.channels);
    else job?.reject(new Error(event.data.error ?? 'The key change failed.'));
  };
  return worker;
}

// A copy of the buffer moved by semitones; its length and timing are unchanged.
export async function shiftBuffer(context: BaseAudioContext, buffer: AudioBuffer, semitones: number): Promise<AudioBuffer> {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice());
  const id = nextJob++;
  const shifted = await new Promise<Float32Array[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    shiftWorker(id).postMessage({ id, channels, semitones, sampleRate: buffer.sampleRate }, channels.map(channel => channel.buffer));
  });
  const result = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  shifted.forEach((channel, index) => result.copyToChannel(channel as Float32Array<ArrayBuffer>, index));
  return result;
}
