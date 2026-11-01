import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { jobExpiry } from './shared.mjs';

// One-time migration: preserve completed records and never overwrite newer state.
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
if (!process.env.TABLE_NAME) throw new Error('TABLE_NAME is required.');
let cursor;
let updated = 0;
do {
  const page = await database.send(new ScanCommand({
    TableName: process.env.TABLE_NAME, ExclusiveStartKey: cursor, Limit: 100,
    FilterExpression: '#status <> :completed AND attribute_not_exists(expiresAt)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':completed': 'completed' },
  }));
  for (const job of page.Items ?? []) {
    try {
      await database.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME, Key: { userId: job.userId, jobId: job.jobId },
        UpdateExpression: 'SET expiresAt = :expiry',
        ConditionExpression: '#status = :status AND attribute_exists(jobId) AND attribute_not_exists(expiresAt)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':expiry': jobExpiry(job), ':status': job.status },
      }));
      updated++;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      console.warn('Skipped job changed concurrently', { jobId: job.jobId });
    }
  }
  cursor = page.LastEvaluatedKey;
} while (cursor);
console.log(`Applied expiration to ${updated} existing unfinished/failed job records.`);
