import {
  AudioContext, BiquadFilterNode, ConvolverNode, GainNode, StereoPannerNode, WaveShaperNode, type AudioBuffer,
} from 'react-native-audio-api';
import { createSynchronizable } from 'react-native-worklets';

export interface Effects {
  volume: number; preGain: number; compression: number; distortion: number;
  bass: number; mid: number; treble: number; pan: number; reverb: number;
}
export const EFFECT_CONTROLS = [
  { key: 'volume', label: 'Volume', min: 0, max: 100, step: 1 },
  { key: 'preGain', label: 'Pre-gain', min: 0, max: 200, step: 1 },
  { key: 'compression', label: 'Compression', min: 0, max: 100, step: 1 },
  { key: 'distortion', label: 'Distortion', min: 0, max: 100, step: 1 },
  { key: 'bass', label: 'Bass', min: -12, max: 12, step: .5 },
  { key: 'mid', label: 'Mid', min: -12, max: 12, step: .5 },
  { key: 'treble', label: 'Treble', min: -12, max: 12, step: .5 },
  { key: 'pan', label: 'Pan', min: -100, max: 100, step: 1 },
  { key: 'reverb', label: 'Reverb', min: 0, max: 100, step: 1 },
] as const;
export const defaults = (): Effects => ({
  volume: 80, preGain: 100, compression: 0, distortion: 0,
  bass: 0, mid: 0, treble: 0, pan: 0, reverb: 0,
});

// Stereo-linked envelope compression, without the browser compressor's lookahead.
export function compressionGain(peak: number, amount: number): number {
  'worklet';
  if (amount <= 0 || peak <= 0) return 1;
  const threshold = -amount * .6, ratio = 1 + amount * .11;
  const level = 20 * Math.log10(Math.max(peak, 1e-12));
  return level <= threshold ? 1 : Math.pow(10, (threshold + (level - threshold) / ratio - level) / 20);
}

// Native 0.13.6 nodes in the default "max" channel mode process in place in their
// input's buffer, and a node read by a second consumer hands out a different, stale
// buffer. Any fan-out (dry/wet, effect sends) then silences the stem. "explicit"
// nodes mix their inputs into their own buffer, which avoids both problems.
export const EXPLICIT_STEREO = { channelCount: 2, channelCountMode: 'explicit' } as const;
export const stereoGain = (context: AudioContext, gain = 1) => new GainNode(context, { ...EXPLICIT_STEREO, gain });

const impulses = new WeakMap<AudioContext, AudioBuffer>();
function impulse(context: AudioContext) {
  let buffer = impulses.get(context);
  if (buffer) return buffer;
  buffer = context.createBuffer(2, Math.round(context.sampleRate * 1.5), context.sampleRate);
  let seed = 1234567;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff * 2 - 1) * Math.pow(1 - i / data.length, 3);
    }
  }
  impulses.set(context, buffer);
  return buffer;
}

export function createEffects(context: AudioContext) {
  const input = stereoGain(context), dry = stereoGain(context, 0), wet = stereoGain(context);
  const preGain = stereoGain(context), output = stereoGain(context);
  const compression = createSynchronizable(0);
  const envelope = createSynchronizable(0);
  const attack = Math.exp(-1 / (.003 * context.sampleRate));
  const release = Math.exp(-1 / (.25 * context.sampleRate));
  const compressor = context.createWorkletProcessingNode((inputs, outputs, frames) => {
    'worklet';
    const amount = compression.getDirty();
    let level = envelope.getDirty();
    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let ch = 0; ch < inputs.length; ch++) peak = Math.max(peak, Math.abs(inputs[ch][i]));
      const coefficient = peak > level ? attack : release;
      level = coefficient * level + (1 - coefficient) * peak;
      const gain = compressionGain(level, amount);
      for (let ch = 0; ch < outputs.length; ch++) outputs[ch][i] = (inputs[ch]?.[i] ?? 0) * gain;
    }
    envelope.setBlocking(level);
  });
  // The worklet node cannot be made explicit, so it feeds exactly one explicit node.
  const compressed = stereoGain(context);
  const curve = new Float32Array(4097);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(25 * (i * 2 / (curve.length - 1) - 1)) / 25;
  const distortion = new WaveShaperNode(context, EXPLICIT_STEREO);
  distortion.curve = curve;
  const distortionDry = stereoGain(context), distortionWet = stereoGain(context, 0), distortionOut = stereoGain(context);
  const bass = new BiquadFilterNode(context, { ...EXPLICIT_STEREO, type: 'lowshelf', frequency: 150 });
  const mid = new BiquadFilterNode(context, { ...EXPLICIT_STEREO, type: 'peaking', frequency: 1000, Q: .7 });
  const treble = new BiquadFilterNode(context, { ...EXPLICIT_STEREO, type: 'highshelf', frequency: 4000 });
  const pan = new StereoPannerNode(context, EXPLICIT_STEREO);
  const send = stereoGain(context, 0), reverbWet = stereoGain(context, 0);
  // Native 0.13.6 processes connected convolvers even at zero send gain and
  // dereferences an uninitialized thread pool if their buffer is still null.
  const convolver = new ConvolverNode(context, EXPLICIT_STEREO);
  convolver.buffer = impulse(context);
  input.connect(dry); dry.connect(output);
  input.connect(preGain); preGain.connect(compressor); compressor.connect(compressed);
  compressed.connect(distortionDry); distortionDry.connect(distortionOut);
  compressed.connect(distortion); distortion.connect(distortionWet); distortionWet.connect(distortionOut);
  distortionOut.connect(bass); bass.connect(mid); mid.connect(treble); treble.connect(pan);
  pan.connect(wet); wet.connect(output);
  treble.connect(send); send.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(pan);
  return { input, output, compression, envelope, preGain, bass, mid, treble, pan,
    dry, wet, compressor, compressed, distortion, distortionDry, distortionWet, distortionOut, send, convolver, reverbWet };
}
export type EffectNodes = ReturnType<typeof createEffects>;

export function applyEffects(context: AudioContext, nodes: EffectNodes, settings: Effects, bypass: boolean) {
  const smooth = (param: { value: number; setTargetAtTime(value: number, time: number, constant: number): void }, value: number) =>
    param.setTargetAtTime(value, context.currentTime, .015);
  nodes.compression.setBlocking(settings.compression);
  smooth(nodes.preGain.gain, settings.preGain / 100);
  smooth(nodes.bass.gain, settings.bass); smooth(nodes.mid.gain, settings.mid); smooth(nodes.treble.gain, settings.treble);
  smooth(nodes.pan.pan, settings.pan / 100);
  smooth(nodes.distortionDry.gain, 1 - settings.distortion / 100); smooth(nodes.distortionWet.gain, settings.distortion / 100);
  smooth(nodes.dry.gain, bypass ? 1 : 0); smooth(nodes.wet.gain, bypass ? 0 : 1);
  smooth(nodes.send.gain, bypass ? 0 : settings.reverb / 100);
  smooth(nodes.reverbWet.gain, bypass ? 0 : settings.reverb / 100 * .5);
}
