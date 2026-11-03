import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { visibleJob, failedHistoryExpired } from './shared.mjs';
import { publicSong, signedStemJob } from './stem-api.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

export function createHandler({ database = db, signer = getSignedUrl } = {}) {
  return async event => {
    const reply = (statusCode, body) => ({
      statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) return reply(401, { message: 'Sign in to continue.' });
    try {
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
      // Only split songs belong in the library, even a malformed scene that carries createdAt.
      const visible = (result.Items ?? []).filter(item => item.type === 'stems')
        .map(item => item.deleting ? publicSong(item) : visibleJob(item, now))
        .filter(job => !failedHistoryExpired(job, now));
      const jobs = await Promise.all(visible.map(job => signedStemJob(job, signer, s3)));
      return reply(200, {
        jobs, cursor: result.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null,
      });
    } catch (error) {
      console.error('Library API failed', error);
      return reply(500, { message: 'The service is unavailable. Please try again.' });
    }
  };
}

export const handler = createHandler();
