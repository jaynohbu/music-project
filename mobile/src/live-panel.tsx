// Play along live: the input is heard and mixed like a stem, its instrument is found automatically,
// the band follows the player's tempo, and the take is kept as the song's user stem.
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import type { Song } from './api';
import { MAX_RATE, MIN_RATE, instrument, type InstrumentId } from './live-follow';
import { LiveSession, STRENGTHS, type FollowStrength } from './live-session';
import { deleteTake, loadTake, saveTake, takePath, type LiveTake } from './live-take';
import { t as text } from './i18n';
import { useLanguage } from './language';
import { IconButton, LampSwitch } from './mixer-console';
import type { Mixer } from './player';
import type { useSongTasks } from './song-tasks';
import { EDGE } from './stem-scroll';
import { type Theme, useStyles, useTheme } from './theme';
import { errorText, useConfirm } from './ui';

const SYNC_STEP = 0.01;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const track = (jobId: string, take: LiveTake) => ({ path: takePath(jobId, take), duration: take.duration, latency: take.latency,
  points: take.points, volume: take.volume, muted: take.muted });

export function LivePanel({ open, mixer, song, tasks, position, onRecording, console: mixerConsole }: {
  open: boolean; mixer: Mixer; song: Song; tasks: ReturnType<typeof useSongTasks>; position: number; onRecording: (recording: boolean) => void;
  // The same mixer console the stems have; `heard` is whether the input or the take is sounding.
  console: (heard: boolean) => ReactNode;
}) {
  const styles = useStyles(makeStyles), theme = useTheme(), { t, language } = useLanguage();
  const confirm = useConfirm();
  const jobId = song.jobId;
  // The panel is keyed by song, so the saved take is read once.
  const [saved] = useState(() => loadTake(jobId));
  const [take, setTake] = useState(saved);
  // Found from the input while recording; a saved take keeps the instrument it was played on.
  const [detected, setDetected] = useState<InstrumentId | null>(saved?.instrument ?? null);
  // Part of the scene entry's mix (mixer-settings.ts), so it is kept per scene, not per song. Off by default:
  // the instrument is guessed, and a wrong guess would silence a band part.
  const replace = mixer.replacePart;
  const [session, setSession] = useState<LiveSession | null>(null);
  const [strength, setStrength] = useState<FollowStrength>('normal');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [, refresh] = useReducer(count => count + 1, 0);
  const active = useRef<LiveSession | null>(null);

  useEffect(() => {
    if (!saved) return;
    mixer.attachTake(track(jobId, saved)).catch(failure => setError(text('live.loadFailed', { error: errorText(failure) })));
  }, [saved, jobId, mixer]);
  // Leaving the screen mid-take keeps what was played.
  useEffect(() => () => { void active.current?.stop(true).catch(failure => console.warn('Live take was not saved', failure)); }, []);
  useEffect(() => session?.subscribe(refresh), [session]);

  const { muted } = mixer.liveChannel;

  const current = detected ? instrument(detected) : null;
  const recording = !!session;
  // The band's matching part goes quiet while the player is heard: live, or through an unmuted take.
  const replacedStem = replace && current?.stem && (recording || (take && !muted)) ? current.stem : null;
  useEffect(() => { mixer.setReplacedStem(replacedStem); }, [mixer, replacedStem]);
  useEffect(() => () => mixer.setReplacedStem(null), [mixer]);
  const finished = (saved: LiveTake | null, failure?: string) => {
    active.current = null;
    setSession(null); onRecording(false);
    if (saved) { setTake(saved); setDetected(saved.instrument); }
    if (failure) setError(failure);
  };
  const record = async () => {
    if (!tasks.grid) return;
    if (take && !await confirm(t('live.newTitle'), t('live.newMessage'), t('live.newAction'))) return;
    setError(''); setStarting(true);
    try {
      const started = await LiveSession.start({ mixer, jobId, beats: tasks.grid.beats, strength, previous: take, replace });
      started.onFinished = finished;
      started.onInstrument = setDetected;
      active.current = started;
      setDetected(null);
      setSession(started); onRecording(true);
    } catch (failure) { setError(errorText(failure)); }
    finally { setStarting(false); }
  };
  const stop = async () => {
    if (!session) return;
    try { finished(await session.stop(true)); }
    catch (failure) { finished(null, errorText(failure)); }
  };
  const remove = async () => {
    if (!await confirm(t('live.deleteTitle'), t('live.deleteMessage'), t('live.deleteAction'))) return;
    try { await mixer.removeTake(); deleteTake(jobId); setTake(null); }
    catch (failure) { setError(errorText(failure)); }
  };
  const toggleReplace = () => mixer.setReplacePart(!replace);
  const update = (change: Partial<LiveTake>) => {
    if (!take) return;
    const next = { ...take, ...change };
    setTake(next);
    saveTake(jobId, next);
    if (change.latency !== undefined) void mixer.attachTake(track(jobId, next)).catch(failure => setError(errorText(failure)));
  };

  // Hidden, the panel still loads the take and keeps the band's part silenced while it plays.
  if (!open && !recording) return null;
  const status = session?.status;
  const stemLabel = current?.stem ? t(`stem.${current.stem}`) : '';
  const instrumentLabel = current ? t(`instrument.${current.id}`) : '';
  return <View style={styles.card}>
    <View style={styles.header}>
      <View style={styles.titleBlock}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{t('mixer.liveInput')}</Text>
          <Text style={[styles.badge, !current && styles.badgeWaiting]} accessibilityLiveRegion="polite">
            {current ? instrumentLabel : recording ? t('live.detecting') : t('live.autoInstrument')}
          </Text>
        </View>
        <Text style={styles.subtitle} numberOfLines={1}>
          {recording ? t('live.recordingStatus')
            : take ? t('live.yourTake', { length: clock(take.duration), date: new Date(take.recordedAt).toLocaleDateString(language) })
              : t('live.intro')}
        </Text>
      </View>
      {take && !recording && <IconButton icon="remove" danger accessibilityLabel={t('live.deleteTake')} onPress={() => void remove()} />}
      <IconButton icon={recording ? 'stop' : 'record'} primary={recording} danger={!recording}
        disabled={starting || (!recording && !tasks.grid)}
        accessibilityLabel={t(recording ? 'live.stopSave' : take ? 'live.recordNew' : 'live.record')}
        onPress={() => void (recording ? stop() : record())} />
    </View>
    <View style={styles.body}>
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {!tasks.grid && !recording && <View style={styles.row}>
        <Text style={[styles.note, styles.grow]}>
          {t(tasks.findingChords ? 'live.findingBeats' : 'live.needBeats')}
        </Text>
        {!tasks.findingChords && <Pressable onPress={tasks.findDrums} accessibilityRole="button" style={styles.chip}>
          <Text style={styles.chipText}>{t('live.findBeats')}</Text>
        </Pressable>}
      </View>}
      {recording && status && <View style={styles.readout} accessibilityLiveRegion="polite">
        <View style={[styles.recLamp, status.seconds % 1 < .5 && styles.recLampOn]} />
        <Text style={styles.readoutText}>{clock(status.seconds)}</Text>
        <Text style={styles.readoutText}>{t('live.band', { rate: status.rate.toFixed(2) })}</Text>
        <Text style={styles.readoutText}>{status.locked ? t('live.beat', { beat: Math.max(1, Math.round(status.beat) + 1) }) : t(status.notes ? 'live.listening' : 'live.waiting')}</Text>
        <View style={styles.meter} accessibilityLabel={t('live.level')}>
          <View style={[styles.meterFill, { width: `${Math.max(0, Math.min(100, (status.level + 60) / 60 * 100))}%` }]} />
        </View>
      </View>}
      {!recording && !!current?.stem && <View style={styles.row}>
        <LampSwitch label={t('live.bandOff', { stem: stemLabel })} on={replace} onPress={toggleReplace}
          accessibilityLabel={t('live.silenceHint', { stem: stemLabel })} />
        <Text style={[styles.note, styles.grow]}>{t(replace ? 'live.stemOff' : 'live.stemOn', { stem: stemLabel })}</Text>
      </View>}
      {!recording && !!tasks.grid && <View style={styles.row}>
        <Text style={styles.label}>{t('live.follow')}</Text>
        <View style={styles.segments} accessibilityRole="radiogroup" accessibilityLabel={t('live.followHint')}>
          {STRENGTHS.map(item => <Pressable key={item.id} onPress={() => setStrength(item.id)} accessibilityRole="radio"
            accessibilityState={{ checked: strength === item.id }} style={[styles.segment, strength === item.id && styles.segmentOn]}>
            <Text style={[styles.segmentText, strength === item.id && { color: theme.onAccent }]}>{t(`follow.${item.id}`)}</Text>
          </Pressable>)}
        </View>
      </View>}
      {take && !recording && <>
        <TempoLine take={take} duration={mixer.duration} position={position} />
        <View style={styles.row}>
          <Text style={styles.label}>{t('live.sync')}</Text>
          <Pressable onPress={() => update({ latency: Math.max(-0.3, take.latency - SYNC_STEP) })} accessibilityRole="button"
            accessibilityLabel={t('live.earlierHint')} style={styles.chip}><Text style={styles.chipText}>{t('live.earlier')}</Text></Pressable>
          <Text style={styles.readoutValue}>{Math.round(take.latency * 1000)} ms</Text>
          <Pressable onPress={() => update({ latency: Math.min(0.5, take.latency + SYNC_STEP) })} accessibilityRole="button"
            accessibilityLabel={t('live.laterHint')} style={styles.chip}><Text style={styles.chipText}>{t('live.later')}</Text></Pressable>
        </View>
      </>}
      {!recording && <Text style={styles.note}>
        {t(`live.hint.${current?.id ?? 'other'}`)} {t('live.headphones')}
      </Text>}
    </View>
    {mixerConsole(recording || (!!take && mixer.isPlaying))}
  </View>;
}

// The band's speed across the song while the take was recorded, with a line at normal speed.
function TempoLine({ take, duration, position }: { take: LiveTake; duration: number; position: number }) {
  const styles = useStyles(makeStyles), theme = useTheme(), { t } = useLanguage();
  const [width, setWidth] = useState(0);
  const height = 56;
  const x = (pos: number) => Math.max(0, Math.min(1, pos / duration)) * width;
  const y = (rate: number) => (1 - (rate - MIN_RATE) / (MAX_RATE - MIN_RATE)) * height;
  const points = take.points;
  let path = '';
  if (width && points.length) {
    const end = Math.min(duration, points.at(-1)!.pos + (take.duration - points.at(-1)!.at) * points.at(-1)!.rate);
    path = `M${x(points[0].pos)} ${y(points[0].rate)}`;
    points.forEach((point, index) => {
      if (index) path += `L${x(point.pos)} ${y(points[index - 1].rate)}L${x(point.pos)} ${y(point.rate)}`;
    });
    path += `L${x(end)} ${y(points.at(-1)!.rate)}`;
  }
  const fastest = Math.max(...points.map(point => point.rate)), slowest = Math.min(...points.map(point => point.rate));
  return <View>
    <View style={styles.tempo} onLayout={event => setWidth(event.nativeEvent.layout.width)}
      accessibilityLabel={t('live.tempoLabel', { slow: slowest.toFixed(2), fast: fastest.toFixed(2) })}>
      {!!width && <Svg width={width} height={height}>
        <Line x1={0} x2={width} y1={y(1)} y2={y(1)} stroke={theme.waveLine} strokeWidth={1} strokeDasharray="4 4" />
        <Path d={path} stroke={theme.waveBar} strokeWidth={2} fill="none" strokeLinejoin="round" />
        <Line x1={x(position)} x2={x(position)} y1={0} y2={height} stroke={theme.playhead} strokeWidth={1.5} />
      </Svg>}
    </View>
    <View style={styles.tempoLegend}>
      <Text style={styles.legend}>{t('live.tempoLegend')}</Text>
      <Text style={styles.legend}>{slowest.toFixed(2)}× – {fastest.toFixed(2)}×</Text>
    </View>
  </View>;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // The same card as a stem's (mixer-view.tsx), so the live input reads as one more part of the mix.
  card: { backgroundColor: t.surface, borderRadius: 10, borderWidth: 1, borderColor: t.line, overflow: 'hidden', paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: EDGE, minHeight: 36 },
  body: { paddingHorizontal: EDGE, paddingTop: 10, gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badge: { fontSize: 12, fontWeight: '700', color: t.onAccent, backgroundColor: t.accent, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  badgeWaiting: { color: t.muted, backgroundColor: t.surfaceMuted },
  titleBlock: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '700', color: t.ink },
  subtitle: { fontSize: 12, color: t.muted, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: 0 },
  label: { fontSize: 13, fontWeight: '700', color: t.ink },
  note: { fontSize: 12, lineHeight: 17, color: t.muted },
  error: { backgroundColor: t.dangerSoft, color: t.errorInk, padding: 10, borderRadius: 8 },
  chip: { minHeight: 32, paddingHorizontal: 10, justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: t.accent, backgroundColor: t.accentSoft },
  chipText: { fontSize: 13, fontWeight: '700', color: t.accent },
  segments: { flexDirection: 'row', borderWidth: 1, borderColor: t.accent, borderRadius: 6, overflow: 'hidden' },
  segment: { paddingHorizontal: 10, minHeight: 32, justifyContent: 'center' },
  pick: { paddingHorizontal: 10, minHeight: 32, justifyContent: 'center', borderWidth: 1, borderColor: t.accent, borderRadius: 6, overflow: 'hidden' },
  segmentOn: { backgroundColor: t.accent, ...(t.accentImage && { backgroundImage: t.accentImage }) },
  segmentText: { fontSize: 12, fontWeight: '700', color: t.accent },
  readout: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', backgroundColor: t.wave, borderRadius: 8, padding: 10 },
  readoutText: { fontSize: 13, fontWeight: '700', color: t.ink, fontVariant: ['tabular-nums'] },
  readoutValue: { fontSize: 13, fontWeight: '700', color: t.ink, minWidth: 52, textAlign: 'center', fontVariant: ['tabular-nums'] },
  recLamp: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#6d2a30' },
  recLampOn: { backgroundColor: '#ff3b47' },
  meter: { flex: 1, minWidth: 60, height: 6, borderRadius: 3, backgroundColor: t.waveLine, overflow: 'hidden' },
  meterFill: { height: 6, backgroundColor: t.end },
  tempo: { height: 56, backgroundColor: t.wave, borderRadius: 6, overflow: 'hidden' },
  tempoLegend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  legend: { fontSize: 11, color: t.muted },
});
