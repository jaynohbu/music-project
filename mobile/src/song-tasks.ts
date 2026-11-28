import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import {
  createHarmony, createLyrics, createRendering, createRestoration, fetchResult, getSong, readScore, saveLyrics as sendLyrics, saveSongScore, laySongScore,
  ENSEMBLE_STEMS, SCORE_ENGINE, type HarmonyGrid, type RenderFamily, type HarmonyPart, type LyricLine, type ScorePart, type Song, type StemName,
} from './api';
import { t, type TextKey } from './i18n';
import type { SoundChoices } from './score-parts';
import { errorText } from './ui';

// The same interval and wording as the website (web/src/stem-pages.ts).
const POLL_MS = 4000;
// About how long a score takes, as the website says it: the reader's time a page (a PDF's pages are not counted
// here, so a few are assumed), and laying it on the song on the server.
const READING_SECONDS = 4 * 22, LAYING_SECONDS = 240;
const SCORE_FILES = /\.(pdf|png|jpe?g)$/i, MUSICXML_FILES = /\.(musicxml|xml)$/i;

const running = (status?: string) => status === 'queued' || status === 'processing';
export const working = (song: Song | null) => !!song && (running(song.lyrics?.status) || running(song.harmony?.status) ||
  Object.values(song.harmony?.stems ?? {}).some(part => running(part?.status)) ||
  (song.restorations ?? []).some(item => running(item.status)) || (song.renderings ?? []).some(item => running(item.status)));
export const hasMusic = (part?: HarmonyPart) => !!part && (part.chords.length > 0 || part.notes.length > 0 || !!part.hits?.length);
export const regenerateLabel = (name: string) => t(name === 'drums' ? 'tasks.regenDrums' : 'tasks.regenChordsMelody');
export const stemName = (name: string) => t(`stem.${name}` as TextKey);

// Songs whose chords and melody were asked for by themselves in this run of the app, so a song open in two
// places, or reopened, is not asked twice. A failed run is not retried by itself; the button does that.
const autoRequested = new Set<string>();

// Finds, loads and saves a song's lyrics and score, polling the song while the API works on them.
export function useSongTasks(initial: Song | null) {
  const [song, setSong] = useState(initial);
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [lyricsLoadError, setLyricsLoadError] = useState('');
  const [startingLyrics, setStartingLyrics] = useState(false);
  const [grid, setGrid] = useState<HarmonyGrid | null>(null);
  // Keyed by stem, so reading the part of a stem that no longer exists fails to compile.
  const [parts, setParts] = useState<Partial<Record<StemName, HarmonyPart>> | null>(null);
  const [chordsLoadError, setChordsLoadError] = useState('');
  const [startingChords, setStartingChords] = useState(false);
  const [startingParts, setStartingParts] = useState<string[]>([]);
  const [startingClean, setStartingClean] = useState<string[]>([]);
  const [partLoadErrors, setPartLoadErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  // The analysis's sounds for the song.
  const [soundChoices, setSoundChoices] = useState<SoundChoices>();
  // Reading and saving an uploaded score: the minutes it should take, shown alone, on the stem it is for.
  const [scoreMinutes, setScoreMinutes] = useState(0);
  const [scorePart, setScorePart] = useState<ScorePart>('other');
  const appliedScore = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const loading = useRef({ lyrics: false, chords: false });
  const loadedParts = useRef(new Map<string, string>());
  // The result whose scores are shown: the finished one, or the previous one while a new run goes.
  const [loadedChords, setLoadedChords] = useState<string>();
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

  // The first time a split song is opened, its chords and melody are found in the background; a score from an
  // older analysis version is redone the same way, and shown meanwhile.
  const needsChords = !!jobId && song?.status === 'completed' && (!song.harmony || !!song.harmony.stale);
  useEffect(() => {
    if (!needsChords || !jobId || autoRequested.has(jobId)) return;
    autoRequested.add(jobId);
    createHarmony(jobId).then(refresh, failure => {
      if (alive.current) setError(t('tasks.startChordsFailed', { error: errorText(failure) }));
    });
  }, [needsChords, jobId, refresh]);

  const lyricsUrl = song?.lyrics?.url;
  useEffect(() => {
    if (!lyricsUrl || lyrics || loading.current.lyrics || lyricsLoadError) return;
    loading.current.lyrics = true;
    fetchResult<{ lines: LyricLine[] }>(lyricsUrl, 'Lyrics')
      .then(({ lines }) => { if (alive.current) setLyrics(lines); })
      .catch(failure => { if (alive.current) setLyricsLoadError(t('tasks.loadLyricsFailed', { error: errorText(failure) })); })
      .finally(() => { loading.current.lyrics = false; });
  }, [lyricsUrl, lyrics, lyricsLoadError]);

  const shown = song?.harmony?.status === 'completed' ? song.harmony : song?.harmony?.previous;
  const chordsUrl = shown?.url, chordsId = shown?.id;
  useEffect(() => {
    if (!chordsUrl || chordsId === loadedChords || loading.current.chords || chordsLoadError) return;
    loading.current.chords = true;
    fetchResult<HarmonyGrid & { stems: Record<string, HarmonyPart>; ensemble?: HarmonyPart; accompaniment?: SoundChoices }>(chordsUrl, 'Chords')
      .then(({ stems, ensemble, beats, firstBar, accompaniment }) => {
        if (!alive.current) return;
        setSoundChoices(accompaniment);
        // A newer result replaces the shown one, regenerated parts included.
        loadedParts.current.clear();
        setPartLoadErrors({});
        setLoadedChords(chordsId);
        setGrid({ beats, firstBar });
        // The ensemble part is other's score.
        setParts(ensemble ? { ...stems, ...Object.fromEntries(ENSEMBLE_STEMS.map(name => [name, ensemble])) } : stems);
      })
      .catch(failure => { if (alive.current) setChordsLoadError(t('tasks.loadChordsFailed', { error: errorText(failure) })); })
      .finally(() => { loading.current.chords = false; });
  }, [chordsUrl, chordsId, loadedChords, chordsLoadError]);

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
          if (alive.current) setPartLoadErrors(errors => ({ ...errors, [name]: t('tasks.loadPartFailed', { error: errorText(failure) }) }));
        });
    }
  }, [hasParts, loadedChords, regenerated, partLoadErrors]);

  // A song with its own scores whose parts are not yet from them (its analysis just finished, or a score is newer), or
  // were laid by an earlier version of the laying: the server is asked to lay them on the song, once per set of scores.
  const harmony = song?.harmony;
  const scores = { ...(song?.score ? { other: song.score } : {}), ...song?.scores };
  const scoreParts = Object.keys(scores) as ScorePart[];
  const signature = scoreParts.map(part => `${part}:${scores[part]!.savedAt}`).join(' ');
  useEffect(() => {
    if (!jobId || !signature || harmony?.status !== 'completed' || scoreMinutes) return;
    // Laid already: each score's saving time is in the result (an older result names the Harmonic one at its top).
    const laid = signature.split(' ').every(entry => {
      const [part, savedAt] = [entry.slice(0, entry.indexOf(':')), entry.slice(entry.indexOf(':') + 1)] as [ScorePart, string];
      return (harmony.fromScore?.parts?.[part]?.scoreSavedAt ?? (part === 'other' ? harmony.fromScore?.scoreSavedAt : undefined)) === savedAt;
    });
    const current = harmony.fromScore?.engine === SCORE_ENGINE;
    if ((laid && current) || appliedScore.current === signature) return;
    appliedScore.current = signature;
    laySongScore(jobId, laid && !current).then(refresh, failure => {
      if (alive.current) setError(t('tasks.useScoreFailed', { error: errorText(failure) }));
    });
  }, [jobId, signature, harmony, scoreMinutes, refresh]);
  const scoring = !!harmony?.scoring && running(harmony.status);
  // While the server lays the scores, the time it has taken, counted every second.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!scoring) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [scoring]);
  const laying = (): string => {
    const started = Date.parse(harmony?.startedAt ?? '');
    const minutes = Math.round(LAYING_SECONDS / 60);
    if (!Number.isFinite(started)) return t('tasks.processing', { minutes });
    const seconds = Math.max(0, Math.round((now - started) / 1000));
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    return t(seconds <= LAYING_SECONDS ? 'tasks.processingElapsed' : 'tasks.processingLong', { elapsed, minutes });
  };

  const findingLyrics = startingLyrics || (!!song?.lyrics && song.lyrics.status !== 'failed' && !lyricsLoadError);
  const findingChords = startingChords || (!!song?.harmony && !song.harmony.stale && song.harmony.status !== 'failed' && !chordsLoadError);
  // A new score is being found while the previous one is shown.
  const updatingChords = !!parts && findingChords && song?.harmony?.status !== 'completed';
  const regenerating = (name: string) => startingParts.includes(name) || running(song?.harmony?.stems?.[name]?.status);
  // The same rules as the website: a stem is cleaning from the tap until its restoration fails.
  const cleaning = (name: string) => startingClean.includes(name) ||
    !!song?.restorations?.some(item => item.stem === name && item.status !== 'failed');

  const start = async (begin: () => void, end: () => void, operation: () => Promise<unknown>, failed: (error: string) => string) => {
    begin(); setError('');
    try { await operation(); await refresh(); }
    catch (failure) { if (alive.current) setError(failed(errorText(failure))); }
    finally { if (alive.current) end(); }
  };

  // An uploaded score saved with the song for one part: a PDF or image read by the ScoreReader first, MusicXML as it is.
  const uploadScore = async (part: ScorePart) => {
    if (!jobId || scoreMinutes) return;
    let result: DocumentPicker.DocumentPickerResult;
    try { result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true }); }
    catch (failure) { setError(errorText(failure)); return; }
    if (result.canceled) return;
    const asset = result.assets[0];
    const pdf = SCORE_FILES.test(asset.name);
    if (!pdf && !MUSICXML_FILES.test(asset.name)) { setError(t('tasks.scoreKind')); return; }
    setError('');
    setScorePart(part);
    setScoreMinutes(Math.max(1, Math.round(((pdf ? READING_SECONDS : 0) + LAYING_SECONDS) / 60)));
    try {
      const file = new File(asset.uri), title = asset.name.replace(/\.[^.]+$/, '');
      await saveSongScore(jobId, pdf ? { title, reading: await readScore(file) } : { title, musicxml: await file.text() }, part);
      // With no analysis yet, it runs first; the score is laid on the song after it.
      if (!song?.harmony) await createHarmony(jobId);
      await refresh();
    } catch (failure) {
      if (alive.current) setError(t('tasks.useScoreFailed', { error: errorText(failure) }));
    } finally {
      if (alive.current) setScoreMinutes(0);
    }
  };

  // A part's notes (chords & notes for the Harmonic and bass stems, the drum score for the drums): a song with its
  // own score for the part takes them from it; otherwise the app asks whether there is a score.
  const chordsAndNotes = (part: ScorePart, fromAudio: () => void) => {
    if (!jobId || scoreMinutes) return;
    if (scores[part]) {
      laySongScore(jobId).then(refresh, failure => setError(t('tasks.useScoreFailed', { error: errorText(failure) })));
      return;
    }
    Alert.alert(t(part === 'drums' ? 'tasks.drumScore' : 'tasks.chordsMelody'),
      t(part === 'drums' ? 'tasks.drumScoreQuestion' : part === 'bass' ? 'tasks.bassScoreQuestion' : 'tasks.scoreQuestion'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('tasks.fromAudio'), onPress: fromAudio },
        { text: t('tasks.uploadScore'), onPress: () => void uploadScore(part) },
      ]);
  };

  const findChords = () => {
    if (findingChords || !jobId) return;
    setChordsLoadError('');
    void start(() => setStartingChords(true), () => setStartingChords(false), () => createHarmony(jobId), error => t('tasks.startChordsFailed', { error }));
  };
  // Uses the version being heard, since the same audio would give the same notes.
  const regenerateFromAudio = (name: string, cleaned: boolean) => {
    if (regenerating(name) || !jobId) return;
    setPartLoadErrors(({ [name]: _, ...others }) => others);
    void start(() => setStartingParts(names => [...names, name]), () => setStartingParts(names => names.filter(item => item !== name)),
      () => createHarmony(jobId, { stem: name, cleaned }), error => t('tasks.startRegenFailed', { stem: stemName(name), error }));
  };

  // A score part in a sound, made on the server for the result shown (asked for once per result, family and sound).
  const askedRenderings = useRef(new Set<string>());
  const render = (family: RenderFamily, sound: number, again = false) => {
    if (!jobId || !loadedChords) return;
    const wanted = `${loadedChords}:${family}:${sound}`;
    if (again) askedRenderings.current.delete(wanted);
    if (askedRenderings.current.has(wanted)) return;
    askedRenderings.current.add(wanted);
    createRendering(jobId, family, sound).then(refresh, failure => {
      askedRenderings.current.delete(wanted);
      if (alive.current) setError(t('score.renderFailed', { error: errorText(failure) }));
    });
  };

  return {
    // The result whose parts are shown, its renderings, and asking for one.
    resultId: loadedChords, renderings: song?.renderings ?? [], render,
    song, lyrics, grid, parts, error, findingLyrics, findingChords, updatingChords, regenerating, cleaning, soundChoices,
    // While a score is read and saved, or laid on the song on the server: about how many minutes (on the stem the
    // upload is for, or on every stem with a score while they are laid).
    processing: scoreMinutes || (scoring ? Math.round(LAYING_SECONDS / 60) : 0),
    processingFor: (name: string) => scoreMinutes ? (name === scorePart ? scoreMinutes : 0)
      : scoring && (scores as Record<string, unknown>)[name] ? Math.round(LAYING_SECONDS / 60) : 0,
    // A stem's own score, uploaded from its card.
    hasScore: (name: string) => !!(scores as Record<string, unknown>)[name],
    // Whether the stem's part shown is laid from its uploaded score, not transcribed from its sound (an older result
    // names only the Harmonic score, at its top).
    fromScore: (name: string) => harmony?.fromScore?.parts ? !!(harmony.fromScore.parts as Record<string, unknown>)[name]
      : name === 'other' && !!harmony?.fromScore,
    uploadScore(name: string) { if (name === 'other' || name === 'bass' || name === 'drums') void uploadScore(name); },
    // What the stem's card says while its score is read or laid: how long it has taken, while the server lays it.
    processingNote: (name: string) => scoreMinutes ? (name === scorePart ? t('tasks.processing', { minutes: scoreMinutes }) : '')
      : scoring && (scores as Record<string, unknown>)[name] ? laying() : '',
    // The song's uploaded scores laid on it again.
    regenerateScore() {
      if (!jobId || scoreMinutes || scoring) return;
      setError('');
      laySongScore(jobId, true).then(refresh, failure => { if (alive.current) setError(t('tasks.useScoreFailed', { error: errorText(failure) })); });
    },
    cleanFailure: (name: string) => cleaning(name) ? undefined
      : song?.restorations?.find(item => item.stem === name && item.status === 'failed')?.error,
    clean(name: StemName) {
      if (cleaning(name) || !jobId) return;
      void start(() => setStartingClean(names => [...names, name]), () => setStartingClean(names => names.filter(item => item !== name)),
        () => createRestoration(jobId, name), error => t('tasks.startCleanFailed', { stem: stemName(name), error }));
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
      void start(() => setStartingLyrics(true), () => setStartingLyrics(false), () => createLyrics(jobId), error => t('tasks.startLyricsFailed', { error }));
    },
    // A part's notes for the first time (asking about its score first); the analysis finds them all.
    findChords() { chordsAndNotes('other', findChords); },
    findBass() { chordsAndNotes('bass', findChords); },
    findDrums() { chordsAndNotes('drums', findChords); },
    // Regenerating a part asks for its score first (or uses the song's own); without one it is found again from audio.
    regenerate(name: string, cleaned: boolean) {
      if (name === 'other' || name === 'bass' || name === 'drums') chordsAndNotes(name, () => regenerateFromAudio(name, cleaned));
      else regenerateFromAudio(name, cleaned);
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
