import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
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
const MESSAGES = {
  download: 'Unable to read the original stems. Please try again.',
  clean: 'Stem cleanup failed. Please try again.',
  validate: 'Stem cleanup did not produce audio aligned with the song.',
  upload: 'Unable to save the cleaned stem. Please try again.',
  record: 'Unable to record the cleaned stem. Please try again.',
};

// Stems can carry extra chunks such as ffmpeg's LIST, so compare audio rather than file size.
export async function wavFormat(file) {
  const handle = await open(file);
  try {
    const { size } = await handle.stat();
    const read = async (position, length) => {
      const { buffer } = await handle.read(Buffer.alloc(length), 0, length, position);
      return buffer;
    };
    const header = await read(0, 12);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Not a WAV file.');
    }
    let format;
    for (let position = 12; position + 8 <= size;) {
      const chunk = await read(position, 8);
      const name = chunk.toString('ascii', 0, 4), length = chunk.readUInt32LE(4);
      if (name === 'fmt ') format = await read(position + 8, 16);
      if (name === 'data') {
        if (!format || position + 8 + length > size) throw new Error('Invalid WAV file.');
        return {
          channels: format.readUInt16LE(2), sampleRate: format.readUInt32LE(4),
          bits: format.readUInt16LE(14), dataBytes: length,
        };
      }
      position += 8 + length + (length % 2);
    }
    throw new Error('WAV file has no audio.');
  } finally {
    await handle.close();
  }
}

export const runStemTask = ({ separate, restore }) => job =>
  job.kind === 'restoration' ? restore(job) : separate(job);

export function createRestoreWorker({
  database = db, storage = s3, run = execute,
  pythonPath = process.env.STEM_PYTHON_PATH ?? 'python3',
} = {}) {
  return async input => {
    const read = async jobId => (await database.send(new GetCommand({
      TableName: process.env.TABLE_NAME, Key: { userId: input.userId, jobId }, ConsistentRead: true,
    }))).Item;
    const child = await read(input.jobId);
    if (!child || child.type !== 'restoration') throw new Error('Restoration not found.');
    if (child.status !== 'queued') return;
    const key = { userId: child.userId, jobId: child.jobId };
    const update = async (expected, fields, removed = []) => database.send(new UpdateCommand({
      TableName: process.env.TABLE_NAME, Key: key, ConditionExpression: '#current = :expected',
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
      if (Date.now() >= stemDeadline(child)) throw new Error('Restoration deadline expired.');
      const parent = await read(child.parentJobId);
      if (!parent || parent.type !== 'stems') throw new Error('Parent job not found.');
      directory = await realpath(await mkdtemp(path.join(tmpdir(), 'restore-')));
      const files = {};
      for (const name of [child.stem, ...child.references]) {
        const object = await storage.send(new GetObjectCommand({
          Bucket: process.env.BUCKET_NAME, Key: parent.stems[name].key,
        }));
        files[name] = path.join(directory, `${name}.wav`);
        await pipeline(object.Body, createWriteStream(files[name]));
      }
      stage = 'clean';
      const output = path.join(directory, 'cleaned.wav');
      await run(pythonPath, [
        fileURLToPath(new URL('./restore_stem.py', import.meta.url)), files[child.stem], output,
        '--strength', String(child.strength),
        ...child.references.flatMap(name => ['--reference', files[name]]),
      ], { timeout: Math.max(1000, stemDeadline(child) - Date.now() - 60000), maxBuffer: 2 * 1024 * 1024 });
      stage = 'validate';
      const [source, cleaned, result] = await Promise.all([
        wavFormat(files[child.stem]), wavFormat(output), stat(output),
      ]);
      if (JSON.stringify(source) !== JSON.stringify(cleaned)) throw new Error('Cleaned stem is not aligned.');
      stage = 'upload';
      await storage.send(new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME, Key: child.key, ContentType: 'audio/wav',
        Body: createReadStream(output), ContentLength: result.size,
      }));
      uploaded = true;
      stage = 'record';
      await update('processing', {
        status: 'completed', bytes: result.size, completedAt: new Date().toISOString(),
      }, ['expiresAt']);
    } catch (error) {
      console.error('Stem cleanup failed', { jobId: child.jobId, stage, name: error.name });
      await update('processing', {
        status: 'failed', ...failureRetention(), error: MESSAGES[stage],
        errorCode: `RESTORE_${stage.toUpperCase()}_FAILED`, failureStage: stage,
      });
      if (uploaded) await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: child.key }));
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}
