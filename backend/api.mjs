import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { youtubeUrl, visibleJob, failureRetention, jobExpiry, failedHistoryExpired } from './shared.mjs';
import { signedStemJob } from './stem-api.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});
const s3 = new S3Client({});

export function createHandler({ database = db, invoker = lambda, signer = getSignedUrl } = {}) {
  return async event => {
    const reply = (statusCode, body) => ({
      statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) return reply(401, { message: 'Sign in to continue.' });
    try {
      if (event.requestContext.http.method === 'POST') {
        let url;
        try {
          const rawBody = event.isBase64Encoded
            ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
          let body;
          try {
            body = JSON.parse(rawBody ?? '{}');
          } catch {
            throw new Error('Send a JSON object containing a YouTube URL.');
          }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('Send a JSON object containing a YouTube URL.');
          }
          url = youtubeUrl(body.url);
        } catch (error) {
          console.warn('Invalid conversion request', error.message);
          return reply(400, { message: error.message });
        }
        const job = {
          userId, jobId: randomUUID(), createdAt: new Date().toISOString(),
          status: 'queued', sourceUrl: url,
        };
        job.expiresAt = jobExpiry(job);
        await database.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: job }));
        try {
          await invoker.send(new InvokeCommand({
            FunctionName: process.env.WORKER_NAME, InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify(job)),
          }));
        } catch (error) {
          console.error('Unable to enqueue conversion', error);
          const retention = failureRetention();
          await database.send(new UpdateCommand({
            TableName: process.env.TABLE_NAME, Key: { userId, jobId: job.jobId },
            UpdateExpression: 'SET #status = :failed, #error = :error, failedAt = :failedAt, expiresAt = :expiresAt',
            ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
            ExpressionAttributeValues: {
              ':failed': 'failed', ':error': 'Unable to start conversion. Please try again.',
              ':failedAt': retention.failedAt, ':expiresAt': retention.expiresAt,
            },
          }));
          return reply(503, { message: 'Unable to start conversion. Please try again.' });
        }
        return reply(202, { job });
      }
      const cursor = event.queryStringParameters?.cursor;
      let start;
      if (cursor) {
        try {
          start = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          if (start.userId !== userId || typeof start.jobId !== 'string' ||
              typeof start.createdAt !== 'string' || Object.keys(start).length !== 3) {
            throw new Error('Invalid cursor');
          }
        } catch {
          console.warn('Invalid pagination cursor');
          return reply(400, { message: 'Invalid pagination cursor.' });
        }
      }
      const result = await database.send(new QueryCommand({
        TableName: process.env.TABLE_NAME, IndexName: 'ByCreatedAt',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false, Limit: 20, ExclusiveStartKey: start,
      }));
      const now = Date.now();
      const visible = (result.Items ?? []).map(item => visibleJob(item, now))
        .filter(job => !failedHistoryExpired(job, now));
      const jobs = await Promise.all(visible.map(async job => {
        if (job.type === 'stems') return signedStemJob(job, signer, s3, database);
        if (job.status !== 'completed') return job;
        const params = { Bucket: process.env.BUCKET_NAME, Key: job.key };
        return {
          ...job,
          playUrl: await signer(s3, new GetObjectCommand(params), { expiresIn: 3600 }),
          downloadUrl: await signer(s3, new GetObjectCommand({
            ...params, ResponseContentDisposition: `attachment; filename="${job.jobId}.wav"`,
          }), { expiresIn: 3600 }),
        };
      }));
      return reply(200, {
        jobs, cursor: result.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null,
      });
    } catch (error) {
      console.error('YouTube API failed', error);
      return reply(500, { message: 'The service is unavailable. Please try again.' });
    }
  };
}

export const handler = createHandler();
