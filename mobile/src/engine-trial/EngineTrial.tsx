// Temporary audio engine trial (design doc, step 1). Never ships: index.ts only
// loads it when EXPO_PUBLIC_ENGINE_TRIAL=1.
//
// Each pair of files holds the same tones with opposite polarity, so the mix cancels
// to near silence only while they stay aligned. Any drift shows up as a louder mix.
import { Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import {
  AudioContext, AudioManager, MediaElementAudioSourceNode, PlaybackNotificationManager, type AnalyserNode, type GainNode,
} from 'react-native-audio-api';
// @ts-expect-error Not part of the public API; needed to schedule a shared start time.
import { AudioFileSourceNode } from 'react-native-audio-api/lib/module/Audio/AudioFileSourceNode';

// iOS reads the files embedded by app.config.js; Android reads what push-test-audio.sh copied.
const DIRECTORY = Platform.OS === 'ios'
  ? decodeURI(Paths.bundle.uri.replace(/^file:\/\//, '').replace(/\/$/, ''))
  : '/storage/emulated/0/Android/data/com.tunesbasis.sorituh/files/trial';
const NAMES = ['0a', '0b', '1a', '1b', '2a', '2b'];
const START_DELAY = 0.2;
const SEEK_SETTLE_MS = 500;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Stem {
  name: string;
  source: any;
  routed: MediaElementAudioSourceNode;
  gain: GainNode;
}

function build(context: AudioContext, seconds: number, effects: boolean) {
  const master = context.createGain();
  const analyser: AnalyserNode = context.createAnalyser();
  analyser.fftSize = 2048;
  master.connect(analyser);
  analyser.connect(context.destination);

  const stems: Stem[] = NAMES.map(name => {
    const native = context.context.createFileSource({
      source: `${DIRECTORY}/s${seconds}_${name}.mp4`, loop: false, volume: 1, playbackRate: 1, preservesPitch: false,
    });
    if (!native) throw new Error('File source is unavailable; FFmpeg is missing.');
    const source = new AudioFileSourceNode(context, native);
    // Without this routing, start() also connects the source straight to the speakers.
    const routed = new MediaElementAudioSourceNode(context, {
      mediaElement: { getFileSourceNode: () => native } as any,
    });
    const gain = context.createGain();
    if (effects) {
      // The EQ from web/src/stem-effects.ts. Compressor and reverb are out of scope.
      const bass = context.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 150;
      bass.gain.value = 3;
      const mid = context.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 1000;
      mid.Q.value = 0.7;
      mid.gain.value = -2;
      const treble = context.createBiquadFilter();
      treble.type = 'highshelf';
      treble.frequency.value = 4000;
      treble.gain.value = 2;
      routed.connect(bass);
      bass.connect(mid);
      mid.connect(treble);
      treble.connect(gain);
    } else {
      routed.connect(gain);
    }
    gain.connect(master);
    return { name, source, routed, gain };
  });
  return { analyser, stems };
}

function levels(analyser: AnalyserNode, buffer: Float32Array) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const value of buffer) sum += value * value;
  return 10 * Math.log10(sum / buffer.length + 1e-12);
}

type Log = (line: string) => void;

const startAll = (context: AudioContext, stems: Stem[]) => {
  const when = context.currentTime + START_DELAY;
  for (const { source } of stems) source.getFileSourceNode().start(when);
};
const spread = (stems: Stem[]) => {
  const times = stems.map(({ source }) => source.getCurrentTime());
  return { position: times[0], spreadMs: (Math.max(...times) - Math.min(...times)) * 1000 };
};
const seekAll = async (stems: Stem[], target: number) => {
  for (const { source } of stems) source.pause();
  for (const { source } of stems) source.seekToTime(target);
  await wait(SEEK_SETTLE_MS);
};

// Measures the worst and median level over a window, and confirms audio really plays.
async function measure(log: Log, label: string, analyser: AnalyserNode, stems: Stem[], seconds: number) {
  const buffer = new Float32Array(analyser.fftSize);
  const values: number[] = [];
  let maxSpread = 0;
  const firstPosition = spread(stems).position;
  const firstClock = analyser.context.currentTime;
  for (let i = 0; i < seconds * 4; i++) {
    await wait(250);
    values.push(levels(analyser, buffer));
    maxSpread = Math.max(maxSpread, spread(stems).spreadMs);
  }
  values.sort((a, b) => a - b);
  const stallMs = ((analyser.context.currentTime - firstClock) - (spread(stems).position - firstPosition)) * 1000;
  log(`${label} state=${analyser.context.state} median=${values[Math.floor(values.length / 2)].toFixed(1)}dB worst=${values.at(-1)!.toFixed(1)}dB maxSpread=${maxSpread.toFixed(2)}ms stall=${stallMs.toFixed(0)}ms at=${spread(stems).position.toFixed(1)}s`);
}

async function proveAudible(log: Log, analyser: AnalyserNode, stems: Stem[]) {
  const opposite = stems.filter(({ name }) => name.endsWith('b'));
  for (const { gain } of opposite) gain.gain.value = 0;
  await wait(500);
  await measure(log, 'audible(b muted)', analyser, stems, 2);
  for (const { gain } of opposite) gain.gain.value = 1;
  await wait(500);
}

async function scenario(log: Log, label: string, seconds: number, effects: boolean, listen: number, seeks: number) {
  log(`--- ${label} file=${seconds}s effects=${effects}`);
  const context = new AudioContext({ sampleRate: 44100 });
  await context.resume();
  const { analyser, stems } = build(context, seconds, effects);
  const firstClock = context.currentTime;
  const tone = context.createOscillator();
  const toneGain = context.createGain();
  toneGain.gain.value = 0.1;
  tone.connect(toneGain);
  toneGain.connect(analyser);
  tone.start();
  await wait(1000);
  const probe = new Float32Array(analyser.fftSize);
  log(`diag state=${context.state} clock ${firstClock.toFixed(3)}->${context.currentTime.toFixed(3)} rate=${context.sampleRate} toneLevel=${levels(analyser, probe).toFixed(1)}dB durations=${stems.map(({ source }) => source.getDuration().toFixed(1)).join(',')}`);
  tone.stop();
  toneGain.disconnect();
  await wait(200);
  startAll(context, stems);
  await wait(1000);
  await measure(log, 'start', analyser, stems, 5);
  await proveAudible(log, analyser, stems);
  for (let i = 0; i < seeks; i++) {
    const target = Math.random() * (seconds - 30);
    await seekAll(stems, target);
    startAll(context, stems);
    await wait(1000);
    await measure(log, `seek${i + 1}->${target.toFixed(1)}s`, analyser, stems, 2);
  }
  if (seeks) await proveAudible(log, analyser, stems);
  // Listen from the start, so a late random seek cannot run into the end of the file.
  if (listen) {
    await seekAll(stems, 0);
    startAll(context, stems);
    await wait(1000);
  }
  for (let elapsed = 0; elapsed < listen; elapsed += 60) {
    await measure(log, `listen+${elapsed}s`, analyser, stems, Math.min(60, listen - elapsed));
  }
  await proveAudible(log, analyser, stems);
  for (const { source } of stems) source.pause();
  await context.close();
  await wait(1000);
}

// Listening mode: a mixer the user hears, for clicks, screen lock and lock-screen controls.
// Ramped changes are what the real mixer will use; "ramp off" sets gains at once, which
// should click, so the user knows what a click sounds like on this phone.
const RAMP_SECONDS = 0.03;
const VOLUMES = [1, 0.5, 0.25];

interface Channel { muted: boolean; volume: number }

interface Listening {
  context: AudioContext;
  stems: Stem[];
  playing: boolean;
  // Wall clock and audio position at the last play, to tell whether audio kept going while locked.
  playedAt: number;
  playedFrom: number;
  subscriptions: { remove(): void }[];
  timer: ReturnType<typeof setInterval>;
}

function markPlayed(session: Listening, from: number) {
  Object.assign(session, { playing: true, playedAt: Date.now(), playedFrom: from });
}

function setGain(gain: GainNode, value: number, ramp: boolean) {
  const now = gain.context.currentTime;
  gain.gain.cancelScheduledValues(now);
  if (!ramp) {
    gain.gain.value = value;
    return;
  }
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(value, now + RAMP_SECONDS);
}

const LISTEN_SECONDS = 900;
// The b stems start muted, so the a stems are heard as plain tones.
const initialChannels = () => NAMES.map(name => ({ muted: name.endsWith('b'), volume: 1 }));

export default function EngineTrial() {
  const [lines, setLines] = useState<string[]>(['Tap a test.']);
  const [busy, setBusy] = useState(false);
  const [channels, setChannels] = useState<Channel[]>(initialChannels);
  const [ramp, setRamp] = useState(true);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inSession, setInSession] = useState(false);
  const fullLog = useRef<string[]>([]);
  const listening = useRef<Listening | null>(null);

  const log: Log = line => {
    console.log(`TRIAL ${line}`);
    fullLog.current.push(line);
    setLines(current => [...current.slice(-40), line]);
  };

  // Logs what the system does to the audio session, to explain any stop in playback.
  useEffect(() => {
    AudioManager.observeAudioInterruptions(true);
    const subscriptions = [
      AudioManager.addSystemEventListener('interruption', event =>
        log(`system interruption ${event.type} shouldResume=${event.shouldResume}`)),
      AudioManager.addSystemEventListener('routeChange', event => log(`system routeChange ${event.reason}`)),
      AppState.addEventListener('change', state => log(`app ${state}`)),
    ];
    return () => subscriptions.forEach(subscription => subscription?.remove());
  }, []);

  const runAuto = (label: string, seconds: number, listen: number, seeks: number) => {
    setBusy(true);
    scenario(log, label, seconds, true, listen, seeks)
      .then(() => log('DONE'))
      .catch(error => log(`FAILED ${error?.message ?? error}`))
      .finally(() => setBusy(false));
  };

  const showNotification = (session: Listening) =>
    PlaybackNotificationManager.show({
      title: 'Sorituh engine trial',
      artist: '6 stems with EQ',
      duration: LISTEN_SECONDS,
      elapsedTime: spread(session.stems).position,
      state: session.playing ? 'playing' : 'paused',
    }).catch(error => log(`notification failed ${error?.message ?? error}`));

  const play = async () => {
    const session = listening.current;
    if (!session || session.playing) return;
    // Re-seek to the shared position so all stems restart together.
    const from = spread(session.stems).position;
    await seekAll(session.stems, from);
    startAll(session.context, session.stems);
    markPlayed(session, from);
    setPlaying(true);
    log(`play at ${from.toFixed(1)}s`);
    await showNotification(session);
  };

  const pause = async () => {
    const session = listening.current;
    if (!session?.playing) return;
    for (const { source } of session.stems) source.pause();
    session.playing = false;
    setPlaying(false);
    log(`pause at ${spread(session.stems).position.toFixed(1)}s`);
    await showNotification(session);
  };

  const seekBy = async (delta: number) => {
    const session = listening.current;
    if (!session) return;
    const target = Math.min(Math.max(spread(session.stems).position + delta, 0), LISTEN_SECONDS - 5);
    await seekAll(session.stems, target);
    if (session.playing) {
      startAll(session.context, session.stems);
      markPlayed(session, target);
    }
    log(`seek to ${target.toFixed(1)}s`);
    await showNotification(session);
  };

  const startListening = async () => {
    setBusy(true);
    try {
      AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default' });
      const context = new AudioContext({ sampleRate: 44100 });
      await context.resume();
      const { stems } = build(context, LISTEN_SECONDS, true);
      const start = initialChannels();
      stems.forEach((stem, i) => { stem.gain.gain.value = start[i].muted ? 0 : start[i].volume; });
      setChannels(start);
      const session: Listening = {
        context, stems, playing: false, playedAt: 0, playedFrom: 0, subscriptions: [],
        timer: setInterval(() => setPosition(spread(stems).position), 1000),
      };
      listening.current = session;
      setInSession(true);
      await PlaybackNotificationManager.enableControl('play', true);
      await PlaybackNotificationManager.enableControl('pause', true);
      await PlaybackNotificationManager.enableControl('skipForward', true);
      await PlaybackNotificationManager.enableControl('skipBackward', true);
      session.subscriptions = [
        PlaybackNotificationManager.addEventListener('playbackNotificationPlay', () => { log('lock screen: play'); play(); }),
        PlaybackNotificationManager.addEventListener('playbackNotificationPause', () => { log('lock screen: pause'); pause(); }),
        PlaybackNotificationManager.addEventListener('playbackNotificationSkipForward', () => { log('lock screen: +15'); seekBy(15); }),
        PlaybackNotificationManager.addEventListener('playbackNotificationSkipBackward', () => { log('lock screen: -15'); seekBy(-15); }),
      ];
      log(`listening: durations=${stems.map(({ source }) => source.getDuration().toFixed(1)).join(',')}`);
      await play();
    } catch (error: any) {
      log(`FAILED ${error?.message ?? error}`);
      setBusy(false);
    }
  };

  const stopListening = async () => {
    const session = listening.current;
    if (!session) return;
    listening.current = null;
    clearInterval(session.timer);
    for (const subscription of session.subscriptions) subscription.remove();
    for (const { source } of session.stems) source.pause();
    await session.context.close();
    await PlaybackNotificationManager.hide().catch(() => {});
    setPlaying(false);
    setInSession(false);
    setBusy(false);
    log('listening stopped');
  };

  const changeChannel = (index: number, change: Partial<Channel>) => {
    const session = listening.current;
    if (!session) return;
    const next = { ...channels[index], ...change };
    setGain(session.stems[index].gain, next.muted ? 0 : next.volume, ramp);
    setChannels(channels.map((channel, i) => (i === index ? next : channel)));
    log(`${NAMES[index]} ${next.muted ? 'muted' : `volume ${next.volume}`} ramp=${ramp ? 'on' : 'off'} at ${spread(session.stems).position.toFixed(1)}s`);
  };

  // After the screen was locked, compares wall time with how far the audio moved.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const session = listening.current;
      if (state !== 'active' || !session?.playing) return;
      const wall = (Date.now() - session.playedAt) / 1000;
      const audio = spread(session.stems).position - session.playedFrom;
      log(`back in app: ${wall.toFixed(1)}s since play, audio moved ${audio.toFixed(1)}s`);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => () => { stopListening(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shareLog = () => Share.share({ message: fullLog.current.join('\n') });

  return (
    <View style={styles.page}>
      <View style={styles.row}>
        <Button label="Auto 4 min" disabled={busy} onPress={() => runAuto('G EQ only', 240, 60, 20)} />
        <Button label="Auto 15 min" disabled={busy} onPress={() => runAuto('H EQ 15 min', 900, 800, 5)} />
        <Button label="Share log" onPress={shareLog} />
      </View>
      <View style={styles.row}>
        {inSession
          ? <Button label="Stop listening" onPress={stopListening} />
          : <Button label="Listen 15 min" disabled={busy} onPress={startListening} />}
        {inSession && <Button label={playing ? 'Pause' : 'Play'} onPress={playing ? pause : play} />}
        {inSession && <Button label="-30 s" onPress={() => seekBy(-30)} />}
        {inSession && <Button label="+30 s" onPress={() => seekBy(30)} />}
      </View>
      {inSession && (
        <>
          <View style={styles.row}>
            <Text style={styles.line}>{position.toFixed(1)} s</Text>
            <Button label={`Ramp ${ramp ? 'on' : 'off'}`} onPress={() => setRamp(!ramp)} />
          </View>
          {channels.map((channel, i) => (
            <View key={NAMES[i]} style={styles.row}>
              <Text style={styles.line}>{NAMES[i]}</Text>
              <Button label={channel.muted ? 'Unmute' : 'Mute'} onPress={() => changeChannel(i, { muted: !channel.muted })} />
              <Button
                label={`Vol ${channel.volume * 100}%`}
                onPress={() => changeChannel(i, { volume: VOLUMES[(VOLUMES.indexOf(channel.volume) + 1) % VOLUMES.length] })}
              />
            </View>
          ))}
        </>
      )}
      <ScrollView style={styles.log}>
        {lines.map((line, index) => <Text key={index} style={styles.line}>{line}</Text>)}
      </ScrollView>
    </View>
  );
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[styles.button, disabled && styles.disabled]} onPress={onPress} disabled={disabled}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: 60, paddingHorizontal: 12, backgroundColor: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  button: { backgroundColor: '#3459c9', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontSize: 14 },
  log: { flex: 1, marginTop: 8 },
  line: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});
