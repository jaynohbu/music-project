import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStemHandler } from '../stem-api.mjs';
import { finalize } from '../stem-worker.mjs';
import { LIMITS, refundSplit, takeSplit, usageMonth } from '../stem-usage.mjs';

process.env.TABLE_NAME = 'jobs';
const event = (route, method = 'POST', body = {}) => ({
  rawPath: `/api/stems/${route}`, body: JSON.stringify(body),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'owner' } } } },
});

// Just enough of DynamoDB for the usage records: get, put, query by user, and ADD with a limit.
function fakeDatabase() {
  const items = new Map();
  const id = key => `${key.userId}/${key.jobId}`;
  return {
    items,
    put: item => items.set(id(item), structuredClone(item)),
    get: (userId, jobId) => items.get(id({ userId, jobId })),
    async send(command) {
      const { input } = command;
      switch (command.constructor.name) {
        case 'GetCommand': return { Item: structuredClone(items.get(id(input.Key))) };
        case 'PutCommand': items.set(id(input.Item), structuredClone(input.Item)); return {};
        case 'QueryCommand': return {
          Items: [...items.values()].filter(item => item.userId === input.ExpressionAttributeValues[':userId'] &&
            item.type === input.ExpressionAttributeValues[':stems']),
        };
        case 'UpdateCommand': {
          const item = items.get(id(input.Key)) ?? { ...input.Key };
          const values = input.ExpressionAttributeValues;
          if (input.UpdateExpression.startsWith('ADD splits')) {
            const limit = values[':limit'];
            if ((limit !== undefined && (item.splits ?? 0) >= limit) || (values[':zero'] !== undefined && !(item.splits > 0))) {
              throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
            }
            item.splits = (item.splits ?? 0) + (values[':one'] ?? values[':minus']);
          } else {
            if (input.ConditionExpression?.includes('#status = :uploading') && item.status !== 'uploading') {
              throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
            }
            if (input.ConditionExpression?.includes('#status IN (:queued, :processing)') &&
                !['queued', 'processing'].includes(item.status)) {
              throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
            }
            item.status = values[':failed'] ?? values[':queued'] ?? item.status;
            if (values[':month']) item.usageMonth = values[':month'];
            if (values[':started']) item.startedAt = values[':started'];
          }
          items.set(id(input.Key), item);
          return {};
        }
        default: throw new Error(`Unexpected ${command.constructor.name}`);
      }
    },
  };
}

const song = (n, extra = {}) => ({
  userId: 'owner', jobId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, type: 'stems',
  status: 'completed', createdAt: new Date().toISOString(), bytes: 100, inputKey: 'k', ...extra,
});
const handlerFor = database => createStemHandler({
  database, uploadSigner: async () => ({ url: 'signed', fields: {} }),
  storage: { send: async () => ({ ContentLength: 100 }) }, orchestrator: { send: async () => ({}) },
});

test('usage reports the plan, this month\'s splits and the songs stored now', async () => {
  const database = fakeDatabase();
  database.put(song(1));
  database.put(song(2, { status: 'failed' }));
  database.put(song(3, { status: 'uploading', createdAt: '2020-01-01T00:00:00.000Z' }));
  database.put({ userId: 'owner', jobId: `usage:${usageMonth()}`, splits: 4 });
  database.put({ userId: 'owner', jobId: 'usage:2020-01', splits: 30 });
  const handler = handlerFor(database);
  const body = JSON.parse((await handler(event('usage', 'GET'))).body);
  assert.deepEqual(body.usage, {
    plan: 'free', month: usageMonth(), splits: { used: 4, limit: 30 }, songs: { used: 1, limit: 100 },
  });
  database.put({ userId: 'owner', jobId: 'plan', plan: 'premium' });
  assert.deepEqual(JSON.parse((await handler(event('usage', 'GET'))).body).usage.splits, { used: 4, limit: 100 });
});

test('an upload is refused before it starts when songs or this month\'s splits are used up', async () => {
  const database = fakeDatabase();
  const handler = handlerFor(database);
  const upload = () => handler(event('uploads', 'POST', { fileName: 'song.mp3', bytes: 100 }));
  for (let n = 0; n < LIMITS.free.songs; n++) database.put(song(n));
  let response = await upload();
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, 'SONG_LIMIT');
  database.items.delete(`owner/${song(0).jobId}`);
  database.put({ userId: 'owner', jobId: `usage:${usageMonth()}`, splits: LIMITS.free.splits });
  response = await upload();
  assert.equal(JSON.parse(response.body).code, 'SPLIT_LIMIT');
  database.put({ userId: 'owner', jobId: 'plan', plan: 'premium' });
  assert.equal((await upload()).statusCode, 201, 'premium has room for more');
});

test('starting a split takes one atomically, and the last one cannot be taken twice', async () => {
  const database = fakeDatabase();
  const handler = handlerFor(database);
  database.put({ userId: 'owner', jobId: `usage:${usageMonth()}`, splits: LIMITS.free.splits - 1 });
  const first = song(1, { status: 'uploading' }), second = song(2, { status: 'uploading' });
  database.put(first);
  database.put(second);
  assert.equal((await handler(event(`jobs/${first.jobId}/complete`))).statusCode, 202);
  assert.equal(database.get('owner', first.jobId).usageMonth, usageMonth());
  const refused = await handler(event(`jobs/${second.jobId}/complete`));
  assert.equal(refused.statusCode, 403);
  assert.equal(JSON.parse(refused.body).code, 'SPLIT_LIMIT');
  assert.equal(database.get('owner', second.jobId).status, 'uploading', 'the refused song can start next month');
  assert.equal(database.get('owner', `usage:${usageMonth()}`).splits, LIMITS.free.splits);
});

test('a failed split is refunded once, and a refund never goes below zero', async () => {
  const database = fakeDatabase();
  const month = await takeSplit(database, 'owner');
  await refundSplit(database, 'owner', month);
  await refundSplit(database, 'owner', month);
  assert.equal(database.get('owner', `usage:${month}`).splits, 0);
  await refundSplit(database, 'owner', undefined);
});

test('a separation task that stops gives its split back', async t => {
  const database = fakeDatabase();
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', command => database.send(command));
  const month = await takeSplit(database, 'owner');
  database.put(song(1, { status: 'processing', usageMonth: month }));
  await finalize({ userId: 'owner', jobId: song(1).jobId });
  assert.equal(database.get('owner', song(1).jobId).status, 'failed');
  assert.equal(database.get('owner', `usage:${month}`).splits, 0);
  await finalize({ userId: 'owner', jobId: song(1).jobId });
  assert.equal(database.get('owner', `usage:${month}`).splits, 0, 'a repeated finalize does not refund twice');
});
