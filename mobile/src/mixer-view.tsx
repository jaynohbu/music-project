import { useIsFocused } from 'expo-router';
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { HARMONY_STEMS, STEM_NAMES, getSong, type LyricLine, type SceneEntry, type SceneSettings, type Song, type StemName } from './api';
import { addCleanedFile, holdSong, songFiles, stemPaths } from './cache';
import { EFFECT_CONTROLS } from './effects';
import { LivePanel } from './live-panel';
import { Mixer, defaultChannel } from './player';
import { ChannelStrip, IconButton, LampSwitch, MasterFader, Timeline } from './mixer-console';
import { useStemScroll } from './stem-scroll';
import { focusedStem } from './stem-focus';
import { stemPeaks } from './waveform';
import { Button, ButtonRow, Centered, errorText, useConfirm } from './ui';

import { snapshot, restore } from './mixer-settings';
import { HarmonyStrip, LyricsEditor, LyricsStrip } from './score-view';
import { LYRICS_REPLAY_LEAD, firstChange } from './score';
import { CHORDS_NOTE, LYRICS_NOTE, hasMusic, regenerateLabel, useSongTasks } from './song-tasks';
import { type Theme, useStyles, useTheme } from './theme';

interface MixerProps {
  jobId: string; title?: string; entry?: SceneEntry;
  onSettings?: (settings: SceneSettings) => void; onEnded?: () => void;
  onReady?: (mixer: Mixer) => void; onSong?: (song: Song) => void; onMixer?: (mixer: Mixer | null) => void;
}
export type StemPeaks = Partial<Record<StemName, { original?: number[]; cleaned?: number[] }>>;
export function MixerView(props: MixerProps) {
  const focused = useIsFocused();
  return focused ? <MountedMixer {...props} /> : null;
}
function MountedMixer({ jobId, title, entry, onSettings, onEnded, onReady, onSong, onMixer }: MixerProps) {
  const styles = useStyles(makeStyles);
  const [mixer, setMixer] = useState<Mixer | null>(null);
  const [song, setSong] = useState<Song | null>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [peaks, setPeaks] = useState<StemPeaks>({});
  const callbacks = useRef({ onSettings, onEnded, onReady, onSong, onMixer, title });
  const initial = useRef(entry?.settings);
  useLayoutEffect(() => {
    callbacks.current = { onSettings, onEnded, onReady, onSong, onMixer, title };
    initial.current = entry?.settings;
  }, [onSettings, onEnded, onReady, onSong, onMixer, entry?.settings, title]);
  useEffect(() => { mixer?.setTitle(title || song?.title || 'Untitled song'); }, [mixer, title, song?.title]);
  useEffect(() => {
    let cancelled = false, player: Mixer | null = null;
    let unsubscribe: (() => void) | undefined, unend: (() => void) | undefined;
    const release = holdSong(jobId);
    (async () => {
      const found = await getSong(jobId);
      if (cancelled) return;
      setSong(found); callbacks.current.onSong?.(found);
      const files = await songFiles(found, progress => { if (!cancelled) setFraction(progress); });
      if (cancelled) return;
      player = await Mixer.create(stemPaths(jobId, files.original), callbacks.current.title || found.title || 'Untitled song', found.author,
        stemPaths(jobId, files.cleaned), found.duration);
      if (cancelled) { await player.close(); return; }
      if (initial.current) restore(player, initial.current);
      let last = JSON.stringify(snapshot(player));
      const current = player;
      unsubscribe = player.subscribe(() => {
        const settings = snapshot(current), json = JSON.stringify(settings);
        if (json !== last) { last = json; callbacks.current.onSettings?.(settings); }
      });
      unend = player.onEnded(() => callbacks.current.onEnded?.());
      setMixer(player); callbacks.current.onMixer?.(player); callbacks.current.onReady?.(player);
      const duration = player.duration;
      for (const name of STEM_NAMES) {
        for (const [version, fileName] of [['original', files.original[name]], ['cleaned', files.cleaned[name]]] as const) {
          if (!fileName) continue;
          stemPeaks(jobId, fileName, duration, () => cancelled).then(result => {
            if (result && !cancelled) setPeaks(current => ({ ...current, [name]: { ...current[name], [version]: result } }));
          }).catch(failure => console.warn('Waveform could not be drawn', name, failure));
        }
      }
    })().catch(failure => {
      if (!cancelled) setError(errorText(failure));
      if (player) void player.close().catch(failure => console.warn('Audio cleanup failed', failure));
    });
    return () => {
      cancelled = true; unsubscribe?.(); unend?.(); callbacks.current.onMixer?.(null);
      if (player) void player.close().catch(failure => console.warn('Audio cleanup failed', failure)).finally(release);
      else release();
    };
    // A scene entry is mounted with its stable ID; title/settings edits must not recreate audio.
  }, [jobId, attempt]);
  if (error) return <View style={styles.card}>
    <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
    <Button label="Retry loading audio" onPress={() => { setMixer(null); setFraction(null); setPeaks({}); setError(''); setAttempt(value => value + 1); }} />
  </View>;
  if (!mixer) return <Centered><Text style={styles.detail}>{fraction === null ? 'Loading song…' : `Downloading stems ${Math.round(fraction * 100)}%`}</Text></Centered>;
  return <MixerControls mixer={mixer} song={song} peaks={peaks} />;
}

export function MixerControls({ mixer, song = null, peaks }: { mixer: Mixer; song?: Song | null; peaks?: StemPeaks }) {
  const styles = useStyles(makeStyles), theme = useTheme();
  const [, refresh] = useReducer(count => count + 1, 0);
  const [position, setPosition] = useState(0);
  const [open, setOpen] = useState<StemName>('vocals');
  const stems = useRef<Partial<Record<StemName, ComponentRef<typeof View> | null>>>({});
  const anchor = useRef<{ name: StemName; top: number } | null>(null);
  const scroll = useStemScroll();
  // Opening one stem closes the others; keep the newly opened stem where it was so content above shrinking does not jump.
  const openStem = (name: StemName) => {
    const view = stems.current[name];
    if (!view) { setOpen(name); return; }
    view.measureInWindow((_x, top) => { anchor.current = { name, top }; setOpen(name); });
  };
  // While a stem is being measured or swapped open, further scroll events wait so the page cannot flicker between stems.
  const switching = useRef(false);
  const current = useRef(open);
  useLayoutEffect(() => {
    current.current = open;
    const held = anchor.current;
    anchor.current = null;
    const done = () => requestAnimationFrame(() => { switching.current = false; });
    if (held && held.name === open) stems.current[open]?.measureInWindow((_x, top) => { scroll?.scrollBy(top - held.top); done(); });
    else done();
  }, [open, scroll]);
  useEffect(() => scroll?.onScroll(viewport => {
    if (switching.current) return;
    const names = STEM_NAMES.filter(name => stems.current[name]);
    if (!names.length) return;
    switching.current = true;
    Promise.all(names.map(name => new Promise<{ name: StemName; top: number; bottom: number }>(resolve =>
      stems.current[name]!.measureInWindow((_x, top, _width, height) => resolve({ name, top, bottom: top + height })))))
      .then(frames => {
        const found = focusedStem(frames, viewport);
        if (found && found !== current.current) {
          anchor.current = { name: found, top: frames.find(frame => frame.name === found)!.top };
          setOpen(found);
        } else switching.current = false;
      });
  }), [scroll]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const locked = busy || recording;
  const [error, setError] = useState('');
  const [editingLyrics, setEditingLyrics] = useState(false);
  const confirm = useConfirm();
  const tasks = useSongTasks(song);
  // A cleaning that finishes while the mixer is open is downloaded and switched on, as on the website.
  const [cleanedPeaks, setCleanedPeaks] = useState<Partial<Record<StemName, number[]>>>({});
  const [cleanErrors, setCleanErrors] = useState<Partial<Record<StemName, string>>>({});
  const adding = useRef(new Set<StemName>());
  const [cleanRetry, setCleanRetry] = useState(0);
  const finished = tasks.song?.restorations?.filter(item => item.status === 'completed' && item.playUrl).map(item => item.stem).join();
  const jobId = song?.jobId;
  useEffect(() => {
    if (!jobId || !finished) return;
    for (const name of finished.split(',') as StemName[]) {
      if (mixer.hasCleaned(name) || adding.current.has(name)) continue;
      adding.current.add(name);
      (async () => {
        const fileName = await addCleanedFile(jobId, name);
        const path = stemPaths(jobId, { [name]: fileName })[name]!;
        await mixer.addCleaned(name, path);
        // Not added when the mixer closed during the download.
        if (!mixer.hasCleaned(name)) return;
        mixer.setChannel(name, { useCleaned: true });
        const result = await stemPeaks(jobId, fileName, mixer.duration, () => false);
        if (result) setCleanedPeaks(current => ({ ...current, [name]: result }));
      })().catch(failure => {
        adding.current.delete(name);
        setCleanErrors(current => ({ ...current, [name]: `Could not load the cleaned version: ${errorText(failure)}` }));
      });
    }
  }, [jobId, finished, mixer, cleanRetry]);
  useEffect(() => {
    const unsubscribe = mixer.subscribe(refresh);
    const timer = setInterval(() => { mixer.tick(); setPosition(mixer.position); }, 100);
    return () => { clearInterval(timer); unsubscribe(); };
  }, [mixer]);
  const run = async (operation: () => Promise<void>) => {
    if (locked) return;
    setBusy(true); setError('');
    try { await operation(); setPosition(mixer.position); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    if (!await confirm('Reset song settings?', 'Reset all effects, mute/solo, master volume, selection and loop? The song title stays unchanged.', 'Reset song')) return;
    await run(async () => { await mixer.stop(); mixer.reset(); });
  };
  const editLyrics = () => void run(async () => { await mixer.pause(); setEditingLyrics(true); });
  // Leaves the cursor just before the first change, ready to replay it.
  const saveLyrics = async (lines: LyricLine[]) => {
    const changed = firstChange(tasks.lyrics ?? [], lines);
    if (changed !== null) {
      await tasks.saveLyrics(lines);
      await mixer.seek(changed - LYRICS_REPLAY_LEAD);
      setPosition(mixer.position);
    }
    setEditingLyrics(false);
  };
  const allMuted = STEM_NAMES.every(name => mixer.channel(name).muted);
  const soloing = STEM_NAMES.some(name => mixer.channel(name).solo);
  const inside = position > mixer.sectionStart && position < mixer.sectionEnd;
  return <View style={styles.page}>
    {!!(error || mixer.error || tasks.error) && <Text accessibilityRole="alert" style={styles.error}>{error || mixer.error || tasks.error}</Text>}
    {editingLyrics && tasks.lyrics && <LyricsEditor lines={tasks.lyrics} duration={mixer.duration}
      onSave={saveLyrics} onClose={() => setEditingLyrics(false)} />}
    {song && <LivePanel key={song.jobId} mixer={mixer} song={song} tasks={tasks} position={position} onRecording={setRecording} />}
    {STEM_NAMES.map(name => {
      const channel = mixer.channel(name);
      const label = name[0].toUpperCase() + name.slice(1);
      const expanded = open === name;
      const live = mixer.isPlaying && !channel.muted && !(soloing && !channel.solo);
      return <View key={name} style={styles.stem} ref={view => { stems.current[name] = view; }}>
        <View style={styles.stemHeader}>
          <Text style={styles.stemTitle}>{label}</Text>
          {mixer.hasCleaned(name) && <View style={styles.versions} accessibilityRole="radiogroup" accessibilityLabel={`${label} version`}>
            {([false, true] as const).map(cleaned => <Pressable key={String(cleaned)} accessibilityRole="radio"
              accessibilityState={{ checked: channel.useCleaned === cleaned }}
              onPress={() => mixer.setChannel(name, { useCleaned: cleaned })}
              style={[styles.version, channel.useCleaned === cleaned && styles.versionOn]}>
              <Text style={[styles.versionText, channel.useCleaned === cleaned && { color: theme.onAccent }]}>{cleaned ? 'Cleaned' : 'Original'}</Text>
            </Pressable>)}
          </View>}
          {!mixer.hasCleaned(name) && song && (cleanErrors[name]
            ? <Pressable onPress={() => { setCleanErrors(({ [name]: _, ...others }) => others); setCleanRetry(value => value + 1); }}
              accessibilityRole="button" accessibilityLabel={`Load cleaned ${label}`} style={styles.taskButton}>
              <Text style={styles.taskButtonText}>Load cleaned</Text>
            </Pressable>
            : <Pressable onPress={() => tasks.clean(name)} disabled={locked || tasks.cleaning(name)}
              accessibilityRole="button" accessibilityLabel={`Clean ${label}`} accessibilityState={{ disabled: busy || tasks.cleaning(name) }}
              style={[styles.taskButton, (busy || tasks.cleaning(name)) && { opacity: 0.5 }]}>
              <Text style={styles.taskButtonText}>{tasks.cleaning(name) ? 'Cleaning...' : 'Clean'}</Text>
            </Pressable>)}
        </View>
        {!!(tasks.cleanFailure(name) || cleanErrors[name]) &&
          <Text accessibilityRole="alert" style={[styles.error, styles.stemError]}>{tasks.cleanFailure(name) || cleanErrors[name]}</Text>}
        {song && <StemTasks name={name} label={label} cleaned={channel.useCleaned} tasks={tasks} position={position}
          disabled={locked} onEditLyrics={editLyrics} />}
        <Timeline label={label} duration={mixer.duration} start={mixer.sectionStart} end={mixer.sectionEnd} position={position}
          peaks={channel.useCleaned ? peaks?.[name]?.cleaned ?? cleanedPeaks[name] : peaks?.[name]?.original}
          disabled={locked} onSection={(start, end) => mixer.setSection(start, end)}
          onSeek={time => void run(() => mixer.seek(time))}
          onReset={() => mixer.setSection(0, mixer.duration)} />
        <Pressable onPress={() => { if (!expanded) openStem(name); }} style={styles.consoleHeading}
          accessibilityRole="button" accessibilityLabel={`${label} mixer controls`} accessibilityState={{ expanded }}>
          <View style={styles.consoleTitleRow}>
            <Text style={styles.consoleChevron}>{expanded ? '▾' : '▸'}</Text>
            <Text style={styles.consoleTitle}>Mixer</Text>
            {!expanded && <Text style={styles.consoleAction}>Show controls</Text>}
          </View>
          <View style={styles.consoleStatus}>
            <Text style={styles.statusText}>{Math.round(channel.volume * 100)}%</Text>
            {channel.muted && <Text style={styles.statusState}>Muted</Text>}
            {channel.solo && <Text style={styles.statusState}>Solo</Text>}
            <View style={[styles.led, live && styles.ledOn]} />
            <Text style={styles.statusText}>{channel.bypassed ? 'FX off' : 'FX on'}</Text>
          </View>
        </Pressable>
        {expanded && <View style={styles.console}>
          <View style={styles.transport}>
            <IconButton primary icon={mixer.isPlaying ? 'pause' : 'play'} disabled={locked}
              accessibilityLabel={`${mixer.isPlaying ? 'Pause' : inside ? 'Resume' : 'Play'} all stems`}
              onPress={() => void run(() => mixer.isPlaying ? mixer.pause() : mixer.play())} />
            <IconButton icon="stop" disabled={locked || (!mixer.isPlaying && position === mixer.sectionStart)}
              accessibilityLabel="Stop all stems" onPress={() => void run(() => mixer.stop())} />
            <IconButton icon="mute" accessibilityLabel={`Mute ${label}`} on={channel.muted}
              onPress={() => mixer.setChannel(name, { muted: !channel.muted })} />
            <IconButton icon="muteAll" accessibilityLabel="Mute all stems" on={allMuted}
              onPress={() => STEM_NAMES.forEach(stem => mixer.setChannel(stem, { muted: !allMuted }))} />
            <IconButton icon="solo" accessibilityLabel={`Solo ${label}`} on={channel.solo}
              onPress={() => mixer.setChannel(name, { solo: !channel.solo })} />
            <IconButton icon="loop" accessibilityLabel="Loop all stems" on={mixer.loop}
              onPress={() => mixer.setLoop(!mixer.loop)} />
            <IconButton icon="reset" accessibilityLabel="Reset song settings" onPress={() => void reset()} />
          </View>
          <MasterFader value={Math.round(mixer.volume * 100)} onChange={value => mixer.setVolume(value / 100)} />
          <ScrollView horizontal style={styles.channels} contentContainerStyle={styles.channelRow}
            accessibilityLabel={`${label} faders; scroll horizontally`}>
            {EFFECT_CONTROLS.map(control => {
              const value = control.key === 'volume' ? Math.round(channel.volume * 100) : channel[control.key];
              const disabled = channel.bypassed && control.key !== 'volume';
              return <ChannelStrip key={control.key} label={control.label} display={displayValue(control.key, value)}
                value={value} min={control.min} max={control.max} step={control.step} disabled={disabled}
                note={disabled ? 'Bypassed' : UNITS[control.key]}
                onChange={next => mixer.setChannel(name, { [control.key]: control.key === 'volume' ? next / 100 : next })} />;
            })}
          </ScrollView>
          <ButtonRow style={styles.switches}>
            <LampSwitch label="Effects bypass" accessibilityLabel={`${label} effects bypass`} on={channel.bypassed}
              onPress={() => mixer.setChannel(name, { bypassed: !channel.bypassed })} />
            <LampSwitch label="Reset" accessibilityLabel={`${label} reset`} on={false}
              onPress={() => mixer.setChannel(name, { ...defaultChannel(), useCleaned: channel.useCleaned })} />
          </ButtonRow>
          <Text style={styles.consoleNote}>
            {channel.bypassed ? 'Effects bypassed. Volume, mute and solo still apply.'
              : soloing && !channel.solo ? 'Silent while another stem is soloed.'
                : 'All effects apply to this stem. Reset restores its faders and buttons only.'}
          </Text>
        </View>}
      </View>;
    })}
  </View>;
}

// The website's lyrics and 악보 controls for one stem: find, edit or regenerate, then the scrolling strip.
function StemTasks({ name, label, cleaned, tasks, position, disabled, onEditLyrics }: {
  name: StemName; label: string; cleaned: boolean; tasks: ReturnType<typeof useSongTasks>; position: number;
  disabled: boolean; onEditLyrics: () => void;
}) {
  const styles = useStyles(makeStyles);
  const vocals = name === 'vocals', harmonic = HARMONY_STEMS.includes(name);
  if (!vocals && !harmonic) return null;
  const parts = tasks.parts, part = parts?.[name];
  const regenerating = harmonic && tasks.regenerating(name);
  const action = vocals
    ? tasks.lyrics ? { label: 'Edit lyrics', onPress: onEditLyrics }
      : tasks.findingLyrics ? { label: 'Finding lyrics...' } : { label: 'Lyrics', onPress: tasks.findLyrics }
    : !parts ? tasks.findingChords ? { label: 'Finding notes...' }
      : { label: name === 'drums' ? 'Drum score' : 'Chords & melody', onPress: tasks.findChords,
        hint: 'Find chords and melody for guitar, piano, other and bass, and the drum score' }
      : regenerating ? { label: 'Regenerating...' }
        : { label: regenerateLabel(name), onPress: () => tasks.regenerate(name, cleaned), hint: `${regenerateLabel(name)} for ${label} only` };
  const failure = vocals ? tasks.lyricsFailure : tasks.chordsFailure ?? tasks.partFailure(name);
  const note = vocals ? !tasks.lyrics && tasks.findingLyrics && LYRICS_NOTE : (parts ? regenerating : tasks.findingChords) && CHORDS_NOTE;
  return <View>
    <View style={styles.taskRow}>
      <Pressable onPress={action.onPress} disabled={!action.onPress || disabled} accessibilityRole="button"
        accessibilityLabel={action.hint ?? action.label} accessibilityState={{ disabled: !action.onPress || disabled }}
        style={[styles.taskButton, (!action.onPress || disabled) && { opacity: 0.5 }]}>
        <Text style={styles.taskButtonText}>{action.label}</Text>
      </Pressable>
    </View>
    {!!failure && <Text accessibilityRole="alert" style={[styles.error, styles.taskError]}>{failure}</Text>}
    {!!note && <Text accessibilityRole="text" style={styles.taskNote}>{note}</Text>}
    {vocals && tasks.lyrics && (tasks.lyrics.length
      ? <LyricsStrip lines={tasks.lyrics} time={position} />
      : <Text style={styles.taskHint}>No lyrics were found in this stem.</Text>)}
    {harmonic && parts && (name === 'drums' && !part && !regenerating
      ? <Text style={styles.taskHint}>Press Regenerate drum score to write this song&apos;s drums.</Text>
      : hasMusic(part) && tasks.grid ? <HarmonyStrip part={part!} stem={name} grid={tasks.grid} time={position} />
        : part ? <Text style={styles.taskHint}>No clear chords or notes were found in this stem.</Text> : null)}
  </View>;
}

type ControlKey = (typeof EFFECT_CONTROLS)[number]['key'];
const UNITS: Record<ControlKey, string> = {
  volume: '%', preGain: '%', compression: '%', distortion: '%', bass: 'dB', mid: 'dB', treble: 'dB', pan: 'L / R', reverb: '%',
};
function displayValue(key: ControlKey, value: number) {
  if (key === 'pan') return value === 0 ? 'Center' : `${Math.abs(value)}${value < 0 ? 'L' : 'R'}`;
  return UNITS[key] === 'dB' ? `${value} dB` : `${value}%`;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  page: { gap: 14 }, card: { backgroundColor: t.surface, padding: 20, gap: 14, borderRadius: 12 },
  stem: { backgroundColor: t.surface, borderRadius: 10, borderWidth: 1, borderColor: t.line, overflow: 'hidden', paddingTop: 12 },
  stemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, minHeight: 36 },
  stemTitle: { fontSize: 16, fontWeight: '700', color: t.ink },
  versions: { flexDirection: 'row', borderWidth: 1, borderColor: t.accent, borderRadius: 6, overflow: 'hidden' },
  version: { paddingHorizontal: 12, minHeight: 36, justifyContent: 'center' },
  versionOn: { backgroundColor: t.accent, ...(t.accentImage && { backgroundImage: t.accentImage }) },
  versionText: { fontSize: 13, fontWeight: '700', color: t.accent },
  stemError: { marginHorizontal: 14 },
  consoleHeading: { marginTop: 12, paddingHorizontal: 14, paddingVertical: 8, minHeight: 52, flexDirection: 'row', alignItems: 'center',
    alignContent: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, backgroundImage: t.metal, borderTopWidth: 1, borderTopColor: t.consoleLine },
  consoleTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  consoleChevron: { fontSize: 13, lineHeight: 20, color: t.consoleInk },
  consoleTitle: { fontSize: 15, lineHeight: 20, fontWeight: '800', color: t.consoleInk },
  consoleAction: { fontSize: 13, lineHeight: 20, fontWeight: '600', color: t.consoleAccent },
  consoleStatus: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { fontSize: 12, lineHeight: 20, color: t.consoleInk, fontWeight: '600' },
  statusState: { fontSize: 11, color: 'white', backgroundColor: '#28384e', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  led: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#6d7b8e', borderWidth: 1, borderColor: '#3c4a5c' },
  ledOn: { backgroundColor: '#5cf08a', shadowColor: '#5cf08a', shadowOpacity: 1, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
  console: { backgroundImage: t.metal, borderTopWidth: 1, borderTopColor: t.consoleLine, paddingVertical: 10, gap: 8 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
  switches: { paddingHorizontal: 14 },
  channels: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.consoleLine },
  channelRow: { flexDirection: 'row' },
  consoleNote: { fontSize: 12, color: t.consoleMuted, paddingHorizontal: 14 },
  detail: { color: t.muted, fontSize: 13, lineHeight: 20 },
  error: { backgroundColor: t.dangerSoft, color: t.errorInk, padding: 12, borderRadius: 8 },
  taskRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, marginTop: 8 },
  taskButton: { minHeight: 36, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: t.accent, backgroundColor: t.accentSoft },
  taskButtonText: { color: t.accent, fontSize: 13, fontWeight: '700' },
  taskError: { marginHorizontal: 14, marginTop: 8 },
  taskNote: { marginHorizontal: 14, marginTop: 10, padding: 8, borderRadius: 6, backgroundColor: t.surfaceMuted, color: t.muted, fontSize: 13 },
  taskHint: { marginHorizontal: 14, marginTop: 8, color: t.muted, fontSize: 13 },
});
