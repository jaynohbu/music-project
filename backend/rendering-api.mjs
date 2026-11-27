// The song's score parts made as stems (stem-render.mjs), for its current harmony result:
//   POST /api/stems/jobs/{id}/renderings {family, sound} -> {rendering}: that part in that sound, made on the server
//        (the same one again when it is made or being made)
// and listed with the song as renderings: [{id, harmonyId, family, sound, status, auto?, error?, playUrl?}].
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { failedHistoryExpired, failureRetention, visibleJob } from './shared.mjs';
import { childRecords } from './restoration-api.mjs';
import { currentAnalysis } from './analysis-api.mjs';
import { SCORE_FAMILIES, FAMILY_STEM } from './score-render.mjs';
import { renderingRecord } from './stem-render.mjs';

// Renderings kept for a song; the oldest finished ones of other results go first when there are more.
export const MAX_RENDERINGS = 40;
const INVALID = 'Choose guitar, keys, bass or drums and one of its sounds.';
const NO_START = 'Unable to start making this sound. Please try again.';

export async function listRenderings(parent, { database, signer, storage }) {
  const now = Date.now();
  const items = (await childRecords(parent, 'rendering', database)).map(item => visibleJob(item, now)).filter(item => !failedHistoryExpired(item, now));
  items.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.jobId.localeCompare(b.jobId));
  return Promise.all(items.map(item => publicRendering(item, signer, storage)));
}

async function publicRendering(item, signer, storage) {
  const fields = {
    id: item.jobId, harmonyId: item.harmonyId, family: item.family, sound: item.sound, status: item.status,
    ...(item.auto ? { auto: true } : {}), ...(item.error ? { error: item.error } : {}),
  };
  if (item.status !== 'completed') return fields;
  return { ...fields, playUrl: await signer(storage, new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: item.key }), { expiresIn: 3600 }) };
}

export function createRenderingRoutes({ database, storage, orchestrator, signer }) {
  const table = () => process.env.TABLE_NAME;

  // Removes finished renderings of older results beyond MAX_RENDERINGS, oldest first.
  async function prune(parent, items, harmonyId) {
    const old = items.filter(item => item.harmonyId !== harmonyId && ['completed', 'failed'].includes(visibleJob(item).status));
    for (const item of old.slice(0, Math.max(0, items.length + 1 - MAX_RENDERINGS))) {
      if (!item.key?.startsWith(`users/${parent.userId}/harmony/${parent.jobId}/rendered/`)) continue;
      await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: item.key }));
      await database.send(new DeleteCommand({
        TableName: table(), Key: { userId: item.userId, jobId: item.jobId },
        ConditionExpression: '#type = :type', ExpressionAttributeNames: { '#type': 'type' }, ExpressionAttributeValues: { ':type': 'rendering' },
      })).catch(error => { if (error.name !== 'ConditionalCheckFailedException') throw error; });
    }
  }

  async function create({ userId, parentJobId, body, reply }) {
    const parent = (await database.send(new GetCommand({ TableName: table(), Key: { userId, jobId: parentJobId }, ConsistentRead: true }))).Item;
    if (!parent || parent.type !== 'stems') return reply(404, { message: 'Separation job not found.' });
    let input;
    try {
      input = body() ?? {};
    } catch {
      return reply(400, { message: INVALID });
    }
    const { family, sound } = input;
    if (!SCORE_FAMILIES.includes(family) || !Number.isInteger(sound) || sound < 0 || sound > 9999) return reply(400, { message: INVALID });
    const harmony = await currentAnalysis('harmony', parent, { database, signer, storage });
    const laid = harmony?.fromScore;
    if (harmony?.status !== 'completed' || !(laid?.parts ? laid.parts[FAMILY_STEM[family]] : FAMILY_STEM[family] === 'other' && laid)) {
      return reply(409, { message: 'This part plays once its score is laid on the song.' });
    }
    const items = await childRecords(parent, 'rendering', database);
    const same = items.find(item => item.harmonyId === harmony.id && item.family === family && item.sound === sound && visibleJob(item).status !== 'failed');
    if (same) return reply(200, { rendering: await publicRendering(visibleJob(same), signer, storage) });
    await prune(parent, items, harmony.id);
    const child = renderingRecord({ userId, parentJobId, harmonyId: harmony.id, family, sound });
    await database.send(new PutCommand({ TableName: table(), Item: child, ConditionExpression: 'attribute_not_exists(jobId)' }));
    try {
      await orchestrator.send(new StartExecutionCommand({
        stateMachineArn: process.env.STEM_STATE_MACHINE, name: child.jobId,
        input: JSON.stringify({ userId, jobId: child.jobId, kind: 'rendering' }),
      }));
    } catch (error) {
      console.error('Unable to start rendering', { jobId: child.jobId, name: error.name });
      const retention = failureRetention();
      await database.send(new UpdateCommand({
        TableName: table(), Key: { userId, jobId: child.jobId },
        UpdateExpression: 'SET #status = :failed, #error = :error, failedAt = :at, expiresAt = :expiry',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: { ':failed': 'failed', ':error': NO_START, ':at': retention.failedAt, ':expiry': retention.expiresAt },
      }));
      return reply(503, { message: NO_START });
    }
    return reply(202, { rendering: await publicRendering(child, signer, storage) });
  }

  return { create };
}
