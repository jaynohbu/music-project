import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/stem-effects.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { createStemEffects, applyStemEffects, defaultEffects, FADER_CONTROLS } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function contextFixture() {
  const param = (value = 0) => ({
    value,
    setTargetAtTime(next) { this.value = next; },
  });
  const node = () => ({
    edges: [],
    connect(next) { this.edges.push(next); },
    gain: param(1), frequency: param(350), Q: param(1),
    threshold: param(-24), ratio: param(12), pan: param(), delayTime: param(),
    curve: null, buffer: null,
  });
  return {
    currentTime: 0, sampleRate: 48000, destination: node(),
    createGain: node, createDelay: node, createDynamicsCompressor: node,
    createWaveShaper: node, createBiquadFilter: node, createStereoPanner: node,
    createConvolver: node,
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, sampleRate, numberOfChannels: channels, getChannelData: channel => data[channel] };
    },
  };
}

test('nine faders have meaningful ranges and defaults', () => {
  const defaults = defaultEffects();
  assert.equal(FADER_CONTROLS.length, 9);
  for (const control of FADER_CONTROLS) {
    assert.ok(defaults[control.key] >= control.min && defaults[control.key] <= control.max);
  }
  assert.equal(defaults.volume, 80);
  assert.equal(defaults.preGain, 100);
  assert.equal(defaults.pan, 0);
});

test('processed and compensated dry paths share channel output and transport', () => {
  const context = contextFixture();
  const nodes = createStemEffects(context, context.destination);
  assert.deepEqual(nodes.input.edges, [nodes.dryDelay, nodes.preGain]);
  assert.equal(nodes.dryDelay.delayTime.value, 0.006);
  for (const [from, to] of [
    ['dryDelay', 'dry'], ['dry', 'gain'], ['preGain', 'compressor'],
    ['compressor', 'distortion'], ['compressor', 'distortionDry'],
    ['distortionDry', 'distortionOutput'], ['distortion', 'distortionWet'],
    ['distortionWet', 'distortionOutput'], ['distortionOutput', 'bass'], ['bass', 'mid'],
    ['mid', 'treble'], ['reverbSend', 'convolver'], ['convolver', 'reverbWet'],
    ['reverbWet', 'pan'], ['pan', 'processed'], ['processed', 'gain'], ['gain', 'transport'],
  ]) assert.ok(nodes[from].edges.includes(nodes[to]), `${from} -> ${to}`);
  assert.deepEqual(nodes.treble.edges, [nodes.pan, nodes.reverbSend]);
  assert.deepEqual(nodes.transport.edges, [context.destination]);
  assert.equal(nodes.transport.gain.value, 0);
  assert.equal(nodes.compressor.ratio.value, 1);
});

test('effects drive real node parameters; bypass retains settings and channel gain', () => {
  const context = contextFixture();
  const nodes = createStemEffects(context, context.destination);
  const settings = { ...defaultEffects(), preGain: 160, compression: 50, distortion: 70,
    bass: 4, mid: -5, treble: 6, pan: -60, reverb: 75 };
  applyStemEffects(context, nodes, settings, false);
  assert.equal(nodes.preGain.gain.value, 1.6);
  assert.equal(nodes.compressor.threshold.value, -30);
  assert.equal(nodes.compressor.ratio.value, 6.5);
  assert.equal(nodes.bass.gain.value, 4);
  assert.equal(nodes.mid.gain.value, -5);
  assert.equal(nodes.treble.gain.value, 6);
  assert.equal(nodes.pan.pan.value, -0.6);
  assert.equal(nodes.reverbSend.gain.value, 0.75);
  assert.ok(nodes.reverbWet.gain.value > 0);
  assert.equal(nodes.convolver.buffer.numberOfChannels, 2);
  assert.equal(nodes.convolver.buffer.length, 72000);
  const curve = nodes.distortion.curve;
  assert.ok(Math.abs(curve[3072]) < 0.05, 'soft clipping must be level compensated');
  assert.ok(Math.abs(nodes.distortionDry.gain.value - 0.3) < 1e-12);
  assert.equal(nodes.distortionWet.gain.value, 0.7);
  nodes.gain.gain.value = 0.35;
  applyStemEffects(context, nodes, settings, true);
  assert.equal(nodes.dry.gain.value, 1);
  assert.equal(nodes.processed.gain.value, 0);
  assert.equal(nodes.reverbSend.gain.value, 0);
  assert.equal(nodes.gain.gain.value, 0.35);
  assert.equal(nodes.distortion.curve, curve, 'do not rebuild curves on unrelated changes');
  applyStemEffects(context, nodes, settings, false);
  assert.equal(nodes.dry.gain.value, 0);
  assert.equal(nodes.processed.gain.value, 1);
  assert.equal(nodes.reverbSend.gain.value, 0.75);
});

test('defaults neutralize effects and the impulse is shared only within a context', () => {
  const context = contextFixture();
  const first = createStemEffects(context, context.destination);
  const second = createStemEffects(context, context.destination);
  applyStemEffects(context, first, { ...defaultEffects(), distortion: 100, reverb: 100 }, false);
  applyStemEffects(context, second, { ...defaultEffects(), reverb: 100 }, false);
  assert.equal(first.convolver.buffer, second.convolver.buffer);
  const otherContext = contextFixture();
  const third = createStemEffects(otherContext, otherContext.destination);
  applyStemEffects(otherContext, third, { ...defaultEffects(), reverb: 100 }, false);
  assert.notEqual(first.convolver.buffer, third.convolver.buffer);
  applyStemEffects(context, first, defaultEffects(), false);
  assert.equal(first.distortionDry.gain.value, 1);
  assert.equal(first.distortionWet.gain.value, 0);
  assert.equal(first.compressor.ratio.value, 1);
  assert.equal(first.preGain.gain.value, 1);
  assert.equal(first.bass.gain.value, 0);
  assert.equal(first.mid.gain.value, 0);
  assert.equal(first.treble.gain.value, 0);
  assert.equal(first.pan.pan.value, 0);
  assert.equal(first.reverbSend.gain.value, 0);
  assert.equal(first.reverbWet.gain.value, 0);
});

test('distortion never boosts samples and rapid changes never replace its curve', () => {
  const context = contextFixture();
  const nodes = createStemEffects(context, context.destination);
  const curve = nodes.distortion.curve;
  assert.equal(curve[(curve.length - 1) / 2], 0);
  for (let i = 0; i < curve.length; i++) {
    const x = i * 2 / (curve.length - 1) - 1;
    assert.ok(Number.isFinite(curve[i]));
    assert.ok(Math.abs(curve[i]) <= Math.abs(x) + 1e-8);
    assert.ok(Math.abs(curve[i] + curve[curve.length - i - 1]) < 1e-8);
  }
  for (let i = 0; i < 500; i++) {
    applyStemEffects(context, nodes, { ...defaultEffects(), distortion: i % 101 }, false);
    assert.equal(nodes.distortion.curve, curve);
    assert.ok(Math.abs(nodes.distortionDry.gain.value + nodes.distortionWet.gain.value - 1) < 1e-12);
    assert.equal(nodes.transport.gain.value, 0, 'effect changes must not alter transport');
  }
});
