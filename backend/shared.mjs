export const MAX_DURATION = 600;
export const JOB_LIFETIME_MS = 17 * 60 * 1000;
export const FAILED_HISTORY_MS = 10 * 60 * 1000;

export function failureRetention(failedAt = Date.now()) {
  return {
    failedAt: new Date(failedAt).toISOString(),
    expiresAt: Math.ceil((failedAt + FAILED_HISTORY_MS) / 1000),
  };
}

export function jobExpiry(job) {
  if (job.status === 'completed') return undefined;
  if (job.status === 'failed') {
    // Older failed records did not capture failure time; use creation time once.
    const failedAt = Date.parse(job.failedAt ?? job.createdAt);
    if (!Number.isFinite(failedAt)) throw new Error('Failed job has an invalid timestamp.');
    return Math.ceil((failedAt + FAILED_HISTORY_MS) / 1000);
  }
  if (job.type === 'stems') return Math.ceil((stemDeadline(job) + FAILED_HISTORY_MS) / 1000);
  const createdAt = Date.parse(job.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error('Job has an invalid creation timestamp.');
  return Math.ceil((createdAt + JOB_LIFETIME_MS + FAILED_HISTORY_MS) / 1000);
}

export function failedHistoryExpired(job, now = Date.now()) {
  if (job.status !== 'failed') return false;
  const failedAt = Date.parse(job.failedAt ?? job.createdAt);
  if (!Number.isFinite(failedAt)) throw new Error('Failed job has an invalid timestamp.');
  return now >= failedAt + FAILED_HISTORY_MS;
}

export function youtubeUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new Error('Enter a valid YouTube video URL.');
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid YouTube video URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Use an HTTPS YouTube video URL.');
  }
  let id;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.slice(1);
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:shorts|embed)\/([^/]+)$/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new Error('Enter a single YouTube video URL, not a playlist.');
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

export function visibleJob(job, now = Date.now()) {
  const stemJob = job.type === 'stems' || job.type === 'restoration';
  if (stemJob && ['uploading', 'queued', 'processing'].includes(job.status) &&
      now >= stemDeadline(job)) {
    return {
      ...job, status: 'failed',
      error: job.type === 'stems' ? 'Upload or separation expired. Please upload again.' : 'Stem cleanup expired. Please try again.',
      ...failureRetention(stemDeadline(job)),
    };
  }
  if (stemJob) return job;
  if (['queued', 'processing'].includes(job.status) &&
      now - Date.parse(job.createdAt) >= JOB_LIFETIME_MS) {
    return {
      ...job, status: 'failed', error: 'Conversion expired. Please try again.',
      ...failureRetention(Date.parse(job.createdAt) + JOB_LIFETIME_MS),
    };
  }
  return job;
}
import { stemDeadline } from './stem-shared.mjs';
