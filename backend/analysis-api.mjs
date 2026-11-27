import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { failedHistoryExpired, failureRetention, visibleJob } from './shared.mjs';
import { childRecords } from './restoration-api.mjs';
import { checkLyrics } from './stem-analysis.mjs';
import { STEM_WINDOW_MS } from './stem-shared.mjs';

export const ANALYSES = {
  lyrics: { label: 'Lyrics', folder: 'lyrics', notReady: 'Find lyrics after the stems are ready.', noStart: 'Unable to start lyrics recognition. Please try again.' },
  // Bump version when the result format changes: older results are ignored, so they get redone.
  harmony: { version: 16, label: 'Chords', folder: 'harmony', notReady: 'Find chords after the stems are ready.', noStart: 'Unable to start chord analysis. Please try again.' },
};

const RUNNING = ['queued', 'processing'];
const LARGEST_SCORE_HARMONY = 4 * 1024 * 1024;
const finite = value => typeof value === 'number' && Number.isFinite(value);

// What the page sends as the Harmonic score from an uploaded score: the song's harmony result in its usual form
// (beats, firstBar, the ensemble part and the other parts), and a short account of the score it came from.
export function checkScoreHarmony(document) {
  const invalid = message => { throw new Error(message ?? 'This score result could not be saved.'); };
  if (!document || typeof document !== 'object') invalid();
  if (Buffer.byteLength(JSON.stringify(document)) > LARGEST_SCORE_HARMONY) invalid('This score result is too large to save.');
  const { beats, firstBar, ensemble, stems, fromScore } = document;
  if (!Array.isArray(beats) || beats.length < 2 || !beats.every(finite) || beats.some((beat, index) => index && beat <= beats[index - 1])) invalid();
  if (!Number.isInteger(firstBar) || firstBar < 0 || firstBar >= beats.length) invalid();
  const notes = list => Array.isArray(list) && list.every(note => note && finite(note.start) && finite(note.end) && note.end >= note.start
    && Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 && Number.isInteger(note.unit) && Number.isInteger(note.length));
  if (!ensemble || !notes(ensemble.notes) || !Array.isArray(ensemble.chords)) invalid();
  if (stems && (typeof stems !== 'object' || Object.values(stems).some(part => part && (!notes(part.notes ?? []) || (part.hits && !Array.isArray(part.hits)))))) invalid();
  if (!fromScore || typeof fromScore.title !== 'string' || !Number.isInteger(fromScore.measures) || !Number.isInteger(fromScore.notes)) invalid();
  return document;
}
const INVALID_LYRICS = 'These lyrics could not be saved. Check that each line has words, then try again.';
const MOST_LYRIC_WORDS = 20000;
const LONGEST_LYRIC_WORD = 200;

// Playback finds the current word by searching start times, so they must never go backward.
function checkEditedLyrics(lines, duration) {
  checkLyrics({ lines }, duration);
  const words = lines.flatMap(line => line.words);
  if (words.length > MOST_LYRIC_WORDS || !words.every((word, index) =>
    word.text.trim() && word.text.length <= LONGEST_LYRIC_WORD && (!index || word.start >= words[index - 1].start))) {
    throw new Error(INVALID_LYRICS);
  }
}

// Each part can be redone on its own on the song's grid; other (Harmonic) hears the bass for its slash chords.
const REGENERATED_STEMS = ['other', 'bass', 'drums'];
const NOT_REGENERABLE = 'Choose Harmonic, bass or drums to regenerate.';

// Every version's records by default; `current` keeps the analysis's present version only.
async function visibleRecords(type, parent, database, current = true) {
  const now = Date.now();
  return (await childRecords(parent, type, database))
    .filter(item => !current || item.version === ANALYSES[type].version)
    .map(item => visibleJob(item, now)).filter(item => !failedHistoryExpired(item, now))
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

// The newest record that has not failed, else the newest failure.
const newestWorking = records => records.find(record => record.status !== 'failed') ?? records[0];

// A regenerated part replaces that part of the song's result, so parts never overwrite each other's work.
async function regeneratedParts(records, signer, storage) {
  const parts = {};
  for (const stem of new Set(records.map(record => record.stem).filter(Boolean))) {
    const own = records.filter(record => record.stem === stem);
    const done = own.find(record => record.status === 'completed');
    parts[stem] = {
      ...(await publicAnalysis({ ...own[0], status: done ? 'completed' : own[0].status, key: done?.key }, signer, storage)),
      status: own[0].status,
      ...(done ? { resultId: done.jobId } : {}),
    };
  }
  return Object.keys(parts).length ? { stems: parts } : {};
}

// A song has one result of each type, plus any regenerated parts. Until a run of the present version has
// finished, the last finished result of any version is still shown: as `previous` while one runs, or, when
// none has run yet, as the result itself marked `stale` (older apps show it; newer ones start a new run).
export async function currentAnalysis(type, parent, { database, signer, storage }) {
  let records = await visibleRecords(type, parent, database);
  const item = newestWorking(records.filter(record => !record.stem));
  // A result from an uploaded score is on its own beats: parts regenerated before it do not belong to it.
  if (item?.fromScore) records = records.filter(record => !record.stem || record.generatedAt > item.generatedAt);
  const finished = item?.status === 'completed' ? undefined : (await visibleRecords(type, parent, database, false))
    .find(record => !record.stem && record.status === 'completed' && record.key);
  if (!item) return finished && { ...(await publicAnalysis(finished, signer, storage)), stale: true };
  return {
    ...(await publicAnalysis(item, signer, storage)), ...(await regeneratedParts(records, signer, storage)),
    ...(finished ? { previous: await publicAnalysis(finished, signer, storage) } : {}),
  };
}

async function publicAnalysis(item, signer, storage) {
  const fields = {
    id: item.jobId, status: item.status, ...(item.error ? { error: item.error } : {}),
    ...(item.fromScore ? { fromScore: item.fromScore } : {}),
  };
  if (item.status !== 'completed') return fields;
  return {
    ...fields,
    url: await signer(storage, new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: item.key }), { expiresIn: 3600 }),
  };
}

export function createAnalysisRoutes({ database, storage, orchestrator, signer }) {
  const table = () => process.env.TABLE_NAME;

  // An edit is a new finished result, which becomes the song's current one; earlier versions stay stored.
  async function saveEdit({ userId, parent, lines, reply }) {
    const records = await visibleRecords('lyrics', parent, database);
    if (newestWorking(records)?.status !== 'completed') return reply(409, { message: 'Find lyrics before editing them.' });
    try {
      checkEditedLyrics(lines, parent.duration);
    } catch {
      return reply(400, { message: INVALID_LYRICS });
    }
    const id = randomUUID();
    const key = `users/${userId}/${ANALYSES.lyrics.folder}/${parent.jobId}/${id}.json`;
    const body = Buffer.from(JSON.stringify({ lines }));
    await storage.send(new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME, Key: key, ContentType: 'application/json',
      Body: Readable.from([body]), ContentLength: body.length,
    }));
    const now = new Date().toISOString();
    const child = {
      userId, jobId: id, type: 'lyrics', parentJobId: parent.jobId, status: 'completed', edited: true,
      title: ANALYSES.lyrics.label, key, generatedAt: now, startedAt: now, completedAt: now,
    };
    await database.send(new PutCommand({
      TableName: table(), Item: child, ConditionExpression: 'attribute_not_exists(jobId)',
    }));
    return reply(201, { lyrics: await publicAnalysis(child, signer, storage) });
  }

  // A finished result as the song's current one: a new record, earlier ones stay stored.
  async function saveHarmony({ userId, parent, key, fromScore }) {
    // Always after the newest result, so it is the current one even when saved in the same millisecond.
    const newest = (await visibleRecords('harmony', parent, database, false))[0]?.generatedAt;
    const now = new Date(Math.max(Date.now(), newest ? Date.parse(newest) + 1 : 0)).toISOString();
    const child = {
      userId, jobId: key.id, type: 'harmony', parentJobId: parent.jobId, status: 'completed', version: ANALYSES.harmony.version,
      title: ANALYSES.harmony.label, key: key.path, generatedAt: now, startedAt: now, completedAt: now,
      ...(fromScore ? { fromScore } : {}),
    };
    await database.send(new PutCommand({ TableName: table(), Item: child, ConditionExpression: 'attribute_not_exists(jobId)' }));
    return child;
  }

  // The Harmonic score from an uploaded score aligned with the stems (built by the page): saved as the song's
  // harmony result, so the mixer, accompaniment and exports use it.
  async function saveScoreHarmony({ userId, parent, input, reply }) {
    let document;
    try {
      document = checkScoreHarmony(input.fromScore);
    } catch (error) {
      return reply(400, { message: error.message });
    }
    const id = randomUUID();
    const key = `users/${userId}/${ANALYSES.harmony.folder}/${parent.jobId}/${id}.json`;
    const body = Buffer.from(JSON.stringify(document));
    await storage.send(new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME, Key: key, ContentType: 'application/json',
      Body: Readable.from([body]), ContentLength: body.length,
    }));
    const child = await saveHarmony({ userId, parent, key: { id, path: key }, fromScore: document.fromScore });
    return reply(201, { harmony: await publicAnalysis(child, signer, storage) });
  }

  // Back to the analysis: its last finished result made current again.
  async function useAnalysisAgain({ userId, parent, reply }) {
    const analysed = (await visibleRecords('harmony', parent, database))
      .find(record => !record.stem && record.status === 'completed' && !record.fromScore && record.key);
    if (!analysed) return reply(409, { message: 'This song has no chord analysis to go back to.' });
    const child = await saveHarmony({ userId, parent, key: { id: randomUUID(), path: analysed.key } });
    return reply(201, { harmony: await publicAnalysis(child, signer, storage) });
  }

  async function create({ type, userId, parentJobId, reply, body }) {
    const analysis = ANALYSES[type];
    const parent = (await database.send(new GetCommand({
      TableName: table(), Key: { userId, jobId: parentJobId }, ConsistentRead: true,
    }))).Item;
    if (!parent || parent.type !== 'stems') return reply(404, { message: 'Separation job not found.' });
    if (visibleJob(parent).status !== 'completed' || typeof parent.stems?.vocals?.key !== 'string') {
      return reply(409, { message: analysis.notReady });
    }
    let input;
    try {
      input = body() ?? {};
    } catch {
      return reply(400, { message: type === 'harmony' ? NOT_REGENERABLE : INVALID_LYRICS });
    }
    if (type === 'lyrics' && input.lines !== undefined) return saveEdit({ userId, parent, lines: input.lines, reply });
    if (type === 'harmony' && input.fromScore !== undefined) return saveScoreHarmony({ userId, parent, input, reply });
    if (type === 'harmony' && input.useAnalysis === true) return useAnalysisAgain({ userId, parent, reply });
    const { stem, cleaned } = type === 'harmony' ? input : {};
    if (stem !== undefined && !REGENERATED_STEMS.includes(stem)) return reply(400, { message: NOT_REGENERABLE });
    const records = await visibleRecords(type, parent, database);
    const whole = newestWorking(records.filter(record => !record.stem));
    const sources = {};
    if (stem) {
      if (whole?.status !== 'completed') return reply(409, { message: 'Find chords for this song before regenerating a stem.' });
      if (stem === 'other' && whole.fromScore) {
        return reply(409, { message: 'The Harmonic score comes from the uploaded score. Go back to the analysis to regenerate it.' });
      }
      const working = records.find(record => record.stem === stem);
      if (working && RUNNING.includes(working.status)) {
        return reply(200, { [type]: (await regeneratedParts(records, signer, storage)).stems[stem] });
      }
      sources.baseKey = whole.key;
      if (cleaned === true) {
        const restored = (await childRecords(parent, 'restoration', database))
          .filter(item => item.stem === stem && item.status === 'completed')
          .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
        if (!restored) return reply(409, { message: 'This stem has no cleaned version yet.' });
        sources.sourceKey = restored.key;
      }
      // Usage limit: each stem is regenerated once from each source; a failed run can be retried.
      if (records.some(record => record.stem === stem && record.status === 'completed' &&
          (record.sourceKey ?? null) === (sources.sourceKey ?? null))) {
        return reply(200, { [type]: (await regeneratedParts(records, signer, storage)).stems[stem] });
      }
    } else if (whole && whole.status !== 'failed') {
      // Present-version runs only: a stale result is redone.
      return reply(200, { [type]: await currentAnalysis(type, parent, { database, signer, storage }) });
    }
    const now = Date.now();
    const id = randomUUID();
    const child = {
      userId, jobId: id, type, parentJobId, status: 'queued', ...(analysis.version ? { version: analysis.version } : {}),
      ...(stem ? { stem } : {}), ...sources,
      title: analysis.label, key: `users/${userId}/${analysis.folder}/${parentJobId}/${id}.json`,
      // No createdAt: keeps analyses out of the ByCreatedAt library index.
      generatedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(),
      expiresAt: Math.ceil((now + STEM_WINDOW_MS + 600000) / 1000),
    };
    await database.send(new PutCommand({
      TableName: table(), Item: child, ConditionExpression: 'attribute_not_exists(jobId)',
    }));
    try {
      await orchestrator.send(new StartExecutionCommand({
        stateMachineArn: process.env.STEM_STATE_MACHINE, name: id,
        input: JSON.stringify({ userId, jobId: id, kind: type }),
      }));
    } catch (error) {
      console.error('Unable to start analysis', { jobId: id, type, name: error.name });
      const retention = failureRetention();
      await database.send(new UpdateCommand({
        TableName: table(), Key: { userId, jobId: id },
        UpdateExpression: 'SET #status = :failed, #error = :error, failedAt = :at, expiresAt = :expiry',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: {
          ':failed': 'failed', ':error': analysis.noStart,
          ':at': retention.failedAt, ':expiry': retention.expiresAt,
        },
      }));
      return reply(503, { message: analysis.noStart });
    }
    return reply(202, { [type]: await publicAnalysis(child, signer, storage) });
  }

  return { create };
}
