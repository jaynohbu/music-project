import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { failedHistoryExpired, failureRetention, visibleJob } from './shared.mjs';
import { STEM_NAMES, STEM_WINDOW_MS } from './stem-shared.mjs';

export const DEFAULT_STRENGTH = 0.45;
export const MAX_RESTORATIONS = 20;
const INVALID = 'Choose one stem to clean, at least one other stem as a reference, and a strength from 0 to 1.';

export function restorationInput(value) {
  const fail = () => { throw new Error(INVALID); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const { stem, references, strength = DEFAULT_STRENGTH } = value;
  if (!STEM_NAMES.includes(stem) || !Array.isArray(references) || !references.length ||
      new Set(references).size !== references.length ||
      !references.every(name => STEM_NAMES.includes(name) && name !== stem) ||
      typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1) fail();
  return { stem, references: STEM_NAMES.filter(name => references.includes(name)), strength };
}

export async function listRestorations(parent, { database, signer, storage }) {
  const items = [];
  let start;
  do {
    const page = await database.send(new QueryCommand({
      TableName: process.env.TABLE_NAME, ConsistentRead: true, ExclusiveStartKey: start,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'parentJobId = :parent AND #type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':userId': parent.userId, ':parent': parent.jobId, ':type': 'restoration' },
    }));
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  const now = Date.now();
  const visible = items.map(item => visibleJob(item, now)).filter(item => !failedHistoryExpired(item, now));
  visible.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.jobId.localeCompare(b.jobId));
  return Promise.all(visible.map(item => publicRestoration(item, signer, storage)));
}

async function publicRestoration(item, signer, storage) {
  const fields = {
    id: item.jobId, title: item.title, stem: item.stem, references: item.references, strength: item.strength,
    status: item.status, createdAt: item.generatedAt, ...(item.error ? { error: item.error } : {}),
  };
  if (item.status !== 'completed') return fields;
  const params = { Bucket: process.env.BUCKET_NAME, Key: item.key };
  return {
    ...fields,
    playUrl: await signer(storage, new GetObjectCommand(params), { expiresIn: 3600 }),
    downloadUrl: await signer(storage, new GetObjectCommand({
      ...params, ResponseContentDisposition: `attachment; filename="${item.stem}-cleaned-${item.jobId}.wav"`,
    }), { expiresIn: 3600 }),
  };
}

export function createRestorationRoutes({ database, storage, orchestrator, signer }) {
  const table = () => process.env.TABLE_NAME;

  async function create({ userId, parentJobId, body, reply }) {
    const parent = (await database.send(new GetCommand({
      TableName: table(), Key: { userId, jobId: parentJobId }, ConsistentRead: true,
    }))).Item;
    if (!parent || parent.type !== 'stems') return reply(404, { message: 'Separation job not found.' });
    if (visibleJob(parent).status !== 'completed' ||
        !STEM_NAMES.every(name => typeof parent.stems?.[name]?.key === 'string')) {
      return reply(409, { message: 'Clean up a stem after all six stems are ready.' });
    }
    let input;
    try {
      input = restorationInput(body());
    } catch (error) {
      console.warn('Invalid restoration request', { name: error.name });
      return reply(400, { message: INVALID });
    }
    const existing = await listRestorations(parent, { database, signer, storage });
    const same = existing.find(item => item.status !== 'failed' && item.stem === input.stem &&
      item.strength === input.strength && item.references.join() === input.references.join());
    if (same) return reply(200, { restoration: same });
    if (existing.length >= MAX_RESTORATIONS) {
      return reply(409, { message: `Delete a cleaned stem first. A song can have up to ${MAX_RESTORATIONS}.` });
    }
    const now = Date.now();
    const id = randomUUID();
    const child = {
      userId, jobId: id, type: 'restoration', parentJobId, status: 'queued',
      title: `${input.stem} cleaned using ${input.references.join(', ')} (${Math.round(input.strength * 100)}%)`,
      stem: input.stem, references: input.references, strength: input.strength,
      key: `users/${userId}/restored/${parentJobId}/${id}.wav`,
      // No createdAt: keeps cleaned stems out of the ByCreatedAt library index.
      generatedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(),
      expiresAt: Math.ceil((now + STEM_WINDOW_MS + 600000) / 1000),
    };
    await database.send(new PutCommand({
      TableName: table(), Item: child, ConditionExpression: 'attribute_not_exists(jobId)',
    }));
    try {
      await orchestrator.send(new StartExecutionCommand({
        stateMachineArn: process.env.STEM_STATE_MACHINE, name: id,
        input: JSON.stringify({ userId, jobId: id, kind: 'restoration' }),
      }));
    } catch (error) {
      console.error('Unable to start restoration', { jobId: id, name: error.name });
      const retention = failureRetention();
      await database.send(new UpdateCommand({
        TableName: table(), Key: { userId, jobId: id },
        UpdateExpression: 'SET #status = :failed, #error = :error, failedAt = :at, expiresAt = :expiry',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: {
          ':failed': 'failed', ':error': 'Unable to start stem cleanup. Please try again.',
          ':at': retention.failedAt, ':expiry': retention.expiresAt,
        },
      }));
      return reply(503, { message: 'Unable to start stem cleanup. Please try again.' });
    }
    return reply(202, { restoration: await publicRestoration(child, signer, storage) });
  }

  // Removes only this cleaned stem's own object and record. Original stems are never touched.
  async function remove({ userId, parentJobId, id, reply }) {
    const child = (await database.send(new GetCommand({
      TableName: table(), Key: { userId, jobId: id }, ConsistentRead: true,
    }))).Item;
    if (!child) return reply(200, { deleted: true });
    if (child.type !== 'restoration' || child.parentJobId !== parentJobId) {
      return reply(404, { message: 'Cleaned stem not found.' });
    }
    const status = visibleJob(child).status;
    if (status !== 'completed' && status !== 'failed') {
      return reply(409, { message: 'This stem is still being cleaned. Try again when it finishes.' });
    }
    if (!child.key?.startsWith(`users/${userId}/restored/${parentJobId}/`)) {
      throw new Error('Cleaned stem has an unexpected storage key.');
    }
    await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: child.key }));
    try {
      await database.send(new DeleteCommand({
        TableName: table(), Key: { userId, jobId: id },
        ConditionExpression: '#type = :type AND parentJobId = :parent',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':type': 'restoration', ':parent': parentJobId },
      }));
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
    return reply(200, { deleted: true });
  }

  return { create, remove };
}
