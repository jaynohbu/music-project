import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access, truncate } from 'node:fs/promises';
import path from 'node:path';
import { createWorker } from '../worker.mjs';

const job = { userId: 'alice', jobId: 'test-job', sourceUrl: 'https://youtu.be/abcdefghijk' };
const fields = command => Object.fromEntries(
  Object.entries(command.input.ExpressionAttributeNames).map(([name, key]) =>
    [key, command.input.ExpressionAttributeValues[name.replace('#f', ':v')]]),
);

test('uses shell-free arguments, creates private MP3 and removes scratch files', async () => {
  const changes = [];
  const uploads = [];
  let directory;
  const worker = createWorker({
    database: { send: async command => {
      if (command.input.UpdateExpression.includes(' REMOVE ')) {
        const removed = command.input.UpdateExpression.split(' REMOVE ')[1].split(', ');
        assert.deepEqual(removed.map(name => command.input.ExpressionAttributeNames[name]),
          ['expiresAt', 'failedAt', 'error', 'errorCode', 'failureStage']);
        assert.ok(removed.every(name => name.startsWith('#')));
      }
      changes.push(fields(command));
      return {};
    } },
    storage: { send: async command => {
      const data = [];
      for await (const chunk of command.input.Body) data.push(chunk);
      assert.equal(Buffer.concat(data).toString(), 'audio');
      uploads.push(command.input);
      return {};
    } },
    run: async (executable, args, options) => {
      assert.equal(executable, 'yt-dlp');
      assert.equal(options.shell, undefined);
      assert.equal(args.at(-2), '--');
      assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=abcdefghijk');
      assert.ok(args.includes('--no-playlist'));
      assert.equal(args[args.indexOf('--match-filter') + 1], 'duration <= 600 & !is_live');
      assert.equal(args[args.indexOf('--max-filesize') + 1], String(250 * 1024 * 1024));
      assert.equal(args[args.indexOf('--audio-format') + 1], 'mp3');
      assert.equal(args[args.indexOf('--audio-quality') + 1], '192K');
      assert.equal(options.timeout, 855000);
      directory = path.dirname(args[args.indexOf('--output') + 1]);
      await writeFile(path.join(directory, 'audio.mp3'), 'audio');
      await writeFile(path.join(directory, 'audio.info.json'), '{"title":"Test video"}');
    },
  });
  await worker(job, { getRemainingTimeInMillis: () => 900000 });
  assert.equal(changes[0].status, 'processing');
  assert.equal(changes[1].status, 'completed');
  assert.equal(changes[1].title, 'Test video');
  assert.equal(uploads[0].Key, 'users/alice/test-job.mp3');
  assert.equal(uploads[0].ContentType, 'audio/mpeg');
  await assert.rejects(access(directory));
});

test('download errors mark failed and clean up without uploading', async () => {
  const changes = [];
  let directory;
  const worker = createWorker({
    database: { send: async command => { changes.push(fields(command)); return {}; } },
    storage: { send: () => assert.fail('Upload called') },
    run: async (_, args) => {
      directory = path.dirname(args[args.indexOf('--output') + 1]);
      throw new Error('YouTube blocked request');
    },
  });
  await worker(job);
  assert.equal(changes.at(-1).status, 'failed');
  assert.match(changes.at(-1).error, /Conversion failed/);
  assert.equal(changes.at(-1).errorCode, 'DOWNLOAD_FAILED');
  assert.equal(changes.at(-1).failureStage, 'download');
  await assert.rejects(access(directory));
});

test('missing output and S3 errors cannot report success', async () => {
  for (const createOutput of [false, true]) {
    const changes = [];
    const worker = createWorker({
      database: { send: async command => { changes.push(fields(command)); return {}; } },
      storage: { send: async command => {
        command.input.Body.destroy();
        throw new Error('S3 unavailable');
      } },
      run: async (_, args) => {
        if (createOutput) {
          const directory = path.dirname(args[args.indexOf('--output') + 1]);
          await writeFile(path.join(directory, 'audio.mp3'), 'audio');
          await writeFile(path.join(directory, 'audio.info.json'), '{"title":"Video"}');
        }
      },
    });

    await worker(job);
    assert.equal(changes.at(-1).status, 'failed');
    assert.equal(changes.at(-1).errorCode, createOutput ? 'UPLOAD_FAILED' : 'OUTPUT_MISSING');
    assert.ok(!changes.some(change => change.status === 'completed'));
  }
});

test('enforces the exact 250 MiB converted-file threshold', async () => {
  const limit = 250 * 1024 * 1024;
  for (const size of [limit, limit + 1]) {
    const changes = [];
    let uploaded = false;
    const worker = createWorker({
      database: { send: async command => { changes.push(fields(command)); return {}; } },
      storage: { send: async command => {
        assert.equal(command.input.ContentLength, limit);
        command.input.Body.destroy();
        uploaded = true;
        return {};
      } },
      run: async (_, args, options) => {
        assert.equal(options.timeout, 15000);
        assert.equal(options.env.LD_LIBRARY_PATH, '');
        const directory = path.dirname(args[args.indexOf('--output') + 1]);
        const file = path.join(directory, 'audio.mp3');
        await writeFile(file, '');
        await truncate(file, size);
        await writeFile(path.join(directory, 'audio.info.json'), '{"title":"Boundary test"}');
      },
    });
    await worker(job, { getRemainingTimeInMillis: () => 60000 });
    assert.equal(uploaded, size === limit);
    assert.equal(changes.at(-1).status, size === limit ? 'completed' : 'failed');
    if (size > limit) assert.equal(changes.at(-1).errorCode, 'FILE_TOO_LARGE');
  }
});

test('successful downloader exit with skipped video captures filter/size reason', async () => {
  for (const [stdout, expected] of [
    ['[download] Video does not pass filter (duration <= 600 & !is_live), skipping ..', 'VIDEO_FILTERED'],
    ['[download] File is larger than max-filesize (262144000 bytes), skipping', 'FILE_TOO_LARGE'],
  ]) {
    const changes = [];
    const worker = createWorker({
      database: { send: async command => { changes.push(fields(command)); return {}; } },
      storage: { send: () => assert.fail('Skipped video uploaded') },
      run: async () => ({ stdout, stderr: '' }),
    });
    await worker(job);
    assert.equal(changes.at(-1).status, 'failed');
    assert.equal(changes.at(-1).errorCode, expected);
    assert.equal(changes.at(-1).failureStage, 'output');
  }
});

test('YouTube bot rejection is distinct from app limits and raw stderr is not stored', async () => {
  const changes = [];
  const worker = createWorker({
    database: { send: async command => { changes.push(fields(command)); return {}; } },
    storage: { send: () => assert.fail('Upload called') },
    run: async () => {
      throw Object.assign(new Error('Command failed'), {
        code: 1, stderr: 'Sign in to confirm you’re not a bot. https://media.example/?signature=private-value',
      });
    },
  });
  await worker(job);
  const failure = changes.at(-1);
  assert.equal(failure.errorCode, 'YOUTUBE_SIGN_IN_REQUIRED');
  assert.equal(failure.failureStage, 'download');
  assert.match(failure.error, /not the app/);
  assert.ok(!JSON.stringify(changes).includes('private-value'));
});
