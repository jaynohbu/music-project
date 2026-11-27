// An uploaded score made into the song's harmony result, from the stems the mixer has decoded: the score read (a
// PDF by the ScoreReader through `readPdf`, MusicXML here, or the song's saved score), every stem's spectrogram
// drawn, the score aligned with all of them (score-align.ts alignScore) for its key and the stem each part sounds
// like, laid measure by measure on the drum analysis's beats (fitMeasures, which finds repeats and corrects the drum
// bars), the Harmonic score restored from the Harmonic and bass stems together (harmonyFromScore), and the sound of
// the score's notes extracted from those stems (a WAV, for the spectrum page). Nothing is saved here.
import { type Score, parseMusicXml, unrollRepeats, unzipMusicXml } from './musicxml';
import {
  type AlignStem, type DrumFit, type HarmonyDocument, type MeasureFit, type ScoreSummary, alignScore, bassFromScore, drumsFromScore,
  fitDrumScore, fitMeasures, harmonyFromScore, scoreMask,
} from './score-align';
import { HOP, type Spectrogram, maskedSignal, monoSignal, spectrogramOf } from './spectrogram';

export interface ScoreImport { document: HarmonyDocument; fit: MeasureFit; title: string; scores: number; musicxml: string; extracted: Blob }
export type ScoreSource = { file: File; pages: string } | { musicxml: string; title: string; savedAt: string };

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

// A mono 16-bit WAV file.
export function wavFile(signal: Float32Array, rate: number): Blob {
  const data = new DataView(new ArrayBuffer(44 + signal.length * 2));
  const text = (at: number, value: string) => [...value].forEach((char, index) => data.setUint8(at + index, char.charCodeAt(0)));
  text(0, 'RIFF'); data.setUint32(4, 36 + signal.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, Math.round(rate), true);
  data.setUint32(28, Math.round(rate) * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  text(36, 'data'); data.setUint32(40, signal.length * 2, true);
  for (let index = 0; index < signal.length; index++) data.setInt16(44 + index * 2, Math.max(-32768, Math.min(32767, Math.round(signal[index] * 32767))), true);
  return new Blob([data.buffer], { type: 'audio/wav' });
}

export async function importScore({ source, stems, analysis, readPdf, progress, fixed = false }: {
  source: ScoreSource; fixed?: boolean;
  stems: Partial<Record<AlignStem, AudioBuffer>>;
  analysis: HarmonyDocument;
  readPdf: (file: File, pages: string) => Promise<{ mxl: Uint8Array; scores: number }>;
  progress: (message: string) => void;
}): Promise<ScoreImport> {
  let text: string, scores = 1;
  if ('file' in source) {
    progress(/\.(pdf|png|jpe?g)$/i.test(source.file.name) ? 'Reading the score…' : 'Opening the score…');
    ({ text, scores } = await scoreText(source.file, source.pages, readPdf));
  } else text = source.musicxml;
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
  const mixedSignal = bass ? Float32Array.from(other, (value, index) => value + (bass[index] ?? 0)) : other;
  const mixed = bass ? await spectrogramOf(mixedSignal, rate, share =>
    progress(`Listening to the stems (${names.length + 1} of ${names.length + 1})… ${(share * 100).toFixed(0)}%`)) : spectrograms.other!;
  const target = { spectrogram: mixed, stems: (bass ? ['other', 'bass'] : ['other']) as AlignStem[] };
  progress('Finding the score in the song…');
  await new Promise(resolve => setTimeout(resolve, 30));
  const seconds = spectrograms.other!.frames * HOP / rate;
  const base = alignScore({ score: unrollRepeats(printed), spectrograms, seconds, beats: analysis.beats, intro: true, target });
  progress('Laying the score on the song measure by measure…');
  await new Promise(resolve => setTimeout(resolve, 30));
  const fit = fitMeasures({ score: printed, spectrograms, seconds, beats: analysis.beats, target }, base, analysis.firstBar, fixed);
  const title = 'file' in source ? printed.title || source.file.name.replace(/\.[^.]+$/, '') : source.title || printed.title;
  const document = harmonyFromScore(analysis, fit.alignment, fit, {
    title, correctedBars: fit.corrections.bars, family: scoreFamily(printed), ...('savedAt' in source ? { scoreSavedAt: source.savedAt } : {}),
  });
  progress('Extracting the score\'s notes from the Harmonic and bass stems…');
  const extracted = await maskedSignal(mixedSignal, rate, scoreMask(fit.alignment.notes, mixed.frames, rate), mixed.frames);
  return { document, fit, title, scores, musicxml: text, extracted: wavFile(extracted, rate) };
}

async function sourceText(source: ScoreSource, readPdf: (file: File, pages: string) => Promise<{ mxl: Uint8Array; scores: number }>) {
  return 'file' in source ? (await scoreText(source.file, source.pages, readPdf)).text : source.musicxml;
}
const titleOf = (source: ScoreSource, score: Score) => 'file' in source ? score.title || source.file.name.replace(/\.[^.]+$/, '') : source.title || score.title;

// A drum score laid on the song's drum transcription (fitDrumScore): the song's drums become the score's.
export async function importDrumScore({ source, analysis, readPdf, progress, fixed = false }: {
  source: ScoreSource; analysis: HarmonyDocument; fixed?: boolean;
  readPdf: (file: File, pages: string) => Promise<{ mxl: Uint8Array; scores: number }>; progress: (message: string) => void;
}): Promise<{ document: HarmonyDocument; summary: ScoreSummary; fit: DrumFit }> {
  const printed = parseMusicXml(await sourceText(source, readPdf));
  const heard = analysis.stems?.drums?.hits;
  if (!heard?.length) throw new Error('The song\'s drums have not been found yet.');
  progress('Laying the drum score on the song measure by measure…');
  const fit = fitDrumScore(printed, heard, analysis.beats, analysis.firstBar, fixed);
  return { ...drumsFromScore(analysis, fit, titleOf(source, printed), 'savedAt' in source ? source.savedAt : undefined), fit };
}

// A bass score laid on the bass stem: aligned and fitted as the Harmonic score is, with the bass stem in its place.
export async function importBassScore({ source, stems, analysis, readPdf, progress, fixed = false }: {
  source: ScoreSource; fixed?: boolean; stems: Partial<Record<AlignStem, AudioBuffer>>; analysis: HarmonyDocument;
  readPdf: (file: File, pages: string) => Promise<{ mxl: Uint8Array; scores: number }>; progress: (message: string) => void;
}): Promise<{ document: HarmonyDocument; summary: ScoreSummary; fit: MeasureFit }> {
  const printed = parseMusicXml(await sourceText(source, readPdf));
  if (!printed.notes.length) throw new Error('No notes were found in the bass score.');
  if (!stems.bass) throw new Error('The bass stem is not loaded yet.');
  const buffer = stems.bass;
  const { signal, rate } = monoSignal(Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)), buffer.sampleRate);
  const spectrogram = await spectrogramOf(signal, rate, share => progress(`Listening to the bass stem… ${(share * 100).toFixed(0)}%`));
  const spectrograms = { other: spectrogram }, target = { spectrogram, stems: ['other'] as AlignStem[] };
  const seconds = spectrogram.frames * HOP / rate;
  progress('Finding the bass score in the song…');
  const base = alignScore({ score: unrollRepeats(printed), spectrograms, seconds, beats: analysis.beats, intro: true, target });
  progress('Laying the bass score on the song measure by measure…');
  const fit = fitMeasures({ score: printed, spectrograms, seconds, beats: analysis.beats, target }, base, analysis.firstBar, fixed);
  return { ...bassFromScore(analysis, fit, titleOf(source, printed), 'savedAt' in source ? source.savedAt : undefined), fit };
}

// The song's scores laid on it in turn: the drum score first (the drums are the song's bars), then the Harmonic
// score, then the bass score (whose notes replace the bass line the Harmonic score gives). The first corrects the
// drum analysis's beats; the later ones keep the grid it laid. fromScore tells of each (parts), and at its top of the first of Harmonic, bass, drums.
export type ScorePart = 'other' | 'bass' | 'drums';
export async function importScores({ sources, stems, analysis, readPdf, progress }: {
  sources: Partial<Record<ScorePart, ScoreSource>>; stems: Partial<Record<AlignStem, AudioBuffer>>; analysis: HarmonyDocument;
  readPdf: (file: File, pages: string) => Promise<{ mxl: Uint8Array; scores: number }>; progress: (message: string) => void;
}): Promise<{ document: HarmonyDocument; parts: Partial<Record<ScorePart, ScoreSummary>>; corrections: Partial<Record<ScorePart, number>>; extracted?: Blob }> {
  let document = analysis, extracted: Blob | undefined;
  const parts: Partial<Record<ScorePart, ScoreSummary>> = {}, corrections: Partial<Record<ScorePart, number>> = {};
  if (sources.drums) {
    const laid = await importDrumScore({ source: sources.drums, analysis: document, readPdf, progress });
    ({ document } = laid); parts.drums = laid.summary; corrections.drums = laid.fit.corrections.bars;
  }
  if (sources.other) {
    const laid = await importScore({ source: sources.other, stems, analysis: document, readPdf, progress, fixed: !!parts.drums });
    const { fromScore, ...rest } = laid.document;
    document = rest as HarmonyDocument; parts.other = fromScore as ScoreSummary; corrections.other = laid.fit.corrections.bars;
    extracted = laid.extracted;
  }
  if (sources.bass) {
    const laid = await importBassScore({ source: sources.bass, stems, analysis: document, readPdf, progress, fixed: !!(parts.drums || parts.other) });
    ({ document } = laid); parts.bass = laid.summary; corrections.bass = laid.fit.corrections.bars;
  }
  const first = parts.other ?? parts.bass ?? parts.drums;
  if (!first) throw new Error('No score was given.');
  return { document: { ...document, fromScore: { ...first, parts } }, parts, corrections, ...(extracted ? { extracted } : {}) };
}
