import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api.mjs';
import { youtubeUrl, visibleJob, JOB_LIFETIME_MS, FAILED_HISTORY_MS, failureRetention, jobExpiry, failedHistoryExpired } from '../shared.mjs';

const request = (method, extra = {}) => ({
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'alice' } } } },
  ...extra,
});
const body = response => JSON.parse(response.body);
process.env.YOUTUBE_OWNER_SUB = 'alice';

test('YouTube creation rejects other subjects even when their claimed email matches the owner', async () => {
  const handler = createHandler({
    database: { send: () => assert.fail('Database must not be touched') },
    invoker: { send: () => assert.fail('Worker must not run') },
  });
  const result = await handler({
    requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims: {
      sub: 'bob', email: 'nohjiyoung@hotmail.com',
    } } } }, body: JSON.stringify({ url: 'https://youtu.be/abcdefghijk', userId: 'alice' }),
  });
  assert.equal(result.statusCode, 403);
});

test('YouTube access fails closed when no account has been configured', async () => {
  delete process.env.YOUTUBE_OWNER_SUB;
  try {
    const handler = createHandler({ database: { send: () => assert.fail('Database must not be touched') } });
    assert.equal((await handler(request('POST'))).statusCode, 403);
  } finally { process.env.YOUTUBE_OWNER_SUB = 'alice'; }
});

test('other accounts see only their direct-upload jobs and never receive YouTube media links', async () => {
  const stems = Object.fromEntries(['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']
    .map(name => [name, { key: `users/bob/stems/id/${name}.wav` }]));
  const signed = [];
  const handler = createHandler({
    database: { send: async command => {
      assert.equal(command.input.ExpressionAttributeValues[':userId'], 'bob');
      return { Items: [
        { userId: 'bob', jobId: 'old', status: 'completed', key: 'users/bob/old.wav' },
        { userId: 'bob', jobId: 'youtube', type: 'youtube', status: 'completed', key: 'users/bob/youtube.wav' },
        { userId: 'bob', jobId: 'upload', type: 'stems', status: 'completed', stems },
      ], LastEvaluatedKey: { userId: 'bob', jobId: 'upload', createdAt: 'now' } };
    } },
    signer: async (_, command) => { signed.push(command.input.Key); return 'https://signed'; },
  });
  const result = await handler({ requestContext: {
    http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'bob' } } },
  } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(body(result).jobs.map(job => job.jobId), ['upload']);
  assert.equal(signed.length, 12);
  assert.ok(signed.every(key => key.includes('/stems/')));
  assert.ok(body(result).cursor);
});

test('accepts single video URLs and strips playlist/extra query parameters', () => {
  for (const url of [
    'https://youtu.be/abcdefghijk?t=10',
    'https://www.youtube.com/watch?v=abcdefghijk&list=xyz',
    'https://youtube.com/shorts/abcdefghijk',
    'https://m.youtube.com/embed/abcdefghijk',
  ]) assert.equal(youtubeUrl(url), 'https://www.youtube.com/watch?v=abcdefghijk');
});

test('rejects malicious hosts, credentials, schemes, playlists and invalid IDs', () => {
  for (const url of [
    undefined, 12, {}, 'not-a-url', 'http://youtu.be/abcdefghijk',
    'https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://evil.test/?youtube.com', 'https://x@youtube.com/watch?v=abcdefghijk',
    'https://youtube.com:123/watch?v=abcdefghijk',
    'https://youtube.com/playlist?list=abcdefghijk',
    'https://youtube.com/watch?v=abc";touch /tmp/pwned',
    'https://youtu.be/abcdefghijkl', 'https://youtu.be/abcdefghijk/extra',
  ]) assert.throws(() => youtubeUrl(url));
});

test('only unfinished jobs expire at the configured deadline', () => {
  const now = Date.now();
  const expired = { createdAt: new Date(now - JOB_LIFETIME_MS - 1).toISOString(), status: 'queued' };
  assert.equal(visibleJob(expired, now).status, 'failed');
  assert.match(visibleJob(expired, now).error, /expired/);
  assert.equal(visibleJob({ ...expired, status: 'completed' }, now).status, 'completed');
  assert.equal(visibleJob({ ...expired, createdAt: new Date(now).toISOString() }, now).status, 'queued');
});

test('rejects unauthenticated requests without touching AWS', async () => {
  const handler = createHandler({ database: { send: () => assert.fail('AWS called') } });
  assert.equal((await handler({ requestContext: {} })).statusCode, 401);
});

test('validates request bodies and reports invalid input', async () => {
  const handler = createHandler({ database: { send: () => assert.fail('AWS called') } });
  for (const value of ['invalid JSON', 'null', '[]', '{}', '{"url":12}', '{"url":"https://evil.test"}']) {
    assert.equal((await handler(request('POST', { body: value }))).statusCode, 400);
  }
});

test('queues job owned by JWT subject, not a client-supplied user ID', async () => {
  const calls = [];
  const invokes = [];
  const handler = createHandler({
    database: { send: async command => { calls.push(command); return {}; } },
    invoker: { send: async command => { invokes.push(command); return {}; } },
  });
  const response = await handler(request('POST', {
    body: JSON.stringify({ url: 'https://youtu.be/abcdefghijk', userId: 'bob' }),
  }));
  assert.equal(response.statusCode, 202);
  assert.equal(body(response).job.userId, 'alice');
  assert.equal(calls[0].input.Item.status, 'queued');
  assert.equal(calls[0].input.Item.expiresAt, jobExpiry(calls[0].input.Item));
  assert.equal(invokes[0].input.InvocationType, 'Event');
  assert.equal(JSON.parse(invokes[0].input.Payload.toString()).userId, 'alice');
});

test('marks enqueue failures explicitly and returns 503', async () => {
  const calls = [];
  const handler = createHandler({
    database: { send: async command => { calls.push(command); return {}; } },
    invoker: { send: async () => { throw new Error('throttled'); } },
  });
  const response = await handler(request('POST', {
    body: '{"url":"https://youtu.be/abcdefghijk"}',
  }));
  assert.equal(response.statusCode, 503);
  assert.equal(calls[1].input.ExpressionAttributeValues[':failed'], 'failed');
  const values = calls[1].input.ExpressionAttributeValues;
  assert.equal(values[':expiresAt'], failureRetention(Date.parse(values[':failedAt'])).expiresAt);
});

test('list queries only current user and signs completed private files', async () => {
  let query;
  const signed = [];
  const key = { userId: 'alice', jobId: 'job-1', createdAt: '2026-01-01T00:00:00Z' };
  const handler = createHandler({
    database: { send: async command => {
      query = command.input;
      return {
        Items: [
          { ...key, status: 'completed', key: 'users/alice/job-1.wav' },
          { ...key, jobId: 'job-2', status: 'failed', error: 'failed', ...failureRetention() },
        ],
        LastEvaluatedKey: key,
      };
    } },
    signer: async (_, command, options) => { signed.push({ input: command.input, options }); return 'https://signed.test'; },
  });

  test('download names follow the stored format, old WAV and new MP3', async () => {
    const dispositions = [];
    const createdAt = new Date().toISOString();
    const handler = createHandler({
      database: { send: async () => ({ Items: [
        { jobId: 'old', createdAt, status: 'completed', key: 'users/alice/old.wav' },
        { jobId: 'new', createdAt, status: 'completed', key: 'users/alice/new.mp3' },
      ] }) },
      signer: async (_, command) => {
        if (command.input.ResponseContentDisposition) dispositions.push(command.input.ResponseContentDisposition);
        return 'https://signed.test';
      },
    });
    assert.equal((await handler(request('GET'))).statusCode, 200);
    assert.deepEqual(dispositions, ['attachment; filename="old.wav"', 'attachment; filename="new.mp3"']);
  });

  test('failed history is hidden at exactly ten minutes, successful records remain', async () => {
    const now = Date.now();
    const createdAt = new Date(now - 3600000).toISOString();
    const items = [
      { jobId: 'just-failed', createdAt, status: 'failed', ...failureRetention(now) },
      { jobId: 'expired', createdAt, status: 'failed', ...failureRetention(now - FAILED_HISTORY_MS - 1000) },
      { jobId: 'legacy', createdAt, status: 'failed' },
      { jobId: 'stalled', createdAt, status: 'processing' },
      { jobId: 'completed', createdAt, status: 'completed', key: 'users/alice/completed.wav' },
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
    const expiryMs = jobExpiry(failed) * 1000;
    assert.equal(expiryMs, Math.ceil((now + FAILED_HISTORY_MS) / 1000) * 1000);
    assert.equal(jobExpiry({ ...failed, status: 'completed' }), undefined);
    const stale = visibleJob({
      status: 'queued', createdAt: new Date(now - JOB_LIFETIME_MS).toISOString(),
    }, now);
    assert.equal(stale.status, 'failed');
    assert.equal(Date.parse(stale.failedAt), now);
  });
  const response = await handler(request('GET'));
  assert.equal(query.ExpressionAttributeValues[':userId'], 'alice');
  assert.equal(query.Limit, 20);
  assert.equal(query.ScanIndexForward, false);
  assert.equal(body(response).jobs[0].playUrl, 'https://signed.test');
  assert.equal(body(response).jobs[1].playUrl, undefined);
  assert.equal(signed.length, 2);
  assert.equal(signed[0].options.expiresIn, 3600);
  assert.match(signed[1].input.ResponseContentDisposition, /attachment/);
  assert.deepEqual(JSON.parse(Buffer.from(body(response).cursor, 'base64url')), key);
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
