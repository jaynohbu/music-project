// The player's own recording for a song ("user stem") and the tempo the band followed while
// it was recorded. One per song, kept in Documents so clearing the stem cache keeps it.
import { Directory, File, Paths } from 'expo-file-system';
import type { TempoPoint } from './live-follow';

export interface LiveTake {
  version: 1;
  // File name inside the song's take folder; the app's container path changes between installs.
  file: string;
  recordedAt: number;
  duration: number;
  // Seconds between the band being heard and the guitar reaching the recording; nudged by the user.
  latency: number;
  points: TempoPoint[];
  volume: number;
  muted: boolean;
}

export const TAKES_FOLDER = 'takes';
const folder = (jobId: string) => new Directory(Paths.document, TAKES_FOLDER, jobId);
const record = (jobId: string) => new File(folder(jobId), 'take.json');

export const takeSubDirectory = (jobId: string) => `${TAKES_FOLDER}/${jobId}`;

export function takePath(jobId: string, take: LiveTake) {
  return decodeURI(new File(folder(jobId), take.file).uri.replace(/^file:\/\//, ''));
}

export function loadTake(jobId: string): LiveTake | null {
  try {
    const file = record(jobId);
    if (!file.exists) return null;
    const take = JSON.parse(file.textSync()) as LiveTake;
    if (take.version !== 1 || !Array.isArray(take.points) || !new File(folder(jobId), take.file).exists) return null;
    return take;
  } catch (failure) {
    console.warn('The saved live take could not be read', failure);
    return null;
  }
}

// Saves the take and removes any older recording in the folder, so only one user stem remains.
export function saveTake(jobId: string, take: LiveTake) {
  const directory = folder(jobId);
  directory.create({ idempotent: true, intermediates: true });
  record(jobId).write(JSON.stringify(take));
  for (const item of directory.list()) {
    if (item instanceof File && item.name !== 'take.json' && item.name !== take.file) item.delete();
  }
}

// Removes a recording that was not kept, such as a cancelled take.
export function discardRecording(jobId: string, name: string, keep?: LiveTake | null) {
  if (keep?.file === name) return;
  const file = new File(folder(jobId), name);
  if (file.exists) file.delete();
}

// Deletes the user stem and its tempo together.
export function deleteTake(jobId: string) {
  const directory = folder(jobId);
  if (directory.exists) directory.delete();
}
