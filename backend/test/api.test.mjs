import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api.mjs';
import { STEM_WINDOW_MS } from '../stem-shared.mjs';
import { visibleJob, FAILED_HISTORY_MS, failureRetention, jobExpiry, failedHistoryExpired } from '../shared.mjs';

const request = (method, extra = {}) => ({
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'alice' } } } },
  ...extra,
});
const body = response => JSON.parse(response.body);
const stems = Object.fromEntries(['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']
  .map(name => [name, { key: `users/alice/stems/id/${name}.wav` }]));

test('the library lists only split songs and never signs older YouTube files', async () => {
  const signed = [];
  const handler = createHandler({
    database: { send: async command => {
      assert.equal(command.input.ExpressionAttributeValues[':userId'], 'alice');
      return { Items: [
        { userId: 'alice', jobId: 'old', status: 'completed', key: 'users/alice/old.wav' },
        { userId: 'alice', jobId: 'youtube', type: 'youtube', status: 'completed', key: 'users/alice/youtube.wav' },
        { userId: 'alice', jobId: 'upload', type: 'stems', status: 'completed', stems },
      ], LastEvaluatedKey: { userId: 'alice', jobId: 'upload', createdAt: 'now' } };
    } },
    signer: async (_, command) => { signed.push(command.input.Key); return 'https://signed'; },
  });
  const result = await handler(request('GET'));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(body(result).jobs.map(job => job.jobId), ['upload']);
  assert.equal(signed.length, 12);
  assert.ok(signed.every(key => key.includes('/stems/')));
  assert.ok(body(result).cursor);
});

test('only unfinished jobs expire at the configured deadline', () => {
  const now = Date.now();
  const expired = { type: 'stems', createdAt: new Date(now - STEM_WINDOW_MS - 1).toISOString(), status: 'queued' };
  assert.equal(visibleJob(expired, now).status, 'failed');
  assert.match(visibleJob(expired, now).error, /expired/);
  assert.equal(visibleJob({ ...expired, status: 'completed' }, now).status, 'completed');
  assert.equal(visibleJob({ ...expired, createdAt: new Date(now).toISOString() }, now).status, 'queued');
});

test('rejects unauthenticated requests without touching AWS', async () => {
  const handler = createHandler({ database: { send: () => assert.fail('AWS called') } });
  assert.equal((await handler({ requestContext: {} })).statusCode, 401);
});

test('list queries only the current user, newest first, with a cursor', async () => {
  let query;
  const key = { userId: 'alice', jobId: 'job-1', createdAt: '2026-01-01T00:00:00Z' };
  const handler = createHandler({
    database: { send: async command => {
      query = command.input;
      return {
        Items: [
          { ...key, type: 'stems', status: 'completed', stems },
          { ...key, jobId: 'job-2', type: 'stems', status: 'failed', error: 'failed', ...failureRetention() },
        ],
        LastEvaluatedKey: key,
      };
    } },
    signer: async () => 'https://signed.test',
  });
  const response = await handler(request('GET'));
  assert.equal(query.ExpressionAttributeValues[':userId'], 'alice');
  assert.equal(query.Limit, 20);
  assert.equal(query.ScanIndexForward, false);
  assert.deepEqual(body(response).jobs.map(job => job.jobId), ['job-1', 'job-2']);
  assert.deepEqual(JSON.parse(Buffer.from(body(response).cursor, 'base64url')), key);
});

test('failed history is hidden at exactly ten minutes, successful records remain', async () => {
  const now = Date.now();
  const createdAt = new Date(now - 3600000).toISOString();
  const items = [
    { jobId: 'just-failed', type: 'stems', createdAt, status: 'failed', ...failureRetention(now) },
    { jobId: 'expired', type: 'stems', createdAt, status: 'failed', ...failureRetention(now - FAILED_HISTORY_MS - 1000) },
    { jobId: 'legacy', type: 'stems', createdAt, status: 'failed' },
    { jobId: 'completed', type: 'stems', createdAt, status: 'completed', stems },
  ];
  const handler = createHandler({
    database: { send: async () => ({ Items: items, LastEvaluatedKey: { userId: 'alice', jobId: 'legacy', createdAt } }) },
    signer: async () => 'https://signed.test',
  });
  const response = await handler(request('GET'));
  assert.deepEqual(body(response).jobs.map(job => job.jobId), ['just-failed', 'completed']);
  assert.ok(body(response).cursor);
  const failed = { createdAt, status: 'failed', ...failureRetention(now) };
  assert.equal(failedHistoryExpired(failed, now + FAILED_HISTORY_MS - 1), false);
  assert.equal(failedHistoryExpired(failed, now + FAILED_HISTORY_MS), true);
  assert.equal(failedHistoryExpired({ ...failed, status: 'completed' }, now + 3600000), false);
  assert.equal(jobExpiry(failed) * 1000, Math.ceil((now + FAILED_HISTORY_MS) / 1000) * 1000);
  assert.equal(jobExpiry({ ...failed, status: 'completed' }), undefined);
});

test('rejects cross-user and malformed cursors before querying', async () => {
  const handler = createHandler({ database: { send: () => assert.fail('AWS called') } });
  for (const cursor of [
    'garbage',
    Buffer.from(JSON.stringify({ userId: 'bob', jobId: 'x', createdAt: 'y' })).toString('base64url'),
  ]) {
    assert.equal((await handler(request('GET', { queryStringParameters: { cursor } }))).statusCode, 400);
  }
});

test('passes valid pagination keys and reports database errors', async () => {
  const start = { userId: 'alice', jobId: 'x', createdAt: 'y' };
  const handler = createHandler({
    database: { send: async command => {
      assert.deepEqual(command.input.ExclusiveStartKey, start);
      throw new Error('database unavailable');
    } },
  });
  const response = await handler(request('GET', {
    queryStringParameters: { cursor: Buffer.from(JSON.stringify(start)).toString('base64url') },
  }));
  assert.equal(response.statusCode, 500);
  assert.match(body(response).message, /unavailable/);
});
