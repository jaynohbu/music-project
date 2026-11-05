// Play along live: the band follows the player's tempo, and the take is kept as the song's user stem.
import { useEffect, useReducer, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import type { Song } from './api';
import { INSTRUMENTS, MAX_RATE, MIN_RATE, instrument, type InstrumentId } from './live-follow';
import { LiveSession, STRENGTHS, type FollowStrength } from './live-session';
import { deleteTake, loadTake, saveTake, takePath, type LiveTake } from './live-take';
import { IconButton, LampSwitch, MasterFader } from './mixer-console';
import type { Mixer } from './player';
import type { useSongTasks } from './song-tasks';
import { type Theme, useStyles, useTheme } from './theme';
import { errorText, useConfirm } from './ui';

const SYNC_STEP = 0.01;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const HINTS: Record<InstrumentId, string> = {
  guitar: 'Plug your guitar into an audio interface',
  bass: 'Plug your bass into an audio interface',
  keyboard: 'Connect the keyboard’s line out to an audio interface',
  piano: 'Put the phone near the piano or use a mic on an interface',
  drums: 'Put the phone near the kit, or mic the snare through an interface',
  vocals: 'Sing into a mic on an audio interface or a headset mic',
  other: 'Use an audio interface or put the phone near your instrument',
};
const track = (jobId: string, take: LiveTake) => ({ path: takePath(jobId, take), duration: take.duration, latency: take.latency,
  points: take.points, volume: take.volume, muted: take.muted });

export function LivePanel({ mixer, song, tasks, position, onRecording }: {
  mixer: Mixer; song: Song; tasks: ReturnType<typeof useSongTasks>; position: number; onRecording: (recording: boolean) => void;
}) {
  const styles = useStyles(makeStyles), theme = useTheme();
  const confirm = useConfirm();
  const jobId = song.jobId;
  // The panel is keyed by song, so the saved take is read once.
  const [saved] = useState(() => loadTake(jobId));
  const [take, setTake] = useState(saved);
  // One take per song: the take's instrument is the song's, and the picker relabels it.
  const [chosen, setChosen] = useState<InstrumentId>(saved?.instrument ?? 'guitar');
  const [replace, setReplace] = useState(saved?.replace ?? true);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [strength, setStrength] = useState<FollowStrength>('normal');
  const [monitor, setMonitor] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [, refresh] = useReducer(count => count + 1, 0);
  const active = useRef<LiveSession | null>(null);

  useEffect(() => {
    if (saved) mixer.attachTake(track(jobId, saved)).catch(failure => setError(`Your take could not be loaded: ${errorText(failure)}`));
  }, [saved, jobId, mixer]);
  // Leaving the screen mid-take keeps what was played.
  useEffect(() => () => { void active.current?.stop(true).catch(failure => console.warn('Live take was not saved', failure)); }, []);
  useEffect(() => session?.subscribe(refresh), [session]);

  const current = instrument(chosen);
  const recording = !!session;
  // The band's matching part goes quiet while the player is heard: live, or through an unmuted take.
  const replacedStem = replace && current.stem && (recording || (take && !take.muted)) ? current.stem : null;
  useEffect(() => { mixer.setReplacedStem(replacedStem); }, [mixer, replacedStem]);
  useEffect(() => () => mixer.setReplacedStem(null), [mixer]);

  const finished = (saved: LiveTake | null, failure?: string) => {
    active.current = null;
    setSession(null); onRecording(false);
    if (saved) setTake(saved);
    if (failure) setError(failure);
  };
  const record = async () => {
    if (!tasks.grid) return;
    if (take && !await confirm('Record a new take?', 'Your current take and its tempo will be replaced when the new one is saved.', 'Record new take')) return;
    setError(''); setStarting(true);
    try {
      const started = await LiveSession.start({ mixer, jobId, beats: tasks.grid.beats, strength, monitor, previous: take, instrument: chosen, replace });
      started.onFinished = finished;
      active.current = started;
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
    if (!await confirm('Delete your take?', 'Delete your recording and the tempo the band followed? The stems play at their normal speed again.', 'Delete take')) return;
    try { await mixer.removeTake(); deleteTake(jobId); setTake(null); }
    catch (failure) { setError(errorText(failure)); }
  };
  const choose = (id: InstrumentId) => { setChosen(id); update({ instrument: id }); };
  const toggleReplace = () => { setReplace(!replace); update({ replace: !replace }); };
  const update = (change: Partial<LiveTake>) => {
    if (!take) return;
    const next = { ...take, ...change };
    setTake(next);
    saveTake(jobId, next);
    if (change.latency !== undefined) void mixer.attachTake(track(jobId, next)).catch(failure => setError(errorText(failure)));
    else if (change.volume !== undefined || change.muted !== undefined) mixer.setTakeLevel({ volume: next.volume, muted: next.muted });
  };

  const status = session?.status;
  const stemLabel = current.stem ? current.stem[0].toUpperCase() + current.stem.slice(1) : '';
  return <View style={styles.card}>
    <View style={styles.header}>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{current.id === 'other' ? 'Live instrument' : `Live ${current.label.toLowerCase()}`}</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {recording ? 'Recording. The band follows your tempo.'
            : take ? `Your take · ${clock(take.duration)} · ${new Date(take.recordedAt).toLocaleDateString()}`
              : 'Play along and the band follows you.'}
        </Text>
      </View>
      {take && !recording && <IconButton icon="remove" danger accessibilityLabel="Delete your take" onPress={() => void remove()} />}
      <IconButton icon={recording ? 'stop' : 'record'} primary={recording} danger={!recording}
        disabled={starting || (!recording && !tasks.grid)}
        accessibilityLabel={recording ? 'Stop recording and save the take' : take ? 'Record a new take' : 'Record a take'}
        onPress={() => void (recording ? stop() : record())} />
    </View>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!tasks.grid && !recording && <View style={styles.row}>
      <Text style={[styles.note, styles.grow]}>
        {tasks.findingChords ? 'Finding the beats… The band can follow you once they are ready.' : 'The band needs the song’s beats to follow you.'}
      </Text>
      {!tasks.findingChords && <Pressable onPress={tasks.findChords} accessibilityRole="button" style={styles.chip}>
        <Text style={styles.chipText}>Find beats</Text>
      </Pressable>}
    </View>}
    {recording && status && <View style={styles.readout} accessibilityLiveRegion="polite">
      <View style={[styles.recLamp, status.seconds % 1 < .5 && styles.recLampOn]} />
      <Text style={styles.readoutText}>{clock(status.seconds)}</Text>
      <Text style={styles.readoutText}>Band {status.rate.toFixed(2)}×</Text>
      <Text style={styles.readoutText}>{status.locked ? `Beat ${Math.max(1, Math.round(status.beat) + 1)}` : status.notes ? 'Listening…' : 'Waiting for you'}</Text>
      <View style={styles.meter} accessibilityLabel="Input level">
        <View style={[styles.meterFill, { width: `${Math.max(0, Math.min(100, (status.level + 60) / 60 * 100))}%` }]} />
      </View>
    </View>}
    {!recording && <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Your instrument">
      {INSTRUMENTS.map(item => <Pressable key={item.id} onPress={() => choose(item.id)} accessibilityRole="radio"
        accessibilityState={{ checked: chosen === item.id }} style={[styles.pick, chosen === item.id && styles.segmentOn]}>
        <Text style={[styles.segmentText, chosen === item.id && { color: theme.onAccent }]}>{item.label}</Text>
      </Pressable>)}
    </View>}
    {!recording && !!current.stem && <View style={styles.row}>
      <LampSwitch label={`Band ${current.stem} off`} on={replace} onPress={toggleReplace}
        accessibilityLabel={`Silence the band's ${current.stem} stem while you play`} />
      <Text style={[styles.note, styles.grow]}>{replace ? `${stemLabel} stem is off while your part plays.` : `${stemLabel} stem plays with you.`}</Text>
    </View>}
    {!recording && !!tasks.grid && <View style={styles.row}>
      <Text style={styles.label}>Follow</Text>
      <View style={styles.segments} accessibilityRole="radiogroup" accessibilityLabel="How closely the band follows">
        {STRENGTHS.map(item => <Pressable key={item.id} onPress={() => setStrength(item.id)} accessibilityRole="radio"
          accessibilityState={{ checked: strength === item.id }} style={[styles.segment, strength === item.id && styles.segmentOn]}>
          <Text style={[styles.segmentText, strength === item.id && { color: theme.onAccent }]}>{item.label}</Text>
        </Pressable>)}
      </View>
      <LampSwitch label="Hear input" on={monitor} onPress={() => setMonitor(value => !value)}
        accessibilityLabel="Hear your instrument through the phone while recording" />
    </View>}
    {take && !recording && <>
      <TempoLine take={take} duration={mixer.duration} position={position} />
      <View style={styles.row}>
        <IconButton icon="mute" on={take.muted} accessibilityLabel="Mute your take" onPress={() => update({ muted: !take.muted })} />
        <View style={styles.grow}>
          <MasterFader label="Take" value={Math.round(take.volume * 100)} onChange={value => update({ volume: value / 100 })} />
        </View>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Sync</Text>
        <Pressable onPress={() => update({ latency: Math.max(-0.3, take.latency - SYNC_STEP) })} accessibilityRole="button"
          accessibilityLabel="Play your take earlier" style={styles.chip}><Text style={styles.chipText}>Earlier</Text></Pressable>
        <Text style={styles.readoutValue}>{Math.round(take.latency * 1000)} ms</Text>
        <Pressable onPress={() => update({ latency: Math.min(0.5, take.latency + SYNC_STEP) })} accessibilityRole="button"
          accessibilityLabel="Play your take later" style={styles.chip}><Text style={styles.chipText}>Later</Text></Pressable>
      </View>
    </>}
    {!recording && <Text style={styles.note}>
      {HINTS[current.id]} and use wired headphones; Bluetooth adds delay. The band catches up within a beat or two.
    </Text>}
  </View>;
}

// The band's speed across the song while the take was recorded, with a line at normal speed.
function TempoLine({ take, duration, position }: { take: LiveTake; duration: number; position: number }) {
  const styles = useStyles(makeStyles), theme = useTheme();
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
      accessibilityLabel={`Tempo of your take: from ${slowest.toFixed(2)} to ${fastest.toFixed(2)} times the original speed`}>
      {!!width && <Svg width={width} height={height}>
        <Line x1={0} x2={width} y1={y(1)} y2={y(1)} stroke={theme.waveLine} strokeWidth={1} strokeDasharray="4 4" />
        <Path d={path} stroke={theme.waveBar} strokeWidth={2} fill="none" strokeLinejoin="round" />
        <Line x1={x(position)} x2={x(position)} y1={0} y2={height} stroke={theme.playhead} strokeWidth={1.5} />
      </Svg>}
    </View>
    <View style={styles.tempoLegend}>
      <Text style={styles.legend}>Tempo the band followed</Text>
      <Text style={styles.legend}>{slowest.toFixed(2)}× – {fastest.toFixed(2)}×</Text>
    </View>
  </View>;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  card: { backgroundColor: t.surface, borderRadius: 10, borderWidth: 1, borderColor: t.line, padding: 14, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
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
