#!/usr/bin/env node
// One-off (2026-11-21): splits the songs made with six stems again into four (htdemucs), keeping each song's ID,
// title and place in scenes. Run after the four-stem worker is deployed:
//   AWS_REGION=us-west-2 node backend/resplit-songs.mjs plan.json
// plan.json lists [{ userId, jobId, source }]: source is a local file, "s3:<key>" in the audio bucket, or
// "rebuild" to sum the six stems (the uploads themselves expire after a day). Each song is backed up first
// (record and stem files under backup/resplit-2026-11-21/) and put back if its split fails.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CloudFormationClient, DescribeStackResourceCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { STEM_MAX_BYTES, STEM_NAMES, STEM_WINDOW_MS } from './stem-shared.mjs';

const OLD_STEMS = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'];
const BACKUP = 'backup/resplit-2026-11-21';
const run = promisify(execFile);
const stack = new CloudFormationClient({});
const resource = async id => (await stack.send(new DescribeStackResourceCommand({
  StackName: 'youtube-audio-library', LogicalResourceId: id,
}))).StackResourceDetail.PhysicalResourceId;
const [TABLE, BUCKET, MACHINE] = await Promise.all(['Jobs', 'AudioBucket', 'StemWorkflow'].map(resource));
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sfn = new SFNClient({});
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

async function keys(prefix) {
  const found = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    found.push(...(page.Contents ?? []).map(item => item.Key));
    token = page.NextContinuationToken;
  } while (token);
  return found;
}
const copy = (from, to) => s3.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${encodeURI(from)}`, Key: to }));
const remove = key => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
async function download(key, file) {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await pipeline(object.Body, createWriteStream(file));
}

// The audio to split: a local file, an object in the bucket, or the six stems summed back together.
async function prepare(song, directory) {
  if (song.source.startsWith('s3:')) {
    const file = path.join(directory, `source${path.extname(song.source)}`);
    await download(song.source.slice(3), file);
    return file;
  }
  if (song.source !== 'rebuild') return song.source;
  const inputs = [];
  for (const name of OLD_STEMS) {
    const file = path.join(directory, `${name}.wav`);
    await download(song.record.stems[name].key, file);
    inputs.push('-i', file);
  }
  const mix = ['-filter_complex', `amix=inputs=${OLD_STEMS.length}:normalize=0`, '-ac', '2', '-ar', '44100'];
  let file = path.join(directory, 'rebuilt.flac');
  await run('ffmpeg', ['-v', 'error', '-y', ...inputs, ...mix, '-c:a', 'flac', '-compression_level', '8', file]);
  if ((await stat(file)).size > STEM_MAX_BYTES) {
    file = path.join(directory, 'rebuilt.m4a');
    await run('ffmpeg', ['-v', 'error', '-y', ...inputs, ...mix, '-c:a', 'aac', '-b:a', '320k', file]);
  }
  return file;
}

async function waitFor(song) {
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 20000));
    const item = (await db.send(new GetCommand({ TableName: TABLE, Key: { userId: song.userId, jobId: song.jobId }, ConsistentRead: true }))).Item;
    if (item.status === 'completed' || item.status === 'failed') return item;
  }
}

async function children(song) {
  const found = [];
  let start;
  do {
    const page = await db.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'userId = :user', ExclusiveStartKey: start,
      FilterExpression: 'parentJobId = :parent', ExpressionAttributeValues: { ':user': song.userId, ':parent': song.jobId },
    }));
    found.push(...page.Items);
    start = page.LastEvaluatedKey;
  } while (start);
  return found;
}

async function resplit(song) {
  const key = { userId: song.userId, jobId: song.jobId };
  song.record = (await db.send(new GetCommand({ TableName: TABLE, Key: key, ConsistentRead: true }))).Item;
  if (!song.record) throw new Error('No such song (deleted?).');
  if (song.record.type !== 'stems' || song.record.status !== 'completed') throw new Error('Not a finished song.');
  if (!OLD_STEMS.every(name => song.record.stems?.[name]?.key)) return log(song.record.title, 'already has four stems');
  const backup = `${BACKUP}/${song.userId}/${song.jobId}`;
  const stems = await keys(`users/${song.userId}/stems/${song.jobId}/`);
  for (const stemKey of stems) await copy(stemKey, `${backup}/${path.basename(stemKey)}`);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${backup}/record.json`, Body: JSON.stringify(song.record), ContentType: 'application/json' }));
  log(song.record.title, `backed up ${stems.length} files`);

  const directory = await mkdtemp(path.join(tmpdir(), 'resplit-'));
  try {
    const source = await prepare(song, directory);
    const bytes = (await stat(source)).size;
    if (bytes > STEM_MAX_BYTES) throw new Error(`Source is ${bytes} bytes, over the upload limit.`);
    const inputKey = `stem-inputs/${song.userId}/${song.jobId}/input${path.extname(source).toLowerCase()}`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: inputKey, Body: createReadStream(source), ContentLength: bytes }));
    log(song.record.title, `source ${path.basename(source)} ${(bytes / 1e6).toFixed(1)} MB`);
    const startedAt = new Date().toISOString();
    // No usageMonth: a failed split here must not refund a past month's count.
    await db.send(new UpdateCommand({
      TableName: TABLE, Key: key, ConditionExpression: '#status = :completed',
      UpdateExpression: 'SET #status = :queued, inputKey = :input, bytes = :bytes, startedAt = :started, expiresAt = :expiry REMOVE usageMonth',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':completed': 'completed', ':queued': 'queued', ':input': inputKey, ':bytes': bytes, ':started': startedAt,
        ':expiry': Math.ceil((Date.parse(startedAt) + STEM_WINDOW_MS + 600000) / 1000),
      },
    }));
    // Execution names stay taken for 90 days, so the first split's name (the job ID) cannot be reused.
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: MACHINE, name: `${song.jobId}-resplit-${Date.now()}`,
      input: JSON.stringify({ userId: song.userId, jobId: song.jobId }),
    }));
    const done = await waitFor(song);
    if (done.status !== 'completed' || !STEM_NAMES.every(name => done.stems?.[name]?.key)) {
      throw new Error(`Split failed: ${done.error ?? done.status}`);
    }
    log(song.record.title, `split into ${Object.keys(done.stems).join(', ')} (${done.duration.toFixed(1)} s)`);
  } catch (error) {
    log(song.record.title, 'failed, restoring the backup:', error.message);
    for (const stemKey of stems) await copy(`${backup}/${path.basename(stemKey)}`, stemKey);
    await db.send(new PutCommand({ TableName: TABLE, Item: song.record }));
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // The old guitar and piano files, cleaned versions and scores belong to the six stems. Lyrics stay.
  for (const name of ['guitar', 'piano']) {
    for (const extension of ['wav', 'm4a']) await remove(`users/${song.userId}/stems/${song.jobId}/${name}.${extension}`);
  }
  for (const folder of ['restored', 'harmony']) {
    for (const objectKey of await keys(`users/${song.userId}/${folder}/${song.jobId}/`)) await remove(objectKey);
  }
  const old = (await children(song)).filter(item => item.type === 'restoration' || item.type === 'harmony');
  for (const item of old) await db.send(new DeleteCommand({ TableName: TABLE, Key: { userId: item.userId, jobId: item.jobId } }));
  log(song.record.title, `removed guitar and piano, ${old.length} cleaned versions and scores`);
}

// Scenes keep each entry's mix; the guitar and piano faders go with their stems.
async function trimScenes(userId) {
  const items = (await db.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'userId = :user', FilterExpression: '#type = :scene',
    ExpressionAttributeNames: { '#type': 'type' }, ExpressionAttributeValues: { ':user': userId, ':scene': 'scene' },
  }))).Items;
  for (const scene of items) {
    let changed = false;
    for (const entry of scene.entries ?? []) {
      for (const name of ['guitar', 'piano']) {
        if (entry.settings?.tracks?.[name]) { delete entry.settings.tracks[name]; changed = true; }
      }
    }
    if (changed) {
      await db.send(new PutCommand({ TableName: TABLE, Item: scene }));
      log(`scene "${scene.name}": guitar and piano faders removed`);
    }
  }
}

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const failed = [];
for (const song of plan) {
  try { await resplit(song); } catch (error) { log(song.jobId, 'skipped:', error.message); failed.push(song.jobId); }
}
if (failed.length) {
  // A song put back to six stems still needs its scene faders.
  log(`failed and restored: ${failed.join(', ')}; scenes left as they were`);
  process.exitCode = 1;
} else {
  for (const userId of new Set(plan.map(song => song.userId))) await trimScenes(userId);
  log('done');
}
