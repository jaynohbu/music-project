import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { failedHistoryExpired, failureRetention, visibleJob } from './shared.mjs';
import { childRecords } from './restoration-api.mjs';
import { STEM_WINDOW_MS } from './stem-shared.mjs';

export const ANALYSES = {
  lyrics: { label: 'Lyrics', folder: 'lyrics', notReady: 'Find lyrics after the stems are ready.', noStart: 'Unable to start lyrics recognition. Please try again.' },
  harmony: { label: 'Chords', folder: 'harmony', notReady: 'Find chords after the stems are ready.', noStart: 'Unable to start chord analysis. Please try again.' },
};

// A song has one result of each type: the newest record that has not failed, else the newest failure.
export async function currentAnalysis(type, parent, { database, signer, storage }) {
  const now = Date.now();
  const visible = (await childRecords(parent, type, database))
    .map(item => visibleJob(item, now)).filter(item => !failedHistoryExpired(item, now))
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  const item = visible.find(record => record.status !== 'failed') ?? visible[0];
  return item ? publicAnalysis(item, signer, storage) : undefined;
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

  async function create({ type, userId, parentJobId, reply }) {
    const analysis = ANALYSES[type];
    const parent = (await database.send(new GetCommand({
      TableName: table(), Key: { userId, jobId: parentJobId }, ConsistentRead: true,
    }))).Item;
    if (!parent || parent.type !== 'stems') return reply(404, { message: 'Separation job not found.' });
    if (visibleJob(parent).status !== 'completed' || typeof parent.stems?.vocals?.key !== 'string') {
      return reply(409, { message: analysis.notReady });
    }
    const existing = await currentAnalysis(type, parent, { database, signer, storage });
    if (existing && existing.status !== 'failed') return reply(200, { [type]: existing });
    const now = Date.now();
    const id = randomUUID();
    const child = {
      userId, jobId: id, type, parentJobId, status: 'queued',
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
