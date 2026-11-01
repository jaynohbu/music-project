import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversionError, classifyConversionError, missingOutputError } from '../conversion-errors.mjs';

test('classifies downloader failures without echoing untrusted output', () => {
  for (const [text, code] of [
    ['ERROR: Sign in to confirm you’re not a bot', 'YOUTUBE_SIGN_IN_REQUIRED'],
    ['Sign in to confirm your age', 'AGE_RESTRICTED'],
    ['This video is age-restricted', 'AGE_RESTRICTED'],
    ['Private video', 'VIDEO_UNAVAILABLE'],
    ['Video unavailable', 'VIDEO_UNAVAILABLE'],
    ['This video is not available in your country', 'VIDEO_UNAVAILABLE'],
    ['yt-dlp: error: no such option: --js-runtimes', 'DOWNLOADER_INCOMPATIBLE'],
    ['Unsupported Python version', 'DOWNLOADER_INCOMPATIBLE'],
    ['File is larger than max-filesize', 'FILE_TOO_LARGE'],
    ['does not pass filter (duration <= 600 & !is_live)', 'VIDEO_FILTERED'],
    ['ERROR: ffmpeg and ffprobe not found', 'FFMPEG_FAILED'],
    ['ERROR: Postprocessing: conversion failed!', 'FFMPEG_FAILED'],
    ['Requested format is not available', 'FORMAT_UNAVAILABLE'],
    ['HTTP Error 403: Forbidden', 'DOWNLOAD_FORBIDDEN'],
    ['HTTP Error 429: Too Many Requests', 'DOWNLOAD_RATE_LIMITED'],
    ['certificate verify failed', 'NETWORK_FAILED'],
    ['Connection reset by peer', 'NETWORK_FAILED'],
    ['Request timed out', 'NETWORK_FAILED'],
    ['Unknown extraction error', 'DOWNLOAD_FAILED'],
  ]) {
    const error = Object.assign(new Error('Command failed'), {
      stderr: `${text}\nhttps://example.com/?token=secret-value /tmp/private-directory`,
    });
    const diagnostic = classifyConversionError(error, 'download');
    assert.equal(diagnostic.errorCode, code, text);
    assert.ok(diagnostic.error);
    assert.ok(!diagnostic.error.includes('secret-value'));
    assert.ok(!diagnostic.error.includes('private-directory'));
  }
});

test('process launch, execution deadline, and output failures remain distinct', () => {
  assert.equal(classifyConversionError({ code: 'ENOENT' }, 'download').errorCode, 'DOWNLOADER_MISSING');
  assert.equal(classifyConversionError({ killed: true, signal: 'SIGTERM' }, 'download').errorCode, 'CONVERSION_TIMEOUT');
  assert.equal(classifyConversionError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'download').errorCode, 'DOWNLOAD_FAILED');
  assert.equal(missingOutputError().code, 'OUTPUT_MISSING');
  assert.equal(missingOutputError('Video does not pass filter, skipping').code, 'VIDEO_FILTERED');
});

test('stage-specific errors cannot be mistaken for YouTube download rejection', () => {
  const error = Object.assign(new Error('HTTP Error 403'), { stderr: 'Forbidden' });
  for (const [stage, code] of [
    ['upload', 'UPLOAD_FAILED'], ['record', 'JOB_UPDATE_FAILED'],
    ['metadata', 'METADATA_INVALID'], ['scratch', 'LOCAL_STORAGE_FAILED'],
    ['output', 'LOCAL_STORAGE_FAILED'], ['validate', 'INVALID_VIDEO_URL'],
  ]) assert.equal(classifyConversionError(error, stage).errorCode, code);
  assert.equal(classifyConversionError(new ConversionError('FILE_TOO_LARGE'), 'output').errorCode, 'FILE_TOO_LARGE');
});
