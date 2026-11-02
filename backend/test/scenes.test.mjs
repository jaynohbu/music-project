import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createSceneHandler, dynamoSize, MAX_SCENE_BODY_BYTES, MAX_SCENE_ENTRIES, MAX_SCENE_ITEM_BYTES } from '../scene-api.mjs';
import { createStemHandler } from '../stem-api.mjs';
import { createHandler } from '../api.mjs';
import { createLocalServer } from '../local-server.mjs';
import { STEM_NAMES } from '../stem-shared.mjs';

process.env.TABLE_NAME = 'jobs';
process.env.BUCKET_NAME = 'bucket';
process.env.STEM_STATE_MACHINE = 'machine';
process.env.YOUTUBE_OWNER_SUB = 'owner-sub';

const A = 'user-a', B = 'user-b';
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SONG = uuid(1), SONG2 = uuid(2), CHILD_R = uuid(10), CHILD_L = uuid(11), CHILD_H = uuid(12);
const clone = value => value === undefined ? undefined : structuredClone(value);
const conditionFailure = () => Object.assign(new Error('ConditionalCheckFailedException'), { name: 'ConditionalCheckFailedException' });

// Evaluates the small expression subset the backend uses, so conditions are really enforced.
function evaluate(expression, item, names = {}, values = {}) {
  if (!expression) return true;
  return expression.split(' AND ').every(clause => {
    const name = token => names[token] ?? token;
    let m;
    if ((m = /^attribute_exists\((.+)\)$/.exec(clause))) return item?.[name(m[1])] !== undefined;
    if ((m = /^attribute_not_exists\((.+)\)$/.exec(clause))) return item?.[name(m[1])] === undefined;
    if ((m = /^(\S+) IN \((.+)\)$/.exec(clause))) return m[2].split(', ').some(v => item?.[name(m[1])] === values[v]);
    if ((m = /^(\S+) = (\S+)$/.exec(clause))) return item !== undefined && item[name(m[1])] === values[m[2]];
    throw new Error(`Unsupported expression ${clause}`);
  });
}

function fakeDatabase({ pageSize = 2 } = {}) {
  const items = new Map(), hooks = [];
  const id = key => `${key.userId}|${key.jobId}`;
  const applyUpdate = input => {
    const names = input.ExpressionAttributeNames, values = input.ExpressionAttributeValues;
    const next = items.get(id(input.Key)) ?? { ...input.Key };
    const [setPart, removePart] = (' ' + input.UpdateExpression).split(/ REMOVE /);
    for (const pair of setPart.replace(/^ ?SET /, '').split(', ').filter(Boolean)) {
      const [key, value] = pair.split(' = ');
      next[names?.[key] ?? key] = clone(values[value]);
    }
    for (const key of removePart?.split(', ') ?? []) delete next[names?.[key] ?? key];
    items.set(id(input.Key), next);
  };
  const db = {
    items, hooks, calls: [], transactions: [],
    put: item => items.set(id(item), clone(item)),
    get: (userId, jobId) => clone(items.get(id({ userId, jobId }))),
    async send(command) {
      const input = command.input, kind = command.constructor.name;
      db.calls.push(kind);
      for (const hook of [...hooks]) await hook(kind, input);
      const names = input.ExpressionAttributeNames, values = input.ExpressionAttributeValues;
      if (kind === 'GetCommand') return { Item: clone(items.get(id(input.Key))) };
      if (kind === 'PutCommand') {
        if (!evaluate(input.ConditionExpression, items.get(id(input.Item)), names, values)) throw conditionFailure();
        items.set(id(input.Item), clone(input.Item));
        return {};
      }
      if (kind === 'DeleteCommand') {
        if (!evaluate(input.ConditionExpression, items.get(id(input.Key)), names, values)) throw conditionFailure();
        items.delete(id(input.Key));
        return {};
      }
      if (kind === 'TransactWriteCommand') {
        db.transactions.push(input.TransactItems);
        const reasons = input.TransactItems.map(action => {
          const op = action.Update ?? action.ConditionCheck;
          const ok = evaluate(op.ConditionExpression, items.get(id(op.Key)), op.ExpressionAttributeNames, op.ExpressionAttributeValues);
          return { Code: ok ? 'None' : 'ConditionalCheckFailed' };
        });
        if (reasons.some(reason => reason.Code !== 'None')) {
          throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException', CancellationReasons: reasons });
        }
        for (const action of input.TransactItems) if (action.Update) applyUpdate(action.Update);
        return {};
      }
      if (kind === 'UpdateCommand') {
        if (!evaluate(input.ConditionExpression, items.get(id(input.Key)), names, values)) throw conditionFailure();
        applyUpdate(input);
        return {};
      }
      if (kind === 'QueryCommand') {
        const all = [...items.values()].filter(item => item.userId === values[':userId']);
        if (input.IndexName === 'ByCreatedAt') {
          return { Items: all.filter(item => item.createdAt !== undefined).map(clone) };
        }
        all.sort((a, b) => a.jobId.localeCompare(b.jobId));
        const start = input.ExclusiveStartKey ? all.findIndex(item => item.jobId === input.ExclusiveStartKey.jobId) + 1 : 0;
        const page = all.slice(start, start + pageSize);
        return {
          Items: page.filter(item => evaluate(input.FilterExpression, item, names, values)).map(clone),
          LastEvaluatedKey: start + pageSize < all.length ? { userId: values[':userId'], jobId: page.at(-1).jobId } : undefined,
        };
      }
      throw new Error(`Unexpected ${kind}`);
    },
  };
  return db;
}

function fakeStorage() {
  const objects = new Map(), calls = [];
  return {
    objects, calls,
    async send(command) {
      const input = command.input, kind = command.constructor.name;
      calls.push({ kind, key: input.Key ?? input.Prefix });
      if (kind === 'ListObjectsV2Command') {
        const keys = [...objects.keys()].filter(key => key.startsWith(input.Prefix)).sort();
        // Like S3, the token marks a key position, so deleting listed keys does not skip any.
        const page = keys.filter(key => !input.ContinuationToken || key > input.ContinuationToken).slice(0, 2);
        const more = keys.some(key => key > (page.at(-1) ?? ''));
        return { Contents: page.map(Key => ({ Key })), IsTruncated: more, NextContinuationToken: more ? page.at(-1) : undefined };
      }
      if (kind === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
      if (kind === 'PutObjectCommand') {
        const chunks = [];
        for await (const chunk of input.Body ?? Readable.from([])) chunks.push(chunk);
        objects.set(input.Key, Buffer.concat(chunks));
        return {};
      }
      throw new Error(`Unexpected ${kind}`);
    },
  };
}

const signer = async (_client, command) => `https://signed/${command.input.Key}`;

function song(userId, jobId, extra = {}) {
  return {
    userId, jobId, type: 'stems', status: 'completed', title: 'Song', createdAt: '2026-10-01T00:00:00.000Z',
    duration: 180, inputKey: `stem-inputs/${userId}/${jobId}/input.wav`,
    stems: Object.fromEntries(STEM_NAMES.map(name => [name, { key: `users/${userId}/stems/${jobId}/${name}.wav` }])),
    ...extra,
  };
}

function seedSong(database, storage, userId, jobId, extra) {
  const item = song(userId, jobId, extra);
  database.put(item);
  storage.objects.set(item.inputKey, Buffer.from('in'));
  for (const name of STEM_NAMES) storage.objects.set(item.stems[name].key, Buffer.from(name));
  return item;
}

function track(overrides = {}) {
  return {
    volume: 80, preGain: 100, compression: 0, distortion: 0, bass: 0, mid: 0, treble: 0, pan: 0, reverb: 0,
    muted: false, solo: false, bypassed: false, useCleaned: false, ...overrides,
  };
}
function settings(overrides = {}) {
  return {
    masterVolume: 80, sectionStart: 0, sectionEnd: 180, loop: false,
    tracks: Object.fromEntries(STEM_NAMES.map(name => [name, track()])), ...overrides,
  };
}

const event = (userId, method, rawPath, body) => ({
  rawPath, body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) },
});
async function call(handler, ...args) {
  const result = await handler(event(...args));
  return { status: result.statusCode, body: JSON.parse(result.body) };
}

function setup() {
  const database = fakeDatabase(), storage = fakeStorage(), started = [];
  const orchestrator = { async send(command) { started.push(command.input); return {}; } };
  const scenes = createSceneHandler({ database });
  const stems = createStemHandler({ database, storage, orchestrator, signer });
  return { database, storage, started, scenes, stems };
}

async function makeScene(scenes, userId = A, name = 'Set') {
  const created = await call(scenes, userId, 'POST', '/api/scenes', { name });
  assert.equal(created.status, 201);
  return created.body.scene;
}

test('scene CRUD returns the contract shape and isolates owners', async () => {
  const { database, scenes, storage } = setup();
  seedSong(database, storage, A, SONG);
  assert.equal((await call(scenes, undefined, 'GET', '/api/scenes')).status, 401);
  const scene = await makeScene(scenes, A, '  Friday set  ');
  assert.equal(scene.name, 'Friday set');
  assert.deepEqual(scene.entries, []);
  assert.equal(scene.revision, 1);
  assert.equal(typeof scene.createdAt, 'string');
  const stored = database.get(A, scene.id);
  assert.equal(stored.type, 'scene');
  assert.equal(stored.createdAt, undefined, 'scenes never enter the ByCreatedAt library index');
  assert.equal(stored.generatedAt, scene.createdAt);

  assert.deepEqual((await call(scenes, A, 'GET', '/api/scenes')).body, { scenes: [scene] });
  assert.deepEqual((await call(scenes, B, 'GET', '/api/scenes')).body, { scenes: [] });
  assert.equal((await call(scenes, A, 'GET', `/api/scenes/${scene.id}`)).body.scene.id, scene.id);
  assert.equal((await call(scenes, B, 'GET', `/api/scenes/${scene.id}`)).status, 404);
  assert.equal((await call(scenes, B, 'PATCH', `/api/scenes/${scene.id}`, { revision: 1, name: 'x' })).status, 404);
  assert.equal((await call(scenes, B, 'DELETE', `/api/scenes/${scene.id}`)).status, 404);
  assert.equal((await call(scenes, A, 'GET', '/api/scenes/not-a-uuid')).status, 404);
  // A song record is not a scene, even for its owner.
  assert.equal((await call(scenes, A, 'GET', `/api/scenes/${SONG}`)).status, 404);
  assert.equal((await call(scenes, A, 'DELETE', `/api/scenes/${SONG}`)).status, 404);
  assert.ok(database.get(A, SONG));

  const entries = [
    { id: uuid(100), jobId: SONG, title: ' Opener ', settings: settings({ sectionStart: 10, sectionEnd: 20, loop: true }) },
    { id: uuid(101), jobId: SONG },
  ];
  const patched = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 1, name: 'Renamed', entries });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.scene.revision, 2);
  assert.equal(patched.body.scene.name, 'Renamed');
  assert.equal(patched.body.scene.entries[0].title, 'Opener');
  assert.equal(patched.body.scene.entries[1].settings, undefined, 'settings stay optional');
  assert.equal(patched.body.scene.entries.length, 2, 'the same song may appear twice with distinct entry IDs');
  assert.deepEqual((await call(scenes, A, 'GET', `/api/scenes/${scene.id}`)).body.scene, patched.body.scene);

  assert.deepEqual((await call(scenes, A, 'DELETE', `/api/scenes/${scene.id}`)).body, { deleted: true });
  assert.equal((await call(scenes, A, 'GET', `/api/scenes/${scene.id}`)).status, 404);
  assert.equal((await call(scenes, A, 'DELETE', `/api/scenes/${scene.id}`)).status, 404);
});

test('scene listing paginates the base table internally and skips other records', async () => {
  const { database, scenes, storage } = setup();
  seedSong(database, storage, A, SONG);
  database.put({ userId: A, jobId: CHILD_R, type: 'restoration', parentJobId: SONG, status: 'completed', generatedAt: 'x' });
  const made = [];
  for (let i = 0; i < 5; i++) made.push(await makeScene(scenes, A, `Scene ${i}`));
  const listed = (await call(scenes, A, 'GET', '/api/scenes')).body.scenes;
  assert.equal(listed.length, 5);
  assert.deepEqual(new Set(listed.map(scene => scene.id)), new Set(made.map(scene => scene.id)));
  assert.ok(database.calls.filter(kind => kind === 'QueryCommand').length > 1, 'more than one page was read');
});

test('scene names, bodies and entries are validated strictly', async () => {
  const { database, scenes, storage } = setup();
  seedSong(database, storage, A, SONG);
  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 'a\u0007b' }, { name: 5 },
    { name: 'ok', entries: [] }]) {
    assert.equal((await call(scenes, A, 'POST', '/api/scenes', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(scenes, A, 'POST', '/api/scenes', { name: 'x'.repeat(200) })).status, 201);
  const raw = await createSceneHandler({ database })({ ...event(A, 'POST', '/api/scenes'), body: '{nope' });
  assert.equal(raw.statusCode, 400);
  const scene = await makeScene(scenes);
  const patch = body => call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 1, ...body });
  const entry = (extra = {}) => ({ id: uuid(200), jobId: SONG, ...extra });
  const bad = [
    { entries: 'nope' },
    { entries: [entry({ id: 'not-uuid' })] },
    { entries: [entry({ id: 'ABCDEF00-0000-4000-8000-000000000200' })] },
    { entries: [entry({ jobId: 'abc' })] },
    { entries: [entry(), entry()] },
    { entries: [entry({ extra: 1 })] },
    { entries: [entry({ title: 'x'.repeat(201) })] },
    { entries: [entry({ title: 7 })] },
    { entries: [entry({ title: '' })] },
    { entries: [entry({ title: '   ' })] },
    { entries: Array.from({ length: MAX_SCENE_ENTRIES + 1 }, (_, i) => ({ id: uuid(1000 + i), jobId: SONG })) },
    { name: 'ok', other: true },
    {},
  ];
  for (const body of bad) assert.equal((await patch(body)).status, 400, JSON.stringify(body).slice(0, 80));
  const many = Array.from({ length: MAX_SCENE_ENTRIES }, (_, i) => ({ id: uuid(1000 + i), jobId: SONG }));
  assert.equal((await patch({ entries: many })).status, 200, `exactly ${MAX_SCENE_ENTRIES} entries are allowed`);
});

test('entry settings follow the mixer ranges exactly', async () => {
  const { database, scenes, storage } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  let revision = 1;
  const save = async value => {
    const result = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
      { revision, entries: [{ id: uuid(300), jobId: SONG, settings: value }] });
    if (result.status === 200) revision = result.body.scene.revision;
    return result;
  };
  const withTrack = (stem, overrides) => settings({ tracks: { ...settings().tracks, [stem]: track(overrides) } });
  const valid = [
    settings(), settings({ masterVolume: 0 }), settings({ masterVolume: 100 }),
    settings({ sectionStart: 179.5, sectionEnd: 180 }), settings({ sectionStart: 0, sectionEnd: 0.01, loop: true }),
    withTrack('bass', { volume: 0, preGain: 200, compression: 100, distortion: 100, bass: -12, mid: 12, treble: 0.5, pan: -100, reverb: 100 }),
    withTrack('vocals', { pan: 100, muted: true, solo: true, bypassed: true, useCleaned: true }),
  ];
  for (const value of valid) assert.equal((await save(value)).status, 200, JSON.stringify(value).slice(0, 120));
  const { tracks: _drop, ...noTracks } = settings();
  const { drums: _drums, ...fiveTracks } = settings().tracks;
  const invalid = [
    null, [], 'x', noTracks, { ...settings(), extra: 1 },
    settings({ masterVolume: 101 }), settings({ masterVolume: -1 }), settings({ masterVolume: '80' }), settings({ masterVolume: NaN }),
    settings({ sectionStart: -0.1 }), settings({ sectionStart: 10, sectionEnd: 10 }), settings({ sectionStart: 10, sectionEnd: 5 }),
    settings({ sectionEnd: 180.01 }), settings({ loop: 'yes' }), settings({ tracks: [] }),
    settings({ tracks: fiveTracks }), settings({ tracks: { ...settings().tracks, flute: track() } }),
    withTrack('drums', { volume: 101 }), withTrack('drums', { preGain: 201 }), withTrack('drums', { preGain: -1 }),
    withTrack('drums', { compression: 101 }), withTrack('drums', { distortion: -1 }), withTrack('drums', { bass: 12.5 }),
    withTrack('drums', { mid: -13 }), withTrack('drums', { treble: 13 }), withTrack('drums', { pan: 101 }),
    withTrack('drums', { reverb: 101 }), withTrack('drums', { muted: 0 }), withTrack('drums', { solo: 'false' }),
    withTrack('drums', { bypassed: null }), withTrack('drums', { useCleaned: 1 }), withTrack('drums', { extra: 1 }),
    settings({ tracks: { ...settings().tracks, drums: (({ reverb, ...rest }) => rest)(track()) } }),
  ];
  for (const value of invalid) {
    const result = await save(value);
    assert.equal(result.status, 400, JSON.stringify(value)?.slice(0, 120));
    assert.match(result.body.message, /settings|tracks/);
  }
  const message = (await save(withTrack('drums', { pan: 101 }))).body.message;
  assert.equal(message, 'entries[0].settings.tracks.drums.pan must be a number from -100 to 100.');
});

test('entries must reference the caller\'s own completed songs', async () => {
  const { database, scenes, storage } = setup();
  seedSong(database, storage, A, SONG);
  seedSong(database, storage, B, SONG2);
  database.put(song(A, uuid(3), { status: 'uploading' }));
  database.put(song(A, uuid(4), { status: 'queued' }));
  database.put(song(A, uuid(5), { status: 'failed', failedAt: new Date().toISOString() }));
  database.put(song(A, uuid(6), { deleting: 'token' }));
  database.put({ ...song(A, uuid(7)), stems: { drums: { key: 'x' } } });
  database.put({ userId: A, jobId: uuid(8), type: 'restoration', parentJobId: SONG, status: 'completed' });
  database.put({ ...song(A, uuid(9)), type: undefined });
  const scene = await makeScene(scenes);
  const attempt = jobId => call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
    { revision: 1, entries: [{ id: uuid(400), jobId }] });
  assert.equal((await attempt(SONG2)).status, 404, 'another user\'s song is not found');
  assert.equal((await attempt(uuid(99))).status, 404);
  assert.equal((await attempt(uuid(8))).status, 404, 'child records are not songs');
  assert.equal((await attempt(uuid(9))).status, 404);
  for (const n of [3, 4, 5, 6, 7]) assert.equal((await attempt(uuid(n))).status, 409, `song ${n}`);
  assert.equal(database.get(A, scene.id).revision, 1, 'rejected edits change nothing');
  assert.equal((await attempt(SONG)).status, 200);
});

test('PATCH requires the current revision and never silently overwrites', async () => {
  const { database, scenes, storage } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  const path = `/api/scenes/${scene.id}`;
  assert.equal((await call(scenes, A, 'PATCH', path, { name: 'x' })).status, 400);
  assert.equal((await call(scenes, A, 'PATCH', path, { name: 'x', revision: '1' })).status, 400);
  assert.equal((await call(scenes, A, 'PATCH', path, { name: 'x', revision: 0 })).status, 400);
  const first = await call(scenes, A, 'PATCH', path, { revision: 1, name: 'First' });
  assert.equal(first.body.scene.revision, 2);
  const stale = await call(scenes, A, 'PATCH', path, { revision: 1, name: 'Second' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.scene.name, 'First', 'the conflict returns the current scene');
  assert.equal(stale.body.scene.revision, 2);

  // A write that lands between this request's read and its conditional update is not overwritten.
  let raced = false;
  database.hooks.push(async (kind, input) => {
    if (kind === 'UpdateCommand' && !raced && input.ExpressionAttributeValues?.[':name'] === 'Loser') {
      raced = true;
      const current = database.get(A, scene.id);
      database.put({ ...current, name: 'Winner', revision: current.revision + 1 });
    }
  });
  const lost = await call(scenes, A, 'PATCH', path, { revision: 2, name: 'Loser' });
  assert.equal(lost.status, 409);
  assert.equal(lost.body.scene.name, 'Winner');
  assert.equal(database.get(A, scene.id).name, 'Winner');
  const won = await call(scenes, A, 'PATCH', path, { revision: 3, entries: [{ id: uuid(500), jobId: SONG }] });
  assert.equal(won.status, 200);
  assert.equal(won.body.scene.name, 'Winner', 'unchanged fields are kept');
  assert.equal(won.body.scene.revision, 4);
});

function seedChildren(database, storage, userId, jobId) {
  const now = new Date().toISOString();
  const children = [
    { jobId: CHILD_R, type: 'restoration', key: `users/${userId}/restored/${jobId}/${CHILD_R}.wav`, stem: 'vocals', references: ['drums'], strength: 0.5 },
    { jobId: CHILD_L, type: 'lyrics', key: `users/${userId}/lyrics/${jobId}/${CHILD_L}.json` },
    { jobId: CHILD_H, type: 'harmony', version: 3, key: `users/${userId}/harmony/${jobId}/${CHILD_H}.json` },
  ].map(child => ({ userId, parentJobId: jobId, status: 'completed', generatedAt: now, startedAt: now, title: 't', ...child }));
  for (const child of children) { database.put(child); storage.objects.set(child.key, Buffer.from('x')); }
  return children;
}

test('deleting a song removes its files, children and scene entries, and nothing of anyone else', async () => {
  const { database, storage, scenes, stems } = setup();
  seedSong(database, storage, A, SONG);
  seedSong(database, storage, A, SONG2);
  seedChildren(database, storage, A, SONG);
  // An orphaned object under the song's prefixes is still removed.
  storage.objects.set(`users/${A}/lyrics/${SONG}/orphan.json`, Buffer.from('x'));
  // The same job ID under another user, and a neighbouring prefix, must survive.
  seedSong(database, storage, B, SONG);
  seedChildren(database, storage, B, SONG);
  storage.objects.set(`users/${A}/stems/${SONG}0/drums.wav`, Buffer.from('x'));
  storage.objects.set(`users/${A}/${SONG}.wav`, Buffer.from('youtube'));
  const bScene = await makeScene(scenes, B);
  await call(scenes, B, 'PATCH', `/api/scenes/${bScene.id}`, { revision: 1, entries: [{ id: uuid(600), jobId: SONG }] });

  const withSong = await makeScene(scenes, A, 'With song');
  await call(scenes, A, 'PATCH', `/api/scenes/${withSong.id}`, { revision: 1, entries: [
    { id: uuid(601), jobId: SONG }, { id: uuid(602), jobId: SONG2, title: 'Keep' }, { id: uuid(603), jobId: SONG },
  ] });
  const without = await makeScene(scenes, A, 'Without');

  const result = await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { deleted: true });

  for (const id of [SONG, CHILD_R, CHILD_L, CHILD_H]) assert.equal(database.get(A, id), undefined, id);
  for (const prefix of [`stem-inputs/${A}/${SONG}/`, `users/${A}/stems/${SONG}/`, `users/${A}/restored/${SONG}/`,
    `users/${A}/lyrics/${SONG}/`, `users/${A}/harmony/${SONG}/`]) {
    assert.deepEqual([...storage.objects.keys()].filter(key => key.startsWith(prefix)), [], prefix);
  }
  assert.ok(database.get(A, SONG2));
  assert.ok(storage.objects.has(`users/${A}/stems/${SONG2}/drums.wav`));
  assert.ok(storage.objects.has(`users/${A}/stems/${SONG}0/drums.wav`));
  assert.ok(storage.objects.has(`users/${A}/${SONG}.wav`));
  assert.ok(database.get(B, SONG) && database.get(B, CHILD_R));
  assert.ok(storage.objects.has(`users/${B}/stems/${SONG}/vocals.wav`));
  assert.ok(storage.objects.has(`users/${B}/restored/${SONG}/${CHILD_R}.wav`));
  assert.equal(database.get(B, bScene.id).entries.length, 1, 'another user\'s scene is untouched');
  assert.equal(database.get(B, bScene.id).revision, 2);
  assert.ok(storage.calls.filter(call => call.kind === 'DeleteObjectCommand')
    .every(call => call.key.includes(`/${A}/`)), 'only the caller\'s keys are deleted');

  const cleaned = (await call(scenes, A, 'GET', `/api/scenes/${withSong.id}`)).body.scene;
  assert.deepEqual(cleaned.entries, [{ id: uuid(602), jobId: SONG2, title: 'Keep' }]);
  assert.equal(cleaned.revision, 3);
  assert.equal((await call(scenes, A, 'GET', `/api/scenes/${without.id}`)).body.scene.revision, 2,
    'every scene is bumped so in-flight edits re-validate');
  assert.equal((await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`)).status, 404);
});

test('song deletion refuses unfinished songs, running children and other users', async () => {
  const { database, storage, stems } = setup();
  seedSong(database, storage, B, SONG);
  assert.equal((await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`)).status, 404);
  assert.ok(database.get(B, SONG) && storage.objects.has(`users/${B}/stems/${SONG}/drums.wav`));
  assert.equal((await call(stems, A, 'DELETE', `/api/stems/jobs/${uuid(99)}`)).status, 404);
  for (const status of ['uploading', 'queued', 'processing']) {
    database.put(song(A, uuid(20), { status, startedAt: new Date().toISOString() }));
    const result = await call(stems, A, 'DELETE', `/api/stems/jobs/${uuid(20)}`);
    assert.equal(result.status, 409, status);
    assert.equal(database.get(A, uuid(20)).deleting, undefined);
  }
  database.put({ userId: A, jobId: uuid(21), type: 'restoration', parentJobId: SONG, status: 'completed' });
  assert.equal((await call(stems, A, 'DELETE', `/api/stems/jobs/${uuid(21)}`)).status, 404, 'children are not songs');

  seedSong(database, storage, A, SONG2);
  const [restoration] = seedChildren(database, storage, A, SONG2);
  for (const status of ['queued', 'processing']) {
    database.put({ ...restoration, status, startedAt: new Date().toISOString() });
    const result = await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG2}`);
    assert.equal(result.status, 409);
    assert.match(result.body.message, /still running/);
    assert.equal(database.get(A, SONG2).deleting, undefined, 'the deletion flag is released');
    assert.ok(storage.objects.has(`users/${A}/stems/${SONG2}/drums.wav`), 'nothing was deleted');
  }
  // An expired running child counts as failed and no longer blocks deletion.
  database.put({ ...restoration, status: 'processing', startedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal((await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG2}`)).status, 200);
});

test('failed songs, including partial ones with failed children, can be deleted', async () => {
  const { database, storage, stems } = setup();
  const failed = song(A, SONG, { status: 'failed', failedAt: '2020-01-01T00:00:00.000Z', stems: undefined });
  database.put(failed);
  storage.objects.set(failed.inputKey, Buffer.from('in'));
  storage.objects.set(`users/${A}/stems/${SONG}/drums.wav`, Buffer.from('partial'));
  database.put({ userId: A, jobId: CHILD_R, type: 'restoration', parentJobId: SONG, status: 'failed', startedAt: '2020-01-01T00:00:00.000Z' });
  assert.deepEqual((await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`)).body, { deleted: true });
  assert.equal(database.items.size, 0);
  assert.equal(storage.objects.size, 0);
});

test('song deletion refuses records pointing outside the song\'s own storage', async () => {
  const { database, storage, stems } = setup();
  seedSong(database, storage, A, SONG, { stems: { ...song(A, SONG).stems, drums: { key: `users/${B}/stems/${SONG}/drums.wav` } } });
  storage.objects.set(`users/${B}/stems/${SONG}/drums.wav`, Buffer.from('b'));
  assert.equal((await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`)).status, 500);
  assert.ok(storage.objects.has(`users/${B}/stems/${SONG}/drums.wav`));
  assert.ok(database.get(A, SONG));
});

test('a song being deleted blocks new scene entries, cleanups, analyses and metadata edits', async () => {
  const { database, storage, scenes, stems, started } = setup();
  seedSong(database, storage, A, SONG, { deleting: 'other-request' });
  const scene = await makeScene(scenes);
  assert.equal((await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
    { revision: 1, entries: [{ id: uuid(700), jobId: SONG }] })).status, 409);
  const restore = await call(stems, A, 'POST', `/api/stems/jobs/${SONG}/restorations`, { stem: 'vocals', references: ['drums'] });
  assert.equal(restore.status, 409);
  assert.equal((await call(stems, A, 'POST', `/api/stems/jobs/${SONG}/harmony`, {})).status, 409);
  assert.equal((await call(stems, A, 'POST', `/api/stems/jobs/${SONG}/lyrics`, {})).status, 409);
  assert.equal((await call(stems, A, 'PATCH', `/api/stems/jobs/${SONG}`, { title: 'New', author: '' })).status, 409);
  assert.equal(database.get(A, SONG).title, 'Song');
  assert.deepEqual([...database.items.values()].filter(item => item.parentJobId), [], 'no child record remains');
  assert.equal(started.length, 0, 'no work was started');
  assert.equal(storage.objects.size, 7, 'no objects were added');
});

test('a child created just before the deletion flag is either seen by deletion or removes itself', async () => {
  const { database, storage, stems, started } = setup();
  seedSong(database, storage, A, SONG);
  // Deletion sets its flag after the cleanup request read the song, but before its record is written.
  database.hooks.push(async (kind, input) => {
    if (kind === 'PutCommand' && input.Item.parentJobId) {
      const parent = database.get(A, SONG);
      database.put({ ...parent, deleting: 'racing-delete' });
    }
  });
  const result = await call(stems, A, 'POST', `/api/stems/jobs/${SONG}/restorations`, { stem: 'vocals', references: ['drums'] });
  assert.equal(result.status, 409);
  assert.deepEqual([...database.items.values()].filter(item => item.parentJobId), []);
  assert.equal(started.length, 0);
});

test('an edited lyrics file saved while the song is being deleted is removed again', async () => {
  const { database, storage, stems } = setup();
  seedSong(database, storage, A, SONG);
  database.put({ userId: A, jobId: CHILD_L, type: 'lyrics', parentJobId: SONG, status: 'completed',
    key: `users/${A}/lyrics/${SONG}/${CHILD_L}.json`, generatedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:00.000Z' });
  storage.objects.set(`users/${A}/lyrics/${SONG}/${CHILD_L}.json`, Buffer.from(JSON.stringify({ lines: [] })));
  database.hooks.push(async (kind, input) => {
    if (kind === 'PutCommand' && input.Item.edited) database.put({ ...database.get(A, SONG), deleting: 'racing-delete' });
  });
  const lines = [{ start: 0, end: 1, text: 'hi', words: [{ text: 'hi', start: 0, end: 1 }] }];
  const result = await call(stems, A, 'POST', `/api/stems/jobs/${SONG}/lyrics`, { lines });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.deepEqual([...storage.objects.keys()].filter(key => key.includes('/lyrics/')), [`users/${A}/lyrics/${SONG}/${CHILD_L}.json`]);
  assert.deepEqual([...database.items.values()].filter(item => item.edited), []);
});

test('a scene edit validated before a song deletion cannot re-add the deleted song', async () => {
  const { database, storage, scenes, stems } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  let deleted;
  database.hooks.push(async (kind, input) => {
    if (kind === 'TransactWriteCommand' && !deleted) {
      deleted = await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`);
    }
  });
  const result = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
    { revision: 1, entries: [{ id: uuid(800), jobId: SONG }] });
  assert.equal(deleted.status, 200);
  assert.equal(result.status, 409);
  assert.deepEqual(database.get(A, scene.id).entries, []);
});

test('song deletion keeps its flag and reports a conflict when scenes keep changing', async () => {
  const { database, storage, scenes, stems } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  database.hooks.push(async (kind, input) => {
    if (kind === 'UpdateCommand' && input.Key.jobId === scene.id) {
      const current = database.get(A, scene.id);
      database.put({ ...current, revision: current.revision + 1 });
    }
  });
  const result = await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`);
  assert.equal(result.status, 409);
  assert.ok(database.get(A, SONG).deleting, 'writes stay blocked until a retry finishes');
  assert.ok(storage.objects.has(`users/${A}/stems/${SONG}/drums.wav`));
  database.hooks.length = 0;
  assert.equal((await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`)).status, 200, 'a retry resumes');
  assert.equal(database.get(A, SONG), undefined);
});

test('the jobs listing never shows scenes, even malformed ones with createdAt', async () => {
  const database = fakeDatabase();
  database.put(song(A, SONG, { deleting: 'secret-token', deletingAt: '2026-10-01T00:00:00.000Z' }));
  database.put({ userId: A, jobId: uuid(900), type: 'scene', name: 'Bad', createdAt: 'not-a-date', status: 'failed' });
  database.put({ userId: A, jobId: uuid(901), type: 'scene', name: 'Bad 2', createdAt: '2026-10-02T00:00:00.000Z' });
  const api = createHandler({ database, signer });
  const result = await api(event(A, 'GET', '/api/jobs'));
  assert.equal(result.statusCode, 200);
  const { jobs } = JSON.parse(result.body);
  assert.deepEqual(jobs.map(job => job.jobId), [SONG]);
  assert.equal(jobs[0].status, 'deleting');
  assert.equal(jobs[0].stems, undefined, 'stems of a song being deleted are not offered');
  assert.equal(jobs[0].deleting, undefined);
  assert.equal(JSON.stringify(jobs).includes('secret-token'), false);
});

test('only the dedicated deletion handler serves DELETE, and it serves nothing else', async () => {
  const database = fakeDatabase(), storage = fakeStorage();
  seedSong(database, storage, A, SONG);
  const deleteOnly = createStemHandler({ database, storage, signer, deleteOnly: true });
  assert.equal((await call(deleteOnly, A, 'GET', `/api/stems/jobs/${SONG}`)).status, 404);
  assert.equal((await call(deleteOnly, A, 'POST', '/api/stems/uploads', { fileName: 'a.wav', bytes: 1 })).status, 404);
  assert.equal((await call(deleteOnly, A, 'DELETE', `/api/stems/jobs/${SONG}`)).status, 200);
});

test('the local server routes authenticated scene and song-deletion requests', async t => {
  const seen = [];
  const handler = name => async event => {
    seen.push({ name, method: event.requestContext.http.method, path: event.rawPath, size: event.body.length,
      sub: event.requestContext.authorizer?.jwt?.claims?.sub });
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
  };
  const server = createLocalServer({
    api: handler('api'), accounts: handler('accounts'), stems: handler('stems'), scenes: handler('scenes'),
    verify: async token => { if (token !== 'good') throw new Error('bad'); return { sub: A }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer good' };
  const id = uuid(1);
  assert.equal((await fetch(`${base}/api/scenes`)).status, 401);
  assert.equal((await fetch(`${base}/api/scenes/${id}`, { method: 'DELETE' })).status, 401);
  for (const [method, path] of [['GET', '/api/scenes'], ['POST', '/api/scenes'], ['GET', `/api/scenes/${id}`],
    ['PATCH', `/api/scenes/${id}`], ['DELETE', `/api/scenes/${id}`], ['DELETE', `/api/stems/jobs/${id}`]]) {
    assert.equal((await fetch(base + path, { method, headers, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) })).status, 200, `${method} ${path}`);
  }
  assert.deepEqual(seen.map(item => item.name), ['scenes', 'scenes', 'scenes', 'scenes', 'scenes', 'stems']);
  assert.ok(seen.every(item => item.sub === A));
  for (const [method, path] of [['DELETE', '/api/scenes'], ['PUT', `/api/scenes/${id}`], ['POST', `/api/scenes/${id}`],
    ['PUT', `/api/stems/jobs/${id}`]]) {
    assert.equal((await fetch(base + path, { method, headers })).status, 405, `${method} ${path}`);
  }
  const large = JSON.stringify({ revision: 1, entries: 'x'.repeat(100_000) });
  assert.equal((await fetch(`${base}/api/scenes/${id}`, { method: 'PATCH', headers, body: large })).status, 200);
  assert.equal((await fetch(`${base}/api/scenes/${id}`, { method: 'PATCH', headers, body: 'x'.repeat(MAX_SCENE_BODY_BYTES + 1) })).status, 413);
  assert.equal((await fetch(`${base}/api/stems/jobs/${id}`, { method: 'PATCH', headers, body: 'x'.repeat(5000) })).status, 413);
});

test('the template routes scenes and song deletion with scoped permissions', () => {
  const template = readFileSync(new URL('../../template.yaml', import.meta.url), 'utf8');
  const section = (start, end) => template.slice(template.indexOf(`  ${start}:\n`), template.indexOf(`  ${end}:\n`));
  const scenesFn = section('SceneApi', 'StemVpc');
  assert.match(scenesFn, /Handler: scene-api\.handler/);
  for (const [path, method] of [['/api/scenes', 'GET'], ['/api/scenes', 'POST'], ['/api/scenes/{sceneId}', 'GET'],
    ['/api/scenes/{sceneId}', 'PATCH'], ['/api/scenes/{sceneId}', 'DELETE']]) {
    assert.ok(scenesFn.includes(`Path: ${path}\n            Method: ${method}`), `${method} ${path}`);
  }
  assert.equal(scenesFn.includes('s3:'), false, 'scenes need no storage access');
  const deletion = section('SongDeletion', 'SceneApi');
  assert.match(deletion, /Handler: stem-api\.songDeletionHandler/);
  assert.ok(deletion.includes('Path: /api/stems/jobs/{jobId}\n            Method: DELETE'));
  for (const prefix of ['stem-inputs/*', 'users/*/stems/*', 'users/*/restored/*', 'users/*/lyrics/*', 'users/*/harmony/*']) {
    assert.ok(deletion.includes(`\${AudioBucket.Arn}/${prefix}'`), prefix);
  }
  assert.equal(/s3:(PutObject|GetObject)/.test(deletion), false);
  const stemApi = section('StemApi', 'SongDeletion');
  assert.equal(stemApi.includes('Method: DELETE\n') && stemApi.includes('Path: /api/stems/jobs/{jobId}\n            Method: DELETE'), false);
  assert.equal(stemApi.includes("users/*/stems/*'"), false, 'the general stem API still cannot delete original stems');
  assert.match(template, /AllowMethods: \[GET, POST, PATCH, DELETE, OPTIONS\]/);
});

test('a blank alias gets a clear error, and omitting it is fine', async () => {
  const { database, scenes, storage } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  const blank = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
    { revision: 1, entries: [{ id: uuid(900), jobId: SONG, title: ' ' }] });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.message, "entries[0].title cannot be blank. Leave it out to use the song's own title.");
  assert.equal((await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
    { revision: 1, entries: [{ id: uuid(900), jobId: SONG }] })).status, 200);
});

test('each entry keeps its own full settings exactly, even for the same song', async () => {
  const { database, scenes, storage } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  const first = settings({ masterVolume: 33.3333333333333, sectionStart: 1.23456789, sectionEnd: 99.87654321, loop: true,
    tracks: Object.fromEntries(STEM_NAMES.map((name, i) => [name, track({ volume: i * 7.25, pan: -(i + 1) * 3.5, bass: -11.5,
      treble: 0.1 + i, preGain: 150 + i, solo: i % 2 === 0, useCleaned: i === 2 })])) });
  const second = settings({ masterVolume: 12, tracks: { ...settings().tracks, drums: track({ muted: true, reverb: 64 }) } });
  const entries = [{ id: uuid(910), jobId: SONG, settings: first }, { id: uuid(911), jobId: SONG, title: 'Again', settings: second }];
  const saved = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 1, entries });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.scene.entries, entries);
  assert.deepEqual((await call(scenes, A, 'GET', `/api/scenes/${scene.id}`)).body.scene.entries, entries);
  // Changing one entry's settings leaves the other exactly as saved.
  const changed = [entries[0], { ...entries[1], settings: settings({ masterVolume: 99 }) }];
  const next = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 2, entries: changed });
  assert.deepEqual(next.body.scene.entries[0].settings, first);
});

test('99 entries with full settings and longest titles fit the body and item limits', async () => {
  const { database, scenes, storage } = setup();
  const songs = Array.from({ length: MAX_SCENE_ENTRIES }, (_, i) => uuid(2000 + i));
  for (const jobId of songs) seedSong(database, storage, A, jobId, { duration: 720 });
  const scene = await makeScene(scenes, A, '가'.repeat(200));
  // Longest-printing doubles in range and 3-byte characters: the worst realistic case.
  const n = (max, i) => Number((max - 1e-13 * (i + 1)).toPrecision(17)) * (i % 2 ? -1 : 1);
  const full = i => ({
    masterVolume: 99.99999999999997, sectionStart: 1.2345678901234567, sectionEnd: 719.9999999999999, loop: true,
    tracks: Object.fromEntries(STEM_NAMES.map(name => [name, {
      volume: 99.99999999999997, preGain: 199.99999999999997, compression: 0.1234567890123457, distortion: 0.1234567890123457,
      bass: n(12, i), mid: n(12, i + 1), treble: n(12, i + 2), pan: n(100, i), reverb: 0.1234567890123457,
      muted: true, solo: false, bypassed: true, useCleaned: false,
    }])),
  });
  const entries = songs.map((jobId, i) => ({ id: uuid(5000 + i), jobId, title: '가'.repeat(200), settings: full(i) }));
  const body = JSON.stringify({ revision: 1, name: '가'.repeat(200), entries });
  assert.ok(Buffer.byteLength(body) < MAX_SCENE_BODY_BYTES, `${Buffer.byteLength(body)} bytes of JSON`);
  const stored = { userId: A, jobId: scene.id, type: 'scene', name: '가'.repeat(200), entries, revision: 2,
    generatedAt: scene.createdAt, updatedAt: scene.createdAt };
  const size = Object.entries(stored).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + dynamoSize(value), 0);
  assert.ok(size < MAX_SCENE_ITEM_BYTES && MAX_SCENE_ITEM_BYTES < 400 * 1024, `${size} estimated item bytes`);
  const saved = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, JSON.parse(body));
  assert.equal(saved.status, 200, saved.body.message);
  assert.deepEqual(saved.body.scene.entries, entries);
  assert.equal(MAX_SCENE_ENTRIES, 99);
  assert.equal(database.transactions.at(-1).length, 100, 'scene update plus a check for every song');
});

test('a scene save is checked atomically against songs being deleted', async () => {
  const { database, storage, scenes } = setup();
  seedSong(database, storage, A, SONG);
  seedSong(database, storage, A, SONG2);
  const scene = await makeScene(scenes);
  const ok = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 1, entries: [{ id: uuid(920), jobId: SONG }] });
  assert.equal(ok.status, 200);
  const checks = database.transactions.at(-1).filter(action => action.ConditionCheck);
  assert.deepEqual(checks.map(action => action.ConditionCheck.Key), [{ userId: A, jobId: SONG }]);
  // The song is flagged after this save validated it but before the write: the transaction refuses.
  database.hooks.push(async kind => {
    if (kind === 'TransactWriteCommand') database.put({ ...database.get(A, SONG2), deleting: 'racing' });
  });
  const raced = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
    { revision: 2, entries: [{ id: uuid(920), jobId: SONG }, { id: uuid(921), jobId: SONG2 }] });
  assert.equal(raced.status, 409);
  assert.equal(raced.body.message, 'entries[1].jobId is being deleted or is no longer ready. Reload and try again.');
  assert.equal(database.get(A, scene.id).revision, 2);
  assert.deepEqual(database.get(A, scene.id).entries.map(entry => entry.jobId), [SONG]);
  // Every referenced song, existing or new, is checked.
  database.hooks.length = 0;
  database.put({ ...database.get(A, SONG2), deleting: undefined });
  await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
    { revision: 2, entries: [{ id: uuid(920), jobId: SONG }, { id: uuid(921), jobId: SONG2 }] });
  assert.deepEqual(database.transactions.at(-1).slice(1).map(action => action.ConditionCheck.Key.jobId).sort(), [SONG, SONG2].sort());
  // Removing every song needs no song checks.
  assert.equal((await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 3, entries: [] })).status, 200);
});

test('a song stuck in deleting is shown as deleting and a retry finishes it', async () => {
  const { database, storage, stems, scenes } = setup();
  seedSong(database, storage, A, SONG, { deleting: 'crashed-request', deletingAt: '2026-10-01T00:00:00.000Z' });
  seedChildren(database, storage, A, SONG);
  // Part of an earlier attempt already happened.
  storage.objects.delete(`users/${A}/stems/${SONG}/drums.wav`);
  database.items.delete(`${A}|${CHILD_R}`);
  const scene = await makeScene(scenes);
  database.put({ ...database.get(A, scene.id), entries: [{ id: uuid(930), jobId: SONG }] });

  const shown = await call(stems, A, 'GET', `/api/stems/jobs/${SONG}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.body.job.status, 'deleting');
  assert.equal(shown.body.job.deleting, undefined);
  assert.equal(shown.body.job.stems, undefined);
  assert.equal((await call(stems, A, 'POST', `/api/stems/jobs/${SONG}/complete`)).status, 409);
  assert.equal((await call(stems, A, 'POST', `/api/stems/jobs/${SONG}/harmony`, { stem: 'bass' })).status, 409);

  assert.deepEqual((await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`)).body, { deleted: true });
  assert.deepEqual([...database.items.values()].map(item => item.type), ['scene']);
  assert.deepEqual(database.get(A, scene.id).entries, []);
  assert.equal(storage.objects.size, 0);
  assert.equal((await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`)).status, 404, 'once gone, a retry reports not found');
});

test('a transaction holding the song makes deletion ask for a retry', async () => {
  const { database, storage, stems } = setup();
  seedSong(database, storage, A, SONG);
  database.hooks.push(async (kind, input) => {
    if (kind === 'UpdateCommand' && input.UpdateExpression.startsWith('SET deleting')) {
      throw Object.assign(new Error('conflict'), { name: 'TransactionConflictException' });
    }
  });
  const result = await call(stems, A, 'DELETE', `/api/stems/jobs/${SONG}`);
  assert.equal(result.status, 409);
  assert.match(result.body.message, /Try deleting it again/);
  assert.equal(database.get(A, SONG).deleting, undefined);
});

test('the maximum scene with 4-byte characters still fits the item limit', async () => {
  const { database, storage, scenes } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  database.put({ ...database.get(A, scene.id), name: '𝄞'.repeat(100) });
  const entries = Array.from({ length: MAX_SCENE_ENTRIES }, (_, i) => ({ id: uuid(6000 + i), jobId: SONG, title: '𝄞'.repeat(100), settings: settings() }));
  const ok = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 1, entries });
  assert.equal(ok.status, 200, 'the real maximum still fits');
});

test('frontend default and edge settings are accepted exactly as the mixer captures them', async () => {
  const { database, storage, scenes } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  let revision = 1;
  const save = async value => {
    const result = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`,
      { revision, entries: [{ id: uuid(310), jobId: SONG, settings: value }] });
    if (result.status === 200) revision = result.body.scene.revision;
    return result;
  };
  const allTracks = overrides => Object.fromEntries(STEM_NAMES.map(name => [name, track(overrides)]));
  // Reset state: master 80, full song (end = job duration), loop off, original audio on every stem.
  assert.equal((await save(settings({ tracks: allTracks({ useCleaned: false }) }))).status, 200);
  assert.equal((await save(settings({ tracks: allTracks({ useCleaned: true }) }))).status, 200);
  // The mixer's minimum 0.05 s interval at either end of the song.
  assert.equal((await save(settings({ sectionStart: 0, sectionEnd: 0.05 }))).status, 200);
  assert.equal((await save(settings({ sectionStart: 179.95, sectionEnd: 180 }))).status, 200);
  const zero = await save(settings({ sectionStart: 0, sectionEnd: 0 }));
  assert.equal(zero.status, 400);
  assert.equal(zero.body.message, 'entries[0].settings.sectionEnd must be greater than sectionStart.');
});

test(`every one of ${MAX_SCENE_ENTRIES} distinct songs is checked, so a deleting last song is refused`, async () => {
  const { database, storage, scenes } = setup();
  const songs = Array.from({ length: MAX_SCENE_ENTRIES }, (_, i) => uuid(7000 + i));
  for (const jobId of songs) seedSong(database, storage, A, jobId);
  const scene = await makeScene(scenes);
  const entries = songs.map((jobId, i) => ({ id: uuid(8000 + i), jobId }));
  // Validation reads all songs as ready; the last one is flagged before the write.
  database.hooks.push(async kind => {
    if (kind !== 'TransactWriteCommand') return;
    database.put({ ...database.get(A, songs.at(-1)), deleting: 'token' });
  });
  const result = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 1, entries });
  assert.equal(result.status, 409);
  assert.equal(result.body.message, `entries[${MAX_SCENE_ENTRIES - 1}].jobId is being deleted or is no longer ready. Reload and try again.`);
  const checked = database.transactions.at(-1).filter(item => item.ConditionCheck).map(item => item.ConditionCheck.Key.jobId);
  assert.deepEqual(checked.sort(), [...songs].sort());
  assert.deepEqual(database.get(A, scene.id).entries, []);
});

test(`${MAX_SCENE_ENTRIES + 1} entries are rejected even for one song`, async () => {
  const { database, storage, scenes } = setup();
  seedSong(database, storage, A, SONG);
  const scene = await makeScene(scenes);
  const entries = Array.from({ length: MAX_SCENE_ENTRIES + 1 }, (_, i) => ({ id: uuid(9000 + i), jobId: SONG }));
  const result = await call(scenes, A, 'PATCH', `/api/scenes/${scene.id}`, { revision: 1, entries });
  assert.equal(result.status, 400);
  assert.equal(result.body.message, `A scene can have up to ${MAX_SCENE_ENTRIES} songs.`);
});
