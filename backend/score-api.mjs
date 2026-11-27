// Score reading for the spectrum page's score alignment: a PDF (or a PNG or JPEG) read into MusicXML by Audiveris in
// the ScoreReader Lambda (read_score.py).
//   POST /api/scores {bytes}             -> {id, upload}: a presigned POST for the file, to score-readings/<user>/<id>/input
//   POST /api/scores/{id}/read {pages}   -> 202: ScoreReader started (asynchronously)
//   GET  /api/scores/{id}                -> {status: 'reading' | 'completed' | 'failed', message?, scores?, url?}
// Everything under score-readings/ expires after a day (template.yaml); nothing is kept in the Jobs table.
import { randomUUID } from 'node:crypto';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const LARGEST_SCORE = 40 * 1024 * 1024;
const PAGES = /^\d+(-\d+)?([ ,]+\d+(-\d+)?)*$/;
const ID = /^[0-9a-f-]{36}$/;

const s3 = new S3Client({});
const lambda = new LambdaClient({});

const missing = error => error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;

export function createScoreHandler({ storage = s3, reader = lambda, uploadSigner = createPresignedPost, signer = getSignedUrl } = {}) {
  return async event => {
    const reply = (statusCode, body) => ({
      statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) return reply(401, { message: 'Sign in to continue.' });
    const method = event.requestContext?.http?.method, route = event.rawPath ?? '';
    const bucket = process.env.BUCKET_NAME;
    const prefix = id => `score-readings/${userId}/${id}`;
    let body = {};
    try {
      body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
    } catch {
      return reply(400, { message: 'The request is not valid JSON.' });
    }
    try {
      if (method === 'POST' && route === '/api/scores') {
        const bytes = body.bytes;
        if (!Number.isInteger(bytes) || bytes <= 0) return reply(400, { message: 'Give the file size in bytes.' });
        if (bytes > LARGEST_SCORE) return reply(413, { message: 'The file is larger than 40 MB.' });
        const id = randomUUID();
        const upload = await uploadSigner(storage, {
          Bucket: bucket, Key: `${prefix(id)}/input`, Expires: 900,
          Fields: { 'Content-Type': 'application/octet-stream' },
          Conditions: [['content-length-range', bytes, bytes], ['eq', '$Content-Type', 'application/octet-stream']],
        });
        return reply(201, { id, upload });
      }
      const match = /^\/api\/scores\/([^/]+)(\/read)?$/.exec(route);
      if (!match || !ID.test(match[1]) || (match[2] ? method !== 'POST' : method !== 'GET')) return reply(404, { message: 'Endpoint not found.' });
      const id = match[1];
      if (match[2]) {
        const pages = String(body.pages ?? '').trim();
        if (pages && !PAGES.test(pages)) return reply(400, { message: 'Pages are numbers and ranges, such as 2 or 2-3.' });
        try {
          await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix(id)}/input` }));
        } catch (error) {
          if (missing(error)) return reply(404, { message: 'Upload the score first.' });
          throw error;
        }
        await reader.send(new InvokeCommand({
          FunctionName: process.env.SCORE_READER, InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ bucket, prefix: prefix(id), pages })),
        }));
        return reply(202, { id, status: 'reading' });
      }
      let status;
      try {
        const object = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix(id)}/status.json` }));
        status = JSON.parse(await object.Body.transformToString());
      } catch (error) {
        if (missing(error)) return reply(200, { id, status: 'reading' });
        throw error;
      }
      if (status.status !== 'completed') return reply(200, { id, status: 'failed', message: String(status.message ?? 'The score could not be read.') });
      const url = await signer(storage, new GetObjectCommand({ Bucket: bucket, Key: `${prefix(id)}/score.mxl` }), { expiresIn: 900 });
      return reply(200, { id, status: 'completed', scores: Number(status.scores) || 1, url });
    } catch (error) {
      console.error('Score API failed', error);
      return reply(500, { message: 'The service is unavailable. Please try again.' });
    }
  };
}

export const handler = createScoreHandler();
