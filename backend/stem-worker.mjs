import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, readFile, stat, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PLAY_VERSION, playbackEncoder, savePlayCopies } from './stem-playback.mjs';
import { failureRetention } from './shared.mjs';
import { refundSplit } from './stem-usage.mjs';
import { STEM_NAMES, STEM_MAX_BYTES, STEM_MAX_DURATION, STEM_MAX_OUTPUT_BYTES, stemDeadline } from './stem-shared.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const execute = promisify(execFile);

export function createStemWorker({
  database = db, storage = s3, run = execute,
  pythonPath = process.env.STEM_PYTHON_PATH ?? 'python3',
  ffmpegPath = process.env.LOCAL_FFMPEG_PATH ?? 'ffmpeg',
  device = process.env.STEM_DEVICE ?? 'cpu',
  encode = playbackEncoder(ffmpegPath),
} = {}) {
  return async input => {
    const key = { userId: input.userId, jobId: input.jobId };
    const record = await database.send(new GetCommand({
      TableName: process.env.TABLE_NAME, Key: key, ConsistentRead: true,
    }));
    const job = record.Item;
    if (!job || job.type !== 'stems') throw new Error('Separation job not found.');
    if (job.status !== 'queued') return;
    try {
      await database.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME, Key: key,
        UpdateExpression: 'SET #status = :processing',
        ConditionExpression: '#status = :queued',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':queued': 'queued', ':processing': 'processing' },
      }));
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return;
      throw error;
    }
    let directory;
    let stage = 'download';
    const uploaded = [];
    const update = async fields => {
      const removed = fields.status === 'completed'
        ? ['expiresAt', 'failedAt', 'error', 'errorCode', 'failureStage'] : [];
      await database.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME, Key: key,
        ConditionExpression: '#current = :processing',
        UpdateExpression: 'SET ' + Object.keys(fields).map((_, i) => `#f${i} = :v${i}`).join(', ') +
          (removed.length ? ' REMOVE ' + removed.map((_, i) => `#r${i}`).join(', ') : ''),
        ExpressionAttributeNames: {
          '#current': 'status',
          ...Object.fromEntries(Object.keys(fields).map((name, i) => [`#f${i}`, name])),
          ...Object.fromEntries(removed.map((name, i) => [`#r${i}`, name])),
        },
        ExpressionAttributeValues: {
          ':processing': 'processing',
          ...Object.fromEntries(Object.values(fields).map((value, i) => [`:v${i}`, value])),
        },
      }));
    };
    try {
      if (Date.now() >= stemDeadline(job)) throw new Error('Separation deadline expired.');
      directory = await realpath(await mkdtemp(path.join(tmpdir(), 'stem-')));
      const source = path.join(directory, 'input');
      const object = await storage.send(new GetObjectCommand({
        Bucket: process.env.BUCKET_NAME, Key: job.inputKey,
      }));
      if (object.ContentLength !== job.bytes || object.ContentLength > STEM_MAX_BYTES || !object.Body) {
        throw new Error('Uploaded file size is invalid.');
      }
      let bytes = 0;
      await pipeline(object.Body, new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(bytes > job.bytes ? new Error('Upload exceeded declared size.') : null, chunk);
        },
      }), createWriteStream(source));
      if (bytes !== job.bytes) throw new Error('Upload is incomplete.');
      stage = 'separate';
      const result = await run(pythonPath, [
        fileURLToPath(new URL('./separate.py', import.meta.url)), source, directory,
        '--device', device, '--ffmpeg', ffmpegPath,
      ], { timeout: Math.max(1000, stemDeadline(job) - Date.now() - 60000), maxBuffer: 2 * 1024 * 1024 });
      const output = JSON.parse(result.stdout);
      if (!Number.isFinite(output.duration) || output.duration <= 0 || output.duration > STEM_MAX_DURATION) {
        throw new Error('Invalid separation duration.');
      }
      stage = 'validate';
      const files = await Promise.all(STEM_NAMES.map(async name => {
        const file = path.join(directory, `${name}.wav`);
        if (output.stems?.[name] !== file) throw new Error('Missing required stem.');
        const details = await stat(file);
        const header = await readFile(file);
        if (details.size < 44 || details.size > STEM_MAX_OUTPUT_BYTES ||
            header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
          throw new Error('Invalid WAV stem.');
        }
        return { name, file, bytes: details.size };
      }));
      stage = 'upload';
      const stems = {};
      for (const file of files) {
        const objectKey = `users/${job.userId}/stems/${job.jobId}/${file.name}.wav`;
        await storage.send(new PutObjectCommand({
          Bucket: process.env.BUCKET_NAME, Key: objectKey, ContentType: 'audio/wav',
          Body: createReadStream(file.file), ContentLength: file.bytes,
        }));
        uploaded.push(objectKey);
        stems[file.name] = { key: objectKey, bytes: file.bytes };
      }
      const copies = await savePlayCopies({
        storage, encode, jobId: job.jobId,
        files: files.map(file => ({ file: file.file, key: stems[file.name].key })),
      });
      if (copies) {
        for (const name of STEM_NAMES) {
          Object.assign(stems[name], copies[stems[name].key]);
          uploaded.push(stems[name].playKey);
        }
      }
      stage = 'record';
      await update({
        status: 'completed', stems, duration: output.duration,
        completedAt: new Date().toISOString(), ...(copies ? { playVersion: PLAY_VERSION } : {}),
      });
    } catch (error) {
      console.error('Stem separation failed', { jobId: job.jobId, stage, name: error.name });
      const messages = {
        download: 'Unable to read the uploaded audio. Upload again.',
        separate: `Audio separation failed. Use decodable audio up to ${STEM_MAX_DURATION} seconds; check the worker and Demucs installation.`,
        validate: 'Separation did not produce six valid aligned WAV stems.',
        upload: 'Unable to save the separated stems. Please try again.',
        record: 'Unable to record the separation result. Check database permissions and connectivity.',
      };
      await update({
        status: 'failed', ...failureRetention(), error: messages[stage],
        errorCode: `STEM_${stage.toUpperCase()}_FAILED`, failureStage: stage,
      });
      await refundSplit(database, job.userId, job.usageMonth);
      for (const objectKey of uploaded) {
        await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: objectKey }));
      }
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}

export async function finalize(event) {
  const key = { userId: event.userId, jobId: event.jobId };
  const result = await db.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: key, ConsistentRead: true }));
  if (!result.Item || ['completed', 'failed'].includes(result.Item.status)) return;
  const retention = failureRetention();
  try {
    await db.send(new UpdateCommand({
      TableName: process.env.TABLE_NAME, Key: key,
      ConditionExpression: '#status IN (:queued, :processing)',
      UpdateExpression: 'SET #status = :failed, #error = :error, failedAt = :at, expiresAt = :expiry, errorCode = :code, failureStage = :stage',
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
      ExpressionAttributeValues: {
        ':queued': 'queued', ':processing': 'processing', ':failed': 'failed',
        ':error': {
          restoration: 'Stem cleanup stopped before completion. Please try again.',
          lyrics: 'Lyrics recognition stopped before completion. Please try again.',
          harmony: 'Chord analysis stopped before completion. Please try again.',
        }[result.Item.type] ?? 'The separation task stopped before completion. Please try again.',
        ':at': retention.failedAt, ':expiry': retention.expiresAt,
        ':code': 'STEM_TASK_STOPPED', ':stage': 'worker',
      },
    }));
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    return;
  }
  if (result.Item.type === 'stems') await refundSplit(db, result.Item.userId, result.Item.usageMonth);
}
