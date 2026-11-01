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

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sfn = new SFNClient({});

export async function signedStemJob(job, signer = getSignedUrl, storage = s3) {
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
  uploadSigner = createPresignedPost, signer = getSignedUrl,
} = {}) {
  const restorations = createRestorationRoutes({ database, storage, orchestrator, signer });
  const analyses = createAnalysisRoutes({ database, storage, orchestrator, signer });
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
      if (!match || (match[2] ? method !== 'POST' : method !== 'GET')) {
        return reply(404, { message: 'Endpoint not found.' });
      }
      const key = { userId, jobId: match[1] };
      const result = await database.send(new GetCommand({
        TableName: process.env.TABLE_NAME, Key: key, ConsistentRead: true,
      }));
      const job = result.Item;
      if (!job || job.type !== 'stems') return reply(404, { message: 'Separation job not found.' });
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
      console.error('Stem API failed', { name: error.name });
      return reply(500, { message: 'The separation service is unavailable. Please try again.' });
    }
  };
}

export const handler = createStemHandler();
