import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { extractedKey } from './song-score.mjs';
import { failureRetention } from './shared.mjs';
import { stemDeadline } from './stem-shared.mjs';
import { renderClosest } from './stem-render.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const execute = promisify(execFile);
const LARGEST_SCORE_HARMONY = 4 * 1024 * 1024;
const finite = value => typeof value === 'number' && Number.isFinite(value);

// What the page sends as the Harmonic score from an uploaded score: the song's harmony result in its usual form
// (beats, firstBar, the ensemble part and the other parts), and a short account of the score it came from.
export function checkScoreHarmony(document) {
  const invalid = message => { throw new Error(message ?? 'This score result could not be saved.'); };
  if (!document || typeof document !== 'object') invalid();
  if (Buffer.byteLength(JSON.stringify(document)) > LARGEST_SCORE_HARMONY) invalid('This score result is too large to save.');
  const { beats, firstBar, ensemble, stems, fromScore } = document;
  if (!Array.isArray(beats) || beats.length < 2 || !beats.every(finite) || beats.some((beat, index) => index && beat <= beats[index - 1])) invalid();
  if (!Number.isInteger(firstBar) || firstBar < 0 || firstBar >= beats.length) invalid();
  const notes = list => Array.isArray(list) && list.every(note => note && finite(note.start) && finite(note.end) && note.end >= note.start
    && Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 && Number.isInteger(note.unit) && Number.isInteger(note.length));
  if (!ensemble || !notes(ensemble.notes) || !Array.isArray(ensemble.chords)) invalid();
  if (stems && (typeof stems !== 'object' || Object.values(stems).some(part => part && (!notes(part.notes ?? []) || (part.hits && !Array.isArray(part.hits)))))) invalid();
  if (!fromScore || typeof fromScore.title !== 'string' || !Number.isInteger(fromScore.measures) || !Number.isInteger(fromScore.notes)) invalid();
  return document;
}

const validTime = (time, duration) => Number.isFinite(time) && time >= 0 && time <= duration + 1;

export function checkLyrics(value, duration) {
  if (!Array.isArray(value?.lines) || !value.lines.every(line => Array.isArray(line.words) && line.words.length &&
      line.words.every(word => typeof word.text === 'string' && word.text &&
        validTime(word.start, duration) && validTime(word.end, duration) && word.end >= word.start))) {
    throw new Error('Invalid lyrics.');
  }
  return value;
}

const DRUM_NAMES = ['kick', 'snare', 'tom', 'hihat', 'cymbal'];

function checkDrums(part) {
  return (part.hits === undefined || (Array.isArray(part.hits) && part.hits.every(hit =>
    Number.isInteger(hit.unit) && hit.unit >= 0 && DRUM_NAMES.includes(hit.drum)))) &&
    (part.patterns === undefined || (Array.isArray(part.patterns) && part.patterns.every(pattern =>
      Number.isInteger(pattern.unit) && pattern.unit >= 0 && typeof pattern.label === 'string' && pattern.label)));
}

const checkChords = (chords, duration) => Array.isArray(chords) &&
  chords.every(chord => typeof chord.name === 'string' && chord.name && validTime(chord.start, duration));
const checkNotes = (notes, duration) => Array.isArray(notes) && notes.every(note => Number.isInteger(note.pitch) && note.pitch >= 0 &&
  note.pitch <= 127 && validTime(note.start, duration) && validTime(note.end, duration) && note.end >= note.start &&
  Number.isInteger(note.unit) && note.unit >= 0 && Number.isInteger(note.length) && note.length >= 1);

// The other stem (guitars, keys and the rest): the song's key, one chord progression, a melody and the line under it.
function checkEnsemble(ensemble, duration) {
  return ensemble === undefined || (typeof ensemble?.key === 'string' && /^[A-G][#b]?m?$/.test(ensemble.key) &&
    checkChords(ensemble.chords, duration) && checkNotes(ensemble.notes, duration) &&
    (ensemble.second === undefined || checkNotes(ensemble.second, duration)));
}

// Optional: the genre and, per family, styles and sounds ranked closest first.
function checkAccompaniment(value) {
  if (value === undefined) return true;
  const ranked = part => part && Array.isArray(part.styles) && part.styles.every(name => typeof name === 'string')
    && Array.isArray(part.sounds) && part.sounds.every(Number.isInteger);
  // The bass and drum scores' sounds are ranked without styles.
  const sounds = part => part === undefined || (Array.isArray(part.sounds) && part.sounds.every(Number.isInteger));
  return typeof value === 'object' && typeof value.genre === 'string' && ranked(value.guitar) && ranked(value.keys)
    && sounds(value.bass) && sounds(value.drums)
    && (value.closest === undefined || ['guitar', 'keys'].includes(value.closest));
}

export function checkHarmony(value, duration) {
  const parts = value?.stems && Object.values(value.stems);
  const beats = value?.beats;
  if (!Array.isArray(beats) || beats.length < 2 || !beats.every((beat, index) => Number.isFinite(beat) && (!index || beat > beats[index - 1])) ||
      ![0, 1, 2, 3].includes(value.firstBar) ||
      !parts?.length || !parts.every(part => checkChords(part.chords, duration) && checkNotes(part.notes, duration) && checkDrums(part)) ||
      !checkEnsemble(value.ensemble, duration) || !checkAccompaniment(value.accompaniment)) {
    throw new Error('Invalid harmony.');
  }
  return value;
}

export const HARMONY_STEMS = ['other', 'bass', 'drums'];

const LYRICS = {
  type: 'lyrics', code: 'LYRICS', stems: () => ['vocals'], check: checkLyrics,
  command: (files, output) => ['transcribe_vocals.py', files.vocals, output],
  messages: {
    download: 'Unable to read the vocal stem. Please try again.',
    analyze: 'Lyrics recognition failed. Please try again.',
    validate: 'Lyrics recognition returned an invalid result. Please try again.',
    upload: 'Unable to save the lyrics. Please try again.',
    record: 'Unable to record the lyrics. Please try again.',
  },
};

// One part keeps the song's grid. Other stays as chord context for the bass, and the bass for other's slash chords.
const harmonyStems = child => !child.stem ? HARMONY_STEMS
  : child.stem === 'drums' ? ['drums'] : ['other', 'bass'];

// The whole score also chooses the live accompaniment, whose genre is heard with the vocals and the title.
// A harmony record with scoreKey is the song's chords & notes from its own score (song-score.mjs): the score laid on
// the stems by the website's engine (score_run.mjs, in Node), on the analysis result at baseKey; the sound of the
// score's notes is saved as the song's extracted sound.
const SCORED_STEMS = ['other', 'vocals', 'bass', 'drums'];
// What a record keeps of a result from a score: everything but where each measure is (that stays in the result).
export const summary = ({ bars: _bars, parts, ...rest }) => ({
  ...rest, ...(parts ? { parts: Object.fromEntries(Object.entries(parts).map(([part, { bars: _, ...kept }]) => [part, kept])) } : {}),
});
// A run's scores by part (records from before the bass and drum scores have only the Harmonic one).
const runScores = child => child.scores ?? (child.scoreKey ? { other: { key: child.scoreKey, title: child.scoreTitle ?? '', savedAt: child.scoreSavedAt } } : {});
const HARMONY = {
  type: 'harmony', code: 'HARMONY',
  stems: child => child.scoreKey ? SCORED_STEMS : child.stem ? harmonyStems(child) : [...HARMONY_STEMS, 'vocals'],
  check: (value, duration, child) => child.scoreKey ? checkScoreHarmony(value) : checkHarmony(value, duration),
  program: child => child.scoreKey ? process.execPath : undefined,
  command: (files, output, child, parent) => child.scoreKey ? ['score_run.mjs', output,
    ...SCORED_STEMS.flatMap(name => ['--stem', `${name}=${files[name]}`]), '--base', files.base,
    ...Object.entries(runScores(child)).flatMap(([part, score]) => ['--score', `${part}=${files[`score-${part}`]}`,
      '--title', `${part}=${score.title}`, '--saved-at', `${part}=${score.savedAt ?? ''}`]),
    '--extracted', files.extracted] : ['analyze_harmony.py', output,
    ...harmonyStems(child).flatMap(name => ['--stem', `${name}=${files[name]}`]),
    ...(child.stem ? ['--only', child.stem, '--grid', files.base] : ['--vocals', files.vocals, '--title', parent.title ?? ''])],
  messages: {
    download: 'Unable to read the stems. Please try again.',
    analyze: 'Chord analysis failed. Please try again.',
    validate: 'Chord analysis returned an invalid result. Please try again.',
    upload: 'Unable to save the chords. Please try again.',
    record: 'Unable to record the chords. Please try again.',
  },
};

function createAnalysisWorker(analysis, {
  database = db, storage = s3, run = execute,
  pythonPath = process.env.STEM_PYTHON_PATH ?? 'python3',
} = {}) {
  return async input => {
    const read = async jobId => (await database.send(new GetCommand({
      TableName: process.env.TABLE_NAME, Key: { userId: input.userId, jobId }, ConsistentRead: true,
    }))).Item;
    const child = await read(input.jobId);
    if (!child || child.type !== analysis.type) throw new Error('Analysis record not found.');
    if (child.status !== 'queued') return;
    const update = async (expected, fields, removed = []) => database.send(new UpdateCommand({
      TableName: process.env.TABLE_NAME, Key: { userId: child.userId, jobId: child.jobId },
      ConditionExpression: '#current = :expected',
      UpdateExpression: 'SET ' + Object.keys(fields).map((_, i) => `#f${i} = :v${i}`).join(', ') +
        (removed.length ? ' REMOVE ' + removed.map((_, i) => `#r${i}`).join(', ') : ''),
      ExpressionAttributeNames: {
        '#current': 'status',
        ...Object.fromEntries(Object.keys(fields).map((name, i) => [`#f${i}`, name])),
        ...Object.fromEntries(removed.map((name, i) => [`#r${i}`, name])),
      },
      ExpressionAttributeValues: {
        ':expected': expected,
        ...Object.fromEntries(Object.values(fields).map((value, i) => [`:v${i}`, value])),
      },
    }));
    try {
      await update('queued', { status: 'processing' });
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return;
      throw error;
    }
    let directory;
    let stage = 'download';
    let uploaded = false;
    try {
      if (Date.now() >= stemDeadline(child)) throw new Error('Analysis deadline expired.');
      const parent = await read(child.parentJobId);
      if (!parent || parent.type !== 'stems') throw new Error('Parent job not found.');
      directory = await realpath(await mkdtemp(path.join(tmpdir(), 'analysis-')));
      const files = {};
      const download = async (name, key, extension) => {
        const object = await storage.send(new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
        files[name] = path.join(directory, `${name}.${extension}`);
        await pipeline(object.Body, createWriteStream(files[name]));
      };
      for (const name of analysis.stems(child)) {
        await download(name, name === child.stem && child.sourceKey ? child.sourceKey : parent.stems[name].key, 'wav');
      }
      if (child.baseKey) await download('base', child.baseKey, 'json');
      if (child.scoreKey) {
        for (const [part, score] of Object.entries(runScores(child))) await download(`score-${part}`, score.key, 'musicxml');
        files.extracted = path.join(directory, 'extracted.wav');
      }
      stage = 'analyze';
      const output = path.join(directory, 'result.json');
      const [script, ...args] = analysis.command(files, output, child, parent);
      await run(analysis.program?.(child) ?? pythonPath, [fileURLToPath(new URL(`./${script}`, import.meta.url)), ...args],
        { timeout: Math.max(1000, stemDeadline(child) - Date.now() - 60000), maxBuffer: 16 * 1024 * 1024 });
      stage = 'validate';
      const text = await readFile(output, 'utf8');
      const result = JSON.parse(text);
      analysis.check(result, parent.duration, child);
      stage = 'upload';
      await storage.send(new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME, Key: child.key, ContentType: 'application/json',
        Body: createReadStream(output), ContentLength: Buffer.byteLength(text),
      }));
      uploaded = true;
      const harmonic = runScores(child).other;
      if (harmonic) {
        // The sound of the Harmonic score's notes, as the song's extracted sound while this score is still the song's.
        const wav = await readFile(files.extracted);
        await storage.send(new PutObjectCommand({
          Bucket: process.env.BUCKET_NAME, Key: extractedKey(child.userId, child.parentJobId), ContentType: 'audio/wav', Body: Readable.from([wav]), ContentLength: wav.length,
        }));
        if (parent.score?.savedAt === harmonic.savedAt) {
          await database.send(new UpdateCommand({
            TableName: process.env.TABLE_NAME, Key: { userId: child.userId, jobId: child.parentJobId },
            UpdateExpression: 'SET #score.extractedAt = :at', ConditionExpression: '#score.savedAt = :saved AND attribute_not_exists(deleting)',
            ExpressionAttributeNames: { '#score': 'score' }, ExpressionAttributeValues: { ':at': new Date().toISOString(), ':saved': harmonic.savedAt },
          })).catch(error => { if (error.name !== 'ConditionalCheckFailedException') throw error; });
        }
      }
      stage = 'record';
      // The parts laid from scores made as stems in their closest sounds, waited for by the app once the result is in.
      const closest = child.scoreKey ? await renderClosest({
        userId: child.userId, parentJobId: child.parentJobId, harmonyId: child.jobId, result, seconds: parent.duration + 1, directory, database, storage,
      }) : undefined;
      await update('processing', {
        status: 'completed', completedAt: new Date().toISOString(), ...(child.scoreKey ? { fromScore: summary(result.fromScore) } : {}),
      }, ['expiresAt']);
      await closest?.start().catch(error => console.error('Score renderings stopped', { jobId: child.jobId, name: error.name }));
    } catch (error) {
      console.error('Stem analysis failed', { jobId: child.jobId, type: analysis.type, stage, name: error.name });
      await update('processing', {
        status: 'failed', ...failureRetention(), error: analysis.messages[stage],
        errorCode: `${analysis.code}_${stage.toUpperCase()}_FAILED`, failureStage: stage,
      });
      if (uploaded) await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: child.key }));
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}

export const createLyricsWorker = options => createAnalysisWorker(LYRICS, options);
export const createHarmonyWorker = options => createAnalysisWorker(HARMONY, options);
