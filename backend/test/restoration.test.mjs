import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createStemHandler } from '../stem-api.mjs';
import { createHandler } from '../api.mjs';
import { createLocalServer } from '../local-server.mjs';
import { createRestoreWorker, runStemTask, wavFormat } from '../stem-restore.mjs';
import { checkHarmony, checkLyrics, createHarmonyWorker, createLyricsWorker } from '../stem-analysis.mjs';
import { finalize } from '../stem-worker.mjs';
import { STEM_NAMES } from '../stem-shared.mjs';
import { restorationInput } from '../restoration-api.mjs';

process.env.TABLE_NAME = 'jobs';
process.env.BUCKET_NAME = 'bucket';
process.env.STEM_STATE_MACHINE = 'machine';
const parentId = '11111111-1111-4111-8111-111111111111';
const failure = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const clone = value => value && structuredClone(value);

function fakeDatabase() {
  const items = new Map();
  const id = key => `${key.userId}|${key.jobId}`;
  return {
    items,
    put: item => items.set(id(item), clone(item)),
    get: (userId, jobId) => clone(items.get(id({ userId, jobId }))),
    async send(command) {
      const input = command.input, kind = command.constructor.name;
      if (kind === 'GetCommand') return { Item: clone(items.get(id(input.Key))) };
      if (kind === 'PutCommand') { items.set(id(input.Item), clone(input.Item)); return {}; }
      if (kind === 'QueryCommand') {
        const values = input.ExpressionAttributeValues;
        return { Items: [...items.values()].filter(item => item.userId === values[':userId'] &&
          item.parentJobId === values[':parent'] && item.type === values[':type']).map(clone) };
      }
      if (kind === 'DeleteCommand') {
        const current = items.get(id(input.Key)), values = input.ExpressionAttributeValues;
        if (!current || current.type !== values[':type'] || current.parentJobId !== values[':parent']) {
          throw failure('ConditionalCheckFailedException', 400);
        }
        items.delete(id(input.Key));
        return {};
      }
      if (kind === 'UpdateCommand') {
        const current = items.get(id(input.Key));
        const names = input.ExpressionAttributeNames ?? {}, values = input.ExpressionAttributeValues;
        const expected = values[':expected'] ?? values[':queued'];
        if (input.ConditionExpression?.includes('IN (')) {
          if (!current || !['queued', 'processing'].includes(current.status)) throw failure('ConditionalCheckFailedException', 400);
        } else if (expected !== undefined && current?.status !== expected) {
          throw failure('ConditionalCheckFailedException', 400);
        }
        const [setPart, removePart] = input.UpdateExpression.startsWith('REMOVE ') ? ['', input.UpdateExpression.slice(7)]
          : input.UpdateExpression.replace(/^SET /, '').split(' REMOVE ');
        for (const pair of setPart ? setPart.split(', ') : []) {
          const [name, value] = pair.split(' = ');
          current[names[name] ?? name] = values[value];
        }
        for (const name of removePart?.split(', ') ?? []) delete current[names[name] ?? name];
        return {};
      }
      throw new Error(`Unexpected ${kind}`);
    },
  };
}

function fakeStorage() {
  const objects = new Map(), calls = [];
  return {
    objects, calls,
    async send(command) {
      const input = command.input, kind = command.constructor.name;
      calls.push({ kind, key: input.Key });
      if (kind === 'GetObjectCommand') {
        if (!objects.has(input.Key)) throw failure('NoSuchKey', 404);
        return { Body: Readable.from([objects.get(input.Key)]) };
      }
      if (kind === 'PutObjectCommand') {
        const chunks = [];
        for await (const chunk of input.Body) chunks.push(chunk);
        objects.set(input.Key, Buffer.concat(chunks));
        return {};
      }
      if (kind === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
      throw new Error(`Unexpected ${kind}`);
    },
  };
}

const stemKey = (name, user = 'owner') => `users/${user}/stems/${parentId}/${name}.wav`;
const parent = (overrides = {}) => ({
  userId: 'owner', jobId: parentId, type: 'stems', status: 'completed', title: 'Song',
  createdAt: new Date().toISOString(), duration: 2,
  stems: Object.fromEntries(STEM_NAMES.map(name => [name, { key: stemKey(name) }])), ...overrides,
});

function setup() {
  const database = fakeDatabase(), storage = fakeStorage(), started = [];
  database.put(parent());
  const orchestrator = { async send(command) {
    if (orchestrator.fail) throw new Error('down');
    started.push(command.input);
    return {};
  } };
  const handler = createStemHandler({
    database, storage, orchestrator, uploadSigner: async () => ({}),
    signer: async (_s, command) => `https://signed/${command.input.Key}`,
  });
  const call = async (path, body, method = 'POST', user = 'owner') => {
    const response = await handler({
      rawPath: `/api/stems/jobs/${path}`, body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: user } } } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  return { database, storage, orchestrator, started, call };
}
const good = { stem: 'other', references: ['vocals', 'bass'], strength: 0.5 };
const route = `${parentId}/restorations`;

test('input needs one target, other stems as references, and a valid strength', () => {
  for (const bad of [null, [], {}, { stem: 'other' }, { stem: 'other', references: [] }, { stem: 'kazoo', references: ['bass'] },
    { stem: 'other', references: ['other'] }, { stem: 'other', references: ['bass', 'bass'] }, { stem: 'other', references: ['kazoo'] },
    { stem: 'other', references: 'bass' }, { ...good, strength: 1.1 }, { ...good, strength: -0.1 }, { ...good, strength: '1' }, { ...good, strength: null }]) {
    assert.throws(() => restorationInput(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(restorationInput({ stem: 'other', references: ['bass', 'drums'] }),
    { stem: 'other', references: ['drums', 'bass'], strength: 0.45 });
});

test('create stores a separate record, starts the task with its kind, and repeats safely', async () => {
  const { call, database, started } = setup();
  const made = await call(route, good);
  assert.equal(made.status, 202);
  const id = made.body.restoration.id;
  const child = database.get('owner', id);
  assert.equal(child.type, 'restoration');
  assert.equal(child.status, 'queued');
  assert.equal(child.key, `users/owner/restored/${parentId}/${id}.wav`);
  assert.equal('createdAt' in child, false, 'must stay out of the library index');
  assert.ok(child.expiresAt > Date.now() / 1000);
  assert.deepEqual(JSON.parse(started[0].input), { userId: 'owner', jobId: id, kind: 'restoration' });
  assert.equal(started[0].name, id);
  assert.equal(made.body.restoration.playUrl, undefined);
  const again = await call(route, { ...good, references: ['bass', 'vocals'] });
  assert.equal(again.status, 200);
  assert.equal(again.body.restoration.id, id);
  assert.equal(started.length, 1);
  assert.equal((await call(route, { ...good, strength: 0.6 })).status, 409, 'one cleanup per stem');
  assert.equal((await call(route, { ...good, stem: 'drums' })).status, 202, 'other stems have their own');
  database.put({ ...database.get('owner', id), status: 'failed', error: 'x', failedAt: new Date().toISOString() });
  assert.equal((await call(route, { ...good, strength: 0.6 })).status, 202, 'a failed cleanup can be retried');
  assert.deepEqual(database.get('owner', parentId).stems, parent().stems);
});

test('create rejects invalid input, other owners, and unfinished parents', async () => {
  const { call, database, started } = setup();
  assert.equal((await call(route, { stem: 'other', references: [] })).status, 400);
  assert.equal((await call(route, good, 'POST', 'intruder')).status, 404);
  database.put(parent({ status: 'processing', stems: undefined }));
  assert.equal((await call(route, good)).status, 409);
  assert.equal(started.length, 0);
});

test('a failed start is recorded and reported, and can be retried', async () => {
  const context = setup();
  context.orchestrator.fail = true;
  assert.equal((await context.call(route, good)).status, 503);
  const job = await context.call(parentId, undefined, 'GET');
  assert.equal(job.body.job.restorations[0].status, 'failed');
  context.orchestrator.fail = false;
  assert.equal((await context.call(route, good)).status, 202);
});

test('parent GET lists progress and signs only completed stems; failed history expires', async () => {
  const { call, database } = setup();
  const id = (await call(route, good)).body.restoration.id;
  let list = (await call(parentId, undefined, 'GET')).body.job.restorations;
  assert.equal(list[0].status, 'queued');
  assert.equal(list[0].playUrl, undefined);
  database.put({ ...database.get('owner', id), status: 'completed' });
  list = (await call(parentId, undefined, 'GET')).body.job.restorations;
  assert.equal(list[0].playUrl, `https://signed/users/owner/restored/${parentId}/${id}.wav`);
  assert.equal(list[0].playVersion, 'wav');
  assert.equal('key' in list[0], false);
  database.put({ ...database.get('owner', id), playKey: `users/owner/restored/${parentId}/${id}.m4a`, playVersion: 'aac-256k' });
  list = (await call(parentId, undefined, 'GET')).body.job.restorations;
  assert.equal(list[0].playUrl, `https://signed/users/owner/restored/${parentId}/${id}.m4a`);
  assert.equal(list[0].downloadUrl, `https://signed/users/owner/restored/${parentId}/${id}.wav`);
  assert.equal(list[0].playVersion, 'aac-256k');
  assert.equal('playKey' in list[0], false);
  database.put({ ...database.get('owner', id), status: 'failed', error: 'x', failedAt: '2020-01-01T00:00:00.000Z', expiresAt: 1 });
  assert.deepEqual((await call(parentId, undefined, 'GET')).body.job.restorations, []);
});

test('a stuck record shows as failed after the deadline', async () => {
  const { call, database } = setup();
  const id = (await call(route, good)).body.restoration.id;
  database.put({ ...database.get('owner', id), status: 'processing', startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60000).toISOString() });
  const [item] = (await call(parentId, undefined, 'GET')).body.job.restorations;
  assert.equal(item.status, 'failed');
  assert.match(item.error, /cleanup expired/);
});

test('delete removes only the cleaned stem and never an original', async () => {
  const { call, database, storage } = setup();
  for (const name of STEM_NAMES) storage.objects.set(stemKey(name), Buffer.from(name));
  const id = (await call(route, good)).body.restoration.id;
  const key = `users/owner/restored/${parentId}/${id}.wav`;
  const path = `${route}/${id}`;
  assert.equal((await call(path, undefined, 'DELETE')).status, 409, 'not while running');
  const playKey = key.replace(/\.wav$/, '.m4a');
  database.put({ ...database.get('owner', id), status: 'completed', playKey });
  storage.objects.set(key, Buffer.from('cleaned'));
  storage.objects.set(playKey, Buffer.from('cleaned aac'));
  const before = database.get('owner', parentId);
  assert.equal((await call(`22222222-2222-4222-8222-222222222222/restorations/${id}`, undefined, 'DELETE')).status, 404);
  assert.equal((await call(`${route}/${parentId}`, undefined, 'DELETE')).status, 404, 'a parent job id is refused');
  assert.equal((await call(path, undefined, 'DELETE', 'intruder')).status, 200);
  assert.ok(storage.objects.has(key));
  assert.equal((await call(path, undefined, 'DELETE')).status, 200);
  assert.equal(storage.objects.has(key), false);
  assert.equal(storage.objects.has(playKey), false);
  assert.equal(database.get('owner', id), undefined);
  for (const name of STEM_NAMES) assert.ok(storage.objects.has(stemKey(name)));
  assert.deepEqual(database.get('owner', parentId), before);
  assert.equal((await call(path, undefined, 'DELETE')).status, 200, 'repeat is safe');
  database.put({ ...parent({ jobId: id }), type: 'restoration', parentJobId: parentId, status: 'completed', key: stemKey('vocals') });
  assert.equal((await call(path, undefined, 'DELETE')).status, 500, 'an unexpected key is refused');
  assert.ok(storage.objects.has(stemKey('vocals')));
  database.put({ ...database.get('owner', id), key, playKey: stemKey('vocals').replace(/\.wav$/, '.m4a') });
  assert.equal((await call(path, undefined, 'DELETE')).status, 500, 'an unexpected play key is refused');
});

test('cleaned stems are not library jobs', async () => {
  const { call, database } = setup();
  await call(route, good);
  const seen = [];
  const list = createHandler({
    database: { async send(command) {
      seen.push(command.input);
      return { Items: [...database.items.values()].filter(item => item.createdAt) };
    } },
    signer: async () => 'https://signed',
  });
  const response = await list({ requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'owner' } } } } });
  assert.deepEqual(JSON.parse(response.body).jobs.map(job => job.type), ['stems']);
  assert.equal(seen[0].IndexName, 'ByCreatedAt');
});

test('the task runs the worker that matches the job kind', async () => {
  const run = runStemTask({ separate: async () => 'separate', restore: async () => 'restore', recognize: async () => 'recognize', harmonize: async () => 'harmonize' });
  assert.equal(await run({ jobId: 'a' }), 'separate');
  assert.equal(await run({ jobId: 'a', kind: 'restoration' }), 'restore');
  assert.equal(await run({ jobId: 'a', kind: 'lyrics' }), 'recognize');
  assert.equal(await run({ jobId: 'a', kind: 'harmony' }), 'harmonize');
});

function workerCase(run) {
  const context = setup();
  for (const name of STEM_NAMES) context.storage.objects.set(stemKey(name), wavFile());
  const child = {
    userId: 'owner', jobId: '33333333-3333-4333-8333-333333333333', type: 'restoration', parentJobId: parentId,
    status: 'queued', stem: 'other', references: ['vocals', 'bass'], strength: 0.45, title: 't',
    key: `users/owner/restored/${parentId}/33333333-3333-4333-8333-333333333333.wav`,
    generatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), expiresAt: 9999999999,
  };
  context.database.put(child);
  const worker = createRestoreWorker({ database: context.database, storage: context.storage, run });
  return { ...context, child, worker, input: { userId: 'owner', jobId: child.jobId, kind: 'restoration' } };
}

function wavFile(seconds = 1, frequency = 330) {
  const frames = 44100 * seconds, data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF'); data.writeUInt32LE(36 + frames * 4, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(44100, 24); data.writeUInt32LE(176400, 28);
  data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(8000 * Math.sin(2 * Math.PI * frequency * i / 44100));
    data.writeInt16LE(sample, 44 + i * 4); data.writeInt16LE(sample, 46 + i * 4);
  }
  return data;
}

test('worker failure records a safe message and leaves originals alone', async () => {
  const { worker, input, database, storage, child } = workerCase(async () => { throw new Error('secret path /tmp/x'); });
  const before = [...storage.objects.entries()];
  await worker(input);
  const saved = database.get('owner', child.jobId);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.failureStage, 'clean');
  assert.equal(saved.error.includes('secret'), false);
  assert.deepEqual([...storage.objects.entries()], before);
  assert.equal(storage.calls.some(call => call.kind === 'PutObjectCommand'), false);
});

test('worker refuses output whose length does not match the original', async () => {
  const { worker, input, database, storage, child } = workerCase(async (_python, args) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(args[2], Buffer.alloc(100));
    return { stdout: '' };
  });
  await worker(input);
  assert.equal(database.get('owner', child.jobId).failureStage, 'validate');
  assert.equal(storage.objects.has(child.key), false);
});

test('worker ignores records that are already running, and other record types', async () => {
  let ran = 0;
  const { worker, input, database, child } = workerCase(async () => { ran++; return { stdout: '' }; });
  database.put({ ...child, status: 'processing' });
  await worker(input);
  assert.equal(ran, 0);
  database.put({ ...child, type: 'stems' });
  await assert.rejects(worker(input));
});

// ffmpeg writes a LIST chunk before the audio, as in real separated stems.
function wavWithList() {
  const plain = wavFile();
  const list = Buffer.alloc(8 + 26);
  list.write('LIST'); list.writeUInt32LE(26, 4); list.write('INFOISFT', 8);
  const output = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  output.writeUInt32LE(output.length - 8, 4);
  return output;
}

test('alignment is judged on audio frames, not file size', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(`${tmpdir()}/wav-`);
  try {
    const write = async (name, data) => { await writeFile(`${directory}/${name}`, data); return `${directory}/${name}`; };
    const plain = await wavFormat(await write('plain.wav', wavFile()));
    assert.deepEqual(plain, { channels: 2, sampleRate: 44100, bits: 16, dataBytes: 176400 });
    assert.deepEqual(await wavFormat(await write('list.wav', wavWithList())), plain);
    assert.notDeepEqual(await wavFormat(await write('short.wav', wavFile(2))), plain);
    await assert.rejects(wavFormat(await write('bad.wav', Buffer.alloc(100))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const python = fileURLToPath(new URL('../../.venv-stems/bin/python', import.meta.url));
let hasPython = false;
try { execFileSync(python, ['-c', 'import scipy, soundfile']); hasPython = true; } catch { /* Skipped below. */ }

test('real script produces an aligned stem through the worker, writing only the new key', { skip: !hasPython }, async () => {
  const { input, database, storage, child } = workerCase();
  // Same layout as real stems, whose extra chunk makes the file larger than the output.
  storage.objects.set(stemKey('other'), wavWithList());
  const real = createRestoreWorker({ database, storage, pythonPath: python, encode: async (_input, output) => writeFile(output, 'aac') });
  const before = new Map([...storage.objects].map(([key, value]) => [key, createHash('md5').update(value).digest('hex')]));
  await real(input);
  const saved = database.get('owner', child.jobId);
  assert.equal(saved.status, 'completed', saved.error);
  assert.equal('expiresAt' in saved, false);
  const output = storage.objects.get(child.key);
  assert.equal(output.length, wavFile().length, 'same audio frames as the original');
  assert.equal(saved.bytes, output.length);
  assert.equal(output.toString('ascii', 0, 4), 'RIFF');
  for (const [key, hash] of before) assert.equal(createHash('md5').update(storage.objects.get(key)).digest('hex'), hash);
  const playKey = child.key.replace(/\.wav$/, '.m4a');
  assert.deepEqual(storage.calls.filter(call => call.kind === 'PutObjectCommand').map(call => call.key), [child.key, playKey]);
  assert.equal(saved.playKey, playKey);
  assert.equal(saved.playVersion, 'aac-256k');
});

test('local server routes cleanup with verified identity', async t => {
  let seen;
  const server = createLocalServer({
    verify: async () => ({ sub: 'real-owner' }),
    stems: async e => { seen = e; return { statusCode: 202, headers: {}, body: '{}' }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/stems/jobs/${parentId}/restorations`;
  const headers = { Authorization: 'Bearer token' };
  assert.equal((await fetch(base, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(base, { method: 'POST', headers, body: '{}' })).status, 202);
  assert.equal(seen.requestContext.authorizer.jwt.claims.sub, 'real-owner');
  assert.equal((await fetch(base, { method: 'DELETE', headers })).status, 405);
  assert.equal((await fetch(`${base}/${parentId}`, { method: 'DELETE', headers })).status, 202);
  assert.equal((await fetch(`${base}/${parentId}`, { method: 'POST', headers })).status, 405);
});

const lyricsRoute = `${parentId}/lyrics`;
const lyricsId = '44444444-4444-4444-8444-444444444444';
const goodLyrics = { language: 'en', lines: [{ start: 0.5, end: 1, words: [{ start: 0.5, end: 1, text: 'Hello' }] }] };

function lyricsCase(run) {
  const context = setup();
  context.storage.objects.set(stemKey('vocals'), wavFile());
  const child = {
    userId: 'owner', jobId: lyricsId, type: 'lyrics', parentJobId: parentId, status: 'queued', title: 'Lyrics',
    key: `users/owner/lyrics/${parentId}/${lyricsId}.json`,
    generatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), expiresAt: 9999999999,
  };
  context.database.put(child);
  const worker = createLyricsWorker({ database: context.database, storage: context.storage, run });
  return { ...context, child, worker, input: { userId: 'owner', jobId: lyricsId, kind: 'lyrics' } };
}

const writesLyrics = content => async (_python, args) => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(args[2], content);
  return { stdout: '' };
};

function lyricsEditing() {
  const context = setup();
  context.database.put({
    userId: 'owner', jobId: lyricsId, type: 'lyrics', parentJobId: parentId, status: 'completed', title: 'Lyrics',
    key: `users/owner/lyrics/${parentId}/${lyricsId}.json`, generatedAt: new Date(Date.now() - 60000).toISOString(),
  });
  return context;
}
const editedLine = (text = 'hello', start = 0.5) => ({ start, end: start + 0.5, words: [{ start, end: start + 0.5, text }] });

test('edited lyrics become the current version, keep the old one, and start no task', async () => {
  const { call, database, storage, started } = lyricsEditing();
  const made = await call(lyricsRoute, { lines: [editedLine()] });
  assert.equal(made.status, 201);
  const child = database.get('owner', made.body.lyrics.id);
  assert.equal(child.edited, true);
  assert.equal(child.status, 'completed');
  assert.equal(child.key, `users/owner/lyrics/${parentId}/${child.jobId}.json`);
  assert.equal('createdAt' in child, false, 'stays out of the library');
  assert.equal('expiresAt' in child, false);
  assert.deepEqual(JSON.parse(storage.objects.get(child.key)), { lines: [editedLine()] });
  assert.ok(database.get('owner', lyricsId), 'the earlier version remains');
  assert.equal((await call(parentId, undefined, 'GET')).body.job.lyrics.id, child.jobId);
  assert.equal(started.length, 0);
  assert.equal((await call(lyricsRoute, {})).status, 200, 'asking to find lyrics does not replace an edit');
  assert.equal((await call(parentId, undefined, 'GET')).body.job.lyrics.id, child.jobId);
  assert.equal((await call(lyricsRoute, { lines: [] })).status, 201, 'all lines may be removed');
  assert.equal(storage.calls.filter(item => item.key?.includes('/stems/')).length, 0, 'originals are not touched');
});

test('lyrics are only edited once found, by their owner', async () => {
  const fresh = setup();
  assert.equal((await fresh.call(lyricsRoute, { lines: [editedLine()] })).status, 409);
  assert.equal((await lyricsEditing().call(lyricsRoute, { lines: [editedLine()] }, 'POST', 'intruder')).status, 404);
});

test('edited lyrics must be real timed words in playing order', async () => {
  const { call, storage } = lyricsEditing();
  const word = (start, text = 'a') => ({ start, end: start, text });
  for (const lines of ['text', null, [{}], [{ words: [] }], [editedLine('')], [editedLine('   ')], [editedLine('x'.repeat(201))],
    [editedLine('late', 99)], [editedLine('a', -1)], [{ words: [{ start: 1, end: 0.5, text: 'a' }] }],
    [{ words: [word(1), word(0.5)] }], [editedLine('a', 1), editedLine('b', 0.5)],
    [{ words: Array.from({ length: 20001 }, () => word(0)) }]]) {
    assert.equal((await call(lyricsRoute, { lines })).status, 400, JSON.stringify(lines)?.slice(0, 60));
  }
  assert.equal(storage.objects.size, 0);
});

const goodHarmony = { beats: [0, 0.5, 1, 1.5], firstBar: 0, stems: { guitar: { chords: [{ start: 0, name: 'Am' }], notes: [{ start: 0.5, end: 1, pitch: 69, unit: 4, length: 4 }] }, piano: { chords: [], notes: [] }, other: { chords: [], notes: [] }, bass: { chords: [], notes: [] } } };

function harmonyCase(run) {
  const context = setup();
  for (const name of STEM_NAMES) context.storage.objects.set(stemKey(name), wavFile());
  const child = {
    userId: 'owner', jobId: lyricsId, type: 'harmony', parentJobId: parentId, status: 'queued', title: 'Chords',
    key: `users/owner/harmony/${parentId}/${lyricsId}.json`,
    generatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), expiresAt: 9999999999,
  };
  context.database.put(child);
  const worker = createHarmonyWorker({ database: context.database, storage: context.storage, run });
  return { ...context, child, worker, input: { userId: 'owner', jobId: lyricsId, kind: 'harmony' } };
}

test('harmony is one record per song, separate from lyrics, and leaves originals alone', async () => {
  const { call, database, started } = setup();
  const made = await call(`${parentId}/harmony`, {});
  assert.equal(made.status, 202);
  const id = made.body.harmony.id;
  assert.equal(database.get('owner', id).key, `users/owner/harmony/${parentId}/${id}.json`);
  assert.equal('createdAt' in database.get('owner', id), false);
  assert.deepEqual(JSON.parse(started[0].input), { userId: 'owner', jobId: id, kind: 'harmony' });
  assert.equal((await call(`${parentId}/harmony`, {})).status, 200);
  assert.equal(started.length, 1);
  const job = (await call(parentId, undefined, 'GET')).body.job;
  assert.equal(job.harmony.status, 'queued');
  assert.equal(job.lyrics, undefined);
  assert.equal((await call(`${parentId}/lyrics`, {})).status, 202, 'lyrics still start on their own');
  assert.equal(started.length, 2);
});

test('harmony worker reads its stems, passes them by name, and writes only its key', async () => {
  let args;
  const { worker, input, database, storage, child } = harmonyCase(async (_python, given) => {
    args = given;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(given[1], JSON.stringify(goodHarmony));
    return { stdout: '' };
  });
  await worker(input);
  const saved = database.get('owner', lyricsId);
  assert.equal(saved.status, 'completed', saved.error);
  assert.ok(args[0].endsWith('analyze_harmony.py'));
  const stems = args.slice(2, args.indexOf('--vocals'));
  assert.deepEqual(stems.filter(item => item !== '--stem').map(item => item.split('=')[0]), ['other', 'bass', 'drums']);
  // The vocals and title go only to the accompaniment's genre, not to the score.
  assert.ok(args[args.indexOf('--vocals') + 1].endsWith('vocals.wav'));
  assert.equal(args[args.indexOf('--title') + 1], 'Song');
  assert.deepEqual(storage.calls.map(call => [call.kind, call.key]), [
    ...['other', 'bass', 'drums', 'vocals'].map(name => ['GetObjectCommand', stemKey(name)]), ['PutObjectCommand', child.key],
  ]);
});

test('harmony worker records safe failures and saves nothing', async () => {
  for (const [run, stage] of [
    [async () => { throw new Error('secret path /tmp/x'); }, 'analyze'],
    [async (_python, given) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(given[1], '{"stems":{}}');
      return { stdout: '' };
    }, 'validate'],
  ]) {
    const { worker, input, database, storage, child } = harmonyCase(run);
    await worker(input);
    const saved = database.get('owner', lyricsId);
    assert.equal(saved.failureStage, stage);
    assert.equal(saved.error.includes('secret'), false);
    assert.equal(storage.objects.has(child.key), false);
  }
});

test('harmony results from an older version stay shown until a new run finishes', async () => {
  const { call, database, started } = setup();
  database.put({
    userId: 'owner', jobId: lyricsId, type: 'harmony', parentJobId: parentId, status: 'completed', title: 'Chords', version: 12,
    key: `users/owner/harmony/${parentId}/${lyricsId}.json`, generatedAt: new Date(Date.now() - 60000).toISOString(),
  });
  const stale = (await call(parentId, undefined, 'GET')).body.job.harmony;
  assert.equal(stale.id, lyricsId);
  assert.equal(stale.status, 'completed', 'Older apps show it as it is');
  assert.equal(stale.stale, true, 'Newer ones start a new run');
  assert.ok(stale.url.endsWith(`${lyricsId}.json`));
  assert.equal((await call(`${parentId}/harmony`, {})).status, 202);
  const running = (await call(parentId, undefined, 'GET')).body.job.harmony;
  assert.equal(database.get('owner', running.id).version, 16);
  assert.equal(running.status, 'queued');
  assert.equal(running.stale, undefined);
  assert.equal(running.previous.id, lyricsId, 'The old score is shown while the new one is found');
  assert.ok(running.previous.url.endsWith(`${lyricsId}.json`));
  assert.equal((await call(`${parentId}/harmony`, {})).status, 200, 'Asking again does not start another run');
  assert.equal(started.length, 1);
  database.put({ ...database.get('owner', running.id), status: 'completed' });
  assert.equal((await call(parentId, undefined, 'GET')).body.job.harmony.previous, undefined);
});

function regeneration() {
  const context = setup();
  const finished = (id, fields) => context.database.put({
    userId: 'owner', jobId: id, type: 'harmony', version: 16, parentJobId: parentId, status: 'completed', title: 'Chords',
    key: `users/owner/harmony/${parentId}/${id}.json`, generatedAt: new Date(Date.now() - 60000).toISOString(), ...fields,
  });
  finished(lyricsId);
  return { ...context, finished };
}
const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('regenerating one stem needs a finished song result and a harmonic stem', async () => {
  const { call, started } = setup();
  assert.equal((await call(`${parentId}/harmony`, { stem: 'bass' })).status, 409);
  const { call: callDone } = regeneration();
  for (const stem of ['vocals', 'kazoo', 1, 'guitar']) assert.equal((await callDone(`${parentId}/harmony`, { stem })).status, 400, String(stem));
  assert.equal(started.length, 0);
});

test('regenerating starts only that stem, keeps the song result, and repeats safely while running', async () => {
  const { call, database, started } = regeneration();
  const made = await call(`${parentId}/harmony`, { stem: 'bass', cleaned: false });
  assert.equal(made.status, 202);
  const child = database.get('owner', made.body.harmony.id);
  assert.equal(child.stem, 'bass');
  assert.equal(child.baseKey, `users/owner/harmony/${parentId}/${lyricsId}.json`);
  assert.equal(child.sourceKey, undefined);
  assert.equal((await call(`${parentId}/harmony`, { stem: 'bass' })).status, 200);
  assert.equal(started.length, 1);
  assert.equal((await call(`${parentId}/harmony`, { stem: 'drums' })).status, 202, 'other stems run at the same time');
  assert.equal(started.length, 2);
  assert.equal((await call(`${parentId}/harmony`, {})).status, 200, 'the whole song is not redone');
  assert.equal(started.length, 2);
  const job = (await call(parentId, undefined, 'GET')).body.job;
  assert.equal(job.harmony.id, lyricsId);
  assert.equal(job.harmony.status, 'completed');
  assert.equal(job.harmony.stems.bass.status, 'queued');
  assert.equal(job.harmony.stems.drums.status, 'queued');
  assert.equal(job.harmony.stems.other, undefined);
  assert.equal((await call(`${parentId}/harmony`, { stem: 'other', cleaned: false })).status, 202, 'Harmonic is redone alone too');
  assert.equal((await call(parentId, undefined, 'GET')).body.job.harmony.stems.other.status, 'queued');
});

test('a failed regeneration reports its error and keeps the last good result of that stem', async () => {
  const { call, finished } = regeneration();
  finished(otherId, { stem: 'bass' });
  const failedId = '55555555-5555-4555-8555-555555555555';
  finished(failedId, { stem: 'bass', status: 'failed', error: 'Chord analysis failed. Please try again.', generatedAt: new Date().toISOString(), failedAt: new Date().toISOString() });
  const part = (await call(parentId, undefined, 'GET')).body.job.harmony.stems.bass;
  assert.equal(part.status, 'failed');
  assert.equal(part.error, 'Chord analysis failed. Please try again.');
  assert.equal(part.resultId, otherId);
  assert.ok(part.url.endsWith(`${otherId}.json`));
  const kept = await call(`${parentId}/harmony`, { stem: 'bass' });
  assert.equal(kept.status, 200, 'a stem regenerated once from this source is not redone');
  assert.equal(kept.body.harmony.resultId, otherId);
  finished('88888888-8888-4888-8888-888888888888', { stem: 'drums', status: 'failed', error: 'x', generatedAt: new Date().toISOString(), failedAt: new Date().toISOString() });
  assert.equal((await call(`${parentId}/harmony`, { stem: 'drums' })).status, 202, 'a failed one can be tried again');
});

test('regenerating from the cleaned version uses the newest finished cleanup of that stem', async () => {
  const { call, database } = regeneration();
  assert.equal((await call(`${parentId}/harmony`, { stem: 'bass', cleaned: true })).status, 409);
  const cleanup = (jobId, stem, generatedAt, status = 'completed') => database.put({
    userId: 'owner', jobId, type: 'restoration', parentJobId: parentId, stem, status, generatedAt, key: `users/owner/restored/${jobId}.wav`,
  });
  cleanup('66666666-6666-4666-8666-666666666666', 'bass', '2026-01-01T00:00:00.000Z');
  cleanup('77777777-7777-4777-8777-777777777777', 'bass', '2026-02-01T00:00:00.000Z');
  cleanup('88888888-8888-4888-8888-888888888888', 'bass', '2026-03-01T00:00:00.000Z', 'failed');
  cleanup('99999999-9999-4999-8999-999999999999', 'drums', '2026-04-01T00:00:00.000Z');
  const made = await call(`${parentId}/harmony`, { stem: 'bass', cleaned: true });
  assert.equal(made.status, 202);
  assert.equal(database.get('owner', made.body.harmony.id).sourceKey, 'users/owner/restored/77777777-7777-4777-8777-777777777777.wav');
});

test('the worker for one stem reads its source and the song grid, and skips what it does not need', async () => {
  for (const [stem, stemsRead] of [['other', ['other', 'bass']], ['bass', ['other', 'bass']], ['drums', ['drums']]]) {
    let args;
    const { worker, input, database, storage, child } = harmonyCase(async (_python, given) => {
      args = given;
      const { writeFile, readFile } = await import('node:fs/promises');
      assert.equal(await readFile(given[given.indexOf('--grid') + 1], 'utf8'), '{"grid":true}');
      await writeFile(given[1], JSON.stringify(goodHarmony));
      return { stdout: '' };
    });
    const sourceKey = 'users/owner/restored/x.wav', baseKey = `users/owner/harmony/${parentId}/base.json`;
    storage.objects.set(sourceKey, wavFile());
    storage.objects.set(baseKey, Buffer.from('{"grid":true}'));
    database.put({ ...child, stem, sourceKey, baseKey });
    await worker(input);
    const saved = database.get('owner', lyricsId);
    assert.equal(saved.status, 'completed', saved.error);
    assert.equal(args[args.indexOf('--only') + 1], stem);
    assert.deepEqual(args.filter((_, index) => args[index - 1] === '--stem').map(item => item.split('=')[0]), stemsRead);
    assert.deepEqual(storage.calls.filter(call => call.kind === 'GetObjectCommand').map(call => call.key),
      [...stemsRead.map(name => name === stem ? sourceKey : stemKey(name)), baseKey]);
    assert.deepEqual(storage.calls.filter(call => call.kind === 'PutObjectCommand').map(call => call.key), [child.key]);
  }
});

const python3 = (body, ...args) => JSON.parse(execFileSync('python3', ['-c',
  `import json, sys; sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('..', import.meta.url)))})
from note_lines import clear_line, drum_units, first_bar, note_values, struck_line
${body}`, ...args.map(value => JSON.stringify(value))], { encoding: 'utf8' }));
const noteLines = events => ({ line: python3('print(json.dumps(clear_line([tuple(e) for e in json.loads(sys.argv[1])])))', events) });
const pitches = result => result.line.map(note => note.pitch);
const written = (line, beats) => python3('print(json.dumps(note_values(json.loads(sys.argv[1]), json.loads(sys.argv[2]))))', line, beats)
  .map(note => [note.unit, note.length, note.pitch]);
const everyHalfSecond = Array.from({ length: 40 }, (_, index) => index * 0.5);
const note = (start, end, pitch = 60) => ({ start, end, pitch });

test('strummed chords no longer blank anything: the top note is written', () => {
  const strum = at => [[at, at + 0.4, 52, 0.9], [at + 0.03, at + 0.4, 59, 0.9], [at + 0.06, at + 0.4, 64, 0.9]];
  assert.ok(pitches(noteLines([...strum(0), ...strum(1), ...strum(2)])).includes(64));
});

test('same-level notes with nothing between connect, keeping length', () => {
  const { line } = noteLines([[1, 1.5, 69, 0.9], [1.7, 2.2, 69, 0.9], [2.4, 3, 69, 0.9], [5, 5.5, 69, 0.9]]);
  assert.deepEqual(line, [{ start: 1, end: 3, pitch: 69 }, { start: 5, end: 5.5, pitch: 69 }], 'a long silence stays a gap');
  assert.deepEqual(pitches(noteLines([[1, 1.5, 69, 0.9], [1.6, 2, 71, 0.9], [2.1, 2.5, 69, 0.9]])), [69, 71, 69], 'a note between keeps them apart');
});

test('only clear notes are written, and a removed blip does not split a note', () => {
  assert.deepEqual(pitches(noteLines([[1, 1.5, 69, 0.3], [2, 2.05, 70, 0.9], [3, 3.5, 71, 0.9]])), [71]);
  assert.deepEqual(noteLines([[1, 1.5, 69, 0.9], [1.5, 1.63, 74, 0.9], [1.63, 2, 69, 0.9]]).line, [{ start: 1, end: 2, pitch: 69 }]);
});

test('guitar takes the highest sounding note', () => {
  assert.deepEqual(pitches(noteLines([[1, 2, 45, 0.9], [1.2, 1.8, 57, 0.9]])), [45, 57]);
  assert.deepEqual(pitches(noteLines([[1, 2, 33, 0.4]])), []);
});

test('every bass pluck is its own note, even on the same pitch', () => {
  const struck = strokes => python3('print(json.dumps(struck_line(json.loads(sys.argv[1]))))', strokes);
  assert.deepEqual(struck([[1, 2, 33], [1.5, 2, 33], [2, 2.2, 31]]),
    [{ start: 1, end: 1.5, pitch: 33 }, { start: 1.5, end: 2, pitch: 33 }, { start: 2, end: 2.2, pitch: 31 }], 'a new pluck ends the last');
  assert.deepEqual(struck([[1, 1.3, 33], [1.05, 1.4, 33]]), [{ start: 1, end: 1.4, pitch: 33 }], 'flicker is one pluck');
  assert.deepEqual(struck([[1, 1.3, 33], [1.05, 1.4, 31]]).map(item => item.pitch), [33, 31], 'a fast change of pitch is two');
});

test('plucks sharing a sixteenth are all written', () => {
  const all = (line, beats) => python3('print(json.dumps(note_values(json.loads(sys.argv[1]), json.loads(sys.argv[2]), every=True)))', line, beats)
    .map(item => [item.unit, item.pitch]);
  assert.deepEqual(all([note(1, 1.2), note(1.01, 1.3, 62), note(1.02, 1.4, 64), note(1.5, 2, 65)], everyHalfSecond),
    [[8, 60], [9, 62], [10, 64], [12, 65]]);
});

test('notes snap to values on the beat grid, despite a constant early lean', () => {
  const lean = 0.03;
  assert.deepEqual(written([note(1 - lean, 1.45 - lean), note(2 - lean, 2.2 - lean, 62), note(2.25 - lean, 2.45 - lean, 64), note(4 - lean, 5 - lean, 65)], everyHalfSecond),
    [[8, 4, 60], [16, 2, 62], [18, 2, 64], [32, 8, 65]], 'quarter, two eighths, half; the gap before the half stays a rest');
});

test('short silences before the next note are legato, longer ones are rests, and overlaps are cut', () => {
  assert.deepEqual(written([note(0, 0.8), note(1, 2, 62)], everyHalfSecond), [[0, 8, 60], [8, 8, 62]], 'held to the next note');
  assert.deepEqual(written([note(0, 0.5), note(2, 3, 62)], everyHalfSecond), [[0, 4, 60], [16, 8, 62]], 'a real rest remains');
  assert.deepEqual(written([note(0, 1.5), note(1, 2, 62)], everyHalfSecond), [[0, 8, 60], [8, 8, 62]], 'written notes never overlap');
});

test('positions follow tempo changes, and a sixteenth holds only one note', () => {
  const speeding = [0, 1, 2, 2.5, 3, 3.5, 4, 4.5];
  assert.deepEqual(written([note(1, 2), note(2.5, 3, 62)], speeding).map(item => item.slice(0, 2)), [[4, 4], [12, 4]]);
  assert.equal(written([note(1, 1.2), note(1.01, 1.3, 62)], everyHalfSecond).length, 1);
});

test('bars start on the beat where the low notes most often begin', () => {
  const firstBar = notes => python3('print(first_bar(json.loads(sys.argv[1])))', notes);
  assert.equal(firstBar([{ unit: 12, length: 8 }, { unit: 28, length: 8 }, { unit: 16, length: 2 }]), 3);
  assert.equal(firstBar([]), 0);
});

test('drum hits snap to sixteenths past a constant lean, and flams on one drum become one hit', () => {
  const lean = 0.03;
  const { hits, shift } = python3('hits, shift = drum_units(json.loads(sys.argv[1]), json.loads(sys.argv[2])); print(json.dumps({"hits": hits, "shift": shift}))',
    { kick: [1 - lean, 2 - lean], snare: [1.5 - lean, 1.5 - lean + 0.01], hihat: [1 - lean, 1.25 - lean], tom: [3 - lean] }, everyHalfSecond);
  assert.ok(shift < 0);
  assert.deepEqual(hits.map(hit => [hit.unit, hit.drum]), [[8, 'hihat'], [8, 'kick'], [10, 'hihat'], [12, 'snare'], [16, 'kick'], [24, 'tom']]);
});

test('bars start from the backbeat, with low notes telling beat 1 from beat 3', () => {
  const firstBar = (notes, hits) => python3('print(first_bar(json.loads(sys.argv[1]), json.loads(sys.argv[2])))', notes, hits);
  const groove = Array.from({ length: 40 }, (_, beat) => ({ unit: (beat + 1) * 4, drum: beat % 2 ? 'kick' : 'snare' }));
  assert.equal(firstBar([], groove), 0, 'kicks land on even beats, so bars start on 0 or 2');
  assert.equal(firstBar([{ unit: 8, length: 8 }], groove), 2, 'low notes settle which');
  assert.equal(firstBar([{ unit: 4, length: 8 }], groove), 0, 'low notes on a backbeat do not overrule the drums');
  assert.equal(firstBar([{ unit: 4, length: 8 }], groove.slice(0, 4)), 1, 'too few hits leave it to the low notes');
});

test('harmony values must be real notes inside the song', () => {
  assert.equal(checkHarmony(goodHarmony, 2), goodHarmony);
  // The accompaniment's choices are optional, but when present they are ranked names and sounds.
  const choices = { genre: 'rock', genres: [['rock', 0.5]], guitar: { styles: ['Rock128'], sounds: [29, 30] }, keys: { styles: [], sounds: [0] } };
  assert.ok(checkHarmony({ ...goodHarmony, accompaniment: choices }, 2));
  assert.throws(() => checkHarmony({ ...goodHarmony, accompaniment: { ...choices, keys: { styles: [1], sounds: [] } } }, 2), /Invalid harmony/);
  const withGuitar = part => ({ beats: [0, 1], firstBar: 0, stems: { guitar: { chords: [], notes: [], ...part } } });
  const good = { start: 0, end: 1, pitch: 60, unit: 0, length: 4 };
  assert.ok(checkHarmony(withGuitar({ notes: [good] }), 2));
  assert.ok(checkHarmony(withGuitar({ hits: [{ unit: 4, drum: 'snare' }], patterns: [{ unit: 0, label: 'A' }] }), 2));
  for (const bad of [null, {}, { stems: {} }, { beats: [0, 1], firstBar: 0, stems: { guitar: {} } },
    { ...withGuitar({}), beats: [1, 0] }, { ...withGuitar({}), beats: [1] }, { ...withGuitar({}), beats: undefined }, { ...withGuitar({}), firstBar: 4 },
    withGuitar({ chords: [{ start: 99, name: 'C' }] }), withGuitar({ chords: [{ start: 0, name: '' }] }),
    withGuitar({ notes: [{ ...good, pitch: 200 }] }), withGuitar({ notes: [{ ...good, pitch: 60.5 }] }),
    withGuitar({ notes: [{ ...good, end: undefined }] }), withGuitar({ notes: [{ ...good, start: 1, end: 0.5 }] }),
    withGuitar({ notes: [{ ...good, unit: 1.5 }] }), withGuitar({ notes: [{ ...good, length: 0 }] }),
    withGuitar({ hits: [{ unit: 1, drum: 'cowbell' }] }), withGuitar({ hits: [{ unit: -1, drum: 'kick' }] }), withGuitar({ hits: 'kick' }),
    withGuitar({ patterns: [{ unit: 1, label: '' }] })]) {
    assert.throws(() => checkHarmony(bad, 2), undefined, JSON.stringify(bad));
  }
});

test('lyrics are one record per song, start with their kind, and stay out of the library', async () => {
  const { call, database, started } = setup();
  const made = await call(lyricsRoute, {});
  assert.equal(made.status, 202);
  const id = made.body.lyrics.id;
  const child = database.get('owner', id);
  assert.equal(child.type, 'lyrics');
  assert.equal(child.key, `users/owner/lyrics/${parentId}/${id}.json`);
  assert.equal('createdAt' in child, false);
  assert.deepEqual(JSON.parse(started[0].input), { userId: 'owner', jobId: id, kind: 'lyrics' });
  const again = await call(lyricsRoute, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.lyrics.id, id);
  assert.equal(started.length, 1);
  assert.equal((await call(lyricsRoute, {}, 'POST', 'intruder')).status, 404);
  assert.equal((await call(lyricsRoute, undefined, 'GET')).status, 404);
  database.put({ ...child, status: 'completed' });
  const job = (await call(parentId, undefined, 'GET')).body.job;
  assert.deepEqual(job.lyrics, { id, status: 'completed', url: `https://signed/${child.key}` });
  assert.deepEqual(job.restorations, []);
});

test('lyrics wait for the stems, and a failure can be retried', async () => {
  const context = setup();
  context.database.put(parent({ status: 'processing', stems: undefined }));
  assert.equal((await context.call(lyricsRoute, {})).status, 409);
  context.database.put(parent());
  context.orchestrator.fail = true;
  assert.equal((await context.call(lyricsRoute, {})).status, 503);
  assert.equal((await context.call(parentId, undefined, 'GET')).body.job.lyrics.status, 'failed');
  context.orchestrator.fail = false;
  assert.equal((await context.call(lyricsRoute, {})).status, 202);
  assert.equal((await context.call(parentId, undefined, 'GET')).body.job.lyrics.status, 'queued');
});

test('a stuck lyrics record shows as failed after the deadline', async () => {
  const { call, database } = setup();
  const id = (await call(lyricsRoute, {})).body.lyrics.id;
  database.put({ ...database.get('owner', id), status: 'processing', startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60000).toISOString() });
  const { lyrics } = (await call(parentId, undefined, 'GET')).body.job;
  assert.equal(lyrics.status, 'failed');
  assert.match(lyrics.error, /Lyrics recognition expired/);
});

test('lyrics worker reads only the vocal stem and writes only the lyrics key', async () => {
  const { worker, input, database, storage, child } = lyricsCase(writesLyrics(JSON.stringify(goodLyrics)));
  await worker(input);
  const saved = database.get('owner', lyricsId);
  assert.equal(saved.status, 'completed', saved.error);
  assert.equal('expiresAt' in saved, false);
  assert.deepEqual(JSON.parse(storage.objects.get(child.key)), goodLyrics);
  assert.deepEqual(storage.calls.map(call => [call.kind, call.key]), [
    ['GetObjectCommand', stemKey('vocals')], ['PutObjectCommand', child.key],
  ]);
});

test('a song with no vocals still completes, with no lines', async () => {
  const { worker, input, database, storage, child } = lyricsCase(writesLyrics('{"language":null,"lines":[]}'));
  await worker(input);
  assert.equal(database.get('owner', lyricsId).status, 'completed');
  assert.deepEqual(JSON.parse(storage.objects.get(child.key)).lines, []);
});

test('lyrics worker records safe failures and saves nothing', async () => {
  const bad = { lines: [{ words: [{ start: 99, end: 100, text: 'late' }] }] };
  for (const [run, stage] of [
    [async () => { throw new Error('secret path /tmp/x'); }, 'analyze'],
    [writesLyrics('not json'), 'validate'],
    [writesLyrics(JSON.stringify(bad)), 'validate'],
  ]) {
    const { worker, input, database, storage, child } = lyricsCase(run);
    await worker(input);
    const saved = database.get('owner', lyricsId);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.failureStage, stage);
    assert.equal(saved.error.includes('secret'), false);
    assert.equal(storage.objects.has(child.key), false);
  }
});

test('lyrics worker ignores running records and other record types', async () => {
  let ran = 0;
  const { worker, input, database, child } = lyricsCase(async () => { ran++; return { stdout: '' }; });
  database.put({ ...child, status: 'processing' });
  await worker(input);
  assert.equal(ran, 0);
  database.put({ ...child, type: 'restoration' });
  await assert.rejects(worker(input));
});

test('lyrics times must fall inside the song', () => {
  assert.equal(checkLyrics(goodLyrics, 2), goodLyrics);
  for (const bad of [null, {}, { lines: [{}] }, { lines: [{ words: [] }] },
    { lines: [{ words: [{ start: 1, end: 0.5, text: 'x' }] }] },
    { lines: [{ words: [{ start: 0, end: 1, text: '' }] }] },
    { lines: [{ words: [{ start: -1, end: 1, text: 'x' }] }] }]) {
    assert.throws(() => checkLyrics(bad, 2), undefined, JSON.stringify(bad));
  }
});

test('local server routes lyrics with verified identity', async t => {
  let seen;
  const server = createLocalServer({
    verify: async () => ({ sub: 'real-owner' }),
    stems: async e => { seen = e; return { statusCode: 202, headers: {}, body: '{}' }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/stems/jobs/${parentId}/lyrics`;
  const headers = { Authorization: 'Bearer token' };
  assert.equal((await fetch(base, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(base, { method: 'POST', headers, body: '{}' })).status, 202);
  assert.equal(seen.requestContext.authorizer.jwt.claims.sub, 'real-owner');
  assert.equal((await fetch(base, { headers })).status, 405);
});

test('the template lets the task write lyrics and routes them', () => {
  const template = readFileSync(new URL('../../template.yaml', import.meta.url), 'utf8');
  const taskPolicy = template.slice(template.indexOf('StemTaskRole:'), template.indexOf('StemTask:\n'));
  assert.ok(taskPolicy.includes('users/*/lyrics/*'));
  assert.ok(taskPolicy.includes('users/*/harmony/*'));
  assert.ok(template.includes("Action: s3:PutObject\n              Resource:\n                - !Sub '${AudioBucket.Arn}/users/*/lyrics/*'\n                - !Sub '${AudioBucket.Arn}/users/*/harmony/*'"), 'the API can save edited lyrics and harmony from a score');
  assert.match(taskPolicy, /Action: s3:GetObject[\s\S]*?users\/\*\/restored\/\*[\s\S]*?users\/\*\/harmony\/\*[\s\S]*?Action: \[s3:PutObject/, 'can read cleaned stems and saved results');
  assert.ok(template.includes('/api/stems/jobs/{jobId}/lyrics'));
  assert.ok(template.includes('/api/stems/jobs/{jobId}/harmony'));
  const docker = readFileSync(new URL('../Dockerfile.stems', import.meta.url), 'utf8');
  assert.ok(docker.includes('transcribe_vocals.py'));
  assert.ok(docker.includes('analyze_harmony.py'));
  assert.ok(docker.includes('note_lines.py'));
});

test('the template keeps delete permission away from original stems', () => {
  const template = readFileSync(new URL('../../template.yaml', import.meta.url), 'utf8');
  const taskPolicy = template.slice(template.indexOf('StemTaskRole:'), template.indexOf('StemTask:\n'));
  assert.ok(taskPolicy.includes("users/*/restored/*"));
  const api = template.slice(template.indexOf('Deliberately excludes users/*/stems/*'), template.indexOf('Lets HEAD on a missing'));
  assert.ok(api.includes("users/*/restored/*"));
  assert.equal(api.includes('stems/*\''), false);
});

test('the ensemble part is checked like a stem part, with a key', async () => {
  const { checkHarmony } = await import('../stem-analysis.mjs');
  const base = { beats: [0, 1], firstBar: 0, stems: { bass: { chords: [], notes: [] } } };
  const ensemble = { key: 'F#m', chords: [{ start: 0, name: 'Cmaj7/E' }], notes: [{ start: 0.5, end: 1, pitch: 69, unit: 2, length: 2 }],
    second: [{ start: 0.5, end: 1, pitch: 64, unit: 2, length: 2 }] };
  assert.ok(checkHarmony({ ...base, ensemble }, 2));
  assert.ok(checkHarmony(base, 2), 'Bass or drums regenerated alone have no ensemble');
  for (const bad of [{ ...ensemble, key: 'H' }, { ...ensemble, key: undefined }, { ...ensemble, chords: [{ start: 0, name: '' }] },
    { ...ensemble, notes: [{ start: 0, end: 1, pitch: 200, unit: 0, length: 1 }] },
    { ...ensemble, second: [{ start: 0, end: 1, pitch: 60, unit: -1, length: 1 }] }, null]) {
    assert.throws(() => checkHarmony({ ...base, ensemble: bad }, 2), /Invalid harmony/, JSON.stringify(bad));
  }
});

// Progression rules for the ensemble's chords and lines (harmony version 6). They need librosa: run with
// HARMONY_PYTHON set to an environment that has it (the worker image does); otherwise they are skipped.
const harmonyPython = process.env.HARMONY_PYTHON ?? 'python3';
let hasHarmony = false;
try { execFileSync(harmonyPython, ['-c', 'import librosa']); hasHarmony = true; } catch { /* Skipped below. */ }
const harmony = (body, ...args) => JSON.parse(execFileSync(harmonyPython, ['-c',
  `import json, sys; sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('..', import.meta.url)))})
import numpy as np
import analyze_harmony as h
${body}`, ...args.map(value => JSON.stringify(value))], { encoding: 'utf8' }));

test('chords inside the key cost nothing, common borrowings a little, others more', { skip: !hasHarmony }, () => {
  const costs = harmony('print(json.dumps(h.outside_cost([(0, ""), (9, "m"), (7, "7"), (2, "m7"), (10, ""), (6, "")], 0, False)[:, 0].tolist()))');
  assert.deepEqual(costs, [0, 0, 0, 0, 0.05, 0.15]);
});

test('a dominant going home is the likeliest change, a tritone the least', { skip: !hasHarmony }, () => {
  const [home, up, tritone] = harmony(`chords = [(7, ""), (0, ""), (6, "")]
moves = h.progression_moves(chords, 0, False)
print(json.dumps([moves[0, 1], moves[1, 0], moves[1, 2]]))`);
  assert.ok(home > up && up > tritone, JSON.stringify([home, up, tritone]));
});

test('unclear evidence names the chord the key expects, and changes land on the beat', { skip: !hasHarmony }, () => {
  // E and B, with G and G# equally present: Em belongs to C major, E major does not.
  const path = harmony(`frames = 120
chroma = np.zeros((12, frames))
chroma[[0, 4, 7], :60] = 1
chroma[[4, 11], 60:] = 1
chroma[[7, 8], 60:] = 0.5
beats = [i * 0.5 for i in range(20)]
path = h.progression_path(chroma, np.zeros((12, frames)), 0, False, beats, 0)
changes = [i for i in range(1, frames) if path[i] != path[i - 1]]
print(json.dumps({'first': h.chord_name(*path[10]), 'last': h.chord_name(*path[110]), 'changes': changes}))`);
  assert.equal(path.first, 'C');
  assert.equal(path.last, 'Em');
  const beatFrames = Array.from({ length: 20 }, (_, i) => Math.round(i * 0.5 / (2048 / 22050)));
  assert.ok(path.changes.every(frame => beatFrames.some(beat => Math.abs(beat - frame) <= 1)), JSON.stringify(path.changes));
});

test('the key comes from the notes, and a clear third settles major or minor', { skip: !hasHarmony }, () => {
  // E, B and F# most of all, like a power-chord riff: the profile leans to E major, but G is played and G# is not.
  const [riff, major, none] = harmony(`riff = [(0, 4, 40, 1), (0, 1.5, 47, 1), (1, 2, 42, 1), (2, 2.8, 43, 1), (3, 3.5, 45, 1), (4, 6, 40, 1), (6, 6.4, 43, 1)]
major = [(0, 2, 59, 1), (0, 2, 63, 1), (0, 2, 66, 1), (2, 3, 64, 1), (3, 4, 68, 1), (4, 5, 71, 1)]
print(json.dumps([h.key_name(*h.note_key(riff)), h.key_name(*h.note_key(major)), h.note_key([])]))`);
  assert.equal(riff, 'Em');
  assert.equal(major, 'B');
  assert.equal(none, null);
});

test('chords are named in the key: sharps in sharp keys, flats in flat keys', { skip: !hasHarmony }, () => {
  const names = harmony(`print(json.dumps([h.spell_chord('Abm7/Eb', h.spelling(11, 0)), h.spell_chord('C#', h.spelling(5, 0)),
  h.spell_chord('N.C.', h.SHARP_NAMES), h.key_name(8, 1), h.key_name(3, 1), sorted(h.tones_of('E/G#')), h.tones_of('N.C.')]))`);
  assert.deepEqual(names, ['G#m7/D#', 'Db', 'N.C.', 'G#m', 'Ebm', [4, 8, 11], null]);
});

test('overtones go; real attacks stay as one chord per sixteenth, weak ones and weak inner notes go', { skip: !hasHarmony }, () => {
  const notes = harmony(`events = [(0.0, 0.9, 52, 0.9), (0.0, 0.9, 64, 0.5), (0.0, 0.9, 71, 0.4), (0.01, 0.9, 56, 0.8),
          (0.0, 0.9, 59, 0.5), (0.0, 0.9, 62, 0.8), (0.5, 0.9, 59, 0.7), (0.75, 0.85, 56, 0.39),
          (1.0, 1.3, 60, 0.9), (1.0, 1.3, 57, 0.7), (2.5, 3, 60, 0.9)]
chords = [{'start': 0, 'name': 'E'}, {'start': 1.0, 'name': 'Am'}, {'start': 2.0, 'name': 'N.C.'}]
beats = [i * 0.5 for i in range(10)]
print(json.dumps([(n['unit'], n['length'], n['pitch']) for n in h.chord_notes(h.without_overtones(events), chords, beats)[0]]))`);
  // E3's octave and twelfth are overtones; D is not in E but heard clearly, so it stays; B struck again while it
  // rings is one held B, as strong as its stronger attack; the soft G# on the second half of beat 2 is no real
  // attack; Am's notes last as long as they sound; nothing after N.C.
  assert.deepEqual(notes, [[0, 8, 52], [0, 8, 56], [0, 8, 59], [0, 8, 62], [8, 2, 57], [8, 2, 60]]);
});

test('the same pitch again right after a note is that note held', { skip: !hasHarmony }, () => {
  const joined = harmony(`print(json.dumps(h.joined_repeats([(0, 0.25, 64, 0.5), (0.25, 0.5, 64, 0.8), (0.55, 0.75, 64, 0.4), (1.2, 1.4, 64, 0.5), (0.3, 0.6, 60, 0.6)])))`);
  assert.deepEqual(joined, [[0, 0.75, 64, 0.8], [0.3, 0.6, 60, 0.6], [1.2, 1.4, 64, 0.5]]);
});

test('upper and lower notes starting close together are written as one chord', { skip: !hasHarmony }, () => {
  const notes = harmony(`events = [(0.44, 0.9, 52, 0.8), (0.5, 0.9, 59, 0.8), (0.52, 0.9, 64, 0.8), (1.5, 1.9, 64, 0.8)]
beats = [i * 0.5 for i in range(10)]
print(json.dumps([(n['unit'], n['pitch']) for n in h.chord_notes(events, [{'start': 0, 'name': 'E'}], beats)[0]]))`);
  // The low E comes a sixteenth early (0.44 s is nearer the sixteenth before beat 1); the strum is still one chord.
  assert.deepEqual(notes, [[3, 52], [3, 59], [3, 64], [12, 64]]);
});

test('a note struck again is two notes, one just ringing on is held; one barely struck and faint is no note', { skip: !hasHarmony }, () => {
  const found = harmony(`events = [(0.0, 0.45, 64, 0.8), (0.5, 0.9, 64, 0.8), (1.0, 1.45, 67, 0.8), (1.5, 1.9, 67, 0.8), (2.5, 2.9, 60, 0.4), (3.0, 3.4, 60, 0.8)]
attack = {(0.0, 64): 0.9, (0.5, 64): 0.8, (1.0, 67): 0.9, (1.5, 67): 0.2, (2.5, 60): 0.05, (3.0, 60): 0.9}
beats = [i * 0.5 for i in range(12)]
notes, heard = h.chord_notes(events, [{'start': 0, 'name': 'C'}], beats, attack, [(3.5, 3.9, 64, 0.25)])
print(json.dumps({'notes': [(n['unit'], n['pitch'], n['length'], n['sure']) for n in notes], 'heard': sorted((n['unit'], n['pitch']) for n in heard)}))`);
  assert.deepEqual(found.notes, [[0, 64, 4, 0.84], [4, 64, 4, 0.8], [8, 67, 7, 0.84], [24, 60, 3, 0.84]],
    'E twice, G once held; the faint C barely struck goes; confidence from strength and attack');
  assert.deepEqual(found.heard.at(-1), [28, 64], 'A faint note is heard, for the vote, but not written');
});

test('a note ends where its sound falls away, not with its ringing tail; louder notes get higher velocities', { skip: !hasHarmony }, () => {
  const found = harmony(`times = np.arange(2000) * 256 / 22050
note = np.zeros((2000, 88))
note[1000:1020, 60 - 21] = 0.9
note[1020:1060, 60 - 21] = 0.2
note[1100:1160, 64 - 21] = 0.8
audio = np.zeros(int(times[-1] * 22050) + 2048)
audio[1000 * 256:1060 * 256] = 0.05 * np.sin(np.arange(60 * 256) * 0.1)
audio[1100 * 256:1700 * 256] = 0.5 * np.sin(np.arange(600 * 256) * 0.1)  # The song's loud level around.
shape = h.note_shape({'note': note}, times, audio, 22050)
at = lambda frame: round(float(times[frame]), 2)
print(json.dumps([shape((at(1000), at(1060), 60, 0.6)), shape((at(1100), at(1160), 64, 0.8)), at(1020), at(1160)]))`);
  assert.equal(found[0][0], found[2], 'The C ends as it falls to its ringing tail');
  assert.equal(found[1][0], found[3], 'The E sustains to its end');
  assert.ok(found[1][1] > found[0][1] + 40, 'The loud E is played harder than the soft C');
});

test('a stop is quiet against its own loud level around it; a soft intro is not', { skip: !hasHarmony }, () => {
  const quiet = harmony(`level = np.concatenate([np.full(200, 0.05), np.full(200, 1.0), np.full(10, 0.02), np.full(200, 1.0)])
q = h.quiet_frames(level)
print(json.dumps([bool(q[100]), bool(q[300]), bool(q[405]), bool(q[500])]))`);
  assert.deepEqual(quiet, [false, false, true, false]);
});

test('voted chords: a beat takes what most playings have there; each playing keeps its own rests', { skip: !hasHarmony }, () => {
  const chords = harmony(`import repeats as r
beats = [i * 1.0 for i in range(60)]
# Bars are 4 s. Three playings of one bar: C C G G, C C G G, and C F G G with a rest at 13 s.
chords = [{'start': 0, 'name': 'C'}, {'start': 2, 'name': 'G'}, {'start': 4, 'name': 'C'}, {'start': 6, 'name': 'G'},
          {'start': 8, 'name': 'C'}, {'start': 9, 'name': 'F'}, {'start': 10, 'name': 'G'}, {'start': 12, 'name': 'C'}, {'start': 13, 'name': 'N.C.'}]
print(json.dumps([(c['start'], c['name']) for c in r.voted_chords(chords, beats, 0, 1, [0, 1, 2])]))`);
  assert.deepEqual(chords, [[0, 'C'], [2, 'G'], [4, 'C'], [6, 'G'], [8, 'C'], [10, 'G'], [12, 'C'], [13, 'N.C.']]);
});

test('a long silence and the end of the song are no chord', { skip: !hasHarmony }, () => {
  const changes = harmony(`frames = 200
names = ['C'] * 50 + ['G'] * 50 + ['F'] * 100
audible = np.ones(frames, bool)
audible[60:90] = False
audible[150:] = False
print(json.dumps([(c['name'], c['start']) for c in h.chord_changes(names, audible)]))`);
  const seconds = frame => Math.round(frame * 2048 / 22050 * 100) / 100;
  assert.deepEqual(changes, [['C', 0], ['G', seconds(50)], ['N.C.', seconds(60)], ['G', seconds(90)], ['F', seconds(100)], ['N.C.', seconds(150)]]);
});

// Repeated passages: a four-bar phrase played three times, the second time with two notes missed and one extra.
const repeatsPython = (body) => JSON.parse(execFileSync(harmonyPython, ['-c',
  `import json, sys; sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('..', import.meta.url)))})
import repeats as r
beats = [i * 0.5 for i in range(200)]
phrase = [(0, 60), (2, 62), (4, 64), (6, 65), (8, 67), (12, 65)]
def passage(bar, missing=(), sure=0.8):
    notes = []
    for b in range(4):
        for unit, pitch in phrase:
            if (b, unit) not in missing:
                notes.append({'unit': bar * 16 + b * 16 + unit, 'length': 2, 'pitch': pitch + b, 'start': 0, 'end': 0, 'sure': sure})
    return notes
heard_there = lambda pitch, seconds: 0.4 if seconds < 2 else 0.1
${body}`], { encoding: 'utf8' }));

test('repeated passages correct one another by vote: a note most playings have is added where the sound has some of it', { skip: !hasHarmony }, () => {
  const found = repeatsPython(`
extra = [{'unit': 16 + 10, 'length': 2, 'pitch': 50, 'start': 0, 'end': 0, 'sure': 0.4}, {'unit': 32 + 10, 'length': 2, 'pitch': 52, 'start': 0, 'end': 0, 'sure': 0.9}]
notes = passage(0, missing={(0, 4), (2, 8)}) + extra + passage(8) + passage(16)
n, c, reps, changes = r.voted(notes, notes, heard_there, [], beats, 0)
print(json.dumps({'reps': reps, 'first': sorted((x['unit'], x['pitch']) for x in n if x['unit'] < 64), 'changes': changes,
  'voted': [(x['unit'], x['pitch'], x['sure']) for x in n if x.get('voted')]}))`);
  assert.deepEqual(found.reps.map(rep => [rep.bars, rep.members]), [[4, [0, 8, 16]]], 'One family of four bars');
  assert.deepEqual(found.voted, [[4, 64, 0.4]], 'The missed E in the first second is added: its sound has it; the G at 20 s does not');
  assert.ok(!found.first.some(([unit, pitch]) => unit === 26 && pitch === 50), 'A faint note no other playing has goes');
  assert.ok(found.first.some(([unit, pitch]) => unit === 42 && pitch === 52), 'A clear one is a variation and stays');
  assert.deepEqual(found.changes, { added: 1, removed: [{ unit: 26, pitch: 50, length: 2 }] });
});

test('passages less than 70% alike, or too sparse, are left alone; a phrase moved to another key is a repeat', { skip: !hasHarmony }, () => {
  const found = repeatsPython(`
other = [{'unit': 128 + i * 4, 'length': 2, 'pitch': 50 + (i * 7) % 23, 'start': 0, 'end': 0} for i in range(16)]
sparse = [{'unit': 256 + i * 16, 'length': 2, 'pitch': 60, 'start': 0, 'end': 0} for i in range(8)]
n, c, reps, changes = r.voted(passage(0) + other + sparse, [], heard_there, [], beats, 0)
print(json.dumps(reps))`);
  // Each bar of the phrase is the one before a semitone up, so its last two bars are its first two moved up two.
  assert.deepEqual(found, [{ family: 0, bars: 2, members: [0, 2], shifts: [0, 2] }]);
});

test('a playing moved to another key is voted with the others moved back; time warping lines up a pushed chord', { skip: !hasHarmony }, () => {
  const found = repeatsPython(`
riff = [(0, 52), (0, 59), (4, 52), (6, 55), (8, 57), (12, 59)]
def played(bar, move=0, missing=(), push=0):
    return [{'unit': bar * 16 + b * 16 + unit + (push if unit == 8 else 0), 'length': 2, 'pitch': pitch + move,
             'start': 0, 'end': 0, 'sure': 0.8, 'velocity': 90} for b in range(2) for unit, pitch in riff if (b, unit) not in missing]
heard_here = lambda pitch, seconds: 0.5
notes = played(0) + played(4) + played(8, move=5, missing={(1, 6)}) + played(12, push=2)
n, c, reps, changes = r.voted(notes, notes, heard_here, [], beats, 0)
lined = r.warped({0: {4, 11}, 4: {4}, 6: {7}, 8: {9}}, {0: {4, 11}, 4: {4}, 7: {7}, 10: {9}})
print(json.dumps({'reps': reps, 'voted': [(x['unit'], x['pitch'], x['velocity']) for x in n if x.get('voted')], 'lined': sorted(lined.items())}))`);
  assert.deepEqual(found.reps, [{ family: 0, bars: 2, members: [0, 4, 8, 12], shifts: [0, 0, 5, 0] }]);
  assert.deepEqual(found.voted, [[8 * 16 + 16 + 6, 60, 90]], 'The G missed in the moved playing comes back as its C, at the others\' velocity');
  assert.deepEqual(found.lined, [[0, 0], [4, 4], [7, 6], [10, 8]], 'Late onsets meet their counterparts');
});

const scoreHarmony = (fields = {}) => ({
  beats: [0, 0.5, 1, 1.5, 2], firstBar: 0, accompaniment: { genre: 'rock' },
  ensemble: { key: 'B', chords: [{ start: 0, name: 'B' }], notes: [{ start: 0.5, end: 1, pitch: 71, unit: 4, length: 4, velocity: 90, confidence: 1 }] },
  stems: { bass: { chords: [], notes: [] }, drums: { chords: [], notes: [], hits: [{ unit: 0, drum: 'kick' }] } },
  fromScore: { title: 'Our God', measures: 124, notes: 1464, correctedBars: 0 }, ...fields,
});

test('a Harmonic score from an uploaded score becomes the song\'s result, the analysis stays to go back to', async () => {
  const { call, database, storage, started, finished } = regeneration();
  // A bass part regenerated before the score: on the old beats, so not shown with it.
  finished(otherId, { stem: 'bass', generatedAt: new Date(Date.now() - 30000).toISOString() });
  const made = await call(`${parentId}/harmony`, { fromScore: scoreHarmony() });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.harmony.fromScore, { title: 'Our God', measures: 124, notes: 1464, correctedBars: 0 });
  const child = database.get('owner', made.body.harmony.id);
  assert.equal(child.key, `users/owner/harmony/${parentId}/${child.jobId}.json`);
  assert.equal(child.version, 16);
  assert.deepEqual(JSON.parse(storage.objects.get(child.key)), scoreHarmony());
  const shown = (await call(parentId, undefined, 'GET')).body.job.harmony;
  assert.equal(shown.id, child.jobId);
  assert.equal(shown.stems, undefined, 'the older regenerated part is left out');
  assert.equal(started.length, 0);
  // The analysis no longer redoes the Harmonic part while the score is used; going back makes it current again.
  assert.equal((await call(`${parentId}/harmony`, { stem: 'other' })).status, 409);
  const back = await call(`${parentId}/harmony`, { useAnalysis: true });
  assert.equal(back.status, 201);
  assert.equal(back.body.harmony.fromScore, undefined);
  assert.equal(database.get('owner', back.body.harmony.id).key, `users/owner/harmony/${parentId}/${lyricsId}.json`);
  assert.equal((await call(parentId, undefined, 'GET')).body.job.harmony.id, back.body.harmony.id);
});

test('a Harmonic score from an uploaded score must be a whole result on rising beats', async () => {
  const { call, storage } = regeneration();
  const before = storage.objects.size;
  for (const bad of [null, 'text', scoreHarmony({ beats: [0, 1, 1] }), scoreHarmony({ firstBar: 9 }), scoreHarmony({ ensemble: { chords: [] } }),
    scoreHarmony({ ensemble: { chords: [], notes: [{ start: 1, end: 0.5, pitch: 60, unit: 0, length: 1 }] } }),
    scoreHarmony({ ensemble: { chords: [], notes: [{ start: 0, end: 1, pitch: 200, unit: 0, length: 1 }] } }),
    scoreHarmony({ fromScore: undefined }), scoreHarmony({ ensemble: { chords: [], notes: Array.from({ length: 80000 }, () => ({ start: 0, end: 1, pitch: 60, unit: 0, length: 4, velocity: 90 })) } })]) {
    assert.equal((await call(`${parentId}/harmony`, { fromScore: bad })).status, 400, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.equal(storage.objects.size, before);
  assert.equal((await setup().call(`${parentId}/harmony`, { useAnalysis: true })).status, 409);
});

const scoreXml = '<?xml version="1.0"?><score-partwise version="4.0"><part-list/><part id="P1"/></score-partwise>';

test('a song keeps its own score and the sound extracted with it, removed with it', async () => {
  const { call, database, storage } = regeneration();
  assert.equal((await call(`${parentId}/score/extracted`, { bytes: 1000 })).status, 409, 'no score yet');
  const saved = await call(`${parentId}/score`, { title: 'Our God', musicxml: scoreXml });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.score.title, 'Our God');
  assert.equal(saved.body.score.url, `https://signed/users/owner/scores/${parentId}/score.musicxml`);
  assert.equal(storage.objects.get(`users/owner/scores/${parentId}/score.musicxml`).toString(), scoreXml);
  assert.equal(database.get('owner', parentId).score.title, 'Our God');
  const job = (await call(parentId, undefined, 'GET')).body.job;
  assert.equal(job.score.title, 'Our God');
  assert.equal(job.score.extractedUrl, undefined);
  const upload = await call(`${parentId}/score/extracted`, { bytes: 1000 });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  assert.equal((await call(parentId, undefined, 'GET')).body.job.score.extractedUrl, `https://signed/users/owner/scores/${parentId}/extracted.wav`);
  for (const bad of [{ musicxml: '<html/>' }, { musicxml: 3 }, { title: 'x' }]) assert.equal((await call(`${parentId}/score`, bad)).status, 400);
  assert.equal((await call(`${parentId}/score/extracted`, { bytes: 10 })).status, 400);
  assert.equal((await call(`${parentId}/score`, { title: 'x', musicxml: scoreXml }, 'POST', 'intruder')).status, 404);
  assert.equal((await call(`${parentId}/score`, undefined, 'DELETE')).status, 200);
  assert.equal(database.get('owner', parentId).score, undefined);
  assert.equal(storage.objects.has(`users/owner/scores/${parentId}/score.musicxml`), false);
});

test('a song\'s score is laid on it by the stem worker: started when saved (once), run in Node, its sound saved', async () => {
  const { call, database, storage, started } = regeneration();
  for (const name of STEM_NAMES) storage.objects.set(stemKey(name), wavFile());
  storage.objects.set(`users/owner/harmony/${parentId}/${lyricsId}.json`, Buffer.from(JSON.stringify({ beats: [0, 0.5, 1], firstBar: 0 })));
  const saved = await call(`${parentId}/score`, { title: 'Our God', musicxml: scoreXml });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.harmony.status, 'queued');
  const child = database.get('owner', saved.body.harmony.id);
  assert.equal(child.scoreKey, `users/owner/scores/${parentId}/score.musicxml`);
  assert.equal(child.baseKey, `users/owner/harmony/${parentId}/${lyricsId}.json`, 'on the analysed result');
  assert.equal(child.scoreSavedAt, saved.body.score.savedAt);
  assert.deepEqual(JSON.parse(started.at(-1).input), { userId: 'owner', jobId: child.jobId, kind: 'harmony' });
  // Asking again for the same score, or regenerating Harmonic, gives the same run.
  assert.equal((await call(`${parentId}/harmony`, { useScore: true })).body.harmony.id, child.jobId);
  assert.equal((await call(`${parentId}/harmony`, { stem: 'other' })).body.harmony.id, child.jobId);
  assert.equal(started.length, 1);
  // The worker: node runs score_run.mjs, which writes the result and the extracted sound.
  const document = { beats: [0, 0.5, 1, 1.5], firstBar: 0, ensemble: { key: 'B', chords: [{ start: 0, name: 'B' }], notes: [{ start: 0, end: 0.5, pitch: 59, unit: 0, length: 4, velocity: 90 }] },
    stems: {}, fromScore: { title: 'Our God', measures: 1, notes: 1, heard: 1, correctedBars: 0, bars: [{ number: '1', start: 0, end: 2 }] } };
  const calls = [];
  const run = async (program, args) => {
    calls.push({ program, script: args[0].split('/').pop(), args });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(args[1], JSON.stringify(document));
    await writeFile(args[args.indexOf('--extracted') + 1], Buffer.from('RIFFWAVE'));
    return { stdout: '' };
  };
  await createHarmonyWorker({ database, storage, run })({ userId: 'owner', jobId: child.jobId, kind: 'harmony' });
  assert.equal(calls[0].program, process.execPath);
  assert.equal(calls[0].script, 'score_run.mjs');
  for (const name of ['other', 'vocals', 'bass', 'drums']) assert.ok(calls[0].args.some(arg => arg.startsWith(`${name}=`)));
  const done = database.get('owner', child.jobId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.fromScore, { title: 'Our God', measures: 1, notes: 1, heard: 1, correctedBars: 0 }, 'without where each measure is');
  assert.deepEqual(JSON.parse(storage.objects.get(child.key)), document);
  assert.equal(storage.objects.get(`users/owner/scores/${parentId}/extracted.wav`).toString(), 'RIFFWAVE');
  assert.equal((await call(parentId, undefined, 'GET')).body.job.harmony.id, child.jobId);
});

test('a score saved before the song is analysed waits for the analysis', async () => {
  const { call, started } = setup();
  const saved = await call(`${parentId}/score`, { title: 'x', musicxml: scoreXml });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.harmony, undefined);
  // Asking for chords & notes then runs the analysis first.
  assert.equal((await call(`${parentId}/harmony`, {})).status, 202);
  assert.equal(database_type(started), 'harmony');
});
function database_type(started) { return JSON.parse(started.at(-1).input).kind; }
