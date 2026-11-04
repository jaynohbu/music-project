import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createHarmony, createLyrics, createRestoration, fetchResult, getSong, saveLyrics as sendLyrics,
  type HarmonyGrid, type HarmonyPart, type LyricLine, type Song, type StemName,
} from './api';
import { errorText } from './ui';

// The same interval and wording as the website (web/src/stem-pages.ts).
const POLL_MS = 4000;
export const LYRICS_NOTE = 'Converting voice to text takes time. The timing may not match well at first but improves when reloaded. You can edit the text later.';
export const CHORDS_NOTE = 'Converting to chords and melody takes time, and the result is not the same as the original.';

const running = (status?: string) => status === 'queued' || status === 'processing';
export const working = (song: Song | null) => !!song && (running(song.lyrics?.status) || running(song.harmony?.status) ||
  Object.values(song.harmony?.stems ?? {}).some(part => running(part?.status)) ||
  (song.restorations ?? []).some(item => running(item.status)));
export const hasMusic = (part?: HarmonyPart) => !!part && (part.chords.length > 0 || part.notes.length > 0 || !!part.hits?.length);
export const regenerateLabel = (name: string) =>
  name === 'other' ? 'Regenerate chords' : name === 'drums' ? 'Regenerate drum score' : 'Regenerate chords & melody';

// Finds, loads and saves a song's lyrics and score, polling the song while the API works on them.
export function useSongTasks(initial: Song | null) {
  const [song, setSong] = useState(initial);
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [lyricsLoadError, setLyricsLoadError] = useState('');
  const [startingLyrics, setStartingLyrics] = useState(false);
  const [grid, setGrid] = useState<HarmonyGrid | null>(null);
  const [parts, setParts] = useState<Record<string, HarmonyPart> | null>(null);
  const [chordsLoadError, setChordsLoadError] = useState('');
  const [startingChords, setStartingChords] = useState(false);
  const [startingParts, setStartingParts] = useState<string[]>([]);
  const [startingClean, setStartingClean] = useState<string[]>([]);
  const [partLoadErrors, setPartLoadErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const alive = useRef(true);
  const loading = useRef({ lyrics: false, chords: false });
  const loadedParts = useRef(new Map<string, string>());
  const jobId = initial?.jobId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    if (!jobId) return;
    try {
      const found = await getSong(jobId);
      if (alive.current) setSong(found);
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    }
  }, [jobId]);

  const busy = working(song);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const lyricsUrl = song?.lyrics?.url;
  useEffect(() => {
    if (!lyricsUrl || lyrics || loading.current.lyrics || lyricsLoadError) return;
    loading.current.lyrics = true;
    fetchResult<{ lines: LyricLine[] }>(lyricsUrl, 'Lyrics')
      .then(({ lines }) => { if (alive.current) setLyrics(lines); })
      .catch(failure => { if (alive.current) setLyricsLoadError(`Could not load the lyrics: ${errorText(failure)}`); })
      .finally(() => { loading.current.lyrics = false; });
  }, [lyricsUrl, lyrics, lyricsLoadError]);

  const chordsUrl = song?.harmony?.url;
  useEffect(() => {
    if (!chordsUrl || parts || loading.current.chords || chordsLoadError) return;
    loading.current.chords = true;
    fetchResult<HarmonyGrid & { stems: Record<string, HarmonyPart> }>(chordsUrl, 'Chords')
      .then(({ stems, beats, firstBar }) => { if (alive.current) { setGrid({ beats, firstBar }); setParts(stems); } })
      .catch(failure => { if (alive.current) setChordsLoadError(`Could not load the chords: ${errorText(failure)}`); })
      .finally(() => { loading.current.chords = false; });
  }, [chordsUrl, parts, chordsLoadError]);

  // A regenerated stem replaces just that stem's part, once per result.
  const regenerated = song?.harmony?.stems;
  const hasParts = !!parts;
  useEffect(() => {
    if (!hasParts) return;
    for (const [name, part] of Object.entries(regenerated ?? {})) {
      if (!part?.url || !part.resultId || loadedParts.current.get(name) === part.resultId || partLoadErrors[name]) continue;
      loadedParts.current.set(name, part.resultId);
      fetchResult<{ stems: Record<string, HarmonyPart> }>(part.url, 'Chords')
        .then(({ stems }) => { if (alive.current) setParts(current => current && { ...current, [name]: stems[name] }); })
        .catch(failure => {
          loadedParts.current.delete(name);
          if (alive.current) setPartLoadErrors(errors => ({ ...errors, [name]: `Could not load the regenerated notes: ${errorText(failure)}` }));
        });
    }
  }, [hasParts, regenerated, partLoadErrors]);

  const findingLyrics = startingLyrics || (!!song?.lyrics && song.lyrics.status !== 'failed' && !lyricsLoadError);
  const findingChords = startingChords || (!!song?.harmony && song.harmony.status !== 'failed' && !chordsLoadError);
  const regenerating = (name: string) => startingParts.includes(name) || running(song?.harmony?.stems?.[name]?.status);
  // The same rules as the website: a stem is cleaning from the tap until its restoration fails.
  const cleaning = (name: string) => startingClean.includes(name) ||
    !!song?.restorations?.some(item => item.stem === name && item.status !== 'failed');

  const start = async (begin: () => void, end: () => void, operation: () => Promise<unknown>, what: string) => {
    begin(); setError('');
    try { await operation(); await refresh(); }
    catch (failure) { if (alive.current) setError(`Could not start ${what}: ${errorText(failure)}`); }
    finally { if (alive.current) end(); }
  };

  return {
    song, lyrics, grid, parts, error, findingLyrics, findingChords, regenerating, cleaning,
    cleanFailure: (name: string) => cleaning(name) ? undefined
      : song?.restorations?.find(item => item.stem === name && item.status === 'failed')?.error,
    clean(name: StemName) {
      if (cleaning(name) || !jobId) return;
      void start(() => setStartingClean(names => [...names, name]), () => setStartingClean(names => names.filter(item => item !== name)),
        () => createRestoration(jobId, name), `cleaning ${name}`);
    },
    lyricsFailure: findingLyrics || lyrics ? undefined : lyricsLoadError || song?.lyrics?.error,
    chordsFailure: findingChords || parts ? undefined : chordsLoadError || song?.harmony?.error,
    partFailure(name: string) {
      if (regenerating(name)) return undefined;
      const part = song?.harmony?.stems?.[name];
      return partLoadErrors[name] || (part?.status === 'failed' ? part.error : undefined);
    },
    findLyrics() {
      if (findingLyrics || !jobId) return;
      setLyricsLoadError('');
      void start(() => setStartingLyrics(true), () => setStartingLyrics(false), () => createLyrics(jobId), 'finding lyrics');
    },
    findChords() {
      if (findingChords || !jobId) return;
      setChordsLoadError('');
      void start(() => setStartingChords(true), () => setStartingChords(false), () => createHarmony(jobId), 'finding chords');
    },
    // Uses the version being heard, since the same audio would give the same notes.
    regenerate(name: string, cleaned: boolean) {
      if (regenerating(name) || !jobId) return;
      setPartLoadErrors(({ [name]: _, ...others }) => others);
      void start(() => setStartingParts(names => [...names, name]), () => setStartingParts(names => names.filter(item => item !== name)),
        () => createHarmony(jobId, { stem: name, cleaned }), `regenerating ${name}`);
    },
    async saveLyrics(lines: LyricLine[]) {
      if (!jobId) return;
      await sendLyrics(jobId, lines);
      if (!alive.current) return;
      setLyrics(lines);
      await refresh();
    },
  };
}
export type SongTasks = ReturnType<typeof useSongTasks>;
