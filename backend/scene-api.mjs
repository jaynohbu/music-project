import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { visibleJob } from './shared.mjs';
import { STEM_MAX_DURATION, STEM_NAMES } from './stem-shared.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

export const MAX_SCENES = 100;
// A transaction holds at most 100 actions: the scene update plus one check per referenced song.
export const MAX_SCENE_ENTRIES = 99;
export const MAX_SCENE_NAME = 200;
export const MAX_SCENE_BODY_BYTES = 1024 * 1024;
// DynamoDB items are capped at 400 KiB; keep a margin for the estimate below.
export const MAX_SCENE_ITEM_BYTES = 390_000;
const SCENE_RETRIES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RUNNING = ['uploading', 'queued', 'processing'];
const CHILD_FOLDERS = { restoration: 'restored', lyrics: 'lyrics', harmony: 'harmony' };

// Ranges mirror web/src/stem-effects.ts FADER_CONTROLS.
export const TRACK_RANGES = {
  volume: [0, 100], preGain: [0, 200], compression: [0, 100], distortion: [0, 100],
  bass: [-12, 12], mid: [-12, 12], treble: [-12, 12], pan: [-100, 100], reverb: [0, 100],
};
export const TRACK_FLAGS = ['muted', 'solo', 'bypassed', 'useCleaned'];
const SETTINGS_KEYS = ['masterVolume', 'sectionStart', 'sectionEnd', 'loop', 'tracks'];

export class SceneInputError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'SceneInputError'; this.statusCode = statusCode; }
}
export class SongDeletingError extends Error {
  constructor() { super('This song is being deleted.'); this.name = 'SongDeletingError'; }
}

const fail = (message, statusCode) => { throw new SceneInputError(message, statusCode); };
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys, path) => {
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) fail(`${path} has unsupported field "${extra[0]}".`);
  const missing = keys.filter(key => !(key in value));
  if (missing.length) fail(`${path}.${missing[0]} is required.`);
};
const number = (value, path, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${path} must be a number from ${min} to ${max}.`);
  }
  return value;
};

export function sceneName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_SCENE_NAME || CONTROL.test(value)) {
    fail(`Scene name must be 1–${MAX_SCENE_NAME} characters without control characters.`);
  }
  return value.trim();
}

export function sceneSettings(value, duration, path = 'settings') {
  if (!isObject(value)) fail(`${path} must be an object.`);
  exactKeys(value, SETTINGS_KEYS, path);
  const limit = Number.isFinite(duration) && duration > 0 ? duration : STEM_MAX_DURATION;
  number(value.masterVolume, `${path}.masterVolume`, 0, 100);
  number(value.sectionStart, `${path}.sectionStart`, 0, limit);
  number(value.sectionEnd, `${path}.sectionEnd`, 0, limit);
  if (value.sectionEnd <= value.sectionStart) fail(`${path}.sectionEnd must be greater than sectionStart.`);
  if (typeof value.loop !== 'boolean') fail(`${path}.loop must be true or false.`);
  if (!isObject(value.tracks)) fail(`${path}.tracks must be an object.`);
  exactKeys(value.tracks, STEM_NAMES, `${path}.tracks`);
  const tracks = {};
  for (const stem of STEM_NAMES) {
    const track = value.tracks[stem], at = `${path}.tracks.${stem}`;
    if (!isObject(track)) fail(`${at} must be an object.`);
    exactKeys(track, [...Object.keys(TRACK_RANGES), ...TRACK_FLAGS], at);
    tracks[stem] = {};
    for (const [key, [min, max]] of Object.entries(TRACK_RANGES)) tracks[stem][key] = number(track[key], `${at}.${key}`, min, max);
    for (const key of TRACK_FLAGS) {
      if (typeof track[key] !== 'boolean') fail(`${at}.${key} must be true or false.`);
      tracks[stem][key] = track[key];
    }
  }
  return { masterVolume: value.masterVolume, sectionStart: value.sectionStart, sectionEnd: value.sectionEnd, loop: value.loop, tracks };
}

// Shape-only validation; song ownership and duration checks happen against the table.
export function sceneEntries(value) {
  if (!Array.isArray(value)) fail('entries must be an array.');
  if (value.length > MAX_SCENE_ENTRIES) fail(`A scene can have up to ${MAX_SCENE_ENTRIES} songs.`);
  const ids = new Set();
  return value.map((entry, index) => {
    const path = `entries[${index}]`;
    if (!isObject(entry)) fail(`${path} must be an object.`);
    const extra = Object.keys(entry).filter(key => !['id', 'jobId', 'title', 'settings'].includes(key));
    if (extra.length) fail(`${path} has unsupported field "${extra[0]}".`);
    if (typeof entry.id !== 'string' || !UUID.test(entry.id)) fail(`${path}.id must be a lowercase UUID.`);
    if (ids.has(entry.id)) fail(`${path}.id duplicates another entry.`);
    ids.add(entry.id);
    if (typeof entry.jobId !== 'string' || !UUID.test(entry.jobId)) fail(`${path}.jobId must be a lowercase UUID.`);
    const result = { id: entry.id, jobId: entry.jobId };
    if (entry.title !== undefined) {
      if (typeof entry.title !== 'string' || entry.title.trim().length > MAX_SCENE_NAME || CONTROL.test(entry.title)) {
        fail(`${path}.title must be at most ${MAX_SCENE_NAME} characters without control characters.`);
      }
      if (!entry.title.trim()) fail(`${path}.title cannot be blank. Leave it out to use the song's own title.`);
      result.title = entry.title.trim();
    }
    if (entry.settings !== undefined) result.settings = entry.settings;
    return result;
  });
}

// Conservative DynamoDB item size: numbers are counted at their 21-byte maximum.
export function dynamoSize(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (typeof value === 'number') return 21;
  if (typeof value === 'boolean' || value === null || value === undefined) return 1;
  if (Array.isArray(value)) return 3 + value.reduce((sum, item) => sum + 1 + dynamoSize(item), 0);
  return 3 + Object.entries(value).reduce((sum, [key, item]) => sum + 1 + Buffer.byteLength(key) + dynamoSize(item), 0);
}
const itemSize = item => Object.entries(item).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + dynamoSize(value), 0);

export function publicScene(item) {
  return {
    id: item.jobId, name: item.name, entries: item.entries ?? [], revision: item.revision,
    createdAt: item.generatedAt, updatedAt: item.updatedAt,
  };
}

export async function listSceneRecords(userId, database) {
  const items = [];
  let start;
  do {
    const page = await database.send(new QueryCommand({
      TableName: process.env.TABLE_NAME, ConsistentRead: true, ExclusiveStartKey: start,
      KeyConditionExpression: 'userId = :userId', FilterExpression: '#type = :scene',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':userId': userId, ':scene': 'scene' },
    }));
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

const SONG_READY = '#type = :stems AND #status = :completed AND attribute_not_exists(deleting)';
const playableSong = song => song?.type === 'stems' && song.status === 'completed' &&
  visibleJob(song).status === 'completed' && !song.deleting &&
  STEM_NAMES.every(name => typeof song.stems?.[name]?.key === 'string');

async function checkSongs(userId, entries, database) {
  const ids = [...new Set(entries.map(entry => entry.jobId))];
  const songs = new Map(await Promise.all(ids.map(async jobId => [jobId, (await database.send(new GetCommand({
    TableName: process.env.TABLE_NAME, Key: { userId, jobId }, ConsistentRead: true,
  }))).Item])));
  return entries.map((entry, index) => {
    const song = songs.get(entry.jobId);
    if (!song || song.type !== 'stems') fail(`entries[${index}].jobId is not one of your songs.`, 404);
    if (song.deleting) fail(`entries[${index}].jobId is being deleted.`, 409);
    if (!playableSong(song)) fail(`entries[${index}].jobId must be a song whose stems are ready.`, 409);
    if (entry.settings === undefined) return entry;
    return { ...entry, settings: sceneSettings(entry.settings, song.duration, `entries[${index}].settings`) };
  });
}

export function createSceneHandler({ database = db } = {}) {
  const table = () => process.env.TABLE_NAME;
  const read = async (userId, id) => {
    const item = (await database.send(new GetCommand({
      TableName: table(), Key: { userId, jobId: id }, ConsistentRead: true,
    }))).Item;
    return item?.type === 'scene' ? item : undefined;
  };

  return async event => {
    const reply = (statusCode, body) => ({
      statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) return reply(401, { message: 'Sign in to continue.' });
    const method = event.requestContext.http.method;
    const route = event.rawPath ?? '';
    const body = () => {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body ?? '';
      if (Buffer.byteLength(raw) > MAX_SCENE_BODY_BYTES) fail('Request body is too large.', 413);
      let value;
      try { value = JSON.parse(raw || '{}'); } catch { fail('Send a JSON object.'); }
      if (!isObject(value)) fail('Send a JSON object.');
      return value;
    };
    try {
      if (route === '/api/scenes') {
        if (method === 'GET') {
          const scenes = (await listSceneRecords(userId, database))
            .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.jobId.localeCompare(b.jobId));
          return reply(200, { scenes: scenes.map(publicScene) });
        }
        if (method !== 'POST') return reply(404, { message: 'Endpoint not found.' });
        const input = body();
        const extra = Object.keys(input).filter(key => key !== 'name');
        if (extra.length) fail(`Unsupported field "${extra[0]}". Create a scene with a name, then add songs.`);
        const name = sceneName(input.name);
        if ((await listSceneRecords(userId, database)).length >= MAX_SCENES) {
          return reply(409, { message: `Delete a scene first. You can have up to ${MAX_SCENES} scenes.` });
        }
        const now = new Date().toISOString();
        // No createdAt: keeps scenes out of the ByCreatedAt library index.
        const item = { userId, jobId: randomUUID(), type: 'scene', name, entries: [], revision: 1, generatedAt: now, updatedAt: now };
        await database.send(new PutCommand({ TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(jobId)' }));
        return reply(201, { scene: publicScene(item) });
      }
      const match = /^\/api\/scenes\/([^/]+)$/.exec(route);
      if (!match) return reply(404, { message: 'Endpoint not found.' });
      if (!UUID.test(match[1])) return reply(404, { message: 'Scene not found.' });
      const id = match[1];
      if (method === 'GET') {
        const scene = await read(userId, id);
        return scene ? reply(200, { scene: publicScene(scene) }) : reply(404, { message: 'Scene not found.' });
      }
      if (method === 'DELETE') {
        try {
          await database.send(new DeleteCommand({
            TableName: table(), Key: { userId, jobId: id },
            ConditionExpression: '#type = :scene', ExpressionAttributeNames: { '#type': 'type' },
            ExpressionAttributeValues: { ':scene': 'scene' },
          }));
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException') throw error;
          return reply(404, { message: 'Scene not found.' });
        }
        return reply(200, { deleted: true });
      }
      if (method !== 'PATCH') return reply(404, { message: 'Endpoint not found.' });
      const input = body();
      const extra = Object.keys(input).filter(key => !['revision', 'name', 'entries'].includes(key));
      if (extra.length) fail(`Unsupported field "${extra[0]}".`);
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail('revision is required: send the scene revision you last loaded.');
      if (input.name === undefined && input.entries === undefined) fail('Send a new name, entries, or both.');
      const name = input.name === undefined ? undefined : sceneName(input.name);
      let entries = input.entries === undefined ? undefined : sceneEntries(input.entries);
      const current = await read(userId, id);
      if (!current) return reply(404, { message: 'Scene not found.' });
      const conflict = () => reply(409, {
        message: 'This scene changed since you loaded it. Reload it and try again.', scene: publicScene(current),
      });
      if (current.revision !== input.revision) return conflict();
      if (entries) entries = await checkSongs(userId, entries, database);
      const next = { ...current, ...(name !== undefined ? { name } : {}), ...(entries ? { entries } : {}),
        revision: current.revision + 1, updatedAt: new Date().toISOString() };
      if (itemSize(next) > MAX_SCENE_ITEM_BYTES) fail('This scene is too large to save. Shorten its titles or remove songs.', 413);
      const update = {
        TableName: table(), Key: { userId, jobId: id },
        UpdateExpression: 'SET #name = :name, entries = :entries, revision = :next, updatedAt = :updated',
        ConditionExpression: '#type = :scene AND revision = :expected',
        ExpressionAttributeNames: { '#type': 'type', '#name': 'name' },
        ExpressionAttributeValues: {
          ':name': next.name, ':entries': next.entries, ':next': next.revision, ':updated': next.updatedAt,
          ':scene': 'scene', ':expected': input.revision,
        },
      };
      // Every referenced song is re-checked atomically with the save.
      const songIds = [...new Set((entries ?? []).map(entry => entry.jobId))];
      const stale = async () => {
        const latest = await read(userId, id);
        if (!latest) return reply(404, { message: 'Scene not found.' });
        return reply(409, { message: 'This scene changed since you loaded it. Reload it and try again.', scene: publicScene(latest) });
      };
      try {
        if (!songIds.length) await database.send(new UpdateCommand(update));
        else {
          await database.send(new TransactWriteCommand({ TransactItems: [{ Update: update }, ...songIds.map(jobId => ({
            ConditionCheck: {
              TableName: table(), Key: { userId, jobId }, ConditionExpression: SONG_READY,
              ExpressionAttributeNames: { '#type': 'type', '#status': 'status' },
              ExpressionAttributeValues: { ':stems': 'stems', ':completed': 'completed' },
            },
          }))] }));
        }
      } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') return stale();
        if (error.name !== 'TransactionCanceledException') throw error;
        const reasons = error.CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return stale();
        const song = reasons.findIndex((reason, index) => index > 0 && reason?.Code === 'ConditionalCheckFailed');
        if (song > 0) {
          const index = entries.findIndex(entry => entry.jobId === songIds[song - 1]);
          return reply(409, { message: `entries[${index}].jobId is being deleted or is no longer ready. Reload and try again.` });
        }
        return reply(409, { message: 'This scene is being changed elsewhere. Try again.' });
      }
      return reply(200, { scene: publicScene(next) });
    } catch (error) {
      if (error instanceof SceneInputError) {
        console.warn('Invalid scene request', { status: error.statusCode });
        return reply(error.statusCode, { message: error.message });
      }
      console.error('Scene API failed', { name: error.name });
      return reply(500, { message: 'The scene service is unavailable. Please try again.' });
    }
  };
}

// Removes a song from every scene. Every scene's revision is bumped, even ones without the song,
// so a concurrent PATCH that checked songs before the deletion flag was set fails its revision check.
export async function removeSongFromScenes(userId, jobId, database) {
  for (const listed of await listSceneRecords(userId, database)) {
    let scene = listed;
    for (let attempt = 0; ; attempt++) {
      if (!scene || scene.type !== 'scene') break;
      const entries = (scene.entries ?? []).filter(entry => entry.jobId !== jobId);
      try {
        await database.send(new UpdateCommand({
          TableName: process.env.TABLE_NAME, Key: { userId, jobId: scene.jobId },
          UpdateExpression: 'SET entries = :entries, revision = :next, updatedAt = :updated',
          ConditionExpression: '#type = :scene AND revision = :expected',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: {
            ':entries': entries, ':next': scene.revision + 1, ':updated': new Date().toISOString(),
            ':scene': 'scene', ':expected': scene.revision,
          },
        }));
        break;
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        if (attempt + 1 >= SCENE_RETRIES) throw Object.assign(new Error('Scene cleanup kept conflicting.'), { name: 'SceneCleanupConflict' });
        scene = (await database.send(new GetCommand({
          TableName: process.env.TABLE_NAME, Key: { userId, jobId: scene.jobId }, ConsistentRead: true,
        }))).Item;
      }
    }
  }
}

async function songChildren(userId, jobId, database) {
  const items = [];
  let start;
  do {
    const page = await database.send(new QueryCommand({
      TableName: process.env.TABLE_NAME, ConsistentRead: true, ExclusiveStartKey: start,
      KeyConditionExpression: 'userId = :userId', FilterExpression: 'parentJobId = :parent',
      ExpressionAttributeValues: { ':userId': userId, ':parent': jobId },
    }));
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

async function deletePrefix(prefix, storage) {
  let token;
  do {
    const page = await storage.send(new ListObjectsV2Command({
      Bucket: process.env.BUCKET_NAME, Prefix: prefix, ContinuationToken: token,
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key?.startsWith(prefix)) throw new Error('Storage listing returned an unexpected key.');
      await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: object.Key }));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

export function songPrefixes(userId, jobId) {
  return [
    `stem-inputs/${userId}/${jobId}/`,
    `users/${userId}/stems/${jobId}/`,
    ...Object.values(CHILD_FOLDERS).map(folder => `users/${userId}/${folder}/${jobId}/`),
  ];
}

// Deletes one of the caller's own songs: its input, original stems, cleaned stems, lyrics and chords,
// their records, and every scene entry that uses it. Keys are built from the caller's own user ID.
export function createSongDeletion({ database = db, storage = s3 } = {}) {
  const table = () => process.env.TABLE_NAME;
  return async ({ userId, jobId, reply }) => {
    const key = { userId, jobId };
    const song = (await database.send(new GetCommand({ TableName: table(), Key: key, ConsistentRead: true }))).Item;
    if (!song || song.type !== 'stems') return reply(404, { message: 'Song not found.' });
    if (!['completed', 'failed'].includes(song.status)) {
      return reply(409, { message: 'This song is still uploading or separating. Delete it after it finishes.' });
    }
    const prefixes = songPrefixes(userId, jobId);
    const owned = value => value === undefined || prefixes.some(prefix => typeof value === 'string' && value.startsWith(prefix));
    if (!owned(song.inputKey) || !STEM_NAMES.every(name => owned(song.stems?.[name]?.key))) {
      throw new Error('Song has an unexpected storage key.');
    }
    const token = randomUUID();
    try {
      await database.send(new UpdateCommand({
        TableName: table(), Key: key,
        UpdateExpression: 'SET deleting = :token, deletingAt = :at',
        ConditionExpression: '#type = :stems AND #status IN (:completed, :failed)',
        ExpressionAttributeNames: { '#type': 'type', '#status': 'status' },
        ExpressionAttributeValues: {
          ':token': token, ':at': new Date().toISOString(), ':stems': 'stems', ':completed': 'completed', ':failed': 'failed',
        },
      }));
    } catch (error) {
      if (error.name === 'TransactionConflictException') {
        return reply(409, { message: 'This song is being added to a scene right now. Try deleting it again.' });
      }
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      return reply(409, { message: 'This song changed while deleting. Reload and try again.' });
    }
    const release = async () => {
      try {
        await database.send(new UpdateCommand({
          TableName: table(), Key: key, UpdateExpression: 'REMOVE deleting, deletingAt',
          ConditionExpression: 'deleting = :token', ExpressionAttributeValues: { ':token': token },
        }));
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
      }
    };
    const children = await songChildren(userId, jobId, database);
    const now = Date.now();
    if (children.some(child => RUNNING.includes(visibleJob(child, now).status))) {
      await release();
      return reply(409, { message: 'Stem cleanup, lyrics or chord analysis is still running for this song. Delete it after it finishes.' });
    }
    for (const child of children) {
      const folder = CHILD_FOLDERS[child.type];
      if (!folder || (child.key !== undefined && !child.key.startsWith(`users/${userId}/${folder}/${jobId}/`))) {
        throw new Error('Song has an unexpected child record.');
      }
    }
    try {
      await removeSongFromScenes(userId, jobId, database);
    } catch (error) {
      if (error.name !== 'SceneCleanupConflict') throw error;
      // Keep the deletion flag so no new writes start; retrying the deletion resumes here.
      return reply(409, { message: 'Your scenes kept changing while this song was being deleted. Try again.' });
    }
    for (const prefix of prefixes) await deletePrefix(prefix, storage);
    for (const child of children) {
      try {
        await database.send(new DeleteCommand({
          TableName: table(), Key: { userId, jobId: child.jobId },
          ConditionExpression: 'parentJobId = :parent', ExpressionAttributeValues: { ':parent': jobId },
        }));
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
      }
    }
    try {
      await database.send(new DeleteCommand({
        TableName: table(), Key: key, ConditionExpression: 'attribute_exists(deleting)',
      }));
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
    return reply(200, { deleted: true });
  };
}

// Wraps the database used for child (cleanup/lyrics/chords) creation. After a child is written,
// the parent is re-read; if the song is being deleted (or gone) the child is removed again.
// Deletion sets its flag before listing children, so either it sees the child or the child sees the flag.
export function guardChildWrites(database, storage) {
  return {
    async send(command) {
      const result = await database.send(command);
      const item = command.constructor.name === 'PutCommand' ? command.input.Item : undefined;
      if (!item?.parentJobId) return result;
      const parent = (await database.send(new GetCommand({
        TableName: command.input.TableName, Key: { userId: item.userId, jobId: item.parentJobId }, ConsistentRead: true,
      }))).Item;
      if (parent?.type === 'stems' && !parent.deleting) return result;
      if (item.status === 'completed' && typeof item.key === 'string' &&
          item.key.startsWith(`users/${item.userId}/lyrics/${item.parentJobId}/`)) {
        await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: item.key }));
      }
      try {
        await database.send(new DeleteCommand({
          TableName: command.input.TableName, Key: { userId: item.userId, jobId: item.jobId },
          ConditionExpression: '#type = :type AND parentJobId = :parent',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: { ':type': item.type, ':parent': item.parentJobId },
        }));
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
      }
      throw new SongDeletingError();
    },
  };
}

export const handler = createSceneHandler();
