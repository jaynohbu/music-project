// A song's own score: the MusicXML of an uploaded score (read from a PDF by the ScoreReader, or uploaded as is), kept
// with the song so its chords & notes are always made from it; and the sound the score's notes were extracted as
// from the Harmonic and bass stems (a WAV the page makes and uploads), for the spectrum page.
//   POST   /api/stems/jobs/{id}/score {title, musicxml}  -> {score}: saved as the song's score (replacing one before)
//   POST   /api/stems/jobs/{id}/score/extracted {bytes}  -> {upload}: a presigned POST for the extracted sound
//   DELETE /api/stems/jobs/{id}/score                    -> {removed: true}: the score and its sound removed
// The job record carries score: {title, savedAt, extractedAt?}; files are under users/<user>/scores/<song>/.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'node:stream';
import { visibleJob } from './shared.mjs';

export const LARGEST_SCORE_XML = 4 * 1024 * 1024;
export const LARGEST_EXTRACTED = 80 * 1024 * 1024;
const folder = (userId, jobId) => `users/${userId}/scores/${jobId}`;
export const scoreKey = (userId, jobId) => `${folder(userId, jobId)}/score.musicxml`;
export const extractedKey = (userId, jobId) => `${folder(userId, jobId)}/extracted.wav`;

// The score as the page sees it: its title, when saved, and links to it and to its extracted sound.
export async function signedScore(job, signer, storage) {
  if (!job.score) return undefined;
  const get = key => signer(storage, new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }), { expiresIn: 3600 });
  return {
    title: job.score.title, savedAt: job.score.savedAt,
    url: await get(scoreKey(job.userId, job.jobId)),
    ...(job.score.extractedAt ? { extractedAt: job.score.extractedAt, extractedUrl: await get(extractedKey(job.userId, job.jobId)) } : {}),
  };
}

export function createScoreRoutes({ database, storage, uploadSigner, signer }) {
  const table = () => process.env.TABLE_NAME;
  const bucket = () => process.env.BUCKET_NAME;

  async function song(userId, jobId) {
    const job = (await database.send(new GetCommand({ TableName: table(), Key: { userId, jobId }, ConsistentRead: true }))).Item;
    return job?.type === 'stems' ? job : undefined;
  }

  // Sets or removes the record's score, unless the song is being deleted meanwhile.
  async function record(userId, jobId, update, values = {}) {
    try {
      await database.send(new UpdateCommand({
        TableName: table(), Key: { userId, jobId }, UpdateExpression: update,
        ConditionExpression: 'attribute_exists(jobId) AND #type = :type AND attribute_not_exists(deleting)',
        ExpressionAttributeNames: { '#type': 'type', '#score': 'score' },
        ExpressionAttributeValues: { ':type': 'stems', ...values },
      }));
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  return async ({ userId, jobId, extracted, method, body, reply }) => {
    const job = await song(userId, jobId);
    if (!job) return reply(404, { message: 'Separation job not found.' });
    if (job.deleting) return reply(409, { message: 'This song is being deleted.' });
    if (visibleJob(job).status !== 'completed') return reply(409, { message: 'Add a score after the stems are ready.' });
    let input;
    try {
      input = method === 'POST' ? body() ?? {} : {};
    } catch {
      return reply(400, { message: 'The request is not valid JSON.' });
    }
    if (method === 'DELETE' && !extracted) {
      for (const key of [scoreKey(userId, jobId), extractedKey(userId, jobId)]) {
        await storage.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
      }
      if (!await record(userId, jobId, 'REMOVE #score')) return reply(409, { message: 'This song is being deleted.' });
      return reply(200, { removed: true });
    }
    if (method !== 'POST') return reply(404, { message: 'Endpoint not found.' });
    if (extracted) {
      if (!job.score) return reply(409, { message: 'Add a score first.' });
      if (!Number.isInteger(input.bytes) || input.bytes <= 44 || input.bytes > LARGEST_EXTRACTED) {
        return reply(400, { message: 'Give the WAV file size in bytes, up to 80 MB.' });
      }
      const upload = await uploadSigner(storage, {
        Bucket: bucket(), Key: extractedKey(userId, jobId), Expires: 900,
        Fields: { 'Content-Type': 'audio/wav' },
        Conditions: [['content-length-range', input.bytes, input.bytes], ['eq', '$Content-Type', 'audio/wav']],
      });
      if (!await record(userId, jobId, 'SET #score = :score', { ':score': { ...job.score, extractedAt: new Date().toISOString() } })) {
        return reply(409, { message: 'This song is being deleted.' });
      }
      return reply(201, { upload });
    }
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
    const xml = input.musicxml;
    if (typeof xml !== 'string' || !xml.includes('<score-partwise') || Buffer.byteLength(xml) > LARGEST_SCORE_XML) {
      return reply(400, { message: 'Send the score as partwise MusicXML, up to 4 MB.' });
    }
    const content = Buffer.from(xml);
    await storage.send(new PutObjectCommand({
      Bucket: bucket(), Key: scoreKey(userId, jobId), ContentType: 'application/vnd.recordare.musicxml+xml',
      Body: Readable.from([content]), ContentLength: content.length,
    }));
    // A new score's extracted sound is made again, so the old one is no longer listed.
    const score = { title, savedAt: new Date().toISOString() };
    if (!await record(userId, jobId, 'SET #score = :score', { ':score': score })) {
      await storage.send(new DeleteObjectCommand({ Bucket: bucket(), Key: scoreKey(userId, jobId) }));
      return reply(409, { message: 'This song is being deleted.' });
    }
    return reply(201, { score: await signedScore({ ...job, score }, signer, storage) });
  };
}
