import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { createStemHandler } from '../stem-api.mjs';
import { createStemWorker } from '../stem-worker.mjs';
import { STEM_NAMES, STEM_MAX_BYTES, STEM_MAX_DURATION, STEM_MAX_OUTPUT_BYTES, stemInput } from '../stem-shared.mjs';
import { visibleJob, jobExpiry } from '../shared.mjs';
import { createLocalServer } from '../local-server.mjs';

const id = '12345678-1234-1234-1234-123456789012';
const event = (route, method = 'POST', body = {}) => ({
  rawPath: `/api/stems/${route}`, body: JSON.stringify(body),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'owner' } } } },
});
const job = () => ({
  userId: 'owner', jobId: id, type: 'stems', status: 'uploading', bytes: 100,
  createdAt: new Date().toISOString(), inputKey: `stem-inputs/owner/${id}/input.wav`,
});

test('stem input validates exact bounds and never accepts client paths', () => {
  assert.equal(STEM_MAX_BYTES, 55_000_000);
  assert.equal(STEM_MAX_DURATION, 900);
  assert.ok(STEM_MAX_OUTPUT_BYTES >= 900 * 44100 * 4 + 44);
  for (const bytes of [0, -1, STEM_MAX_BYTES + 1, 1.5]) {
    assert.throws(() => stemInput({ fileName: 'song.wav', bytes }));
  }
  assert.throws(() => stemInput({ fileName: 'song.exe', bytes: 10 }));
  assert.equal(stemInput({ fileName: 'song.WAV', bytes: STEM_MAX_BYTES }).extension, 'wav');
});

test('upload policy accepts exactly 55 MB and rejects one additional byte', async () => {
  let conditions;
  let writes = 0;
  const handler = createStemHandler({
    database: { send: async () => { writes++; return {}; } },
    uploadSigner: async (_storage, options) => {
      conditions = options.Conditions;
      return { url: 'signed', fields: {} };
    },
  });
  assert.equal((await handler(event('uploads', 'POST', {
    fileName: 'song.flac', bytes: 55_000_000,
  }))).statusCode, 201);
  assert.deepEqual(conditions[0], ['content-length-range', 55_000_000, 55_000_000]);
  assert.equal((await handler(event('uploads', 'POST', {
    fileName: 'song.flac', bytes: 55_000_001,
  }))).statusCode, 400);
  assert.equal(writes, 1);
});

test('upload creates server-owned key and exact-size presigned policy', async () => {
  let options;
  let stored;
  const handler = createStemHandler({
    database: { send: async c => { stored = c.input.Item; return {}; } },
    uploadSigner: async (_storage, value) => { options = value; return { url: 'signed', fields: {} }; },
  });
  const result = await handler(event('uploads', 'POST', { fileName: '../song.wav', bytes: 100, userId: 'attacker' }));
  assert.equal(result.statusCode, 201);
  assert.equal(stored.userId, 'owner');
  assert.match(stored.inputKey, /^stem-inputs\/owner\/[0-9a-f-]+\/input.wav$/);
  assert.deepEqual(options.Conditions[0], ['content-length-range', 100, 100]);
  assert.equal(options.Expires, 900);
});

test('stem API requires JWT and hides other owners jobs', async () => {
  const handler = createStemHandler({ database: { send: async c => {
    assert.equal(c.input.Key.userId, 'owner');
    return {};
  } } });
  assert.equal((await handler({ requestContext: {} })).statusCode, 401);
  assert.equal((await handler(event(`jobs/${id}`, 'GET'))).statusCode, 404);
});

test('completion verifies object bytes before starting', async () => {
  let starts = 0;
  const handler = createStemHandler({
    database: { send: async () => ({ Item: job() }) },
    storage: { send: async () => ({ ContentLength: 99 }) },
    orchestrator: { send: async () => { starts++; } },
  });
  assert.equal((await handler(event(`jobs/${id}/complete`))).statusCode, 400);
  assert.equal(starts, 0);
});

test('completion is retryable and deterministic after start failure', async () => {
  const value = job();
  const names = [];
  let first = true;
  const handler = createStemHandler({
    database: { send: async c => {
      if (c.constructor.name === 'GetCommand') return { Item: { ...value } };
      value.status = 'queued';
      value.startedAt = c.input.ExpressionAttributeValues[':started'];
      return {};
    } },
    storage: { send: async () => ({ ContentLength: 100 }) },
    orchestrator: { send: async c => {
      names.push(c.input.name);
      if (first) { first = false; throw new Error('offline'); }
      return {};
    } },
  });
  assert.equal((await handler(event(`jobs/${id}/complete`))).statusCode, 503);
  assert.equal((await handler(event(`jobs/${id}/complete`))).statusCode, 202);
  assert.deepEqual(names, [id, id]);
});

test('worker launch sends identifiers only, excluding decomposed Unicode titles', async () => {
  const value = { ...job(), status: 'queued', title: '\u1107\u1162\u11bc\u110f\u1173', startedAt: new Date().toISOString() };
  let payload;
  const handler = createStemHandler({
    database: { send: async () => ({ Item: value }) },
    orchestrator: { send: async command => {
      payload = JSON.parse(command.input.input);
      return {};
    } },
  });
  assert.equal((await handler(event(`jobs/${id}/complete`))).statusCode, 202);
  assert.deepEqual(payload, { userId: 'owner', jobId: id });
  assert.equal('title' in payload, false);
});

test('separation uses two-hour window, uploads fifteen minutes, failures ten minutes', () => {
  const value = job();
  const time = Date.parse(value.createdAt);
  assert.equal(visibleJob(value, time + 15 * 60000).status, 'failed');
  const queued = { ...value, status: 'queued', startedAt: value.createdAt };
  assert.equal(visibleJob(queued, time + 17 * 60000).status, 'queued');
  assert.equal(visibleJob(queued, time + 120 * 60000).status, 'failed');
  assert.equal(jobExpiry(queued), Math.ceil((time + 130 * 60000) / 1000));
});

test('completed stem jobs return all six signed play/download pairs', async () => {
  const value = { ...job(), status: 'completed',
    stems: Object.fromEntries(STEM_NAMES.map(name => [name, { key: `${name}.wav` }])) };
  let signed = 0;
  const handler = createStemHandler({
    database: { send: async () => ({ Item: value }) },
    signer: async () => `https://signed/${++signed}`,
  });
  const result = JSON.parse((await handler(event(`jobs/${id}`, 'GET'))).body);
  assert.equal(Object.keys(result.job.stems).length, 6);
  assert.equal(signed, 12);
  assert.ok(result.job.stems.vocals.downloadUrl);
});

function wav() {
  const data = Buffer.alloc(444);
  data.write('RIFF');
  data.writeUInt32LE(436, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(44100, 24);
  data.writeUInt32LE(176400, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(400, 40);
  return data;
}

async function workerFixture(missing, duration = 1) {
  const updates = [];
  const stored = [];
  const value = { ...job(), status: 'queued' };
  const worker = createStemWorker({
    database: { send: async c => {
      if (c.constructor.name === 'GetCommand') return { Item: value };
      updates.push(c.input);
      return {};
    } },
    storage: { send: async c => {
      if (c.constructor.name === 'GetObjectCommand') return { ContentLength: 100, Body: Readable.from(Buffer.alloc(100)) };
      stored.push(c.input);
      // Consume upload streams just as the SDK would.
      if (c.input.Body) for await (const _chunk of c.input.Body) { /* drain */ }
      return {};
    } },
    run: async (_cmd, args) => {
      const directory = args[2];
      const stems = {};
      for (const name of STEM_NAMES) {
        if (name === missing) continue;
        stems[name] = path.join(directory, `${name}.wav`);
        await writeFile(stems[name], wav());
      }
      return { stdout: JSON.stringify({ duration, stems }) };
    },
  });
  await worker(value);
  return { updates, stored };
}

test('worker saves six WAVs before completing and aliases reserved removals', async () => {
  const { updates, stored } = await workerFixture();
  assert.equal(stored.length, 6);
  assert.ok(stored.every(item => item.ContentType === 'audio/wav' && item.Key.endsWith('.wav')));
  const completion = updates.at(-1);
  assert.equal(completion.ExpressionAttributeValues[':v0'], 'completed');
  assert.ok(Object.values(completion.ExpressionAttributeNames).includes('error'));
  assert.ok(completion.UpdateExpression.includes('REMOVE #r'));
  assert.equal(Object.keys(completion.ExpressionAttributeValues[':v1']).length, 6);
});

test('worker accepts exactly fifteen minutes and rejects any longer output before uploading', async () => {
  const accepted = await workerFixture(undefined, 900);
  assert.equal(accepted.stored.length, 6);
  assert.equal(accepted.updates.at(-1).ExpressionAttributeValues[':v0'], 'completed');
  const rejected = await workerFixture(undefined, 900 + 1 / 44100);
  assert.equal(rejected.stored.length, 0);
  assert.equal(rejected.updates.at(-1).ExpressionAttributeValues[':v0'], 'failed');
});

test('missing one stem fails the whole job with no partial uploads', async () => {
  const { updates, stored } = await workerFixture('piano');
  assert.equal(stored.length, 0);
  const failure = updates.at(-1);
  assert.equal(failure.ExpressionAttributeValues[':v0'], 'failed');
  assert.ok(Object.values(failure.ExpressionAttributeValues).includes('STEM_VALIDATE_FAILED'));
});

test('local stem routes use verified identity', async t => {
  let seen;
  const server = createLocalServer({
    verify: async () => ({ sub: 'real-owner' }),
    stems: async e => { seen = e; return { statusCode: 200, body: '{}' }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/stems/uploads`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer test' } })).status, 200);
  assert.equal(seen.requestContext.authorizer.jwt.claims.sub, 'real-owner');
});
