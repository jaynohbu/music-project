import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { visibleJob } from './shared.mjs';
import { createRestorationRoutes, listRestorations } from './restoration-api.mjs';
import { ANALYSES, createAnalysisRoutes, currentAnalysis } from './analysis-api.mjs';
import { STEM_NAMES, stemInput, UPLOAD_WINDOW_MS, STEM_WINDOW_MS } from './stem-shared.mjs';
import { createSongDeletion, guardChildWrites, SongDeletingError } from './scene-api.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sfn = new SFNClient({});

// A song being deleted is shown as status "deleting", without its internal marker or stem keys.
export function publicSong(job) {
  if (!job.deleting) return job;
  const { deleting, deletingAt, stems, ...rest } = job;
  return { ...rest, status: 'deleting' };
}

export async function signedStemJob(job, signer = getSignedUrl, storage = s3) {
  if (job.deleting) return publicSong(job);
  const visible = visibleJob(job);
  if (visible.status !== 'completed') return visible;
  if (!STEM_NAMES.every(name => typeof visible.stems?.[name]?.key === 'string')) {
    throw new Error('Completed separation is missing stems.');
  }
  const stems = Object.fromEntries(await Promise.all(STEM_NAMES.map(async name => {
    const params = { Bucket: process.env.BUCKET_NAME, Key: visible.stems[name].key };
    return [name, {
      playUrl: await signer(storage, new GetObjectCommand(params), { expiresIn: 3600 }),
      downloadUrl: await signer(storage, new GetObjectCommand({
        ...params, ResponseContentDisposition: `attachment; filename="${name}.wav"`,
      }), { expiresIn: 3600 }),
    }];
  })));
  return { ...visible, stems };
}

export function createStemHandler({
  database = db, storage = s3, orchestrator = sfn,
  uploadSigner = createPresignedPost, signer = getSignedUrl, deleteOnly = false,
} = {}) {
  const guarded = guardChildWrites(database, storage);
  const restorations = createRestorationRoutes({ database: guarded, storage, orchestrator, signer });
  const analyses = createAnalysisRoutes({ database: guarded, storage, orchestrator, signer });
  const deleteSong = createSongDeletion({ database, storage });
  return async event => {
    const reply = (statusCode, body) => ({
      statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) return reply(401, { message: 'Sign in to continue.' });
    const method = event.requestContext.http.method;
    const route = event.rawPath;
    const body = () => JSON.parse(event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString() : event.body ?? '{}');
    try {
      const song = /^\/api\/stems\/jobs\/([0-9a-f-]{36})$/.exec(route ?? '');
      if (song && method === 'DELETE') return await deleteSong({ userId, jobId: song[1], reply });
      // The song-deletion function's role may delete original stems, so it serves nothing else.
      if (deleteOnly) return reply(404, { message: 'Endpoint not found.' });
      const child = /^\/api\/stems\/jobs\/([0-9a-f-]{36})\/(?:restorations|lyrics|harmony)(?:\/|$)/.exec(route ?? '');
      if (child && method === 'POST') {
        const parent = (await database.send(new GetCommand({
          TableName: process.env.TABLE_NAME, Key: { userId, jobId: child[1] }, ConsistentRead: true,
        }))).Item;
        if (parent?.type === 'stems' && parent.deleting) return reply(409, { message: 'This song is being deleted.' });
      }
      const restoring = /^\/api\/stems\/jobs\/([0-9a-f-]{36})\/restorations(?:\/([0-9a-f-]{36}))?$/.exec(route ?? '');
      if (restoring) {
        const [, parentJobId, id] = restoring;
        if (id && method === 'DELETE') return await restorations.remove({ userId, parentJobId, id, reply });
        if (!id && method === 'POST') return await restorations.create({ userId, parentJobId, body, reply });
        return reply(404, { message: 'Endpoint not found.' });
      }
      const analyzing = /^\/api\/stems\/jobs\/([0-9a-f-]{36})\/(lyrics|harmony)$/.exec(route ?? '');
      if (analyzing) {
        if (method !== 'POST') return reply(404, { message: 'Endpoint not found.' });
        return await analyses.create({ type: analyzing[2], userId, parentJobId: analyzing[1], reply, body });
      }
      if (route === '/api/stems/uploads' && method === 'POST') {
        let input;
        try {
          input = stemInput(body());
        } catch (error) {
          console.warn('Invalid stem upload request', { name: error.name });
          return reply(400, { message: 'Choose a WAV, MP3, M4A, FLAC, OGG or AAC file up to 30 MB (30,000,000 bytes), with a title under 200 characters.' });
        }
        const jobId = randomUUID();
        const job = {
          userId, jobId, type: 'stems', status: 'uploading', title: input.title,
          createdAt: new Date().toISOString(), bytes: input.bytes,
          inputKey: `stem-inputs/${userId}/${jobId}/input.${input.extension}`,
          expiresAt: Math.ceil((Date.now() + UPLOAD_WINDOW_MS + 600000) / 1000),
        };
        const upload = await uploadSigner(storage, {
          Bucket: process.env.BUCKET_NAME, Key: job.inputKey, Expires: 900,
          Fields: { 'Content-Type': 'application/octet-stream' },
          Conditions: [['content-length-range', input.bytes, input.bytes], ['eq', '$Content-Type', 'application/octet-stream']],
        });
        await database.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: job }));
        return reply(201, { job, upload });
      }
      const match = /^\/api\/stems\/jobs\/([0-9a-f-]{36})(\/complete)?$/.exec(route ?? '');
      if (!match || (match[2] ? method !== 'POST' : !['GET', 'PATCH'].includes(method))) {
        return reply(404, { message: 'Endpoint not found.' });
      }
      const key = { userId, jobId: match[1] };
      const result = await database.send(new GetCommand({
        TableName: process.env.TABLE_NAME, Key: key, ConsistentRead: true,
      }));
      const job = result.Item;
      if (!job || job.type !== 'stems') return reply(404, { message: 'Separation job not found.' });
      if (job.deleting && !(method === 'PATCH' && !match[2])) {
        return match[2] ? reply(409, { message: 'This song is being deleted.' }) : reply(200, { job: publicSong(job) });
      }
      if (!match[2] && method === 'PATCH') {
        let metadata;
        try {
          const value = body();
          if (!value || typeof value !== 'object' || Array.isArray(value) ||
              typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 200 ||
              typeof value.author !== 'string' || value.author.trim().length > 200 ||
              /[\u0000-\u001f\u007f]/.test(value.title + value.author)) throw new Error('Invalid music metadata.');
          metadata = { title: value.title.trim(), author: value.author.trim() };
        } catch (error) {
          console.warn('Invalid music metadata', { name: error.name });
          return reply(400, { message: 'Enter a title of 1–200 characters and an optional author up to 200 characters, without control characters.' });
        }
        try {
          await database.send(new UpdateCommand({
            TableName: process.env.TABLE_NAME, Key: key,
            UpdateExpression: 'SET #title = :title, #author = :author',
            ConditionExpression: 'attribute_exists(jobId) AND #type = :type AND attribute_not_exists(deleting)',
            ExpressionAttributeNames: { '#type': 'type', '#title': 'title', '#author': 'author' },
            ExpressionAttributeValues: { ':title': metadata.title, ':author': metadata.author, ':type': 'stems' },
          }));
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException') throw error;
          const latest = (await database.send(new GetCommand({
            TableName: process.env.TABLE_NAME, Key: key, ConsistentRead: true,
          }))).Item;
          if (latest?.type === 'stems' && latest.deleting) return reply(409, { message: 'This song is being deleted.' });
          return reply(404, { message: 'Separation job not found.' });
        }
        return reply(200, { metadata });
      }
      if (!match[2]) {
        const signed = await signedStemJob(job, signer, storage);
        return reply(200, { job: signed.status === 'completed' ? {
          ...signed,
          restorations: await listRestorations(job, { database, signer, storage }),
          ...Object.fromEntries(await Promise.all(Object.keys(ANALYSES).map(async type =>
            [type, await currentAnalysis(type, job, { database, signer, storage })]))),
        } : signed });
      }
      if (visibleJob(job).status === 'failed') return reply(409, { message: 'This job expired or failed. Upload again.' });
      if (job.status === 'completed' || job.status === 'processing') return reply(200, { job });
      if (job.status === 'uploading') {
        let object;
        try {
          object = await storage.send(new HeadObjectCommand({
            Bucket: process.env.BUCKET_NAME, Key: job.inputKey,
          }));
        } catch (error) {
          if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NotFound') throw error;
          console.warn('Stem upload not yet present', { jobId: job.jobId });
          return reply(409, { message: 'Upload is not complete. Finish uploading before starting separation.' });
        }
        if (object.ContentLength !== job.bytes) {
          console.warn('Stem upload size mismatch', { jobId: job.jobId });
          return reply(400, { message: 'Uploaded file size does not match. Upload again.' });
        }
        const startedAt = new Date().toISOString();
        try {
          await database.send(new UpdateCommand({
            TableName: process.env.TABLE_NAME, Key: key,
            UpdateExpression: 'SET #status = :queued, startedAt = :started, expiresAt = :expiry',
            ConditionExpression: '#status = :uploading',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':queued': 'queued', ':uploading': 'uploading', ':started': startedAt,
              ':expiry': Math.ceil((Date.parse(startedAt) + STEM_WINDOW_MS + 600000) / 1000),
            },
          }));
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException') throw error;
          // A competing completion request owns the start; its deterministic execution is safe to repeat.
          return reply(202, { job: { ...job, status: 'queued' } });
        }
        job.status = 'queued';
        job.startedAt = startedAt;
      }
      try {
        await orchestrator.send(new StartExecutionCommand({
          stateMachineArn: process.env.STEM_STATE_MACHINE,
          name: job.jobId, input: JSON.stringify({ userId: job.userId, jobId: job.jobId }),
        }));
      } catch (error) {
        if (error.name !== 'ExecutionAlreadyExists') {
          console.error('Unable to enqueue separation', { jobId: job.jobId, name: error.name });
          // Keep queued so a retry can start the same deterministic execution.
          return reply(503, { message: 'Unable to start separation. Retry this request shortly.' });
        }
      }
      return reply(202, { job });
    } catch (error) {
      if (error instanceof SongDeletingError) return reply(409, { message: 'This song is being deleted.' });
      console.error('Stem API failed', { name: error.name });
      return reply(500, { message: 'The separation service is unavailable. Please try again.' });
    }
  };
}

export const handler = createStemHandler();
export const songDeletionHandler = createStemHandler({ deleteOnly: true });
