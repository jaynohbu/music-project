import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { failedHistoryExpired, failureRetention, visibleJob } from './shared.mjs';
import { childRecords } from './restoration-api.mjs';
import { STEM_WINDOW_MS } from './stem-shared.mjs';

export const ANALYSES = {
  lyrics: { label: 'Lyrics', folder: 'lyrics', notReady: 'Find lyrics after the stems are ready.', noStart: 'Unable to start lyrics recognition. Please try again.' },
  // Bump version when the result format changes: older results are ignored, so they get redone.
  harmony: { version: 3, label: 'Chords', folder: 'harmony', notReady: 'Find chords after the stems are ready.', noStart: 'Unable to start chord analysis. Please try again.' },
};

const RUNNING = ['queued', 'processing'];
const REGENERATED_STEMS = ['guitar', 'piano', 'other', 'bass'];
const NOT_REGENERABLE = 'Choose guitar, piano, other or bass to regenerate.';

async function visibleRecords(type, parent, database) {
  const now = Date.now();
  return (await childRecords(parent, type, database))
    .filter(item => item.version === ANALYSES[type].version)
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

// A song has one result of each type, plus any regenerated parts.
export async function currentAnalysis(type, parent, { database, signer, storage }) {
  const records = await visibleRecords(type, parent, database);
  const item = newestWorking(records.filter(record => !record.stem));
  if (!item) return undefined;
  return { ...(await publicAnalysis(item, signer, storage)), ...(await regeneratedParts(records, signer, storage)) };
}

async function publicAnalysis(item, signer, storage) {
  const fields = { id: item.jobId, status: item.status, ...(item.error ? { error: item.error } : {}) };
  if (item.status !== 'completed') return fields;
  return {
    ...fields,
    url: await signer(storage, new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: item.key }), { expiresIn: 3600 }),
  };
}

export function createAnalysisRoutes({ database, storage, orchestrator, signer }) {
  const table = () => process.env.TABLE_NAME;

  async function create({ type, userId, parentJobId, reply, body }) {
    const analysis = ANALYSES[type];
    const parent = (await database.send(new GetCommand({
      TableName: table(), Key: { userId, jobId: parentJobId }, ConsistentRead: true,
    }))).Item;
    if (!parent || parent.type !== 'stems') return reply(404, { message: 'Separation job not found.' });
    if (visibleJob(parent).status !== 'completed' || typeof parent.stems?.vocals?.key !== 'string') {
      return reply(409, { message: analysis.notReady });
    }
    let input = {};
    if (type === 'harmony') {
      try {
        input = body() ?? {};
      } catch {
        return reply(400, { message: NOT_REGENERABLE });
      }
    }
    const { stem, cleaned } = input;
    if (stem !== undefined && !REGENERATED_STEMS.includes(stem)) return reply(400, { message: NOT_REGENERABLE });
    const records = await visibleRecords(type, parent, database);
    const whole = newestWorking(records.filter(record => !record.stem));
    const sources = {};
    if (stem) {
      if (whole?.status !== 'completed') return reply(409, { message: 'Find chords for this song before regenerating a stem.' });
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
    } else if (whole && whole.status !== 'failed') {
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
