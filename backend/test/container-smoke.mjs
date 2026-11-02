import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { createWorker } from '../worker.mjs';

const run = promisify(execFile);
const ffmpegPath = process.env.LOCAL_FFMPEG_PATH ?? ffmpeg.path;
const directory = await mkdtemp(path.join(tmpdir(), 'youtube-smoke-'));
const file = path.join(directory, 'test.mp4');
let server;
try {
  await run(ffmpegPath, [
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', '-y', file,
  ]);
  const video = await readFile(file);
  server = createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length });
    response.end(video);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const changes = [];
  let uploaded = false;
  const worker = createWorker({
    ffmpegPath,
    downloaderPath: process.env.LOCAL_YTDLP_PATH ?? 'yt-dlp',
    database: { send: async command => {
      changes.push(Object.fromEntries(Object.entries(command.input.ExpressionAttributeNames)
        .map(([name, key]) => [key, command.input.ExpressionAttributeValues[name.replace('#f', ':v')]])));
      return {};
    } },
    storage: { send: async command => {
      const chunks = [];
      for await (const chunk of command.input.Body) chunks.push(chunk);
      const wav = Buffer.concat(chunks);
      assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
      assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
      assert.ok(wav.length > 44100);
      assert.equal(command.input.Key, 'users/smoke/test.wav');
      uploaded = true;
      return {};
    } },
    run: async (executable, args, options) => {
      // Serve our generated video locally; no copyrighted video or AWS access.
      // The generic extractor has no duration metadata for the one-second fixture.
      const filtered = args.filter((_, i) =>
        args[i] !== '--match-filter' && args[i - 1] !== '--match-filter');
      const result = await run(executable, [
        ...filtered.slice(0, -1), `http://127.0.0.1:${address.port}/test.mp4`,
      ], options);
      console.log(result.stdout);
      if (result.stderr) console.log(result.stderr);
      return result;
    },
  });
  await worker({ userId: 'smoke', jobId: 'test', sourceUrl: 'https://youtu.be/abcdefghijk' });
  assert.ok(uploaded, JSON.stringify(changes));
  assert.equal(changes.at(-1).status, 'completed');
  console.log('Conversion smoke passed: synthetic MP4 -> yt-dlp -> FFmpeg WAV -> upload stream.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
