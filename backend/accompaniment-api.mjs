import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { visibleJob } from './shared.mjs';
import { STEM_NAMES, UPLOAD_WINDOW_MS } from './stem-shared.mjs';

export const SAMPLE_RATE = 44100;
export const MAX_CHORDS = 500;
export const MAX_REGIONS = 100;
export const HARMONIC_SOURCES = ['bass', 'vocals', 'guitar', 'piano', 'other'];
export const INSTRUMENT_STYLES = {
  synth: ['pad', 'arpeggio', 'rhythm'],
  'acoustic-guitar': ['strum', 'arpeggio', 'rhythm'],
  'electric-guitar': ['strum', 'arpeggio', 'rhythm'],
  piano: ['pad', 'arpeggio', 'rhythm'],
};
const LABELS = {
  synth: 'Synth', 'acoustic-guitar': 'Acoustic guitar', 'electric-guitar': 'Electric guitar', piano: 'Piano',
};
const CHORD = /^(?:(?:C|C#|D|D#|E|F|F#|G|G#|A|A#|B)m?|N)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVALID = 'Choose a supported instrument and style, a tempo from 40 to 240 BPM, harmonic source stems, up to 500 contiguous chords covering the whole song, and up to 100 ordered, non-overlapping regions inside it.';

export const accompanimentFrames = duration => Math.round(duration * SAMPLE_RATE);
export const accompanimentBytes = duration => 44 + accompanimentFrames(duration) * 4;

export function accompanimentInput(value, duration) {
  const fail = () => { throw new Error(INVALID); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const { instrument, style, tempo, sources, chords, requestId, regions, seed } = value;
  if (!Object.hasOwn(INSTRUMENT_STYLES, instrument) || !INSTRUMENT_STYLES[instrument].includes(style)) fail();
  if (typeof tempo !== 'number' || !Number.isFinite(tempo) || tempo < 40 || tempo > 240) fail();
  if (!Array.isArray(sources) || sources.length < 1 || new Set(sources).size !== sources.length ||
      !sources.every(name => HARMONIC_SOURCES.includes(name))) fail();
  if (!Array.isArray(chords) || chords.length < 1 || chords.length > MAX_CHORDS) fail();
  let cursor = 0;
  const timeline = chords.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.start !== 'number' || typeof item.end !== 'number' ||
        !Number.isFinite(item.start) || !Number.isFinite(item.end) ||
        item.start !== cursor || item.end <= item.start ||
        typeof item.chord !== 'string' || !CHORD.test(item.chord)) fail();
    cursor = item.end;
    return { start: item.start, end: item.end, chord: item.chord };
  });
  if (cursor !== duration) fail();
  if (requestId !== undefined && (typeof requestId !== 'string' || !UUID.test(requestId))) fail();
  // Requests without regions are from before region selection and cover the whole song.
  let previous = 0;
  const selection = regions === undefined ? undefined : Array.isArray(regions) && regions.length >= 1 &&
    regions.length <= MAX_REGIONS ? regions.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.start !== 'number' || typeof item.end !== 'number' ||
          !Number.isFinite(item.start) || !Number.isFinite(item.end) ||
          item.start < previous || item.end <= item.start || item.end > duration) fail();
      previous = item.end;
      return { start: item.start, end: item.end };
    }) : fail();
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) fail();
  return { instrument, style, tempo, sources: [...sources], chords: timeline, requestId, regions: selection, seed };
}

// Canonical 44-byte PCM16 stereo 44.1 kHz header with exact chunk lengths.
export function validWavHeader(header, frames) {
  const dataBytes = frames * 4;
  return header.length === 44 &&
    header.toString('ascii', 0, 4) === 'RIFF' && header.readUInt32LE(4) === 36 + dataBytes &&
    header.toString('ascii', 8, 16) === 'WAVEfmt ' && header.readUInt32LE(16) === 16 &&
    header.readUInt16LE(20) === 1 && header.readUInt16LE(22) === 2 &&
    header.readUInt32LE(24) === SAMPLE_RATE && header.readUInt32LE(28) === SAMPLE_RATE * 4 &&
    header.readUInt16LE(32) === 4 && header.readUInt16LE(34) === 16 &&
    header.toString('ascii', 36, 40) === 'data' && header.readUInt32LE(40) === dataBytes;
}

const publicFields = child => ({
  id: child.jobId, parentJobId: child.parentJobId, status: child.status, title: child.title,
  instrument: child.instrument, style: child.style, tempo: child.tempo, sources: child.sources,
  chords: child.chords, regions: child.regions, bytes: child.bytes, sampleRate: child.sampleRate, frames: child.frames,
  createdAt: child.generatedAt,
});

export async function signedAccompaniment(child, signer, storage) {
  const params = { Bucket: process.env.BUCKET_NAME, Key: child.outputKey };
  const { parentJobId: _parent, status: _status, bytes: _bytes, sampleRate: _rate, frames: _frames, ...fields } =
    publicFields(child);
  return {
    ...fields,
    playUrl: await signer(storage, new GetObjectCommand(params), { expiresIn: 3600 }),
    downloadUrl: await signer(storage, new GetObjectCommand({
      ...params, ResponseContentDisposition: `attachment; filename="${child.instrument}-${child.style}-${child.jobId}.wav"`,
    }), { expiresIn: 3600 }),
  };
}

export async function listGeneratedStems(parent, { database, signer, storage }) {
  const children = [];
  let start;
  do {
    const page = await database.send(new QueryCommand({
      TableName: process.env.TABLE_NAME, ConsistentRead: true, ExclusiveStartKey: start,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'parentJobId = :parent AND #type = :type AND #status = :completed',
      ExpressionAttributeNames: { '#type': 'type', '#status': 'status' },
      ExpressionAttributeValues: {
        ':userId': parent.userId, ':parent': parent.jobId, ':type': 'accompaniment', ':completed': 'completed',
      },
    }));
    children.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  children.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.jobId.localeCompare(b.jobId));
  return Promise.all(children.map(child => signedAccompaniment(child, signer, storage)));
}

export function createAccompanimentRoutes({ database, storage, uploadSigner, signer }) {
  const table = () => process.env.TABLE_NAME;
  const read = async key => (await database.send(new GetCommand({
    TableName: table(), Key: key, ConsistentRead: true,
  }))).Item;
  const uploadPolicy = (child, now) => {
    const remaining = Math.floor((Date.parse(child.generatedAt) + UPLOAD_WINDOW_MS - now) / 1000);
    if (remaining < 1) return null;
    return uploadSigner(storage, {
      Bucket: process.env.BUCKET_NAME, Key: child.inputKey, Expires: Math.min(900, remaining),
      Fields: { 'Content-Type': 'audio/wav' },
      Conditions: [['content-length-range', child.bytes, child.bytes], ['eq', '$Content-Type', 'audio/wav']],
    });
  };

  async function create({ userId, parentJobId, body, reply }) {
    const parent = await read({ userId, jobId: parentJobId });
    if (!parent || parent.type !== 'stems') return reply(404, { message: 'Separation job not found.' });
    if (visibleJob(parent).status !== 'completed' ||
        !STEM_NAMES.every(name => typeof parent.stems?.[name]?.key === 'string') ||
        typeof parent.duration !== 'number' || !Number.isFinite(parent.duration) || parent.duration <= 0) {
      return reply(409, { message: 'Generate accompaniment after all six stems are ready.' });
    }
    let input;
    try {
      input = accompanimentInput(body(), parent.duration);
    } catch (error) {
      console.warn('Invalid accompaniment request', { name: error.name });
      return reply(400, { message: INVALID });
    }
    const now = Date.now();
    const id = input.requestId ?? randomUUID();
    const frames = accompanimentFrames(parent.duration);
    const child = {
      userId, jobId: id, type: 'accompaniment', parentJobId, status: 'uploading',
      title: `${LABELS[input.instrument]} ${input.style} (${input.tempo} BPM)`,
      instrument: input.instrument, style: input.style, tempo: input.tempo,
      sources: input.sources, chords: input.chords,
      ...(input.regions ? { regions: input.regions } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      bytes: accompanimentBytes(parent.duration), sampleRate: SAMPLE_RATE, frames,
      inputKey: `generated-inputs/${userId}/${id}/audio.wav`,
      outputKey: `users/${userId}/accompaniments/${parentJobId}/${id}.wav`,
      // No createdAt: keeps children out of the ByCreatedAt library index.
      generatedAt: new Date(now).toISOString(),
      expiresAt: Math.ceil((now + UPLOAD_WINDOW_MS + 600000) / 1000),
    };
    try {
      await database.send(new PutCommand({
        TableName: table(), Item: child, ConditionExpression: 'attribute_not_exists(jobId)',
      }));
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await read({ userId, jobId: id });
      const same = existing && existing.type === 'accompaniment' && existing.parentJobId === parentJobId &&
        ['instrument', 'style', 'tempo', 'sources', 'chords', 'regions', 'seed']
          .every(field => isDeepStrictEqual(existing[field], child[field]));
      if (!same) return reply(409, { message: 'This request id was already used for a different save.' });
      if (existing.status === 'completed') {
        return reply(200, { accompaniment: await signedAccompaniment(existing, signer, storage) });
      }
      const upload = await uploadPolicy(existing, Date.now());
      if (!upload) return reply(409, { message: 'This save expired. Generate and save again with a new request id.' });
      return reply(200, { accompaniment: publicFields(existing), upload });
    }
    const upload = await uploadPolicy(child, now);
    return reply(201, { accompaniment: publicFields(child), upload });
  }

  async function complete({ userId, parentJobId, id, reply }) {
    const child = await read({ userId, jobId: id });
    if (!child || child.type !== 'accompaniment' || child.parentJobId !== parentJobId) {
      return reply(404, { message: 'Generated accompaniment not found.' });
    }
    if (child.status === 'completed') {
      return reply(200, { accompaniment: await signedAccompaniment(child, signer, storage) });
    }
    if (child.status !== 'uploading' || Date.now() >= child.expiresAt * 1000) {
      return reply(409, { message: 'This save expired. Generate and save again.' });
    }
    const Bucket = process.env.BUCKET_NAME;
    const notFound = error => error.$metadata?.httpStatusCode === 404 || error.name === 'NotFound';
    let object;
    try {
      object = await storage.send(new HeadObjectCommand({ Bucket, Key: child.inputKey }));
    } catch (error) {
      if (!notFound(error)) throw error;
      return reply(409, { message: 'Upload is not complete. Finish uploading before saving.' });
    }
    if (object.ContentLength !== child.bytes || object.ContentType !== 'audio/wav' || !object.ETag) {
      console.warn('Accompaniment upload size or type mismatch', { jobId: id });
      return reply(400, { message: 'Uploaded WAV size does not match this song. Upload again.' });
    }
    let ranged;
    try {
      ranged = await storage.send(new GetObjectCommand({
        Bucket, Key: child.inputKey, Range: 'bytes=0-43', IfMatch: object.ETag,
      }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 412 && !notFound(error)) throw error;
      console.warn('Accompaniment upload changed during validation', { jobId: id });
      return reply(409, { message: 'Upload changed while saving. Retry the save.' });
    }
    const header = Buffer.from(await ranged.Body.transformToByteArray());
    if (!validWavHeader(header, child.frames)) {
      console.warn('Accompaniment upload header invalid', { jobId: id });
      return reply(400, { message: 'Upload a 16-bit stereo 44.1 kHz PCM WAV matching the song length.' });
    }
    try {
      // Copies only the validated version and never replaces an already-finalized file.
      await storage.send(new CopyObjectCommand({
        Bucket, Key: child.outputKey, CopySource: `${Bucket}/${child.inputKey}`,
        CopySourceIfMatch: object.ETag, IfNoneMatch: '*',
        ContentType: 'audio/wav', MetadataDirective: 'REPLACE',
      }));
    } catch (error) {
      if (![409, 412].includes(error.$metadata?.httpStatusCode)) throw error;
      let saved;
      try {
        saved = await storage.send(new HeadObjectCommand({ Bucket, Key: child.outputKey }));
      } catch (headError) {
        if (!notFound(headError)) throw headError;
        console.warn('Accompaniment upload changed during save', { jobId: id });
        return reply(409, { message: 'Upload changed while saving. Retry the save.' });
      }
      // A concurrent completion already copied a validated version.
      if (saved.ContentLength !== child.bytes) throw new Error('Finalized accompaniment has an unexpected size.');
    }
    const completedAt = new Date().toISOString();
    try {
      await database.send(new UpdateCommand({
        TableName: table(), Key: { userId, jobId: id },
        UpdateExpression: 'SET #status = :completed, completedAt = :at REMOVE expiresAt',
        ConditionExpression: '#status = :uploading AND parentJobId = :parent AND #type = :type',
        ExpressionAttributeNames: { '#status': 'status', '#type': 'type' },
        ExpressionAttributeValues: {
          ':completed': 'completed', ':uploading': 'uploading', ':at': completedAt,
          ':parent': parentJobId, ':type': 'accompaniment',
        },
      }));
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      const current = await read({ userId, jobId: id });
      if (current?.status !== 'completed') throw new Error('Accompaniment changed state during completion.');
      return reply(200, { accompaniment: await signedAccompaniment(current, signer, storage) });
    }
    return reply(200, {
      accompaniment: await signedAccompaniment({ ...child, status: 'completed', completedAt }, signer, storage),
    });
  }

  // Removes only this generated stem's own objects and record; the parent job and
  // its stems are never read for keys. Storage goes first so a partial failure
  // leaves a visible stem whose delete can be repeated.
  async function remove({ userId, parentJobId, id, reply }) {
    const child = await read({ userId, jobId: id });
    if (!child) return reply(200, { deleted: true });
    if (child.type !== 'accompaniment' || child.parentJobId !== parentJobId) {
      return reply(404, { message: 'Generated accompaniment not found.' });
    }
    if (child.status !== 'completed') return reply(409, { message: 'This stem is still saving. Try again shortly.' });
    if (!child.outputKey?.startsWith(`users/${userId}/accompaniments/${parentJobId}/`) ||
        !child.inputKey?.startsWith(`generated-inputs/${userId}/${id}/`)) {
      throw new Error('Generated accompaniment has unexpected storage keys.');
    }
    const Bucket = process.env.BUCKET_NAME;
    for (const Key of [child.outputKey, child.inputKey]) {
      await storage.send(new DeleteObjectCommand({ Bucket, Key }));
    }
    try {
      await database.send(new DeleteCommand({
        TableName: table(), Key: { userId, jobId: id },
        ConditionExpression: '#type = :type AND parentJobId = :parent',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':type': 'accompaniment', ':parent': parentJobId },
      }));
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      if (await read({ userId, jobId: id })) throw error;
    }
    return reply(200, { deleted: true });
  }

  return { create, complete, remove };
}
