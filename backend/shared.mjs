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

export function visibleJob(job, now = Date.now()) {
  const stemJob = ['stems', 'restoration', 'lyrics', 'harmony'].includes(job.type);
  if (stemJob && ['uploading', 'queued', 'processing'].includes(job.status) &&
      now >= stemDeadline(job)) {
    return {
      ...job, status: 'failed',
      error: {
        stems: 'Upload or separation expired. Please upload again.',
        restoration: 'Stem cleanup expired. Please try again.',
        lyrics: 'Lyrics recognition expired. Please try again.',
        harmony: 'Chord analysis expired. Please try again.',
      }[job.type],
      ...failureRetention(stemDeadline(job)),
    };
  }
  return job;
}
import { stemDeadline } from './stem-shared.mjs';
