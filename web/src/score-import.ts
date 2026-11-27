// An uploaded score made into the song's harmony result, from the stems the mixer has decoded: the score read (a
// PDF by the ScoreReader through `readPdf`, MusicXML here), every stem's spectrogram drawn, the score aligned with all
// of them (score-align.ts alignScore) for its key and the stem each part sounds like, laid measure by measure on the
// drum analysis's beats (fitMeasures, which finds repeats and corrects the drum bars), and the Harmonic score
// restored from the Harmonic and bass stems together (harmonyFromScore). Nothing is saved here.
import { type Score, parseMusicXml, unrollRepeats, unzipMusicXml } from './musicxml';
import { type AlignStem, type HarmonyDocument, type MeasureFit, alignScore, fitMeasures, harmonyFromScore } from './score-align';
import { HOP, type Spectrogram, monoSignal, spectrogramOf } from './spectrogram';

export interface ScoreImport { document: HarmonyDocument; fit: MeasureFit; title: string; scores: number }

export async function scoreText(file: File, pages: string,
  readPdf: (file: File, pages: string) => Promise<{ mxl: Uint8Array; scores: number }>): Promise<{ text: string; scores: number }> {
  if (/\.mxl$/i.test(file.name)) return { text: await unzipMusicXml(new Uint8Array(await file.arrayBuffer())), scores: 1 };
  if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) return { text: await file.text(), scores: 1 };
  const { mxl, scores } = await readPdf(file, pages);
  return { text: await unzipMusicXml(mxl), scores };
}

// Guitar or keys, from the score's part names: what a part that plays the score starts with when the analysis
// does not say which sounds closer.
export function scoreFamily(score: Score): 'guitar' | 'keys' {
  return score.parts.some(part => /guit|gtr/i.test(part.name)) ? 'guitar' : 'keys';
}

export async function importScore({ file, pages, stems, analysis, readPdf, progress }: {
  file: File; pages: string;
  stems: Partial<Record<AlignStem, AudioBuffer>>;
  analysis: HarmonyDocument;
  readPdf: (file: File, pages: string) => Promise<{ mxl: Uint8Array; scores: number }>;
  progress: (message: string) => void;
}): Promise<ScoreImport> {
  progress(/\.(pdf|png|jpe?g)$/i.test(file.name) ? 'Reading the score…' : 'Opening the score…');
  const { text, scores } = await scoreText(file, pages, readPdf);
  const printed = parseMusicXml(text);
  if (!printed.notes.length) throw new Error('No notes were found in the score.');
  if (!stems.other) throw new Error('The Harmonic stem is not loaded yet.');
  // Every stem at the rate the spectrogram uses (the same for all: they come from one audio context).
  const signals: Partial<Record<AlignStem, { signal: Float32Array; rate: number }>> = {};
  for (const [name, buffer] of Object.entries(stems) as [AlignStem, AudioBuffer][]) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    signals[name] = monoSignal(channels, buffer.sampleRate);
  }
  const rate = signals.other!.rate;
  const spectrograms: Partial<Record<AlignStem, Spectrogram>> = {};
  const names = Object.keys(signals) as AlignStem[];
  for (const [index, name] of names.entries()) {
    spectrograms[name] = await spectrogramOf(signals[name]!.signal, rate, share =>
      progress(`Listening to the stems (${index + 1} of ${names.length + 1})… ${(share * 100).toFixed(0)}%`));
  }
  const other = signals.other!.signal, bass = signals.bass?.signal;
  const mixed = bass ? await spectrogramOf(Float32Array.from(other, (value, index) => value + (bass[index] ?? 0)), rate, share =>
    progress(`Listening to the stems (${names.length + 1} of ${names.length + 1})… ${(share * 100).toFixed(0)}%`)) : undefined;
  const target = mixed ? { spectrogram: mixed, stems: ['other', 'bass'] as AlignStem[] } : undefined;
  progress('Finding the score in the song…');
  await new Promise(resolve => setTimeout(resolve, 30));
  const seconds = spectrograms.other!.frames * HOP / rate;
  const base = alignScore({ score: unrollRepeats(printed), spectrograms, seconds, beats: analysis.beats, intro: true, target });
  progress('Laying the score on the song measure by measure…');
  await new Promise(resolve => setTimeout(resolve, 30));
  const fit = fitMeasures({ score: printed, spectrograms, seconds, beats: analysis.beats, target }, base, analysis.firstBar);
  const title = printed.title || file.name.replace(/\.[^.]+$/, '');
  const document = harmonyFromScore(analysis, fit.alignment, fit, { title, correctedBars: fit.corrections.bars, family: scoreFamily(printed) });
  return { document, fit, title, scores };
}
