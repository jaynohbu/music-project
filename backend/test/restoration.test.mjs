import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
        const [setPart, removePart] = input.UpdateExpression.replace(/^SET /, '').split(' REMOVE ');
        for (const pair of setPart.split(', ')) {
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
const good = { stem: 'guitar', references: ['vocals', 'bass'], strength: 0.5 };
const route = `${parentId}/restorations`;

test('input needs one target, other stems as references, and a valid strength', () => {
  for (const bad of [null, [], {}, { stem: 'guitar' }, { stem: 'guitar', references: [] }, { stem: 'kazoo', references: ['bass'] },
    { stem: 'guitar', references: ['guitar'] }, { stem: 'guitar', references: ['bass', 'bass'] }, { stem: 'guitar', references: ['kazoo'] },
    { stem: 'guitar', references: 'bass' }, { ...good, strength: 1.1 }, { ...good, strength: -0.1 }, { ...good, strength: '1' }, { ...good, strength: null }]) {
    assert.throws(() => restorationInput(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(restorationInput({ stem: 'guitar', references: ['bass', 'drums'] }),
    { stem: 'guitar', references: ['drums', 'bass'], strength: 0.45 });
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
  assert.equal((await call(route, { ...good, strength: 0.6 })).status, 202);
  assert.deepEqual(database.get('owner', parentId).stems, parent().stems);
});

test('create rejects invalid input, other owners, and unfinished parents', async () => {
  const { call, database, started } = setup();
  assert.equal((await call(route, { stem: 'guitar', references: [] })).status, 400);
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
  assert.equal('key' in list[0], false);
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
  database.put({ ...database.get('owner', id), status: 'completed' });
  storage.objects.set(key, Buffer.from('cleaned'));
  const before = database.get('owner', parentId);
  assert.equal((await call(`22222222-2222-4222-8222-222222222222/restorations/${id}`, undefined, 'DELETE')).status, 404);
  assert.equal((await call(`${route}/${parentId}`, undefined, 'DELETE')).status, 404, 'a parent job id is refused');
  assert.equal((await call(path, undefined, 'DELETE', 'intruder')).status, 200);
  assert.ok(storage.objects.has(key));
  assert.equal((await call(path, undefined, 'DELETE')).status, 200);
  assert.equal(storage.objects.has(key), false);
  assert.equal(database.get('owner', id), undefined);
  for (const name of STEM_NAMES) assert.ok(storage.objects.has(stemKey(name)));
  assert.deepEqual(database.get('owner', parentId), before);
  assert.equal((await call(path, undefined, 'DELETE')).status, 200, 'repeat is safe');
  database.put({ ...parent({ jobId: id }), type: 'restoration', parentJobId: parentId, status: 'completed', key: stemKey('vocals') });
  assert.equal((await call(path, undefined, 'DELETE')).status, 500, 'an unexpected key is refused');
  assert.ok(storage.objects.has(stemKey('vocals')));
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
    status: 'queued', stem: 'guitar', references: ['vocals', 'bass'], strength: 0.45, title: 't',
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
  storage.objects.set(stemKey('guitar'), wavWithList());
  const real = createRestoreWorker({ database, storage, pythonPath: python });
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
  assert.deepEqual(storage.calls.filter(call => call.kind === 'PutObjectCommand').map(call => call.key), [child.key]);
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
  assert.deepEqual(args.slice(2).filter(item => item !== '--stem').map(item => item.split('=')[0]), ['guitar', 'piano', 'other', 'bass', 'drums']);
  assert.deepEqual(storage.calls.map(call => [call.kind, call.key]), [
    ...['guitar', 'piano', 'other', 'bass', 'drums'].map(name => ['GetObjectCommand', stemKey(name)]), ['PutObjectCommand', child.key],
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

test('harmony results from the old format are ignored, so they get redone', async () => {
  const { call, database, started } = setup();
  database.put({
    userId: 'owner', jobId: lyricsId, type: 'harmony', parentJobId: parentId, status: 'completed', title: 'Chords',
    key: `users/owner/harmony/${parentId}/${lyricsId}.json`, generatedAt: new Date().toISOString(),
  });
  assert.equal((await call(parentId, undefined, 'GET')).body.job.harmony, undefined);
  assert.equal((await call(`${parentId}/harmony`, {})).status, 202);
  assert.equal(database.get('owner', (await call(parentId, undefined, 'GET')).body.job.harmony.id).version, 3);
  assert.equal(started.length, 1);
});

function regeneration() {
  const context = setup();
  const finished = (id, fields) => context.database.put({
    userId: 'owner', jobId: id, type: 'harmony', version: 3, parentJobId: parentId, status: 'completed', title: 'Chords',
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
  for (const stem of ['vocals', 'kazoo', 1]) assert.equal((await callDone(`${parentId}/harmony`, { stem })).status, 400, String(stem));
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
  assert.equal((await call(`${parentId}/harmony`, { stem: 'guitar' })).status, 202, 'other stems run at the same time');
  assert.equal(started.length, 2);
  assert.equal((await call(`${parentId}/harmony`, {})).status, 200, 'the whole song is not redone');
  assert.equal(started.length, 2);
  const job = (await call(parentId, undefined, 'GET')).body.job;
  assert.equal(job.harmony.id, lyricsId);
  assert.equal(job.harmony.status, 'completed');
  assert.equal(job.harmony.stems.bass.status, 'queued');
  assert.equal(job.harmony.stems.guitar.status, 'queued');
  assert.equal(job.harmony.stems.piano, undefined);
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
  assert.equal((await call(`${parentId}/harmony`, { stem: 'bass' })).status, 202, 'can be tried again');
});

test('regenerating from the cleaned version uses the newest finished cleanup of that stem', async () => {
  const { call, database } = regeneration();
  assert.equal((await call(`${parentId}/harmony`, { stem: 'guitar', cleaned: true })).status, 409);
  const cleanup = (jobId, stem, generatedAt, status = 'completed') => database.put({
    userId: 'owner', jobId, type: 'restoration', parentJobId: parentId, stem, status, generatedAt, key: `users/owner/restored/${jobId}.wav`,
  });
  cleanup('66666666-6666-4666-8666-666666666666', 'guitar', '2026-01-01T00:00:00.000Z');
  cleanup('77777777-7777-4777-8777-777777777777', 'guitar', '2026-02-01T00:00:00.000Z');
  cleanup('88888888-8888-4888-8888-888888888888', 'guitar', '2026-03-01T00:00:00.000Z', 'failed');
  cleanup('99999999-9999-4999-8999-999999999999', 'piano', '2026-04-01T00:00:00.000Z');
  const made = await call(`${parentId}/harmony`, { stem: 'guitar', cleaned: true });
  assert.equal(made.status, 202);
  assert.equal(database.get('owner', made.body.harmony.id).sourceKey, 'users/owner/restored/77777777-7777-4777-8777-777777777777.wav');
});

test('the worker for one stem reads its source and the song grid, and skips what it does not need', async () => {
  for (const [stem, stemsRead] of [['guitar', ['guitar', 'piano', 'other']], ['bass', ['guitar', 'piano', 'other', 'bass']], ['drums', ['drums']]]) {
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
  assert.ok(template.includes("Action: s3:PutObject\n              Resource: !Sub '${AudioBucket.Arn}/users/*/lyrics/*'"), 'the API can save edited lyrics');
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
