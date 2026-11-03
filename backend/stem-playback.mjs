import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

// Phones play AAC copies of the WAV stems; the WAVs stay for downloads and stem cleanup.
// See docs/mobile-app-design.md, Compression.
export const PLAY_VERSION = 'aac-256k';
export const playKeyFor = key => key.replace(/\.wav$/, '.m4a');

export function playbackEncoder(ffmpegPath, run = promisify(execFile)) {
  return (input, output) => run(ffmpegPath, [
    '-nostdin', '-y', '-loglevel', 'error', '-i', input,
    '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', output,
  ], { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
}

// Encodes and uploads an AAC copy of each WAV, returning { [wavKey]: { playKey, playBytes } }.
// A failure removes what this call uploaded and returns null, so the caller keeps serving WAVs:
// a failed copy never fails the song, and a song never mixes AAC and WAV stems.
export async function savePlayCopies({ storage, encode, files, jobId }) {
  const saved = [];
  try {
    const copies = [];
    for (const { file, key } of files) {
      const output = file.replace(/\.wav$/, '.m4a');
      await encode(file, output);
      copies.push({ key, output, playKey: playKeyFor(key), playBytes: (await stat(output)).size });
    }
    for (const copy of copies) {
      await storage.send(new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME, Key: copy.playKey, ContentType: 'audio/mp4',
        Body: createReadStream(copy.output), ContentLength: copy.playBytes,
      }));
      saved.push(copy.playKey);
    }
    return Object.fromEntries(copies.map(({ key, playKey, playBytes }) => [key, { playKey, playBytes }]));
  } catch (error) {
    console.error('Playback copy failed', { jobId, name: error.name });
    for (const key of saved) {
      await storage.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }))
        .catch(cleanup => console.error('Playback copy cleanup failed', { jobId, name: cleanup.name }));
    }
    return null;
  }
}
