import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { visibleJob } from './shared.mjs';

// Usage limits, enforced on the server only (docs/mobile-app-design.md, Usage limits).
// A user's plan and monthly split counts are records in the jobs table beside their songs:
// { jobId: 'plan', plan } is set by hand for now, and { jobId: 'usage:YYYY-MM', splits } counts
// splits started in that UTC month. Neither has a type or createdAt, so song lists never show them.
export const LIMITS = { free: { splits: 30, songs: 100 }, premium: { splits: 100, songs: 500 } };

export class LimitError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const usageMonth = (date = new Date()) => date.toISOString().slice(0, 7);
const usageKey = (userId, month) => ({ userId, jobId: `usage:${month}` });

export async function userPlan(database, userId) {
  const item = (await database.send(new GetCommand({
    TableName: process.env.TABLE_NAME, Key: { userId, jobId: 'plan' }, ConsistentRead: true,
  }))).Item;
  return LIMITS[item?.plan] ? item.plan : 'free';
}

// Songs that exist now, including ones still uploading or separating; failed ones do not count.
export async function storedSongs(database, userId) {
  let count = 0, start;
  const now = Date.now();
  do {
    const page = await database.send(new QueryCommand({
      TableName: process.env.TABLE_NAME, ConsistentRead: true, ExclusiveStartKey: start,
      KeyConditionExpression: 'userId = :userId', FilterExpression: '#type = :stems',
      ProjectionExpression: '#status, createdAt, startedAt',
      ExpressionAttributeNames: { '#type': 'type', '#status': 'status' },
      ExpressionAttributeValues: { ':userId': userId, ':stems': 'stems' },
    }));
    count += (page.Items ?? []).filter(item => visibleJob({ type: 'stems', ...item }, now).status !== 'failed').length;
    start = page.LastEvaluatedKey;
  } while (start);
  return count;
}

export async function splitsUsed(database, userId, month = usageMonth()) {
  const item = (await database.send(new GetCommand({
    TableName: process.env.TABLE_NAME, Key: usageKey(userId, month), ConsistentRead: true,
  }))).Item;
  return item?.splits ?? 0;
}

export async function usage(database, userId) {
  const plan = await userPlan(database, userId);
  const month = usageMonth();
  return {
    plan, month,
    splits: { used: await splitsUsed(database, userId, month), limit: LIMITS[plan].splits },
    songs: { used: await storedSongs(database, userId), limit: LIMITS[plan].songs },
  };
}

// Checked when an upload is created, so nobody uploads a file that cannot be split.
export async function checkUploadAllowed(database, userId) {
  const { splits, songs } = await usage(database, userId);
  if (songs.used >= songs.limit) {
    throw new LimitError('SONG_LIMIT', `You can keep up to ${songs.limit} songs. Delete a song to add another.`);
  }
  if (splits.used >= splits.limit) {
    throw new LimitError('SPLIT_LIMIT', `You have used all ${splits.limit} splits this month.`);
  }
}

// Takes one split atomically when separation starts, and returns the month it was counted in.
export async function takeSplit(database, userId) {
  const month = usageMonth();
  const { splits } = LIMITS[await userPlan(database, userId)];
  try {
    await database.send(new UpdateCommand({
      TableName: process.env.TABLE_NAME, Key: usageKey(userId, month),
      UpdateExpression: 'ADD splits :one',
      ConditionExpression: 'attribute_not_exists(splits) OR splits < :limit',
      ExpressionAttributeValues: { ':one': 1, ':limit': splits },
    }));
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    throw new LimitError('SPLIT_LIMIT', `You have used all ${splits} splits this month.`);
  }
  return month;
}

// Gives a split back when separation fails. Deleting a song never refunds.
export async function refundSplit(database, userId, month) {
  if (!month) return;
  try {
    await database.send(new UpdateCommand({
      TableName: process.env.TABLE_NAME, Key: usageKey(userId, month),
      UpdateExpression: 'ADD splits :minus', ConditionExpression: 'splits > :zero',
      ExpressionAttributeValues: { ':minus': -1, ':zero': 0 },
    }));
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
  }
}
