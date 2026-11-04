import { Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AnalyserNode } from 'react-native-audio-api';
import { STEM_NAMES, type StemName } from '../api';
import { EXPLICIT_STEREO, stereoGain } from '../effects';
import { AppHeader, type MainRoute } from '../app-header';
import { MixerControls, type StemPeaks } from '../mixer-view';
import { decodePeaks } from '../waveform';
import { StemScrollView } from '../stem-scroll';
import { ScorePreview } from './score-preview';
import { Mixer } from '../player';
import { ConfirmationProvider } from '../ui';

// Measures the RMS level after each stage of the first stem and at the master.
async function rms(context: any, node: { connect(n: unknown): void; disconnect(n?: unknown): void }, sink: any) {
  const analyser = new AnalyserNode(context, { ...EXPLICIT_STEREO, fftSize: 2048 });
  node.connect(analyser); analyser.connect(sink);
  await new Promise(resolve => setTimeout(resolve, 300));
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  node.disconnect(analyser);
  return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
}

// Logs each stem's output level, so mute and solo can be checked by numbers.
async function probeStems(mixer: Mixer, log: (message: string) => void, label: string) {
  const internal = mixer as any;
  const sink = stereoGain(internal.context, 0);
  sink.connect(internal.context.destination);
  await new Promise(resolve => setTimeout(resolve, 200));
  const levels: string[] = [];
  for (const name of STEM_NAMES) levels.push(`${name} ${(await rms(internal.context, internal.stems[name].gain, sink)).toFixed(3)}`);
  log(`${label}: ${levels.join(', ')}; master ${(await rms(internal.context, internal.master, sink)).toFixed(3)}`);
}

async function probeStages(mixer: Mixer, log: (message: string) => void, only?: string[]) {
  const internal = mixer as any;
  const context = internal.context;
  const stem = internal.stems[STEM_NAMES[0]];
  const stages: [string, { connect(node: unknown): void; disconnect(node?: unknown): void }][] = [
    ['originalGain', stem.originalGain], ['effects.input', stem.effects.input], ['preGain', stem.effects.preGain],
    ['compressed', stem.effects.compressed], ['distortionDry', stem.effects.distortionDry], ['waveshaper', stem.effects.distortion], ['distortionWet', stem.effects.distortionWet], ['distortionOut', stem.effects.distortionOut], ['bass', stem.effects.bass], ['mid', stem.effects.mid], ['treble', stem.effects.treble], ['send', stem.effects.send], ['convolver', stem.effects.convolver], ['reverbWet', stem.effects.reverbWet], ['pan', stem.effects.pan],
    ['effects.output', stem.effects.output], ['stem gain', stem.gain], ['master', internal.master],
  ];
  const sink = stereoGain(context, 0);
  sink.connect(context.destination);
  for (const [label, node] of stages.filter(([label]) => !only || only.includes(label))) {
    const analyser = new AnalyserNode(context, { ...EXPLICIT_STEREO, fftSize: 2048 });
    node.connect(analyser);
    // The graph is pulled from the destination, so the analyser must reach it.
    analyser.connect(sink);
    await new Promise(resolve => setTimeout(resolve, 400));
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0, nan = 0;
    for (const value of data) { if (Number.isNaN(value)) nan++; else sum += value * value; }
    log(`RMS ${label}: ${Math.sqrt(sum / data.length).toFixed(5)}${nan ? ` (NaN ${nan})` : ''}`);
    node.disconnect(analyser);
  }
}

export default function MixerDiagnostic() {
  const [messages, setMessages] = useState<string[]>([]);
  const [player, setPlayer] = useState<Mixer | null>(null);
  const [peaks, setPeaks] = useState<StemPeaks>({});
  const [route, setRoute] = useState<MainRoute>('/');
  useEffect(() => {
    let mixer: Mixer | undefined;
    const log = (message: string) => {
      console.log(`MIXER_DIAG ${message}`);
      setMessages(current => [message, ...current]);
    };
    const directory = decodeURI(Paths.bundle.uri.replace(/^file:\/\//, '').replace(/\/$/, ''));
    const files = ['0a', '0b', '1a', '1b', '2a', '2b'];
    const paths = Object.fromEntries(STEM_NAMES.map((name, index) => [
      name, `${directory}/s240_${files[index]}.mp4`,
    ])) as Record<StemName, string>;
    const timer = setTimeout(() => {
      void (async () => {
        log('Creating production Mixer with six bundled test stems');
        mixer = await Mixer.create(paths, 'Mixer crash reproduction');
        log(`Created mixer, duration ${mixer.duration}`);
        await mixer.play();
        log('Play started');
        // The test stems are opposite-polarity pairs; keep only one of each pair.
        for (const name of [STEM_NAMES[1], STEM_NAMES[3], STEM_NAMES[5]]) mixer.setChannel(name, { muted: true });
        await new Promise(resolve => setTimeout(resolve, 2000));
        await probeStages(mixer, log);
        mixer.tick();
        log(`Position ${mixer.position}, error ${mixer.error || 'none'}`);
        for (const name of STEM_NAMES) mixer.setChannel(name, { compression: 35, distortion: 20, reverb: 30 });
        log('All effects enabled');
        await new Promise(resolve => setTimeout(resolve, 1500));
        await probeStages(mixer, log, ['convolver', 'reverbWet', 'master']);
        await mixer.stop();
        await mixer.close();
        log('PASS: create/play/effects/stop/close');
        // Non-cancelling stems: only the "a" file of each pair.
        const controlFiles = ['s240_0a', 's240_1a', 's240_2a', 's240_0a', 's240_1a', 's240_2a'];
        const controlPaths = Object.fromEntries(STEM_NAMES.map((name, index) => [
          name, `${directory}/${controlFiles[index]}.mp4`,
        ])) as Record<StemName, string>;
        mixer = await Mixer.create(controlPaths, 'Mixer controls test');
        await mixer.play();
        await probeStems(mixer, log, 'Levels all on');
        mixer.setChannel('vocals', { muted: true });
        await probeStems(mixer, log, 'Levels vocals muted');
        mixer.setChannel('vocals', { muted: false, solo: true });
        await probeStems(mixer, log, 'Levels vocals solo');
        mixer.setChannel('drums', { solo: true });
        await probeStems(mixer, log, 'Levels vocals+drums solo');
        mixer.setChannel('vocals', { solo: false }); mixer.setChannel('drums', { solo: false });
        await mixer.stop();
        // Visible UI state for screenshots: an interval, moved faders and a moving playhead.
        mixer.setSection(mixer.duration * .15, mixer.duration * .8);
        mixer.setChannel('vocals', { bass: 6, pan: -40, compression: 35 });
        await mixer.play();
        await new Promise(resolve => setTimeout(resolve, 1500));
        await probeStages(mixer, log, ['master']);
        setPlayer(mixer);
        const began = Date.now();
        for (const name of STEM_NAMES) {
          const result = await decodePeaks(controlPaths[name], mixer.duration);
          setPeaks(current => ({ ...current, [name]: { original: result } }));
        }
        log(`Waveforms decoded in ${Date.now() - began} ms`);
      })().catch(failure => log(`FAILED: ${failure instanceof Error ? failure.stack : String(failure)}`));
    }, 1000);
    return () => { clearTimeout(timer); if (mixer) void mixer.close().catch(error => console.warn('Diagnostic cleanup failed', error)); };
  }, []);
  return <SafeAreaProvider><ConfirmationProvider><View style={{ flex: 1 }}>
    <AppHeader pathname={route} navigate={setRoute} />
    <StemScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <ScorePreview />
      {messages.slice(0, 6).map((message, index) => <Text key={index} selectable>{message}</Text>)}
      {player && <MixerControls mixer={player} peaks={peaks} />}
    </StemScrollView>
  </View></ConfirmationProvider></SafeAreaProvider>;
}
