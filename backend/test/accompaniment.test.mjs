import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createStemHandler } from '../stem-api.mjs';
import { createHandler } from '../api.mjs';
import { createLocalServer } from '../local-server.mjs';
import { STEM_NAMES } from '../stem-shared.mjs';
import { accompanimentBytes, accompanimentFrames } from '../accompaniment-api.mjs';

process.env.TABLE_NAME = 'jobs';
process.env.BUCKET_NAME = 'bucket';
const parentId = '11111111-1111-4111-8111-111111111111';
const duration = 2.345678;
const frames = Math.round(duration * 44100);
const size = 44 + frames * 4;

const failure = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeDatabase(pageSize = 2) {
  const items = new Map();
  const id = key => `${key.userId}|${key.jobId}`;
  const clone = value => value && structuredClone(value);
  const calls = [];
  return {
    items, calls,
    put: item => items.set(id(item), clone(item)),
    get: (userId, jobId) => clone(items.get(id({ userId, jobId }))),
    async send(command) {
      const input = command.input;
      const kind = command.constructor.name;
      calls.push({ kind, input });
      await tick();
      if (kind === 'GetCommand') return { Item: clone(items.get(id(input.Key))) };
      if (kind === 'PutCommand') {
        if (input.ConditionExpression === 'attribute_not_exists(jobId)' && items.has(id(input.Item))) {
          throw failure('ConditionalCheckFailedException', 400);
        }
        items.set(id(input.Item), clone(input.Item));
        return {};
      }
      if (kind === 'DeleteCommand') {
        const current = items.get(id(input.Key));
        const values = input.ExpressionAttributeValues;
        if (!current || current.type !== values[':type'] || current.parentJobId !== values[':parent']) {
          throw failure('ConditionalCheckFailedException', 400);
        }
        items.delete(id(input.Key));
        return {};
      }
      if (kind === 'UpdateCommand') {
        const current = items.get(id(input.Key));
        const values = input.ExpressionAttributeValues;
        assert.match(input.UpdateExpression, /REMOVE expiresAt/);
        if (!current || current.status !== values[':uploading'] || current.parentJobId !== values[':parent'] ||
            current.type !== values[':type']) throw failure('ConditionalCheckFailedException', 400);
        current.status = values[':completed'];
        current.completedAt = values[':at'];
        delete current.expiresAt;
        return {};
      }
      if (kind === 'QueryCommand') {
        const values = input.ExpressionAttributeValues;
        if (input.IndexName === 'ByCreatedAt') {
          const all = [...items.values()].filter(item => item.userId === values[':userId'] && item.createdAt);
          return { Items: all.map(clone) };
        }
        assert.equal(input.ConsistentRead, true);
        const all = [...items.values()].filter(item => item.userId === values[':userId'])
          .sort((a, b) => a.jobId.localeCompare(b.jobId));
        const offset = input.ExclusiveStartKey ? input.ExclusiveStartKey.offset : 0;
        const page = all.slice(offset, offset + pageSize);
        return {
          Items: page.filter(item => item.parentJobId === values[':parent'] &&
            item.type === values[':type'] && item.status === values[':completed']).map(clone),
          LastEvaluatedKey: offset + pageSize < all.length ? { offset: offset + pageSize } : undefined,
        };
      }
      throw new Error(`Unexpected ${kind}`);
    },
  };
}

function fakeStorage() {
  const objects = new Map();
  const calls = [];
  const etag = body => `"${createHash('md5').update(body).digest('hex')}"`;
  return {
    objects, calls,
    upload: (key, body, type = 'audio/wav') => objects.set(key, { body, type, etag: etag(body) }),
    async send(command) {
      const input = command.input;
      const kind = command.constructor.name;
      calls.push({ kind, input });
      await tick();
      const object = objects.get(input.Key);
      if (kind === 'HeadObjectCommand') {
        if (!object) throw failure('NotFound', 404);
        return { ContentLength: object.body.length, ContentType: object.type, ETag: object.etag };
      }
      if (kind === 'GetObjectCommand') {
        if (!object) throw failure('NoSuchKey', 404);
        if (input.IfMatch && input.IfMatch !== object.etag) throw failure('PreconditionFailed', 412);
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(input.Range);
        const body = object.body.subarray(Number(start), Number(end) + 1);
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      if (kind === 'CopyObjectCommand') {
        const source = objects.get(input.CopySource.slice('bucket/'.length));
        if (!source || source.etag !== input.CopySourceIfMatch) throw failure('PreconditionFailed', 412);
        await tick();
        if (input.IfNoneMatch === '*' && objects.has(input.Key)) throw failure('PreconditionFailed', 412);
        objects.set(input.Key, { ...source, type: input.ContentType });
        return {};
      }
      if (kind === 'DeleteObjectCommand') {
        objects.delete(input.Key);
        return {};
      }
      throw new Error(`Unexpected ${kind}`);
    },
  };
}

function wav({ frameCount = frames, channels = 2, rate = 44100, bits = 16, fill = 0 } = {}) {
  const dataBytes = frameCount * 4;
  const data = Buffer.alloc(44 + dataBytes, fill);
  data.write('RIFF');
  data.writeUInt32LE(36 + dataBytes, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * channels * bits / 8, 28);
  data.writeUInt16LE(channels * bits / 8, 32);
  data.writeUInt16LE(bits, 34);
  data.write('data', 36);
  data.writeUInt32LE(dataBytes, 40);
  return data;
}

const parent = (overrides = {}) => ({
  userId: 'owner', jobId: parentId, type: 'stems', status: 'completed', title: 'Song',
  createdAt: new Date().toISOString(), duration,
  stems: Object.fromEntries(STEM_NAMES.map(name => [name, { key: `users/owner/stems/${parentId}/${name}.wav` }])),
  ...overrides,
});
const request = (overrides = {}) => ({
  instrument: 'piano', style: 'arpeggio', tempo: 120, sources: ['guitar', 'piano'],
  chords: [{ start: 0, end: 1, chord: 'C' }, { start: 1, end: duration, chord: 'A#m' }],
  ...overrides,
});
const event = (path, body, user = 'owner', method = 'POST') => ({
  rawPath: `/api/stems/jobs/${path}`, body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: user } } } },
});

function setup({ pageSize } = {}) {
  const database = fakeDatabase(pageSize);
  const storage = fakeStorage();
  const policies = [];
  database.put(parent());
  const handler = createStemHandler({
    database, storage,
    uploadSigner: async (_s, options) => { policies.push(options); return { url: 'https://upload', fields: { key: options.Key } }; },
    signer: async (_s, command) => `https://signed/${command.input.Key}${command.input.ResponseContentDisposition ? '?download' : ''}`,
  });
  const call = async (path, body, user, method) => {
    const response = await handler(event(path, body, user, method));
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const create = body => call(`${parentId}/accompaniments`, body);
  const complete = id => call(`${parentId}/accompaniments/${id}/complete`);
  return { database, storage, policies, handler, call, create, complete };
}

test('accompaniment size math uses rounded 44.1 kHz stereo PCM16 frames', () => {
  assert.equal(accompanimentFrames(duration), frames);
  assert.equal(accompanimentBytes(duration), size);
  assert.equal(accompanimentBytes(1), 44 + 44100 * 4);
});

test('create rejects unsupported combinations, timings, chords and sources without writes', async () => {
  const { create, database } = setup();
  const bad = [
    { instrument: 'synth', style: 'strum' }, { instrument: 'piano', style: 'strum' },
    { instrument: 'acoustic-guitar', style: 'pad' }, { instrument: 'electric-guitar', style: 'pad' },
    { instrument: 'drums' }, { instrument: 'toString', style: 'pad' },
    { tempo: 39.9 }, { tempo: 240.1 }, { tempo: '120' }, { tempo: null },
    { sources: [] }, { sources: ['drums'] }, { sources: ['piano', 'piano'] }, { sources: 'piano' },
    { chords: [] }, { chords: [{ start: 0, end: duration - 0.001, chord: 'C' }] },
    { chords: [{ start: 0.1, end: duration, chord: 'C' }] },
    { chords: [{ start: 0, end: 1, chord: 'C' }, { start: 1.5, end: duration, chord: 'C' }] },
    { chords: [{ start: 0, end: 1.5, chord: 'C' }, { start: 1, end: duration, chord: 'C' }] },
    { chords: [{ start: 0, end: 0, chord: 'C' }, { start: 0, end: duration, chord: 'C' }] },
    { chords: [{ start: 0, end: null, chord: 'C' }] },
    ...['E#', 'B#', 'Cmaj', 'Db', 'c', 'Nm', '', 'C#m7'].map(chord => ({ chords: [{ start: 0, end: duration, chord }] })),
    { chords: Array.from({ length: 501 }, (_, i) => ({ start: i * duration / 501, end: i === 500 ? duration : (i + 1) * duration / 501, chord: 'N' })) },
    { requestId: 'not-a-uuid' },
  ];
  for (const overrides of bad) {
    assert.equal((await create(request(overrides))).status, 400, JSON.stringify(overrides).slice(0, 80));
  }
  assert.equal((await create('not json')).status, 400);
  assert.equal(database.calls.filter(call => call.kind === 'PutCommand').length, 0);
  for (const [instrument, styles] of Object.entries({
    synth: ['pad', 'arpeggio', 'rhythm'], 'acoustic-guitar': ['strum', 'arpeggio', 'rhythm'],
    'electric-guitar': ['strum', 'arpeggio', 'rhythm'], piano: ['pad', 'arpeggio', 'rhythm'],
  })) {
    for (const style of styles) assert.equal((await create(request({ instrument, style }))).status, 201);
  }
  const step = duration / 500;
  const many = Array.from({ length: 500 }, (_, i) => ({ start: i === 0 ? 0 : null, chord: 'G#' }));
  for (let i = 0; i < 500; i++) {
    many[i].start = i === 0 ? 0 : many[i - 1].end;
    many[i].end = i === 499 ? duration : (i + 1) * step;
  }
  assert.equal((await create(request({ chords: many, tempo: 40, sources: ['bass', 'vocals', 'other'] }))).status, 201);
});

test('create requires an owned completed six-stem parent', async () => {
  const { create, call, database } = setup();
  assert.equal((await call(`${parentId}/accompaniments`, request(), 'intruder')).status, 404);
  database.put(parent({ status: 'processing', stems: undefined }));
  assert.equal((await create(request())).status, 409);
  database.put(parent({ stems: { drums: { key: 'x' } } }));
  assert.equal((await create(request())).status, 409);
  database.put(parent({ type: 'accompaniment' }));
  assert.equal((await create(request())).status, 404);
  assert.equal((await handlerless401()).statusCode, 401);
  assert.equal(database.calls.filter(c => c.kind === 'PutCommand').length, 0);
  async function handlerless401() {
    return createStemHandler({ database })({ rawPath: `/api/stems/jobs/${parentId}/accompaniments`, requestContext: {} });
  }
});

test('create stores a separate uploading child with exact signed POST policy', async () => {
  const { create, database, policies } = setup();
  const before = Date.now();
  const response = await create(request({ userId: 'attacker', bytes: 1 }));
  assert.equal(response.status, 201);
  const id = response.body.accompaniment.id;
  const child = database.get('owner', id);
  assert.equal(child.type, 'accompaniment');
  assert.equal(child.parentJobId, parentId);
  assert.equal(child.status, 'uploading');
  assert.equal(child.bytes, size);
  assert.equal(child.frames, frames);
  assert.equal(child.sampleRate, 44100);
  assert.equal('createdAt' in child, false, 'children must stay out of the ByCreatedAt library index');
  assert.ok(child.expiresAt * 1000 >= before + 25 * 60000 - 1000);
  assert.equal(child.inputKey, `generated-inputs/owner/${id}/audio.wav`);
  assert.deepEqual(policies[0], {
    Bucket: 'bucket', Key: child.inputKey, Expires: 900, Fields: { 'Content-Type': 'audio/wav' },
    Conditions: [['content-length-range', size, size], ['eq', '$Content-Type', 'audio/wav']],
  });
  assert.deepEqual(database.get('owner', parentId), parent({ createdAt: database.get('owner', parentId).createdAt }));
});

test('completion validates exact size and canonical header; failed input can be retried', async () => {
  const { create, complete, storage, database } = setup();
  const id = (await create(request())).body.accompaniment.id;
  const key = `generated-inputs/owner/${id}/audio.wav`;
  assert.equal((await complete(id)).status, 409);
  storage.upload(key, wav().subarray(0, size - 4));
  assert.equal((await complete(id)).status, 400);
  storage.upload(key, wav(), 'application/octet-stream');
  assert.equal((await complete(id)).status, 400);
  for (const header of [wav({ channels: 1, frameCount: frames * 2 }), wav({ rate: 48000 }), wav({ bits: 8, frameCount: frames })]) {
    const body = Buffer.concat([header.subarray(0, 44), Buffer.alloc(size - 44)]);
    storage.upload(key, body);
    assert.equal((await complete(id)).status, 400);
  }
  const shifted = wav();
  shifted.writeUInt32LE(frames * 4 - 4, 40);
  storage.upload(key, shifted);
  assert.equal((await complete(id)).status, 400);
  assert.equal(storage.calls.filter(c => c.kind === 'CopyObjectCommand').length, 0);
  assert.equal(database.get('owner', id).status, 'uploading');
  storage.upload(key, wav({ fill: 7 }));
  const done = await complete(id);
  assert.equal(done.status, 200);
  const range = storage.calls.findLast(c => c.kind === 'GetObjectCommand');
  assert.equal(range.input.Range, 'bytes=0-43');
  assert.equal(range.input.IfMatch, storage.objects.get(key).etag);
});

test('completion copies the verified version write-once and retries return the saved result', async () => {
  const { create, complete, storage, database, call } = setup();
  const created = await create(request());
  const id = created.body.accompaniment.id;
  const key = `generated-inputs/owner/${id}/audio.wav`;
  const output = `users/owner/accompaniments/${parentId}/${id}.wav`;
  const original = wav({ fill: 1 });
  storage.upload(key, original);
  const done = await complete(id);
  assert.equal(done.status, 200);
  const copy = storage.calls.find(c => c.kind === 'CopyObjectCommand').input;
  assert.equal(copy.Key, output);
  assert.equal(copy.CopySource, `bucket/${key}`);
  assert.equal(copy.CopySourceIfMatch, storage.objects.get(key).etag);
  assert.equal(copy.IfNoneMatch, '*');
  assert.equal(copy.ContentType, 'audio/wav');
  const child = database.get('owner', id);
  assert.equal(child.status, 'completed');
  assert.equal('expiresAt' in child, false);
  assert.deepEqual(Object.keys(done.body.accompaniment).sort(),
    ['chords', 'createdAt', 'downloadUrl', 'id', 'instrument', 'playUrl', 'sources', 'style', 'tempo', 'title'].sort());
  assert.equal(done.body.accompaniment.playUrl, `https://signed/${output}`);
  // A still-valid POST overwrites the input; finalized audio must not change.
  storage.upload(key, wav({ fill: 9 }));
  const copies = storage.calls.filter(c => c.kind === 'CopyObjectCommand').length;
  const retry = await complete(id);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, done.body);
  assert.equal(storage.calls.filter(c => c.kind === 'CopyObjectCommand').length, copies);
  assert.deepEqual(storage.objects.get(output).body, original);
  assert.equal((await call(`${parentId}/accompaniments/${id}/complete`, undefined, 'intruder')).status, 404);
  assert.equal((await call(`${'2'.repeat(8)}-2222-4222-8222-222222222222/accompaniments/${id}/complete`)).status, 404);
  assert.equal((await call(`${parentId}/complete`.replace(parentId, id))).status, 404);
});

test('concurrent completions produce one write-once copy and the same completed record', async () => {
  const { create, complete, storage, database } = setup();
  const id = (await create(request())).body.accompaniment.id;
  storage.upload(`generated-inputs/owner/${id}/audio.wav`, wav({ fill: 3 }));
  const results = await Promise.all([complete(id), complete(id), complete(id)]);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200]);
  assert.ok(results.every(r => r.body.accompaniment.playUrl === results[0].body.accompaniment.playUrl));
  assert.equal(database.get('owner', id).status, 'completed');
  assert.equal(storage.objects.get(`users/owner/accompaniments/${parentId}/${id}.wav`).body[100], 3);
});

test('input replaced between validation and copy is not finalized', async () => {
  const { create, complete, storage, database } = setup();
  const id = (await create(request())).body.accompaniment.id;
  const key = `generated-inputs/owner/${id}/audio.wav`;
  storage.upload(key, wav({ fill: 1 }));
  const send = storage.send.bind(storage);
  storage.send = async command => {
    if (command.constructor.name === 'CopyObjectCommand') storage.upload(key, wav({ fill: 2 }));
    return send(command);
  };
  assert.equal((await complete(id)).status, 409);
  assert.equal(database.get('owner', id).status, 'uploading');
  storage.send = send;
  assert.equal((await complete(id)).status, 200);
  assert.equal(storage.objects.get(`users/owner/accompaniments/${parentId}/${id}.wav`).body[100], 2);
});

test('expired uploads cannot be completed', async () => {
  const { create, complete, storage, database } = setup();
  const id = (await create(request())).body.accompaniment.id;
  storage.upload(`generated-inputs/owner/${id}/audio.wav`, wav());
  const child = database.get('owner', id);
  database.put({ ...child, expiresAt: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await complete(id)).status, 409);
  assert.equal(storage.calls.length, 0);
});

test('save retry accepts DynamoDB map key ordering without accepting changed chords', async () => {
  const { create, database } = setup();
  const requestId = randomUUID();
  assert.equal((await create(request({ requestId }))).status, 201);
  const child = database.get('owner', requestId);
  child.chords = child.chords.map(({ start, end, chord }) => ({ chord, end, start }));
  database.put(child);
  assert.equal((await create(request({ requestId }))).status, 200);
  const changed = request({ requestId });
  changed.chords[0].chord = 'Cm';
  assert.equal((await create(changed)).status, 409);
});

test('requestId makes save creation idempotent and rejects reuse for different content', async () => {
  const { create, complete, storage, database, policies } = setup();
  const requestId = randomUUID();
  const [first, second] = await Promise.all([create(request({ requestId })), create(request({ requestId }))]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(first.body.accompaniment.id, requestId);
  assert.equal(second.body.accompaniment.id, requestId);
  assert.ok(first.body.upload && second.body.upload);
  assert.equal(policies.length, 2);
  assert.ok(policies.every(p => p.Expires <= 900 && p.Key === `generated-inputs/owner/${requestId}/audio.wav`));
  assert.equal((await create(request({ requestId, tempo: 121 }))).status, 409);
  storage.upload(`generated-inputs/owner/${requestId}/audio.wav`, wav());
  assert.equal((await complete(requestId)).status, 200);
  const again = await create(request({ requestId }));
  assert.equal(again.status, 200);
  assert.equal(again.body.upload, undefined);
  assert.ok(again.body.accompaniment.playUrl);
  assert.equal(database.get('owner', requestId).status, 'completed');
  // requestId cannot hijack an existing non-accompaniment record.
  assert.equal((await create(request({ requestId: parentId }))).status, 409);
  assert.equal(database.get('owner', parentId).type, 'stems');
});

test('parent GET and library list paginate completed children; children are not library jobs', async () => {
  const { create, complete, storage, database, call } = setup({ pageSize: 2 });
  database.put(parent({ jobId: '33333333-3333-4333-8333-333333333333' }));
  database.put({ userId: 'other', jobId: randomUUID(), type: 'accompaniment', parentJobId: parentId, status: 'completed', generatedAt: '2026-01-01T00:00:00Z' });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = (await create(request({ tempo: 60 + i }))).body.accompaniment.id;
    storage.upload(`generated-inputs/owner/${id}/audio.wav`, wav());
    assert.equal((await complete(id)).status, 200);
    ids.push(id);
  }
  await create(request({ tempo: 99 }));
  const response = await call(parentId, undefined, 'owner', 'GET');
  assert.equal(response.status, 200);
  const generated = response.body.job.generatedStems;
  assert.deepEqual(generated.map(item => item.id).sort(), ids.sort());
  assert.ok(generated.every(item => item.playUrl && item.downloadUrl.endsWith('?download') && item.title && item.createdAt));
  assert.ok(database.calls.filter(c => c.kind === 'QueryCommand').length > 3, 'paginated');
  const other = await call('33333333-3333-4333-8333-333333333333', undefined, 'owner', 'GET');
  assert.deepEqual(other.body.job.generatedStems, []);
  const list = createHandler({ database, signer: async (_s, c) => `https://signed/${c.input.Key}` });
  const library = JSON.parse((await list({
    rawPath: '/api/jobs', requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'owner' } } } },
  })).body);
  assert.deepEqual(library.jobs.map(job => job.jobId).sort(), [parentId, '33333333-3333-4333-8333-333333333333'].sort());
  assert.equal(library.jobs.find(job => job.jobId === parentId).generatedStems.length, 5);
});

async function savedStem(context) {
  const id = (await context.create(request())).body.accompaniment.id;
  const child = context.database.get('owner', id);
  context.storage.upload(child.inputKey, wav());
  assert.equal((await context.complete(id)).status, 200);
  return { id, child: context.database.get('owner', id) };
}

test('regions are validated, stored, returned, and part of request idempotency', async () => {
  const { create, database } = setup();
  const bad = [
    [], {}, 'all', [{ start: 0 }], [null], [{ start: -0.1, end: 1 }], [{ start: 1, end: 1 }], [{ start: 1, end: 0.5 }],
    [{ start: 0, end: duration + 0.1 }], [{ start: 1, end: 2 }, { start: 0, end: 0.5 }],
    [{ start: 0, end: 1 }, { start: 0.9, end: 2 }], [{ start: 0, end: null }],
    Array.from({ length: 101 }, (_, i) => ({ start: i / 100, end: (i + 0.5) / 100 })),
  ];
  for (const regions of bad) {
    assert.equal((await create(request({ regions }))).status, 400, JSON.stringify(regions).slice(0, 60));
  }
  for (const seed of [-1, 1.5, '1', 2 ** 32]) assert.equal((await create(request({ seed }))).status, 400);
  const regions = [{ start: 0, end: 0.5 }, { start: 0.5, end: 1 }, { start: 1.5, end: duration }];
  const requestId = randomUUID();
  const made = await create(request({ regions, seed: 7, requestId, extra: 1 }));
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.accompaniment.regions, regions);
  assert.deepEqual(database.get('owner', requestId).regions, regions);
  assert.equal(database.get('owner', requestId).seed, 7);
  assert.equal((await create(request({ regions, seed: 7, requestId }))).status, 200);
  assert.equal((await create(request({ regions: [regions[0]], seed: 7, requestId }))).status, 409);
  assert.equal((await create(request({ regions, seed: 8, requestId }))).status, 409);
  const legacy = await create(request());
  assert.equal(legacy.status, 201);
  const stored = database.get('owner', legacy.body.accompaniment.id);
  assert.equal('regions' in stored, false);
  assert.equal('seed' in stored, false);
});

test('delete removes only the generated stem and repeats safely', async () => {
  const context = setup();
  const { call, database, storage } = context;
  const originals = STEM_NAMES.map(name => `users/owner/stems/${parentId}/${name}.wav`);
  for (const key of originals) storage.upload(key, wav());
  const { id, child } = await savedStem(context);
  const other = await savedStem(context);
  const parentBefore = database.get('owner', parentId);
  assert.ok(storage.objects.has(child.outputKey));
  const path = `${parentId}/accompaniments/${id}`;
  assert.deepEqual(await call(path, undefined, 'owner', 'DELETE'), { status: 200, body: { deleted: true } });
  assert.equal(storage.objects.has(child.outputKey), false);
  assert.equal(storage.objects.has(child.inputKey), false);
  assert.equal(database.get('owner', id), undefined);
  for (const key of originals) assert.ok(storage.objects.has(key));
  assert.ok(storage.objects.has(other.child.outputKey));
  assert.ok(database.get('owner', other.id));
  assert.deepEqual(database.get('owner', parentId), parentBefore);
  const deleted = storage.calls.filter(item => item.kind === 'DeleteObjectCommand').map(item => item.input.Key);
  assert.deepEqual(deleted, [child.outputKey, child.inputKey]);
  assert.equal((await call(path, undefined, 'owner', 'DELETE')).status, 200);
  const job = await call(parentId, undefined, 'owner', 'GET');
  assert.deepEqual(job.body.job.generatedStems.map(stem => stem.id), [other.id]);
});

test('delete refuses originals, other owners, other parents and unfinished saves', async () => {
  const context = setup();
  const { call, create, database, storage } = context;
  const { id, child } = await savedStem(context);
  const before = storage.calls.length;
  const otherParent = '22222222-2222-4222-8222-222222222222';
  assert.equal((await call(`${otherParent}/accompaniments/${id}`, undefined, 'owner', 'DELETE')).status, 404);
  assert.equal((await call(`${parentId}/accompaniments/${parentId}`, undefined, 'owner', 'DELETE')).status, 404);
  assert.equal((await call(`${parentId}/accompaniments/${id}`, undefined, 'intruder', 'DELETE')).status, 200);
  assert.ok(database.get('owner', id));
  assert.ok(database.get('owner', parentId));
  const uploading = (await create(request())).body.accompaniment.id;
  assert.equal((await call(`${parentId}/accompaniments/${uploading}`, undefined, 'owner', 'DELETE')).status, 409);
  assert.equal((await call(`${parentId}/accompaniments/${id}/complete`, undefined, 'owner', 'DELETE')).status, 404);
  assert.equal(storage.calls.slice(before).some(item => item.kind === 'DeleteObjectCommand'), false);
  database.put({ ...child, outputKey: `users/owner/stems/${parentId}/vocals.wav` });
  assert.equal((await call(`${parentId}/accompaniments/${id}`, undefined, 'owner', 'DELETE')).status, 500);
  assert.equal(storage.calls.slice(before).some(item => item.kind === 'DeleteObjectCommand'), false);
});

test('a failed storage delete keeps the record so delete can be retried', async () => {
  const context = setup();
  const { call, database, storage } = context;
  const { id, child } = await savedStem(context);
  const send = storage.send.bind(storage);
  storage.send = async command => {
    if (command.constructor.name === 'DeleteObjectCommand') throw failure('InternalError', 500);
    return send(command);
  };
  const path = `${parentId}/accompaniments/${id}`;
  assert.equal((await call(path, undefined, 'owner', 'DELETE')).status, 500);
  assert.ok(database.get('owner', id));
  storage.send = send;
  assert.equal((await call(path, undefined, 'owner', 'DELETE')).status, 200);
  assert.equal(storage.objects.has(child.outputKey), false);
  assert.equal(database.get('owner', id), undefined);
});

test('local server routes accompaniment saves with verified identity and larger chord bodies', async t => {
  let seen;
  const server = createLocalServer({
    verify: async () => ({ sub: 'real-owner' }),
    stems: async e => { seen = e; return { statusCode: 201, headers: {}, body: '{}' }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/stems/jobs/${parentId}`;
  const big = JSON.stringify(request({ chords: Array.from({ length: 500 }, (_, i) => ({ start: i, end: i + 1, chord: 'C#m' })) }));
  assert.ok(big.length > 4096);
  const headers = { Authorization: 'Bearer token' };
  assert.equal((await fetch(`${base}/accompaniments`, { method: 'POST', body: big })).status, 401);
  assert.equal((await fetch(`${base}/accompaniments`, { method: 'POST', headers, body: big })).status, 201);
  assert.equal(seen.requestContext.authorizer.jwt.claims.sub, 'real-owner');
  assert.equal(seen.body, big);
  assert.equal((await fetch(`${base}/accompaniments/${parentId}/complete`, { method: 'POST', headers })).status, 201);
  assert.equal((await fetch(`${base}/complete`, { method: 'POST', headers, body: big })).status, 413);
  const stem = `${base}/accompaniments/${parentId}`;
  assert.equal((await fetch(stem, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(stem, { method: 'DELETE', headers })).status, 201);
  assert.equal(seen.requestContext.http.method, 'DELETE');
  assert.equal((await fetch(stem, { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(base, { method: 'DELETE', headers })).status, 405);
});
