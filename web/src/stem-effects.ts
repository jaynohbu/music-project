export interface EffectSettings {
  volume: number;
  preGain: number;
  compression: number;
  distortion: number;
  bass: number;
  mid: number;
  treble: number;
  pan: number;
  reverb: number;
}

export type EffectControl = keyof EffectSettings;
export interface FaderControl {
  key: EffectControl;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

export const FADER_CONTROLS: readonly FaderControl[] = [
  { key: 'volume', label: 'Volume', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'preGain', label: 'Pre-gain', min: 0, max: 200, step: 1, unit: '%' },
  { key: 'compression', label: 'Compression', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'distortion', label: 'Distortion', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'bass', label: 'Bass', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'mid', label: 'Mid', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'treble', label: 'Treble', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'pan', label: 'Pan', min: -100, max: 100, step: 1, unit: '' },
  { key: 'reverb', label: 'Reverb', min: 0, max: 100, step: 1, unit: '%' },
];

export function defaultEffects(): EffectSettings {
  return {
    volume: 80, preGain: 100, compression: 0, distortion: 0,
    bass: 0, mid: 0, treble: 0, pan: 0, reverb: 0,
  };
}

export interface StemEffects {
  input: GainNode;
  dryDelay: DelayNode;
  dry: GainNode;
  processed: GainNode;
  preGain: GainNode;
  compressor: DynamicsCompressorNode;
  distortion: WaveShaperNode;
  distortionDry: GainNode;
  distortionWet: GainNode;
  distortionOutput: GainNode;
  bass: BiquadFilterNode;
  mid: BiquadFilterNode;
  treble: BiquadFilterNode;
  pan: StereoPannerNode;
  convolver: ConvolverNode;
  reverbSend: GainNode;
  reverbWet: GainNode;
  gain: GainNode;
  transport: GainNode;
}

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>();

function reverbImpulse(context: BaseAudioContext): AudioBuffer {
  const cached = impulses.get(context);
  if (cached) return cached;
  const length = Math.round(context.sampleRate * 1.5);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  let seed = 1234567;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff * 2 - 1) * Math.pow(1 - i / length, 3);
    }
  }
  impulses.set(context, buffer);
  return buffer;
}

export function createStemEffects(context: BaseAudioContext, destination: AudioNode): StemEffects {
  const input = context.createGain();
  const dryDelay = context.createDelay();
  const dry = context.createGain();
  const processed = context.createGain();
  const preGain = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const distortion = context.createWaveShaper();
  const distortionDry = context.createGain();
  const distortionWet = context.createGain();
  const distortionOutput = context.createGain();
  const bass = context.createBiquadFilter();
  const mid = context.createBiquadFilter();
  const treble = context.createBiquadFilter();
  const pan = context.createStereoPanner();
  const convolver = context.createConvolver();
  const reverbSend = context.createGain();
  const reverbWet = context.createGain();
  const gain = context.createGain();
  const transport = context.createGain();
  bass.type = 'lowshelf';
  bass.frequency.value = 150;
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 0.7;
  treble.type = 'highshelf';
  treble.frequency.value = 4000;
  compressor.ratio.value = 1;
  compressor.threshold.value = 0;
  // A fixed unity-slope soft clip cannot boost samples. Change the mix, not
  // the render thread's curve, while dragging; an odd length preserves zero.
  const distortionCurve = new Float32Array(4097);
  for (let i = 0; i < distortionCurve.length; i++) {
    const x = i * 2 / (distortionCurve.length - 1) - 1;
    distortionCurve[i] = Math.tanh(25 * x) / 25;
  }
  distortion.curve = distortionCurve;
  distortionWet.gain.value = 0;
  dry.gain.value = 0;
  reverbSend.gain.value = 0;
  reverbWet.gain.value = 0;
  transport.gain.value = 0;
  // Match the compressor's 6 ms lookahead so bypass does not shift a stem.
  dryDelay.delayTime.value = 0.006;
  // Bypass skips every effect but retains channel volume, mute/solo and transport.
  input.connect(dryDelay);
  dryDelay.connect(dry);
  dry.connect(gain);
  input.connect(preGain);
  preGain.connect(compressor);
  compressor.connect(distortionDry);
  distortionDry.connect(distortionOutput);
  compressor.connect(distortion);
  distortion.connect(distortionWet);
  distortionWet.connect(distortionOutput);
  distortionOutput.connect(bass);
  bass.connect(mid);
  mid.connect(treble);
  treble.connect(pan);
  treble.connect(reverbSend);
  reverbSend.connect(convolver);
  convolver.connect(reverbWet);
  reverbWet.connect(pan);
  pan.connect(processed);
  processed.connect(gain);
  gain.connect(transport);
  transport.connect(destination);
  return {
    input, dryDelay, dry, processed, preGain, compressor, distortion,
    distortionDry, distortionWet, distortionOutput, bass, mid, treble,
    pan, convolver, reverbSend, reverbWet, gain, transport,
  };
}

export function disposeStemEffects(nodes: StemEffects): void {
  for (const node of Object.values(nodes)) node.disconnect();
}

export function applyStemEffects(
  context: BaseAudioContext, nodes: StemEffects, settings: EffectSettings, bypass: boolean,
): void {
  const now = context.currentTime;
  const smooth = (param: AudioParam, value: number): void => {
    param.setTargetAtTime(value, now, 0.015);
  };
  smooth(nodes.preGain.gain, settings.preGain / 100);
  smooth(nodes.compressor.threshold, -settings.compression * 0.6);
  smooth(nodes.compressor.ratio, 1 + settings.compression * 0.11);
  smooth(nodes.distortionDry.gain, 1 - settings.distortion / 100);
  smooth(nodes.distortionWet.gain, settings.distortion / 100);
  smooth(nodes.bass.gain, settings.bass);
  smooth(nodes.mid.gain, settings.mid);
  smooth(nodes.treble.gain, settings.treble);
  smooth(nodes.pan.pan, settings.pan / 100);
  smooth(nodes.dry.gain, bypass ? 1 : 0);
  smooth(nodes.processed.gain, bypass ? 0 : 1);
  smooth(nodes.reverbSend.gain, bypass ? 0 : settings.reverb / 100);
  smooth(nodes.reverbWet.gain, settings.reverb / 100 * 0.5);
  if (settings.reverb > 0 && !nodes.convolver.buffer) {
    nodes.convolver.buffer = reverbImpulse(context);
  }
}
