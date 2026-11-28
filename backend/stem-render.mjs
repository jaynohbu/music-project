// A score part made as an audio stem on the server (score-render.mjs): a 'rendering' record under its song, for one
// harmony result (harmonyId), one family and one sound; its AAC file is under the song's harmony folder.
// The closest sound of each family laid from a score is made in the run that lays the score (stem-analysis.mjs);
// another sound when the app asks for it (rendering-api.mjs), in a task of its own.
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { failureRetention } from './shared.mjs';
import { STEM_WINDOW_MS, stemDeadline } from './stem-shared.mjs';
import { SCORE_FAMILIES, familyEvents, fromScore, loadLibrary, offered, renderStem } from './score-render.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
export const RENDER_FAILED = 'Unable to make this sound. Please try again.';
export const renderingKey = (userId, parentJobId, id) => `users/${userId}/harmony/${parentJobId}/rendered/${id}.m4a`;

// A new rendering record, queued (or processing, when its run is this one).
export function renderingRecord({ userId, parentJobId, harmonyId, family, sound, status = 'queued', auto = false }) {
  const now = Date.now(), id = randomUUID();
  return {
    userId, jobId: id, type: 'rendering', parentJobId, harmonyId, family, sound, status, ...(auto ? { auto: true } : {}),
    key: renderingKey(userId, parentJobId, id),
    // No createdAt: keeps renderings out of the ByCreatedAt library index.
    generatedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(),
    expiresAt: Math.ceil((now + STEM_WINDOW_MS + 600000) / 1000),
  };
}

const finish = (database, child, fields) => database.send(new UpdateCommand({
  TableName: process.env.TABLE_NAME, Key: { userId: child.userId, jobId: child.jobId },
  ConditionExpression: '#status = :processing',
  UpdateExpression: 'SET ' + Object.keys(fields).map((_, i) => `#f${i} = :v${i}`).join(', ') + (fields.status === 'completed' ? ' REMOVE expiresAt' : ''),
  ExpressionAttributeNames: { '#status': 'status', ...Object.fromEntries(Object.keys(fields).map((name, i) => [`#f${i}`, name])) },
  ExpressionAttributeValues: { ':processing': 'processing', ...Object.fromEntries(Object.values(fields).map((value, i) => [`:v${i}`, value])) },
})).catch(error => { if (error.name !== 'ConditionalCheckFailedException') throw error; });

// Makes a processing rendering from its result and records how it went; never throws for the rendering itself.
export async function runRendering(child, { result, seconds, directory, database = db, storage = s3, render = renderStem }) {
  const output = path.join(directory, `${child.jobId}.m4a`);
  try {
    if (!await render({ result, family: child.family, sound: child.sound, seconds, directory, output })) throw new Error('The part has no notes.');
    const { size } = await stat(output);
    await storage.send(new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME, Key: child.key, ContentType: 'audio/mp4', Body: createReadStream(output), ContentLength: size,
    }));
    await finish(database, child, { status: 'completed', completedAt: new Date().toISOString(), playBytes: size });
  } catch (error) {
    console.error('Score rendering failed', { jobId: child.jobId, family: child.family, sound: child.sound, name: error.name, message: error.message });
    await finish(database, child, { status: 'failed', error: RENDER_FAILED, errorCode: 'RENDER_FAILED', ...failureRetention() });
  }
}

// The families a result plays from its uploaded scores, each in its closest sound for the song.
export async function closestRenderings(result) {
  const library = await loadLibrary();
  return SCORE_FAMILIES.filter(family => fromScore(result, family) && familyEvents(family, result).length)
    .map(family => ({ family, sound: offered(library, result.accompaniment, family)[0] })).filter(item => item.sound !== undefined);
}

// Records the closest renderings of a result just laid (processing, so the app waits for them), then makes them.
export async function renderClosest({ userId, parentJobId, harmonyId, result, seconds, directory, database = db, storage = s3, render }) {
  let wanted;
  try {
    wanted = await closestRenderings(result);
  } catch (error) {
    console.error('Score renderings could not be chosen', { harmonyId, name: error.name });
    return { start: async () => {} };
  }
  const children = [];
  // A rendering that cannot be recorded is left out (the app asks for it); the score is laid all the same.
  for (const child of wanted.map(item => renderingRecord({ userId, parentJobId, harmonyId, ...item, status: 'processing', auto: true }))) {
    try {
      await database.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: child }));
      children.push(child);
    } catch (error) {
      console.error('Score rendering could not be recorded', { harmonyId, family: child.family, name: error.name });
    }
  }
  // Made after the result is recorded, so the score is heard as soon as it is laid.
  return { start: async () => { for (const child of children) await runRendering(child, { result, seconds, directory, database, storage, render }); } };
}

// The task for a rendering the app asked for.
export function createRenderWorker({ database = db, storage = s3, render } = {}) {
  return async input => {
    const read = async jobId => (await database.send(new GetCommand({
      TableName: process.env.TABLE_NAME, Key: { userId: input.userId, jobId }, ConsistentRead: true,
    }))).Item;
    const child = await read(input.jobId);
    if (!child || child.type !== 'rendering') throw new Error('Rendering not found.');
    if (child.status !== 'queued') return;
    try {
      await database.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME, Key: { userId: child.userId, jobId: child.jobId },
        ConditionExpression: '#status = :queued', UpdateExpression: 'SET #status = :processing',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':queued': 'queued', ':processing': 'processing' },
      }));
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return;
      throw error;
    }
    let directory;
    try {
      if (Date.now() >= stemDeadline(child)) throw new Error('Rendering deadline expired.');
      const [parent, harmony] = await Promise.all([read(child.parentJobId), read(child.harmonyId)]);
      if (parent?.type !== 'stems' || harmony?.type !== 'harmony' || harmony.status !== 'completed' || !harmony.key) throw new Error('The score is gone.');
      const object = await storage.send(new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: harmony.key }));
      const result = JSON.parse(await object.Body.transformToString());
      directory = await realpath(await mkdtemp(path.join(tmpdir(), 'render-')));
      await runRendering({ ...child, status: 'processing' }, { result, seconds: parent.duration + 1, directory, database, storage, render });
    } catch (error) {
      console.error('Score rendering failed', { jobId: child.jobId, name: error.name });
      await finish(database, child, { status: 'failed', error: RENDER_FAILED, errorCode: 'RENDER_FAILED', ...failureRetention() });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}
