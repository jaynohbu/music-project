import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { failureRetention } from './shared.mjs';
import { stemDeadline } from './stem-shared.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const execute = promisify(execFile);
const validTime = (time, duration) => Number.isFinite(time) && time >= 0 && time <= duration + 1;

export function checkLyrics(value, duration) {
  if (!Array.isArray(value?.lines) || !value.lines.every(line => Array.isArray(line.words) && line.words.length &&
      line.words.every(word => typeof word.text === 'string' && word.text &&
        validTime(word.start, duration) && validTime(word.end, duration) && word.end >= word.start))) {
    throw new Error('Invalid lyrics.');
  }
  return value;
}

export function checkHarmony(value, duration) {
  const parts = value?.stems && Object.values(value.stems);
  const beats = value?.beats;
  if (!Array.isArray(beats) || beats.length < 2 || !beats.every((beat, index) => Number.isFinite(beat) && (!index || beat > beats[index - 1])) ||
      ![0, 1, 2, 3].includes(value.firstBar) ||
      !parts?.length || !parts.every(part => Array.isArray(part.chords) && Array.isArray(part.notes) &&
      part.chords.every(chord => typeof chord.name === 'string' && chord.name && validTime(chord.start, duration)) &&
      part.notes.every(note => Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 &&
        validTime(note.start, duration) && validTime(note.end, duration) && note.end >= note.start &&
        Number.isInteger(note.unit) && note.unit >= 0 && Number.isInteger(note.length) && note.length >= 1))) {
    throw new Error('Invalid harmony.');
  }
  return value;
}

// Drums only supply the beat.
export const HARMONY_STEMS = ['guitar', 'piano', 'other', 'bass', 'drums'];

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

// One part keeps the song's grid, so no drums; other parts stay for chord context, and bass only for itself.
const harmonyStems = child => !child.stem ? HARMONY_STEMS
  : HARMONY_STEMS.filter(name => name !== 'drums' && (name !== 'bass' || child.stem === 'bass'));

const HARMONY = {
  type: 'harmony', code: 'HARMONY', stems: harmonyStems, check: checkHarmony,
  command: (files, output, child) => ['analyze_harmony.py', output,
    ...harmonyStems(child).flatMap(name => ['--stem', `${name}=${files[name]}`]),
    ...(child.stem ? ['--only', child.stem, '--grid', files.base] : [])],
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
      stage = 'analyze';
      const output = path.join(directory, 'result.json');
      const [script, ...args] = analysis.command(files, output, child);
      await run(pythonPath, [fileURLToPath(new URL(`./${script}`, import.meta.url)), ...args],
        { timeout: Math.max(1000, stemDeadline(child) - Date.now() - 60000), maxBuffer: 16 * 1024 * 1024 });
      stage = 'validate';
      const text = await readFile(output, 'utf8');
      analysis.check(JSON.parse(text), parent.duration);
      stage = 'upload';
      await storage.send(new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME, Key: child.key, ContentType: 'application/json',
        Body: createReadStream(output), ContentLength: Buffer.byteLength(text),
      }));
      uploaded = true;
      stage = 'record';
      await update('processing', { status: 'completed', completedAt: new Date().toISOString() }, ['expiresAt']);
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
