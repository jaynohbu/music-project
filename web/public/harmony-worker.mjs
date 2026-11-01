import { analyzeHarmony } from './harmony-analysis.mjs';

self.onmessage = event => {
  try {
    const { samples, sampleRate, duration, tempo } = event.data;
    const chords = analyzeHarmony(samples, sampleRate, duration, tempo,
      progress => self.postMessage({ progress }));
    self.postMessage({ chords });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Harmony analysis failed.' });
  }
};
