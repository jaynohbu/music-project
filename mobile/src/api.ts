import { File, UploadType } from 'expo-file-system';
import { API_URL } from './auth';
import type { Effects } from './effects';

// The mixer shows stems in the website's order (web/src/services.ts).
export const STEM_NAMES = ['vocals', 'guitar', 'bass', 'piano', 'drums', 'other'] as const;
export type StemName = typeof STEM_NAMES[number];

export type SongStatus = 'uploading' | 'queued' | 'processing' | 'completed' | 'failed' | 'deleting';

export interface Song {
  type?: string;
  jobId: string;
  title?: string;
  author?: string;
  status: SongStatus;
  createdAt: string;
  duration?: number;
  error?: string;
  // 'aac-256k' when the AAC copies exist, otherwise 'wav'. A change means the files were replaced.
  playVersion?: string;
  // Signed for one hour.
  stems?: Partial<Record<StemName, { playUrl: string; downloadUrl: string }>>;
  restorations?: { id: string; stem: StemName; status: SongStatus; playUrl?: string; playVersion?: string }[];
  lyrics?: Lyrics;
  harmony?: Harmony;
}

// Lyrics and the score are found by the API in the background; the results are JSON at signed URLs.
export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed';
export interface Lyrics { id: string; status: TaskStatus; url?: string; error?: string }
export interface RegeneratedPart extends Lyrics { resultId?: string }
export interface Harmony extends Lyrics { stems?: Record<string, RegeneratedPart | undefined> }
export interface LyricWord { start: number; end: number; text: string }
export interface LyricLine { start: number; end: number; words: LyricWord[] }
// Units are sixteenth notes from the song's first beat.
export interface HarmonyNote { start: number; end: number; pitch: number; unit: number; length: number }
export type DrumName = 'kick' | 'snare' | 'tom' | 'hihat' | 'cymbal';
export interface DrumHit { unit: number; drum: DrumName }
export interface BarPattern { unit: number; label: string }
export interface HarmonyPart { chords: { start: number; name: string }[]; notes: HarmonyNote[]; hits?: DrumHit[]; patterns?: BarPattern[] }
export interface HarmonyGrid { beats: number[]; firstBar: number }
export const HARMONY_STEMS: readonly string[] = ['guitar', 'piano', 'other', 'bass', 'drums'];

export const createLyrics = (jobId: string) => request('POST', `/stems/jobs/${jobId}/lyrics`, {});
export const saveLyrics = (jobId: string, lines: LyricLine[]) => request('POST', `/stems/jobs/${jobId}/lyrics`, { lines });
// Without a part, finds every harmonic stem; with one, regenerates that stem from the version being heard.
export const createHarmony = (jobId: string, part?: { stem: string; cleaned: boolean }) =>
  request('POST', `/stems/jobs/${jobId}/harmony`, part ?? {});
export async function fetchResult<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what} request failed (HTTP ${response.status}).`);
  return await response.json() as T;
}
export interface SceneTrack extends Effects { muted: boolean; solo: boolean; bypassed: boolean; useCleaned: boolean }
export interface SceneSettings {
  masterVolume: number; sectionStart: number; sectionEnd: number; loop: boolean;
  tracks: Record<string, SceneTrack>;
}
export interface SceneEntry { id: string; jobId: string; title?: string; settings?: SceneSettings }
export interface Scene { id: string; name: string; revision: number; entries: SceneEntry[]; createdAt: string }
export const listScenes = async () => (await request<{ scenes: Scene[] }>('GET', '/scenes')).scenes;
export const getScene = async (id: string) => (await request<{ scene: Scene }>('GET', `/scenes/${id}`)).scene;
export const createScene = async (name: string) => (await request<{ scene: Scene }>('POST', '/scenes', { name })).scene;
export const updateScene = async (id: string, revision: number, patch: { name?: string; entries?: SceneEntry[] }) =>
  (await request<{ scene: Scene }>('PATCH', `/scenes/${id}`, { revision, ...patch })).scene;
export const deleteScene = (id: string) => request('DELETE', `/scenes/${id}`);

export interface Usage {
  plan: 'free' | 'premium';
  month: string;
  splits: { used: number; limit: number };
  songs: { used: number; limit: number };
}

export const MAX_UPLOAD_BYTES = 55_000_000;

// expo-file-system reports sizes and progress as 64-bit integers, which arrive as
// BigInt on iOS and cannot be mixed with numbers.
export const toNumber = (value: number | bigint) => Number(value);
export const UPLOAD_EXTENSIONS = /\.(wav|mp3|m4a|flac|ogg|aac)$/i;

// A refusal from the API, with its code (such as SONG_LIMIT) when it gave one.
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

let tokenSource: (() => Promise<string>) | null = null;
export const setTokenSource = (source: () => Promise<string>) => { tokenSource = source; };

async function request<T>(method: string, path: string, body?: object): Promise<T> {
  if (!tokenSource) throw new Error('Sign in to continue.');
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await tokenSource()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let result: T & { message?: string; code?: string };
  try { result = text ? JSON.parse(text) : {} as T; }
  catch { throw new ApiError('The service returned an invalid response. Please try again.', response.status); }
  if (!response.ok) {
    const message = response.status === 401
      ? 'Your session expired. Sign in again.'
      : result?.message ?? 'The service is unavailable. Please try again.';
    throw new ApiError(message, response.status, result?.code);
  }
  return result as T;
}

export async function listSongs(cursor?: string | null) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request<{ jobs: Song[]; cursor: string | null }>('GET', `/jobs${query}`);
}
export async function listReadySongs(): Promise<Song[]> {
  const songs: Song[] = [];
  let cursor: string | null = null;
  do {
    const page = await listSongs(cursor);
    songs.push(...page.jobs.filter(song => song.type === 'stems' && song.status === 'completed'));
    cursor = page.cursor;
  } while (cursor);
  return songs;
}

export const getSong = async (jobId: string) =>
  (await request<{ job: Song }>('GET', `/stems/jobs/${jobId}`)).job;

export const getUsage = async () => (await request<{ usage: Usage }>('GET', '/stems/usage')).usage;

export const deleteSong = (jobId: string) => request<{ deleted: boolean }>('DELETE', `/stems/jobs/${jobId}`);

// Starts the split. Safe to call again after a failure; it does not upload again.
export const startSplit = async (jobId: string) =>
  (await request<{ job: Song }>('POST', `/stems/jobs/${jobId}/complete`, {})).job;

export interface Upload {
  promise: Promise<void>;
  cancel(): void;
}

// Creates the song, then sends the file to S3 as the presigned form post the API returns.
export async function createUpload(
  file: File, fileName: string, title: string, onProgress: (fraction: number) => void,
): Promise<{ job: Song; upload: Upload }> {
  const { job, upload } = await request<{ job: Song; upload: { url: string; fields: Record<string, string> } }>(
    'POST', '/stems/uploads', { fileName, bytes: toNumber(file.size), title },
  );
  const task = file.createUploadTask(upload.url, {
    httpMethod: 'POST',
    uploadType: UploadType.MULTIPART,
    fieldName: 'file',
    parameters: upload.fields,
    mimeType: 'application/octet-stream',
    onProgress: ({ bytesSent, totalBytes }) => {
      const total = toNumber(totalBytes);
      if (total > 0) onProgress(Math.min(toNumber(bytesSent) / total, 1));
    },
  });
  const promise = task.uploadAsync().then(result => {
    if (result.status < 200 || result.status >= 300) throw new Error('The upload failed. Please try again.');
  });
  return { job, upload: { promise, cancel: () => task.cancel() } };
}
