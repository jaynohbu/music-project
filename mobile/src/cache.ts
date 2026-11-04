// Local copies of stems for playback (design doc, Local cache). S3 stays the source
// of truth, so anything here can be deleted and fetched again.
import { Directory, File, Paths } from 'expo-file-system';
import { STEM_NAMES, type Song, type StemName, getSong, toNumber } from './api';

const MAX_SONGS = 20;
const MAX_BYTES = 2_000_000_000;
// Room left on the phone after a download, so the cache never fills the disk.
const DISK_MARGIN = 500_000_000;
// Bytes per second for six stereo stems, to estimate a download before it starts.
const RATE = { aac: 6 * 32_000, wav: 6 * 176_400 };
// S3 error bodies are a few hundred bytes; no real stem is this small.
const MIN_STEM_BYTES = 4096;

interface Entry {
  version: string;
  bytes: number;
  lastPlayed: number;
  files: Record<StemName, string>;
  cleaned?: Partial<Record<StemName, string>>;
  cleanedVersion?: string;
}
export interface SongFiles { original: Record<StemName, string>; cleaned: Partial<Record<StemName, string>> }

const root = new Directory(Paths.document, 'songs');
const indexFile = new File(root, 'index.json');
const songDirectory = (jobId: string) => new Directory(root, jobId);
let index: Record<string, Entry> | null = null;
// Songs that must not be evicted: the one playing or open in the mixer, and any being downloaded.
const inUse = new Map<string, number>();
const downloads = new Map<string, { promise: Promise<SongFiles>; progress: Set<(fraction: number) => void> }>();

function load(): Record<string, Entry> {
  if (index) return index;
  root.create({ idempotent: true, intermediates: true });
  try {
    index = indexFile.exists ? JSON.parse(indexFile.textSync()) : {};
  } catch (failure) {
    console.warn('Song cache index could not be read; downloading fresh copies', failure);
    index = {};
  }
  // Drop entries whose files are gone, and folders the index does not know (an interrupted download).
  for (const jobId of Object.keys(index!)) {
    const entry = index![jobId], directory = songDirectory(jobId);
    if (!directory.exists || STEM_NAMES.some(name => !entry.files?.[name] ||
      !new File(directory, entry.files[name]).exists || toNumber(new File(directory, entry.files[name]).size) < MIN_STEM_BYTES))
      delete index![jobId];
  }
  for (const item of root.list()) {
    if (item instanceof Directory && !index![item.name]) item.delete();
  }
  return index!;
}

const save = () => indexFile.write(JSON.stringify(index ?? {}));

function remove(jobId: string) {
  const entries = load();
  delete entries[jobId];
  const directory = songDirectory(jobId);
  if (directory.exists) directory.delete();
}

// Evicts the least recently played songs until the cache holds at most `songs` songs
// and `bytes` bytes. Songs in use are kept even if that leaves the cache over the limit.
function evict(songs: number, bytes: number) {
  const entries = load();
  const candidates = Object.entries(entries)
    .filter(([jobId]) => !inUse.has(jobId))
    .sort(([, a], [, b]) => a.lastPlayed - b.lastPlayed);
  let count = Object.keys(entries).length;
  let total = Object.values(entries).reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [jobId, entry] of candidates) {
    if (count <= songs && total <= bytes) break;
    remove(jobId);
    count -= 1;
    total -= entry.bytes;
  }
}

export function cacheSize() {
  const entries = Object.values(load());
  return { songs: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

export function clearCache() {
  if (inUse.size) throw new Error('Audio is still open or downloading. Close the mixer, wait for downloads to finish, then try again.');
  if (root.exists) root.delete();
  index = null;
}

export function forgetSong(jobId: string) {
  if (inUse.has(jobId)) return;
  remove(jobId);
  save();
}

// Marks a song as in use until the returned function is called.
export function holdSong(jobId: string) {
  inUse.set(jobId, (inUse.get(jobId) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const count = (inUse.get(jobId) ?? 1) - 1;
    if (count > 0) inUse.set(jobId, count); else inUse.delete(jobId);
  };
}

const extension = (url: string) => (/\.(m4a|wav)(?:\?|$)/i.exec(url)?.[1] ?? 'm4a').toLowerCase();

// Returns local paths for all six stems, downloading them first if the cache has no
// copy of this version. Call holdSong first, so a later download cannot evict it.
export function songFiles(
  song: Song, onProgress: (fraction: number) => void,
): Promise<SongFiles> {
  const existing = downloads.get(song.jobId);
  if (existing) { existing.progress.add(onProgress); return existing.promise; }
  const release = holdSong(song.jobId);
  const progress = new Set([onProgress]);
  const operation = downloadSong(song, fraction => { for (const report of progress) report(fraction); })
    .finally(() => { downloads.delete(song.jobId); release(); });
  downloads.set(song.jobId, { promise: operation, progress });
  return operation;
}

async function downloadSong(song: Song, onProgress: (fraction: number) => void): Promise<SongFiles> {
  const entries = load();
  const fresh = await getSong(song.jobId);
  const version = fresh.playVersion ?? 'wav';
  const restorations = (fresh.restorations ?? []).filter(item => item.status === 'completed');
  const cleanedVersion = JSON.stringify(restorations.map(item => [item.id, item.playVersion ?? 'wav']).sort());
  const cached = entries[song.jobId];
  const valid = (files: Partial<Record<StemName, string>>) => Object.values(files).every(name => {
    const file = new File(songDirectory(song.jobId), name);
    return file.exists && toNumber(file.size) >= MIN_STEM_BYTES;
  });
  if (cached?.version === version && (cached.cleanedVersion ?? '[]') === cleanedVersion && valid(cached.files) && valid(cached.cleaned ?? {})) {
    cached.lastPlayed = Date.now();
    await save();
    return { original: cached.files, cleaned: cached.cleaned ?? {} };
  }
  if (cached) remove(song.jobId);

  // Signed links last an hour, so get fresh ones for the download.
  const stems = fresh.stems;
  if (fresh.status !== 'completed' || !stems || STEM_NAMES.some(name => !stems[name])) {
    throw new Error('This song is not ready to play.');
  }
  const freshVersion = fresh.playVersion ?? 'wav';
  const estimate = (fresh.duration ?? 900) * (freshVersion === 'wav' ? RATE.wav : RATE.aac) * (1 + restorations.length / 6);

  // Prefer downloading before evicting; evict first only when the disk needs the room.
  const free = () => toNumber(Paths.availableDiskSpace);
  if (free() < estimate + DISK_MARGIN) {
    evict(0, 0);
    await save();
    if (free() < estimate + DISK_MARGIN) {
      throw new Error('There is not enough free space on this phone to play this song.');
    }
  }

  // Download into a folder the index does not list, so an interrupted download is
  // removed on the next launch, and add it only when every stem is complete.
  const assets = [
    ...STEM_NAMES.map(stem => ({ stem, name: stem, url: stems[stem]!.playUrl, cleaned: false })),
    ...restorations.map(item => {
      if (!item.playUrl) throw new Error('A cleaned stem has no playback file. Reload the song.');
      return { stem: item.stem, name: `cleaned-${item.stem}`, url: item.playUrl, cleaned: true };
    }),
  ];
  const temporary = new Directory(root, `.download-${song.jobId}`);
  if (temporary.exists) temporary.delete();
  temporary.create();
  const written = new Map<string, number>();
  const totals = new Map<string, number>();
  const report = () => {
    const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
    const done = [...written.values()].reduce((sum, value) => sum + value, 0);
    if (totals.size === assets.length && total > 0) onProgress(Math.min(done / total, 1));
  };
  try {
    const files = {} as Record<StemName, string>;
    const cleaned: Partial<Record<StemName, string>> = {};
    const results = await Promise.allSettled(assets.map(async asset => {
      const fileName = `${asset.name}.${extension(asset.url)}`;
      const task = File.createDownloadTask(asset.url, new File(temporary, fileName), {
        sessionType: 'foreground',
        onProgress: ({ bytesWritten, totalBytes }) => {
          written.set(asset.name, toNumber(bytesWritten));
          if (toNumber(totalBytes) > 0) totals.set(asset.name, toNumber(totalBytes));
          report();
        },
      });
      const file = await task.downloadAsync();
      if (!file || toNumber(file.size) < MIN_STEM_BYTES) throw new Error('A stem failed to download. Please try again.');
      if (asset.cleaned) cleaned[asset.stem] = fileName; else files[asset.stem] = fileName;
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const bytes = [...Object.values(files), ...Object.values(cleaned)].reduce((sum, name) => sum + toNumber(new File(temporary, name).size), 0);
    const directory = songDirectory(song.jobId);
    if (directory.exists) directory.delete();
    temporary.rename(song.jobId);
    entries[song.jobId] = { version: freshVersion, bytes, lastPlayed: Date.now(), files, cleaned, cleanedVersion };
    evict(MAX_SONGS, MAX_BYTES);
    await save();
  } catch (failure) {
    if (temporary.exists) temporary.delete();
    throw failure;
  }
  return { original: entries[song.jobId].files, cleaned: entries[song.jobId].cleaned ?? {} };
}

// Absolute paths in the form the audio engine reads.
export function stemPaths(jobId: string, files: Record<StemName, string>): Record<StemName, string>;
export function stemPaths(jobId: string, files: Partial<Record<StemName, string>>): Partial<Record<StemName, string>>;
export function stemPaths(jobId: string, files: Partial<Record<StemName, string>>) {
  const directory = songDirectory(jobId);
  return Object.fromEntries(Object.entries(files).map(([name, file]) => [
    name, decodeURI(new File(directory, file).uri.replace(/^file:\/\//, '')),
  ])) as Record<StemName, string>;
}
