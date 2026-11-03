import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PLAY_VERSION, playbackEncoder, savePlayCopies } from './stem-playback.mjs';
import { STEM_NAMES } from './stem-shared.mjs';

// One-off: adds AAC playback copies to songs and cleaned stems finished before the workers made them.
// Lists what it would convert unless run with --apply. Needs TABLE_NAME, BUCKET_NAME and ffmpeg.
// Records that change meanwhile (deleted, being deleted, already converted) are left alone.
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const storage = new S3Client({});
const encode = playbackEncoder(process.env.LOCAL_FFMPEG_PATH ?? 'ffmpeg');
const apply = process.argv.includes('--apply');
if (!process.env.TABLE_NAME || !process.env.BUCKET_NAME) throw new Error('TABLE_NAME and BUCKET_NAME are required.');

const pending = [];
let cursor;
do {
  const page = await database.send(new ScanCommand({
    TableName: process.env.TABLE_NAME, ExclusiveStartKey: cursor,
    FilterExpression: '#status = :completed AND #type IN (:stems, :restoration) AND ' +
      'attribute_not_exists(playVersion) AND attribute_not_exists(deleting)',
    ExpressionAttributeNames: { '#status': 'status', '#type': 'type' },
    ExpressionAttributeValues: { ':completed': 'completed', ':stems': 'stems', ':restoration': 'restoration' },
  }));
  pending.push(...(page.Items ?? []));
  cursor = page.LastEvaluatedKey;
} while (cursor);

console.log(`${pending.length} records without playback copies${apply ? '' : ' (dry run; pass --apply to convert)'}`);
let converted = 0, failed = 0;
for (const item of pending) {
  const keys = item.type === 'stems' ? STEM_NAMES.map(name => item.stems[name].key) : [item.key];
  console.log(`${item.type} ${item.jobId}: ${keys.length} file(s)`);
  if (!apply) continue;
  const directory = await mkdtemp(path.join(tmpdir(), 'convert-'));
  try {
    const files = [];
    for (const [index, key] of keys.entries()) {
      const file = path.join(directory, `${index}.wav`);
      const object = await storage.send(new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
      await pipeline(object.Body, createWriteStream(file));
      files.push({ file, key });
    }
    const copies = await savePlayCopies({ storage, encode, files, jobId: item.jobId });
    if (!copies) throw new Error('Encoding or upload failed.');
    const fields = item.type === 'stems'
      ? Object.fromEntries(STEM_NAMES.flatMap(name => [
        [`stems.${name}.playKey`, copies[item.stems[name].key].playKey],
        [`stems.${name}.playBytes`, copies[item.stems[name].key].playBytes],
      ]))
      : copies[item.key];
    fields.playVersion = PLAY_VERSION;
    const names = {}, values = { ':completed': 'completed' };
    const assignments = Object.entries(fields).map(([field, value], i) => {
      const parts = field.split('.').map((part, j) => { names[`#p${i}_${j}`] = part; return `#p${i}_${j}`; });
      values[`:v${i}`] = value;
      return `${parts.join('.')} = :v${i}`;
    });
    try {
      await database.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME, Key: { userId: item.userId, jobId: item.jobId },
        UpdateExpression: `SET ${assignments.join(', ')}`,
        ConditionExpression: '#status = :completed AND attribute_not_exists(deleting) AND attribute_not_exists(playVersion)',
        ExpressionAttributeNames: { ...names, '#status': 'status' }, ExpressionAttributeValues: values,
      }));
    } catch (error) {
      for (const { playKey } of Object.values(copies)) {
        await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: playKey }));
      }
      throw error;
    }
    converted++;
  } catch (error) {
    failed++;
    console.error(`  failed: ${error.name}: ${error.message}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (apply) console.log(`converted ${converted}, failed ${failed}`);
