// A song's own scores: the MusicXML of an uploaded score (read from a PDF by the ScoreReader, or uploaded as is) for
// its Harmonic part, its bass and its drums, kept with the song so those parts are always made from them; and the
// sound the Harmonic score's notes were extracted as from the Harmonic and bass stems, for the spectrum page.
//   POST   /api/stems/jobs/{id}/score[/bass|/drums] {title, musicxml | reading} -> {score}: saved as that part's
//          score (replacing one before); the Harmonic one without a part
//   POST   /api/stems/jobs/{id}/score/extracted {bytes}  -> {upload}: a presigned POST for the extracted sound
//   DELETE /api/stems/jobs/{id}/score[/bass|/drums]       -> {removed: true}: that score (and the Harmonic one's sound)
// The job record carries score: {title, savedAt, extractedAt?} for the Harmonic score and partScores: {bass?, drums?}
// ({title, savedAt}); files are under users/<user>/scores/<song>/.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'node:stream';
import { visibleJob } from './shared.mjs';

export const LARGEST_SCORE_XML = 4 * 1024 * 1024;
export const LARGEST_EXTRACTED = 80 * 1024 * 1024;
const folder = (userId, jobId) => `users/${userId}/scores/${jobId}`;
export const SCORE_PARTS = ['other', 'bass', 'drums'];
export const scoreKey = (userId, jobId, part = 'other') => `${folder(userId, jobId)}/${part === 'other' ? 'score' : part}.musicxml`;
// A song's scores by part, as its record keeps them.
export const songScores = job => ({ ...(job.score ? { other: job.score } : {}), ...(job.partScores ?? {}) });
export const extractedKey = (userId, jobId) => `${folder(userId, jobId)}/extracted.wav`;

// The score as the page sees it: its title, when saved, and links to it and to its extracted sound.
export async function signedScore(job, signer, storage, part = 'other') {
  const score = songScores(job)[part];
  if (!score) return undefined;
  const get = key => signer(storage, new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }), { expiresIn: 3600 });
  return {
    title: score.title, savedAt: score.savedAt,
    url: await get(scoreKey(job.userId, job.jobId, part)),
    ...(score.extractedAt ? { extractedAt: score.extractedAt, extractedUrl: await get(extractedKey(job.userId, job.jobId)) } : {}),
  };
}
// Every score of the song, by part.
export async function signedScores(job, signer, storage) {
  const parts = Object.keys(songScores(job));
  return Object.fromEntries(await Promise.all(parts.map(async part => [part, await signedScore(job, signer, storage, part)])));
}

export function createScoreRoutes({ database, storage, uploadSigner, signer, startScoring = async () => null }) {
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
        ExpressionAttributeNames: { '#type': 'type', ...(update.includes('#score') ? { '#score': 'score' } : {}), ...(update.includes('#parts') ? { '#parts': 'partScores' } : {}) },
        ExpressionAttributeValues: { ':type': 'stems', ...values },
      }));
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  // Sets (or removes, with null) a part's score on the record.
  const recordPart = (userId, job, part, score) => {
    if (part === 'other') return score ? record(userId, job.jobId, 'SET #score = :score', { ':score': score }) : record(userId, job.jobId, 'REMOVE #score');
    const { [part]: _, ...others } = job.partScores ?? {};
    const parts = score ? { ...others, [part]: score } : others;
    return Object.keys(parts).length ? record(userId, job.jobId, 'SET #parts = :parts', { ':parts': parts }) : record(userId, job.jobId, 'REMOVE #parts');
  };

  return async ({ userId, jobId, part = 'other', extracted, method, body, reply }) => {
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
      for (const key of [scoreKey(userId, jobId, part), ...(part === 'other' ? [extractedKey(userId, jobId)] : [])]) {
        await storage.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
      }
      if (!await recordPart(userId, job, part, null)) return reply(409, { message: 'This song is being deleted.' });
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
    // A score read by the ScoreReader (score-api.mjs) can be saved by its reading's id.
    let xml = input.musicxml;
    if (xml === undefined && typeof input.reading === 'string' && /^[0-9a-f-]{36}$/.test(input.reading)) {
      try {
        const object = await storage.send(new GetObjectCommand({ Bucket: bucket(), Key: `score-readings/${userId}/${input.reading}/score.musicxml` }));
        xml = await object.Body.transformToString();
      } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return reply(404, { message: 'That score reading is not ready or has expired.' });
        throw error;
      }
    }
    if (typeof xml !== 'string' || !xml.includes('<score-partwise') || Buffer.byteLength(xml) > LARGEST_SCORE_XML) {
      return reply(400, { message: 'Send the score as partwise MusicXML, up to 4 MB.' });
    }
    // A drum score must have drums in it, and a pitched one notes.
    if (part === 'drums' ? !/<unpitched[\s>]/.test(xml) : !/<pitch[\s>]/.test(xml)) {
      return reply(400, { message: part === 'drums' ? 'No drum notes were found in this score.' : 'No notes were found in this score.' });
    }
    const content = Buffer.from(xml);
    await storage.send(new PutObjectCommand({
      Bucket: bucket(), Key: scoreKey(userId, jobId, part), ContentType: 'application/vnd.recordare.musicxml+xml',
      Body: Readable.from([content]), ContentLength: content.length,
    }));
    // A new score's extracted sound is made again, so the old one is no longer listed.
    const score = { title, savedAt: new Date().toISOString() };
    if (!await recordPart(userId, job, part, score)) {
      await storage.send(new DeleteObjectCommand({ Bucket: bucket(), Key: scoreKey(userId, jobId, part) }));
      return reply(409, { message: 'This song is being deleted.' });
    }
    const saved = part === 'other' ? { ...job, score } : { ...job, partScores: { ...job.partScores, [part]: score } };
    // Laid on the song at once when it has its analysis; otherwise when its parts are asked for next.
    const harmony = await startScoring(userId, saved);
    return reply(201, { score: await signedScore(saved, signer, storage, part), ...(harmony ? { harmony } : {}) });
  };
}
