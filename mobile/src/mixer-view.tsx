import { useIsFocused } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { HARMONY_STEMS, REGENERATED_STEMS, STEM_NAMES, getSong, type LyricLine, type SceneEntry, type SceneSettings, type Song, type StemName } from './api';
import { addCleanedFile, holdSong, songFiles, stemPaths } from './cache';
import { EFFECT_CONTROLS } from './effects';
import { t as text } from './i18n';
import { useT } from './language';
import { LivePanel } from './live-panel';
import { MAX_TRANSPOSE, Mixer, defaultChannel, defaultScoreChannel, type Channel } from './player';
import { FAMILY_STEM, SCORE_FAMILIES, familyEvents, loadLibrary, matchLoudness, offered, renderPartAsync, samplesFor, type Family, type SoundLibrary } from './score-parts';
import { ChannelStrip, IconButton, LampSwitch, MasterFader, Timeline } from './mixer-console';
import { EDGE } from './stem-scroll';
import { stemPeaks } from './waveform';
import { Button, Centered, errorText, useConfirm } from './ui';

import { snapshot, restore } from './mixer-settings';
import { HarmonyStrip, LyricsEditor, LyricsStrip } from './score-view';
import { LYRICS_REPLAY_LEAD, firstChange, transposeKey, transposePart } from './score';
import { shareScorePdf } from './score-pdf';
import { ScorePreview } from './score-preview';
import { scoreSheet, sheetFileName, sheetPages } from './score-sheet';
import { hasMusic, regenerateLabel, useSongTasks } from './song-tasks';
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
  const styles = useStyles(makeStyles), t = useT();
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
  useEffect(() => { mixer?.setTitle(title || song?.title || t('common.untitledSong')); }, [mixer, title, song?.title, t]);
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
      player = await Mixer.create(stemPaths(jobId, files.original), callbacks.current.title || found.title || text('common.untitledSong'), found.author,
        stemPaths(jobId, files.cleaned), found.duration);
      if (cancelled) { await player.close(); return; }
      if (initial.current) restore(player, initial.current);
      const settingsOf = (mixer: Mixer) => snapshot(mixer);
      let last = JSON.stringify(settingsOf(player));
      const current = player;
      unsubscribe = player.subscribe(() => {
        const settings = settingsOf(current), json = JSON.stringify(settings);
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
    <Button label={t('mixer.retryLoad')} onPress={() => { setMixer(null); setFraction(null); setPeaks({}); setError(''); setAttempt(value => value + 1); }} />
  </View>;
  if (!mixer) return <Centered><Text style={styles.detail}>{fraction === null ? t('mixer.loading') : t('mixer.downloading', { percent: Math.round(fraction * 100) })}</Text></Centered>;
  return <MixerControls mixer={mixer} song={song} peaks={peaks} inScene={!!entry} />;
}

// Whether the Live input card is shown; remembered while the app is open.
let liveShown = false;

// `inScene`: opened from a scene, where the mix is saved. From Music nothing is saved, so the song has no reset.
export function MixerControls({ mixer, song = null, peaks, inScene = false }: { mixer: Mixer; song?: Song | null; peaks?: StemPeaks; inScene?: boolean }) {
  const styles = useStyles(makeStyles), theme = useTheme(), t = useT();
  const [, refresh] = useReducer(count => count + 1, 0);
  const [position, setPosition] = useState(0);
  // Every stem's mixer starts folded; each opens and closes on its own.
  const [open, setOpen] = useState<ReadonlySet<StemName>>(() => new Set());
  const toggleStem = (name: StemName) => setOpen(current => {
    const next = new Set(current);
    if (!next.delete(name)) next.add(name);
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [liveOpen, setLiveOpen] = useState(liveShown);
  const [liveExpanded, setLiveExpanded] = useState(false);
  const toggleLive = () => { liveShown = !liveOpen; setLiveOpen(liveShown); };
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
        setCleanErrors(current => ({ ...current, [name]: text('mixer.cleanLoadFailed', { error: errorText(failure) }) }));
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
    if (!await confirm(t('mixer.resetTitle'), t('mixer.resetMessage'), t('mixer.resetSong'))) return;
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
  const allMuted = STEM_NAMES.every(name => mixer.channel(name).muted) && SCORE_FAMILIES.every(family => mixer.scoreChannel(family).muted);
  const soloing = mixer.liveChannel.solo || STEM_NAMES.some(name => mixer.channel(name).solo) || SCORE_FAMILIES.some(family => mixer.scoreChannel(family).solo);
  const liveChannel = mixer.liveChannel;
  const inside = position > mixer.sectionStart && position < mixer.sectionEnd;
  return <View style={styles.page}>
    {!!(error || mixer.error || tasks.error) && <Text accessibilityRole="alert" style={styles.error}>{error || mixer.error || tasks.error}</Text>}
    {tasks.findingChords && !tasks.parts && <View style={styles.status} accessibilityRole="text" accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={theme.accent} />
      <Text style={styles.statusLine}>{t('tasks.autoChords')}</Text>
    </View>}
    {editingLyrics && tasks.lyrics && <LyricsEditor lines={tasks.lyrics} duration={mixer.duration}
      onSave={saveLyrics} onClose={() => setEditingLyrics(false)} />}
    {song && <View style={styles.liveToggle}>
      <LampSwitch label={t('mixer.liveInput')} on={liveOpen} disabled={recording} onPress={toggleLive}
        accessibilityLabel={t('mixer.liveInputHint')} />
      {!liveOpen && mixer.hasTake && <Text style={styles.liveNote}>{t('mixer.takePlays')}</Text>}
    </View>}
    {song && <LivePanel key={song.jobId} open={liveOpen} mixer={mixer} song={song} tasks={tasks} position={position} onRecording={setRecording}
      console={heard => <ChannelConsole {...{ mixer, locked, inside, position, allMuted, soloing, run: operation => void run(operation), onReset: inScene ? () => void reset() : undefined, songKey: tasks.parts?.other?.key }} label={t('mixer.liveInput')} channel={liveChannel}
        expanded={liveExpanded} live={heard && !liveChannel.muted && !(soloing && !liveChannel.solo)}
        onToggle={() => setLiveExpanded(value => !value)} setChannel={change => mixer.setLiveChannel(change)}
        resetChannel={() => mixer.setLiveChannel(defaultChannel())} />} />}
    {STEM_NAMES.map(name => {
      const channel = mixer.channel(name);
      const label = t(`stem.${name}`);
      const expanded = open.has(name);
      const replaced = mixer.replacedStem === name;
      const live = mixer.isPlaying && !channel.muted && !replaced && !(soloing && !channel.solo);
      return <View key={name} style={styles.stem}>
        <View style={styles.stemHeader}>
          <Text style={styles.stemTitle}>{label}</Text>
          {mixer.hasCleaned(name) && <View style={styles.versions} accessibilityRole="radiogroup" accessibilityLabel={t('mixer.version', { stem: label })}>
            {([false, true] as const).map(cleaned => <Pressable key={String(cleaned)} accessibilityRole="radio"
              accessibilityState={{ checked: channel.useCleaned === cleaned }}
              onPress={() => mixer.setChannel(name, { useCleaned: cleaned })}
              style={[styles.version, channel.useCleaned === cleaned && styles.versionOn]}>
              <Text style={[styles.versionText, channel.useCleaned === cleaned && { color: theme.onAccent }]}>{cleaned ? t('mixer.cleaned') : t('mixer.original')}</Text>
            </Pressable>)}
          </View>}
          {!mixer.hasCleaned(name) && song && (cleanErrors[name]
            ? <Pressable onPress={() => { setCleanErrors(({ [name]: _, ...others }) => others); setCleanRetry(value => value + 1); }}
              accessibilityRole="button" accessibilityLabel={t('mixer.loadCleanedFor', { stem: label })} style={styles.taskButton}>
              <Text style={styles.taskButtonText}>{t('mixer.loadCleaned')}</Text>
            </Pressable>
            : <Pressable onPress={() => tasks.clean(name)} disabled={locked || tasks.cleaning(name)}
              accessibilityRole="button" accessibilityLabel={t('mixer.cleanFor', { stem: label })} accessibilityState={{ disabled: busy || tasks.cleaning(name) }}
              style={[styles.taskButton, (busy || tasks.cleaning(name)) && { opacity: 0.5 }]}>
              <Text style={styles.taskButtonText}>{tasks.cleaning(name) ? t('mixer.cleaning') : t('mixer.clean')}</Text>
            </Pressable>)}
        </View>
        {!!(tasks.cleanFailure(name) || cleanErrors[name]) &&
          <Text accessibilityRole="alert" style={[styles.error, styles.stemError]}>{tasks.cleanFailure(name) || cleanErrors[name]}</Text>}
        {song && <StemTasks transpose={mixer.transpose} title={song.title || t('common.untitledSong')} artist={song.author} name={name} label={label} cleaned={channel.useCleaned} tasks={tasks} position={position}
          disabled={locked} onEditLyrics={editLyrics} />}
        <Timeline label={label} duration={mixer.duration} start={mixer.sectionStart} end={mixer.sectionEnd} position={position}
          peaks={channel.useCleaned ? peaks?.[name]?.cleaned ?? cleanedPeaks[name] : peaks?.[name]?.original}
          disabled={locked} onSection={(start, end) => mixer.setSection(start, end)}
          onSeek={time => void run(() => mixer.seek(time))}
          onReset={() => mixer.setSection(0, mixer.duration)} />
        <ChannelConsole {...{ mixer, locked, inside, position, allMuted, soloing, run: operation => void run(operation), onReset: inScene ? () => void reset() : undefined, songKey: tasks.parts?.other?.key }} label={label} channel={channel} expanded={expanded} live={live} replaced={replaced}
          onToggle={() => toggleStem(name)} setChannel={change => mixer.setChannel(name, change)}
          resetChannel={() => {
            mixer.setChannel(name, { ...defaultChannel(), useCleaned: channel.useCleaned });
            if (replaced) mixer.releaseReplacedStem();
          }} />
        {(name === 'other' || name === 'bass' || name === 'drums') && <ScoreParts mixer={mixer} tasks={tasks} stem={name}
          console={(family, label, expanded, onToggle) => {
            const part = mixer.scoreChannel(family);
            return <ChannelConsole {...{ mixer, locked, inside, position, allMuted, soloing, run: operation => void run(operation), onReset: inScene ? () => void reset() : undefined, songKey: tasks.parts?.other?.key }}
              label={label} channel={part} expanded={expanded} onToggle={onToggle}
              live={mixer.isPlaying && !part.muted && !(soloing && !part.solo)}
              setChannel={change => mixer.setScoreChannel(family, change)} resetChannel={() => mixer.setScoreChannel(family, defaultScoreChannel())} />;
          }} />}
      </View>;
    })}
  </View>;
}

// The mixer console under a stem, and under the live input, which is mixed like a stem.
interface ConsoleProps {
  mixer: Mixer; label: string; channel: Channel; expanded: boolean; live: boolean; replaced?: boolean; locked: boolean;
  inside: boolean; position: number; allMuted: boolean; soloing: boolean;
  onToggle: () => void; setChannel: (change: Partial<Channel>) => void; resetChannel: () => void;
  run: (operation: () => Promise<void>) => void;
  // The whole-song reset; only given in a scene.
  onReset?: () => void;
  // The song's key from its score, shown with the key change; undefined until the score is found.
  songKey?: string;
}
function ChannelConsole({ songKey, mixer, label, channel, expanded, live, replaced = false, locked, inside, position, allMuted, soloing,
  onToggle, setChannel, resetChannel, run, onReset }: ConsoleProps) {
  const styles = useStyles(makeStyles), theme = useTheme(), t = useT();
  return <>
    <Pressable onPress={onToggle} style={styles.consoleHeading}
      accessibilityRole="button" accessibilityLabel={t('mixer.controlsFor', { stem: label })} accessibilityState={{ expanded }}>
      <View style={styles.consoleTitleRow}>
        {/* A round key with a chevron, so a folded mixer reads as one that opens. */}
        <View style={[styles.expandKey, expanded && styles.expandKeyOpen]}>
          <Svg width={18} height={18} viewBox="0 0 24 24">
            <Path d={expanded ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} stroke={expanded ? theme.onAccent : theme.accent} strokeWidth={2.8}
              strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
        </View>
        <Text style={styles.consoleTitle} numberOfLines={1}>{t('mixer.mixerFor', { stem: label })}</Text>
        <Text style={styles.consoleAction}>{t(expanded ? 'mixer.hideControls' : 'mixer.showControls')}</Text>
      </View>
      <View style={styles.consoleStatus}>
        <Text style={styles.statusText}>{Math.round(channel.volume * 100)}%</Text>
        {channel.muted && <Text style={styles.statusState}>{t('mixer.muted')}</Text>}
        {channel.solo && <Text style={styles.statusState}>{t('mixer.solo')}</Text>}
        {replaced && <Text style={styles.statusState}>{t('mixer.yourPart')}</Text>}
        <View style={[styles.led, live && styles.ledOn]} />
        <Text style={styles.statusText}>{channel.bypassed ? t('mixer.fxOff') : t('mixer.fxOn')}</Text>
      </View>
    </Pressable>
    {expanded && <View style={styles.console}>
      <View style={styles.transport}>
        <IconButton primary icon={mixer.isPlaying ? 'pause' : 'play'} disabled={locked}
          accessibilityLabel={t(mixer.isPlaying ? 'mixer.pauseAll' : inside ? 'mixer.resumeAll' : 'mixer.playAll')}
          onPress={() => void run(() => mixer.isPlaying ? mixer.pause() : mixer.play())} />
        <IconButton icon="stop" disabled={locked || (!mixer.isPlaying && position === mixer.sectionStart)}
          accessibilityLabel={t('mixer.stopAll')} onPress={() => void run(() => mixer.stop())} />
        <IconButton icon="mute" accessibilityLabel={t('mixer.muteStem', { stem: label })} on={channel.muted}
          onPress={() => setChannel({ muted: !channel.muted })} />
        <IconButton icon="muteAll" accessibilityLabel={t('mixer.muteAll')} on={allMuted}
          onPress={() => {
            STEM_NAMES.forEach(stem => mixer.setChannel(stem, { muted: !allMuted }));
            SCORE_FAMILIES.forEach(family => mixer.setScoreChannel(family, { muted: !allMuted }));
          }} />
        <IconButton icon="solo" accessibilityLabel={t('mixer.soloStem', { stem: label })} on={channel.solo}
          onPress={() => setChannel({ solo: !channel.solo })} />
        <IconButton icon="loop" accessibilityLabel={t('mixer.loopAll')} on={mixer.loop}
          onPress={() => mixer.setLoop(!mixer.loop)} />
        {onReset && <IconButton icon="reset" accessibilityLabel={t('mixer.resetSettings')} onPress={onReset} />}
      </View>
      <MasterFader value={Math.round(mixer.volume * 100)} onChange={value => mixer.setVolume(value / 100)} />
      <KeyChange mixer={mixer} songKey={songKey} />
      <ScrollView horizontal style={styles.channels} contentContainerStyle={styles.channelRow}
        accessibilityLabel={t('mixer.faders', { stem: label })}>
        {EFFECT_CONTROLS.map(control => {
          const value = control.key === 'volume' ? Math.round(channel.volume * 100) : channel[control.key];
          const disabled = channel.bypassed && control.key !== 'volume';
          return <ChannelStrip key={control.key} label={t(`effect.${control.key}`)} display={displayValue(control.key, value, t('mixer.center'))}
            value={value} min={control.min} max={control.max} step={control.step} disabled={disabled}
            note={disabled ? t('mixer.bypassed') : UNITS[control.key]}
            onChange={next => setChannel({ [control.key]: control.key === 'volume' ? next / 100 : next })} />;
        })}
      </ScrollView>
      <View style={styles.switches}>
        <LampSwitch small label={t('mixer.bypass')} accessibilityLabel={t('mixer.bypassFor', { stem: label })} on={channel.bypassed}
          onPress={() => setChannel({ bypassed: !channel.bypassed })} />
        <LampSwitch small label={t('common.reset')} accessibilityLabel={t('mixer.resetFor', { stem: label })} on={false}
          onPress={resetChannel} />
      </View>
      <Text style={styles.consoleNote}>
        {t(replaced ? 'mixer.noteReplaced' : channel.bypassed ? 'mixer.noteBypassed'
          : soloing && !channel.solo ? 'mixer.noteSoloed' : 'mixer.noteDefault')}
      </Text>
    </View>}
  </>;
}

// The scores played under their stems: the Harmonic score on guitar and on keys, the bass part on a bass, the drum
// part on a kit. For each, its sound (the song's closest to begin with) and a console like a stem's. The notes are
// made again when the part, the sound or the key changes, as loud through the song as the stem when its loudness came
// with the result.
function ScoreParts({ mixer, tasks, stem, console }: {
  mixer: Mixer; tasks: ReturnType<typeof useSongTasks>; stem: 'other' | 'bass' | 'drums';
  console: (family: Family, label: string, expanded: boolean, onToggle: () => void) => React.ReactNode;
}) {
  const styles = useStyles(makeStyles), theme = useTheme(), t = useT();
  const [library, setLibrary] = useState<SoundLibrary | null>(null);
  const [failure, setFailure] = useState('');
  const [picking, setPicking] = useState<Family | null>(null);
  const [expanded, setExpanded] = useState<Family | null>(null);
  const parts = tasks.parts, grid = tasks.grid, choices = tasks.soundChoices, loudness = tasks.loudness, transpose = mixer.transpose;
  const part = parts?.[stem];
  const families = SCORE_FAMILIES.filter(family => FAMILY_STEM[family] === stem);
  useEffect(() => { loadLibrary().then(setLibrary, error => setFailure(errorText(error))); }, []);
  const sounds = (family: Family) => library ? offered(library, choices, family) : [];
  const chosen = families.map(family => mixer.scoreSound(family)).join();
  useEffect(() => {
    if (!library || !part || !grid || !parts) return;
    let cancelled = false;
    for (const family of families) {
      const played = familyEvents(family, parts, grid, family === 'drums' ? 0 : transpose);
      const sound = mixer.scoreSound(family) ?? offered(library, choices, family)[0];
      if (!played || sound === undefined) continue;
      if (mixer.scoreSound(family) === undefined) mixer.setScoreSound(family, sound);
      const samples = samplesFor(library, family), levels = loudness?.[stem];
      mixer.decodeSound(sound, samples).then(async ({ buffer, attacks, levels: shape }) => {
        if (cancelled || mixer.scoreSound(family) !== sound) return;
        const matched = loudness && levels ? matchLoudness(played.events, played.measured, { window: loudness.window, other: levels }, samples, shape)
          : { events: played.events, gain: 1 };
        // Rendered whole, the part's level at which it is as loud as its stem included.
        const signal = await renderPartAsync(matched.events, buffer.getChannelData(0), buffer.sampleRate, samples, attacks, mixer.duration + 1, () => cancelled);
        if (!signal) return;
        if (matched.gain !== 1) for (let index = 0; index < signal.length; index++) signal[index] *= matched.gain;
        if (!cancelled && mixer.scoreSound(family) === sound) mixer.setScoreRender(family, signal);
      }, error => { if (!cancelled) setFailure(errorText(error)); });
    }
    return () => { cancelled = true; };
    // families follows stem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixer, library, part, grid, choices, loudness, transpose, chosen, stem]);
  const shown = families.filter(family => parts && grid && familyEvents(family, parts, grid, 0));
  if (!part || !library || !shown.length) return failure ? <Text accessibilityRole="alert" style={[styles.error, styles.taskError]}>{failure}</Text> : null;
  const name = (sound?: number) => sound === undefined ? '' : library.sounds[String(sound)]?.name ?? String(sound);
  return <View style={styles.scoreParts}>
    {!!failure && <Text accessibilityRole="alert" style={[styles.error, styles.taskError]}>{failure}</Text>}
    {shown.map(family => {
      const label = t(`score.${family}`);
      return <View key={family} style={styles.scorePart}>
        <View style={styles.scorePartRow}>
          <Text style={styles.scorePartName}>{label}</Text>
          <Pressable onPress={() => setPicking(family)} accessibilityRole="button" accessibilityLabel={t('score.soundFor', { part: label })}
            style={styles.soundPicker}>
            <Text style={styles.soundPickerText} numberOfLines={1}>{name(mixer.scoreSound(family))}</Text>
            <Text style={styles.soundPickerArrow}>▾</Text>
          </Pressable>
        </View>
        {console(family, label, expanded === family, () => setExpanded(open => open === family ? null : family))}
      </View>;
    })}
    <Modal visible={!!picking} transparent animationType="fade" onRequestClose={() => setPicking(null)}>
      <Pressable style={styles.sheetBackdrop} onPress={() => setPicking(null)} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
        <View style={styles.sheet}>
          <ScrollView>
            {picking && sounds(picking).map((sound, index) => {
              const chosen = mixer.scoreSound(picking) === sound;
              return <Pressable key={sound} accessibilityRole="radio" accessibilityState={{ checked: chosen }}
                onPress={() => { mixer.setScoreSound(picking, sound); setPicking(null); }} style={[styles.sheetRow, chosen && { backgroundColor: theme.accentSoft }]}>
                <Text style={[styles.sheetText, chosen && { color: theme.accent, fontWeight: '700' }]}>
                  {name(sound)}{index === 0 ? ` (${t('score.closest')})` : ''}</Text>
              </Pressable>;
            })}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  </View>;
}

// Raises or lowers the whole song, vocals included, without changing its speed.
function KeyChange({ mixer, songKey }: { mixer: Mixer; songKey?: string }) {
  const styles = useStyles(makeStyles), t = useT();
  const shift = mixer.transpose;
  // Key names when the song's key is known; semitones only until its score is found.
  const signed = shift > 0 ? `+${shift}` : String(shift);
  const value = songKey ? transposeKey(songKey, shift) : shift ? t('mixer.semitones', { count: signed }) : t('mixer.original');
  const from = songKey && shift ? t('mixer.keyFrom', { key: songKey }) : '';
  return <View style={styles.keyRow}>
    <Text style={styles.keyLabel}>{t('mixer.key').toUpperCase()}</Text>
    <IconButton icon="moveEarlier" disabled={shift <= -MAX_TRANSPOSE} accessibilityLabel={t('mixer.keyDown')}
      onPress={() => mixer.setTranspose(shift - 1)} />
    <Text style={styles.keyValue} accessibilityLiveRegion="polite">{value}{!!from && <Text style={styles.keyFrom}>  {from}</Text>}</Text>
    <IconButton icon="moveLater" disabled={shift >= MAX_TRANSPOSE} accessibilityLabel={t('mixer.keyUp')}
      onPress={() => mixer.setTranspose(shift + 1)} />
  </View>;
}

// The website's lyrics and 악보 controls for one stem: find, edit or regenerate, then the scrolling strip.
function StemTasks({ name, label, cleaned, tasks, position, disabled, onEditLyrics, transpose, title, artist }: {
  name: StemName; label: string; cleaned: boolean; tasks: ReturnType<typeof useSongTasks>; position: number;
  disabled: boolean; onEditLyrics: () => void; transpose: number; title: string; artist?: string;
}) {
  const styles = useStyles(makeStyles), t = useT();
  const vocals = name === 'vocals', harmonic = HARMONY_STEMS.includes(name);
  // The score follows the key change; drums have no pitch. Kept until the key or the score changes,
  // so the playhead's ten updates a second do not lay the score out again.
  const parts = tasks.parts, found = parts?.[name];
  const original = parts?.other?.key;
  const part = useMemo(() => found && name !== 'drums' ? transposePart(found, transpose, original) : found, [found, name, transpose, original]);
  // The bass part has no key of its own; it is written in the song's key, after any key change.
  const ensembleKey = parts?.other?.key, songKey = ensembleKey ? transposeKey(ensembleKey, transpose) : undefined;
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState('');
  const [previewing, setPreviewing] = useState(false);
  // The printed score as it is heard, key change included, with the song's title and artist.
  const grid = tasks.grid;
  const sheetText = useMemo(() => {
    const key = name === 'drums' ? undefined : part?.key ?? songKey;
    const subtitle = [label, key && t('tasks.pdfKey', { key }), transpose && ensembleKey && t('mixer.keyFrom', { key: ensembleKey })]
      .filter(Boolean).join(' · ');
    return { title, artist: artist?.trim() || undefined, subtitle, page: (page: number, pages: number) => `${page} / ${pages}` };
  }, [name, part, songKey, label, transpose, ensembleKey, title, artist, t]);
  const sheet = useMemo(() => previewing && part && grid ? sheetPages(part, name, grid, sheetText, songKey) : null,
    [previewing, part, grid, name, sheetText, songKey]);
  if (!vocals && !harmonic) return null;
  // An A4 PDF for the share sheet.
  const savePdf = async () => {
    if (!part || !grid) return;
    setSaving(true); setSaveFailure('');
    try {
      await shareScorePdf(scoreSheet(part, name, grid, sheetText, songKey), sheetFileName(title, label));
    } catch (failure) {
      setSaveFailure(t('tasks.pdfFailed', { error: failure instanceof Error ? failure.message : String(failure) }));
    } finally { setSaving(false); }
  };
  const printable = harmonic && hasMusic(part) && !!tasks.grid;
  const regenerating = harmonic && tasks.regenerating(name);
  const action = vocals
    ? tasks.lyrics ? { label: t('tasks.editLyrics'), onPress: onEditLyrics }
      : tasks.findingLyrics ? { label: t('tasks.findingLyrics') } : { label: t('tasks.lyrics'), onPress: tasks.findLyrics }
    : !parts ? tasks.findingChords ? { label: t('tasks.findingNotes') }
      : { label: t(name === 'drums' ? 'tasks.drumScore' : 'tasks.chordsMelody'), onPress: name === 'drums' ? tasks.findDrums : name === 'bass' ? tasks.findBass : tasks.findChords, hint: t('tasks.findHint') }
      : tasks.updatingChords ? { label: t('tasks.updatingNotes') }
      : regenerating ? { label: t('tasks.regenerating') }
        : !REGENERATED_STEMS.includes(name) ? null
          : { label: regenerateLabel(name), onPress: () => tasks.regenerate(name, cleaned),
            hint: t('tasks.regenerateFor', { action: regenerateLabel(name), stem: label }) };
  const failure = vocals ? tasks.lyricsFailure : tasks.chordsFailure ?? tasks.partFailure(name);
  // While a score is read or laid on the song, only that it is working and about how long.
  const note = vocals ? !tasks.lyrics && tasks.findingLyrics && t('tasks.lyricsNote')
    : tasks.processingFor(name) ? t('tasks.processing', { minutes: tasks.processingFor(name) })
      : (parts ? regenerating || tasks.updatingChords : tasks.findingChords) && t('tasks.chordsNote');
  return <View>
    {(action || printable || harmonic) && <View style={styles.taskRow}>
      {action && <Pressable onPress={action.onPress} disabled={!action.onPress || disabled || (!vocals && !!tasks.processing)} accessibilityRole="button"
        accessibilityLabel={action.hint ?? action.label} accessibilityState={{ disabled: !action.onPress || disabled }}
        style={[styles.taskButton, (!action.onPress || disabled) && { opacity: 0.5 }]}>
        <Text style={styles.taskButtonText}>{action.label}</Text>
      </Pressable>}
      {printable && <Pressable onPress={() => setPreviewing(true)} accessibilityRole="button"
        accessibilityLabel={t('tasks.previewFor', { stem: label })} style={styles.taskButton}>
        <Text style={styles.taskButtonText}>{t('tasks.preview')}</Text>
      </Pressable>}
      {/* The stem's own score (a PDF or MusicXML): its notes are taken from it from then on. */}
      {harmonic && <Pressable onPress={() => tasks.uploadScore(name)} disabled={disabled || !!tasks.processing} accessibilityRole="button"
        accessibilityLabel={t('tasks.uploadScoreFor', { stem: label })} accessibilityState={{ disabled: disabled || !!tasks.processing }}
        style={[styles.taskButton, (disabled || !!tasks.processing) && { opacity: 0.5 }]}>
        <Text style={styles.taskButtonText}>{t(tasks.hasScore(name) ? 'tasks.replaceScore' : 'tasks.uploadScore')}</Text>
      </Pressable>}
    </View>}
    {!!saveFailure && <Text accessibilityRole="alert" style={[styles.error, styles.taskError]}>{saveFailure}</Text>}
    {sheet && <ScorePreview sheet={sheet} title={[title, label].join(' · ')} saving={saving}
      onSave={() => void savePdf()} onClose={() => setPreviewing(false)} />}
    {/* The ensemble is written at concert pitch on a treble staff, the same on all three cards. */}
    {!!part?.key && <Text style={styles.taskHint}>{t('tasks.ensembleNote', { key: part.key })}</Text>}
    {!!failure && <Text accessibilityRole="alert" style={[styles.error, styles.taskError]}>{failure}</Text>}
    {!!note && <Text accessibilityRole="text" style={styles.taskNote}>{note}</Text>}
    {vocals && tasks.lyrics && (tasks.lyrics.length
      ? <LyricsStrip lines={tasks.lyrics} time={position} />
      : <Text style={styles.taskHint}>{t('tasks.noLyrics')}</Text>)}
    {harmonic && parts && (name === 'drums' && !part && !regenerating
      ? <Text style={styles.taskHint}>{t('tasks.pressDrums')}</Text>
      : hasMusic(part) && tasks.grid ? <HarmonyStrip part={part!} stem={name} grid={tasks.grid} time={position}
        songKey={songKey} />
        : part ? <Text style={styles.taskHint}>{t('tasks.noChords')}</Text> : null)}
  </View>;
}

type ControlKey = (typeof EFFECT_CONTROLS)[number]['key'];
const UNITS: Record<ControlKey, string> = {
  volume: '%', preGain: '%', compression: '%', distortion: '%', bass: 'dB', mid: 'dB', treble: 'dB', pan: 'L / R', reverb: '%',
};
function displayValue(key: ControlKey, value: number, center: string) {
  if (key === 'pan') return value === 0 ? center : `${Math.abs(value)}${value < 0 ? 'L' : 'R'}`;
  return UNITS[key] === 'dB' ? `${value} dB` : `${value}%`;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Edge to edge under the scroll rails; the pages inset their other content by EDGE.
  page: { gap: 14, marginHorizontal: -EDGE }, card: { backgroundColor: t.surface, padding: 20, gap: 14, borderRadius: 12 },
  stem: { backgroundColor: t.surface, borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.line, overflow: 'hidden', paddingTop: 12 },
  stemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: EDGE, minHeight: 36 },
  stemTitle: { fontSize: 16, fontWeight: '700', color: t.ink },
  versions: { flexDirection: 'row', borderWidth: 1, borderColor: t.accent, borderRadius: 6, overflow: 'hidden' },
  version: { paddingHorizontal: 12, minHeight: 36, justifyContent: 'center' },
  versionOn: { backgroundColor: t.accent, ...(t.accentImage && { backgroundImage: t.accentImage }) },
  versionText: { fontSize: 13, fontWeight: '700', color: t.accent },
  stemError: { marginHorizontal: EDGE },
  consoleHeading: { marginTop: 12, paddingHorizontal: EDGE, paddingVertical: 8, minHeight: 52, flexDirection: 'row', alignItems: 'center',
    alignContent: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, backgroundImage: t.metal, borderTopWidth: 1, borderTopColor: t.consoleLine },
  consoleTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  expandKey: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.accent,
    backgroundColor: t.surface },
  expandKeyOpen: { backgroundColor: t.accent, ...(t.accentImage && { backgroundImage: t.accentImage }) },
  consoleTitle: { fontSize: 15, lineHeight: 20, fontWeight: '800', color: t.consoleInk },
  consoleAction: { fontSize: 13, lineHeight: 20, fontWeight: '600', color: t.consoleAccent },
  liveToggle: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 8, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line },
  statusLine: { flex: 1, fontSize: 13, lineHeight: 18, color: t.ink },
  liveNote: { flex: 1, fontSize: 12, color: t.muted },
  consoleStatus: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { fontSize: 12, lineHeight: 20, color: t.consoleInk, fontWeight: '600' },
  statusState: { fontSize: 11, color: 'white', backgroundColor: '#28384e', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  led: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#6d7b8e', borderWidth: 1, borderColor: '#3c4a5c' },
  ledOn: { backgroundColor: '#5cf08a', shadowColor: '#5cf08a', shadowOpacity: 1, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
  console: { backgroundImage: t.metal, borderTopWidth: 1, borderTopColor: t.consoleLine, paddingVertical: 10, gap: 8 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: EDGE },
  switches: { flexDirection: 'row', gap: 8, paddingHorizontal: EDGE },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: EDGE },
  keyLabel: { fontSize: 11, fontWeight: '800', letterSpacing: .5, color: t.consoleInk, minWidth: 46 },
  keyValue: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '800', color: t.consoleInk },
  keyFrom: { fontSize: 12, fontWeight: '600', color: t.consoleMuted },
  channels: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.consoleLine },
  channelRow: { flexDirection: 'row' },
  consoleNote: { fontSize: 12, color: t.consoleMuted, paddingHorizontal: EDGE },
  detail: { color: t.muted, fontSize: 13, lineHeight: 20 },
  error: { backgroundColor: t.dangerSoft, color: t.errorInk, padding: 12, borderRadius: 8 },
  taskRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: EDGE, marginTop: 8 },
  taskButton: { minHeight: 36, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: t.accent, backgroundColor: t.accentSoft },
  taskButtonText: { color: t.accent, fontSize: 13, fontWeight: '700' },
  taskError: { marginHorizontal: EDGE, marginTop: 8 },
  taskNote: { marginHorizontal: EDGE, marginTop: 10, padding: 8, borderRadius: 6, backgroundColor: t.surfaceMuted, color: t.muted, fontSize: 13 },
  taskHint: { marginHorizontal: EDGE, marginTop: 8, color: t.muted, fontSize: 13 },
  scoreParts: { marginTop: 12, gap: 0 },
  scorePart: { borderTopWidth: 1, borderTopColor: t.line, paddingTop: 10 },
  scorePartRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: EDGE },
  scorePartName: { fontSize: 15, fontWeight: '700', color: t.ink, minWidth: 56 },
  soundPicker: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 38, paddingHorizontal: 12,
    borderRadius: 8, borderWidth: 1, borderColor: t.line, backgroundColor: t.surface },
  soundPickerText: { flex: 1, fontSize: 14, fontWeight: '600', color: t.ink },
  soundPickerArrow: { fontSize: 13, color: t.muted, marginLeft: 8 },
  sheetBackdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  sheet: { maxHeight: '60%', backgroundColor: t.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingVertical: 8 },
  sheetRow: { paddingHorizontal: 20, paddingVertical: 14 },
  sheetText: { fontSize: 16, color: t.ink },
});
