// Temporary audio engine trial (design doc, step 1). Never ships: index.ts only
// loads it when EXPO_PUBLIC_ENGINE_TRIAL=1.
//
// Each pair of files holds the same tones with opposite polarity, so the mix cancels
// to near silence only while they stay aligned. Any drift shows up as a louder mix.
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { AudioContext, MediaElementAudioSourceNode, type AnalyserNode, type GainNode } from 'react-native-audio-api';
// @ts-expect-error Not part of the public API; needed to schedule a shared start time.
import { AudioFileSourceNode } from 'react-native-audio-api/lib/module/Audio/AudioFileSourceNode';

const DIRECTORY = '/storage/emulated/0/Android/data/com.tunesbasis.sorituh/files/trial';
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
      source: `${DIRECTORY}/s${seconds}_${name}.m4a`, loop: false, volume: 1, playbackRate: 1, preservesPitch: false,
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

export default function EngineTrial() {
  const [lines, setLines] = useState<string[]>(['Starting...']);

  useEffect(() => {
    const log = (line: string) => {
      console.log(`TRIAL ${line}`);
      setLines(current => [...current.slice(-40), line]);
    };

    const startAll = (context: AudioContext, stems: Stem[]) => {
      const when = context.currentTime + START_DELAY;
      for (const { source } of stems) source.getFileSourceNode().start(when);
    };
    const spread = (stems: Stem[]) => {
      const times = stems.map(({ source }) => source.getCurrentTime());
      return { position: times[0], spreadMs: (Math.max(...times) - Math.min(...times)) * 1000 };
    };

    // Measures the worst and median level over a window, and confirms audio really plays.
    const measure = async (label: string, analyser: AnalyserNode, stems: Stem[], seconds: number) => {
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
      log(`${label} median=${values[Math.floor(values.length / 2)].toFixed(1)}dB worst=${values.at(-1)!.toFixed(1)}dB maxSpread=${maxSpread.toFixed(2)}ms stall=${stallMs.toFixed(0)}ms at=${spread(stems).position.toFixed(1)}s`);
    };

    const proveAudible = async (analyser: AnalyserNode, stems: Stem[]) => {
      const opposite = stems.filter(({ name }) => name.endsWith('b'));
      for (const { gain } of opposite) gain.gain.value = 0;
      await wait(500);
      await measure('audible(b muted)', analyser, stems, 2);
      for (const { gain } of opposite) gain.gain.value = 1;
      await wait(500);
    };

    const scenario = async (label: string, seconds: number, effects: boolean, listen: number, seeks: number) => {
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
      await measure('start', analyser, stems, 5);
      await proveAudible(analyser, stems);
      for (let i = 0; i < seeks; i++) {
        const target = Math.random() * (seconds - 30);
        for (const { source } of stems) source.pause();
        for (const { source } of stems) source.seekToTime(target);
        await wait(SEEK_SETTLE_MS);
        startAll(context, stems);
        await wait(1000);
        await measure(`seek${i + 1}->${target.toFixed(1)}s`, analyser, stems, 2);
      }
      if (seeks) await proveAudible(analyser, stems);
      for (let elapsed = 0; elapsed < listen; elapsed += 60) {
        await measure(`listen+${elapsed}s`, analyser, stems, Math.min(60, listen - elapsed));
      }
      await proveAudible(analyser, stems);
      for (const { source } of stems) source.pause();
      await context.close();
      await wait(1000);
    };

    (async () => {
      await scenario('G EQ only', 240, true, 60, 20);
      log('DONE');
    })().catch(error => log(`FAILED ${error?.message ?? error}`));
  }, []);

  return (
    <ScrollView style={styles.page}>
      {lines.map((line, index) => <Text key={index} style={styles.line}>{line}</Text>)}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: 50, paddingHorizontal: 12, backgroundColor: '#fff' },
  line: { fontSize: 12, fontFamily: 'monospace' },
});
