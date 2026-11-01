export const STEM_NAMES = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'];
export const STEM_MAX_BYTES = 30_000_000;
export const STEM_MAX_DURATION = 420;
export const STEM_MAX_OUTPUT_BYTES = STEM_MAX_DURATION * 44100 * 2 * 2 + 4096;
export const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
export const STEM_WINDOW_MS = 2 * 60 * 60 * 1000;

export function stemDeadline(job) {
  return Date.parse(job.startedAt ?? job.createdAt) +
    (job.status === 'uploading' ? UPLOAD_WINDOW_MS : STEM_WINDOW_MS);
}

export function stemInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.fileName !== 'string' || value.fileName.length > 200 ||
      !/\.(wav|mp3|m4a|flac|ogg|aac)$/i.test(value.fileName) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > STEM_MAX_BYTES ||
      (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 200))) {
    throw new Error('Choose a WAV, MP3, M4A, FLAC, OGG or AAC file up to 30 MB (30,000,000 bytes).');
  }
  return {
    fileName: value.fileName, bytes: value.bytes,
    title: value.title?.trim() || value.fileName.replace(/\.[^.]+$/, ''),
    extension: value.fileName.split('.').pop().toLowerCase(),
  };
}
