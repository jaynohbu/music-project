import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { MAX_DURATION, youtubeUrl, failureRetention } from './shared.mjs';
import { ConversionError, classifyConversionError, missingOutputError } from './conversion-errors.mjs';

const execute = promisify(execFile);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const MAX_BYTES = 250 * 1024 * 1024;

export function createWorker({
  database = db, storage = s3, run = execute, ffmpegPath = ffmpeg.path,
  downloaderPath = 'yt-dlp',
} = {}) {
  return async (job, context) => {
    let directory;
    let stage = 'validate';
    const update = (status, fields = {}) => {
      const values = { status, ...fields };
      const removed = status === 'completed'
        ? ['expiresAt', 'failedAt', 'error', 'errorCode', 'failureStage'] : [];
      return database.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME, Key: { userId: job.userId, jobId: job.jobId },
        UpdateExpression: 'SET ' + Object.keys(values).map((key, i) => `#f${i} = :v${i}`).join(', ') +
          (removed.length ? ' REMOVE ' + removed.map((_, i) => `#r${i}`).join(', ') : ''),
        ExpressionAttributeNames: Object.fromEntries([
          ...Object.keys(values).map((key, i) => [`#f${i}`, key]),
          ...removed.map((key, i) => [`#r${i}`, key]),
        ]),
        ExpressionAttributeValues: Object.fromEntries(Object.values(values).map((value, i) => [`:v${i}`, value])),
        ConditionExpression: 'attribute_exists(jobId)',
      }));
    };
    try {
      const url = youtubeUrl(job.sourceUrl);
      stage = 'record';
      await update('processing');
      stage = 'scratch';
      directory = await mkdtemp(path.join(tmpdir(), 'youtube-'));
      const availableMs = context?.getRemainingTimeInMillis?.() ?? 900000;
      stage = 'download';
      const result = await run(downloaderPath, [
        '--no-playlist', '--no-progress',
        '--js-runtimes', 'node', '--socket-timeout', '30',
        '--retries', '2', '--fragment-retries', '2',
        '--match-filter', `duration <= ${MAX_DURATION} & !is_live`,
        '--max-filesize', String(MAX_BYTES), '--format', 'bestaudio/best',
        '--extract-audio', '--audio-format', 'wav',
        '--ffmpeg-location', path.dirname(ffmpegPath),
        '--write-info-json', '--output', path.join(directory, 'audio.%(ext)s'),
        '--', url,
      ], {
        timeout: Math.max(1000, availableMs - 45000),
        maxBuffer: 2 * 1024 * 1024,
        // Python must load system OpenSSL, not the Lambda Node runtime's libraries.
        env: { ...process.env, LD_LIBRARY_PATH: '', HOME: '/tmp', XDG_CACHE_HOME: '/tmp/.cache' },
      });
      const file = path.join(directory, 'audio.wav');
      stage = 'output';
      let details;
      try {
        details = await stat(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw missingOutputError(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
      }
      if (details.size > MAX_BYTES) throw new ConversionError('FILE_TOO_LARGE');
      stage = 'metadata';
      const info = JSON.parse(await readFile(path.join(directory, 'audio.info.json'), 'utf8'));
      if (!info || typeof info !== 'object' || Array.isArray(info)) {
        throw new ConversionError('METADATA_INVALID');
      }
      const key = `users/${job.userId}/${job.jobId}.wav`;
      stage = 'upload';
      await storage.send(new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME, Key: key,
        Body: createReadStream(file), ContentLength: details.size, ContentType: 'audio/wav',
      }));
      stage = 'record';
      await update('completed', {
        key, title: typeof info.title === 'string' ? info.title : 'YouTube audio',
        bytes: details.size, completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const diagnostic = classifyConversionError(error, stage);
      // Avoid exposing subprocess commands, temporary paths or signed media URLs.
      console.error('YouTube conversion failed', {
        jobId: job.jobId, stage, errorCode: diagnostic.errorCode, name: error.name,
        exitCode: typeof error.code === 'number' ? error.code : undefined,
      });
      await update('failed', {
        ...failureRetention(),
        ...diagnostic, failureStage: stage,
      });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}

export const handler = createWorker();
